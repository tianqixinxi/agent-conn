import { join, resolve } from 'node:path'
import type { AgentCard, AuditEvent, InviteScope, Message, MessageEnvelope } from '@agent-comm/protocol'
import {
  AgentCommError,
  formatLocalInviteLink,
  formatRelayInviteLink,
  formatTransportInviteLink,
  HOP_LIMIT,
  isAgentCommError,
  newMessageId,
  nowIso,
  parseInviteLink,
} from '@agent-comm/protocol'
import type { ProfilePaths } from '../config.js'
import { loadE2eKey, newE2eKey, saveE2eKey, validateE2eKey } from '../crypto/e2e.js'
import { ensureIdentity, signCanonical } from '../crypto/identity.js'
import type { StoreChannelRow, StoreHandle, StoreMessageRow } from '../store/index.js'
import { openStore } from '../store/index.js'
import { createRelayDriver } from '../sync/relay-driver.js'
import { withE2e } from '../sync/with-e2e.js'
import type { TransportBinding } from '../transport/api.js'
import type { Engine, EngineDeps, HeldMessage } from './api.js'
import { openLocalHome } from './local-home.js'

/**
 * W1 实现处:L0 业务核心(DESIGN §3/§4 F1-F5)。
 * 依赖 store/(openStore, openHubDb)与 local-home.ts;relay 家经 deps.relayDriverFactory。
 */

const DEFAULT_INBOX_CAP = 1000
const DEFAULT_SYNC_LIMIT = 200

function localHomeString(hubPath: string): string {
  return `local:${hubPath}`
}

function hubPathOf(home: string): string {
  return home.slice('local:'.length)
}

/** store 的 StoreMessageRow(+ 可选 inbox 字段)→ protocol 的 Message */
function toProtocolMessage(row: StoreMessageRow): Message {
  return {
    messageId: row.messageId,
    from: row.from,
    to: row.to,
    channel: row.channel,
    traceId: row.traceId,
    replyTo: row.replyTo,
    replyBy: row.replyBy,
    hop: row.hop,
    contentType: row.contentType,
    payload: row.payload,
    injectedByHuman: row.injectedByHuman,
    ts: row.ts,
    seq: row.seq,
    status: row.status,
    deliveredAt: row.deliveredAt,
    deliveredTo: undefined,
  }
}

/** 从家拉回的 protocol Message → 待写入本地 store 的行(status/deliveredAt 由调用方决定) */
function fromProtocolMessage(m: Message, channel: string): Omit<StoreMessageRow, 'status'> {
  return {
    messageId: m.messageId,
    channel,
    seq: m.seq,
    from: m.from,
    to: m.to,
    traceId: m.traceId,
    replyTo: m.replyTo,
    replyBy: m.replyBy,
    hop: m.hop,
    contentType: m.contentType,
    payload: m.payload,
    injectedByHuman: m.injectedByHuman,
    ts: m.ts,
    deliveredAt: undefined,
  }
}

export async function createEngine(profile: ProfilePaths, deps: EngineDeps = {}): Promise<Engine> {
  const identity = await ensureIdentity({ identityKeyPath: profile.identityKeyPath })
  const store: StoreHandle = openStore(profile.storePath)
  store.identity.insertIfAbsent(identity)
  const inboxCap = deps.inboxCap ?? DEFAULT_INBOX_CAP

  const transportBindings = new Map<string, TransportBinding>()

  async function getTransportBinding(home: string): Promise<TransportBinding> {
    const cached = transportBindings.get(home)
    if (cached) return cached
    let driver: TransportBinding | undefined
    const factoryInput = {
      home,
      identity,
      signRequest: (canonical: string) => signCanonical(profile.identityKeyPath, canonical),
    }
    for (const factory of deps.transportBindingFactories ?? []) {
      driver = await factory(factoryInput)
      if (driver) break
    }
    if (!driver && home.startsWith('local:')) {
      driver = await openLocalHome(hubPathOf(home))
    }
    if (!driver && (home.startsWith('http://') || home.startsWith('https://'))) {
      const relayDriverFactory = deps.relayDriverFactory ?? createRelayDriver
      driver = relayDriverFactory({
        relayUrl: home,
        identity,
        signRequest: factoryInput.signRequest,
      })
    }
    if (!driver) {
      throw new AgentCommError('NOT_IMPLEMENTED', `no transport binding accepts home: ${home}`)
    }
    transportBindings.set(home, driver)
    return driver
  }

  function channelKeyPath(channel: string): string {
    return join(profile.dir, 'keys', `${channel}.key`)
  }

  function trustedChannelKeyPath(channel: string, storedRef: string): string {
    const expected = resolve(channelKeyPath(channel))
    if (resolve(storedRef) !== expected) {
      throw new AgentCommError('AUTH_FAILED', `untrusted E2E key reference for channel: ${channel}`)
    }
    return expected
  }

  async function getChannelDriver(ch: StoreChannelRow): Promise<TransportBinding> {
    const driver = await getTransportBinding(ch.home)
    if (driver.kind === 'local' || ch.visibility === 'public' || !ch.e2eKeyRef) return driver
    return withE2e(driver, loadE2eKey(trustedChannelKeyPath(ch.name, ch.e2eKeyRef)))
  }

  function requireChannel(name: string): StoreChannelRow {
    const ch = store.channels.get(name)
    if (!ch) throw new AgentCommError('NOT_MEMBER', `not a member of channel: ${name}`)
    return ch
  }

  function resolveChannelName(explicit: string | undefined): string {
    if (explicit !== undefined) return explicit
    const channels = store.channels.list()
    if (channels.length === 1) {
      const only = channels[0]
      if (only) return only.name
    }
    throw new AgentCommError('INVALID_INPUT', 'channel is required when member of zero or multiple channels')
  }

  function checkScope(scope: InviteScope | undefined, to: string, contentType: string | undefined): void {
    if (!scope) return
    if (scope.canSendTo && scope.canSendTo.length > 0) {
      const allowed = scope.canSendTo.includes(to) || scope.canSendTo.includes('*')
      if (!allowed) throw new AgentCommError('SCOPE_DENIED', `scope 不允许发给: ${to}`)
    }
    if (scope.contentTypes && scope.contentTypes.length > 0 && contentType !== undefined) {
      if (!scope.contentTypes.includes(contentType)) {
        throw new AgentCommError('SCOPE_DENIED', `scope 不允许的 contentType: ${contentType}`)
      }
    }
  }

  function appendAudit(entry: {
    event: AuditEvent
    messageId?: string | undefined
    channel?: string | undefined
    from?: string | undefined
    to?: string | undefined
    actor: string
    detail?: string | undefined
  }): void {
    store.audit.append({
      ts: nowIso(),
      event: entry.event,
      messageId: entry.messageId,
      channel: entry.channel,
      fromAlias: entry.from,
      toTarget: entry.to,
      actor: entry.actor,
      detail: entry.detail,
    })
  }

  /** 在本 profile 已知的各频道的家里找一条当前处于 held 状态的消息(T3 只给 messageId,不给 channel) */
  async function findHeldMessage(
    messageId: string,
  ): Promise<{ channel: string; home: string; message: Message } | undefined> {
    for (const ch of store.channels.list()) {
      const driver = await getChannelDriver(ch)
      let held: Message[]
      try {
        held = await driver.listHeld(ch.name)
      } catch (err) {
        if (isAgentCommError(err, 'NOT_IMPLEMENTED') || isAgentCommError(err, 'HOME_UNREACHABLE')) continue
        throw err
      }
      const match = held.find((m) => m.messageId === messageId)
      if (match) return { channel: ch.name, home: ch.home, message: match }
    }
    return undefined
  }

  function maybeUpdateLocalMirror(
    messageId: string,
    patch: { status: StoreMessageRow['status']; payload?: unknown; contentType?: string | undefined },
  ): void {
    const cur = store.messages.get(messageId)
    if (!cur) return
    store.messages.replace({
      ...cur,
      status: patch.status,
      payload: Object.hasOwn(patch, 'payload') ? patch.payload : cur.payload,
      contentType: Object.hasOwn(patch, 'contentType') ? patch.contentType : cur.contentType,
      deliveredAt: patch.status === 'delivered' ? nowIso() : cur.deliveredAt,
    })
  }

  function enforceInboxCap(): void {
    let over = store.inbox.count() - inboxCap
    if (over <= 0) return
    for (const row of store.inbox.oldestConsumed(over)) {
      store.inbox.delete(row.messageId)
      over -= 1
      if (over <= 0) return
    }
    if (over <= 0) return
    for (const row of store.inbox.oldestUnconsumed(over)) {
      const msg = store.messages.get(row.messageId)
      store.inbox.delete(row.messageId)
      appendAudit({
        event: 'dropped',
        messageId: row.messageId,
        channel: msg?.channel,
        from: msg?.from,
        to: msg?.to,
        actor: 'agent:system',
        detail: 'inbox cap eviction',
      })
      over -= 1
      if (over <= 0) return
    }
  }

  const engine: Engine = {
    async whoami() {
      return {
        nodeId: identity.nodeId,
        profile: profile.name,
        memberships: store.channels.list().map((c) => ({ channel: c.name, alias: c.myAlias, home: c.home })),
      }
    },

    async identity() {
      return identity
    },

    async createChannel(input, actor) {
      const home = input.home ?? localHomeString(profile.defaultHubPath)
      const driver = await getTransportBinding(home)
      await driver.createChannel({
        name: input.name,
        displayName: input.displayName,
        mode: input.mode,
        visibility: input.visibility,
        description: input.description,
        member: { alias: input.alias, nodeId: identity.nodeId, publicKey: identity.publicKey },
      })
      const createdAt = nowIso()
      const mode = input.mode ?? 'auto'
      const visibility = input.visibility ?? 'private'
      const e2eKeyRef =
        home.startsWith('local:') || visibility === 'public' ? undefined : channelKeyPath(input.name)
      if (e2eKeyRef) saveE2eKey(e2eKeyRef, newE2eKey())
      store.channels.upsert({
        name: input.name,
        home,
        displayName: input.displayName,
        mode,
        visibility,
        description: input.description,
        myAlias: input.alias,
        scope: undefined,
        e2eKeyRef,
        createdAt,
      })
      store.peers.upsert({
        channel: input.name,
        alias: input.alias,
        nodeId: identity.nodeId,
        card: undefined,
        updatedAt: createdAt,
      })
      store.syncState.set(input.name, 0)
      appendAudit({
        event: 'connected',
        channel: input.name,
        from: input.alias,
        actor,
        detail: 'createChannel',
      })
      return {
        name: input.name,
        home,
        displayName: input.displayName,
        mode,
        visibility,
        description: input.description,
        createdAt,
      }
    },

    async joinChannel(input, actor) {
      const home = localHomeString(profile.defaultHubPath)
      const driver = await getTransportBinding(home)
      // 本机 hub 上"无邀请直接加入":引擎内部自铸一次性邀请并立即兑换,对调用方屏蔽 token 概念
      // (TransportBinding.join 契约要求 joinToken;mintInvite 若频道不存在会先抛 CHANNEL_NOT_FOUND)。
      const minted = await driver.mintInvite({ channel: input.channel, byNode: identity.nodeId, maxUses: 1 })
      const result = await driver.join({
        channel: input.channel,
        joinToken: minted.joinToken,
        member: { alias: input.alias, nodeId: identity.nodeId, publicKey: identity.publicKey },
      })
      const alreadyKnown = store.channels.get(result.channel) !== undefined
      const createdAt = nowIso()
      store.channels.upsert({
        name: result.channel,
        home,
        mode: result.mode,
        visibility: result.visibility,
        myAlias: input.alias,
        scope: result.scope,
        createdAt,
      })
      for (const m of result.members) {
        store.peers.upsert({
          channel: result.channel,
          alias: m.alias,
          nodeId: m.nodeId,
          card: m.card,
          updatedAt: createdAt,
        })
      }
      if (!alreadyKnown) store.syncState.set(result.channel, 0)
      appendAudit({
        event: 'connected',
        channel: result.channel,
        from: input.alias,
        actor,
        detail: 'joinChannel',
      })
      const stored = store.channels.get(result.channel)
      if (!stored) throw new AgentCommError('CONFLICT', 'channel disappeared right after join')
      return {
        name: stored.name,
        home: stored.home,
        displayName: stored.displayName,
        mode: stored.mode,
        visibility: stored.visibility,
        description: stored.description,
        createdAt: stored.createdAt,
      }
    },

    async leaveChannel(input, _actor) {
      const ch = requireChannel(input.channel)
      const driver = await getChannelDriver(ch)
      await driver.leave({ channel: input.channel, alias: ch.myAlias, nodeId: identity.nodeId })
      store.channels.delete(input.channel)
      // 注:协议 AuditEvent 枚举没有"离开/断开"事件码,此动作不记 audit(见最终汇报)。
    },

    async listChannels() {
      return store.channels.list().map((c) => ({
        name: c.name,
        home: c.home,
        displayName: c.displayName,
        mode: c.mode,
        visibility: c.visibility,
        description: c.description,
        createdAt: c.createdAt,
      }))
    },

    async listPeers(input) {
      // 拉基线(§2.6):返回前先从各频道的家刷新成员镜像——成员表权威在家,本地只是缓存。
      // 家不可达(如 relay 离线)时降级用旧镜像,保证离线可读(I5)。
      const channels = input?.channel !== undefined ? [requireChannel(input.channel)] : store.channels.list()
      const presence = new Map<string, boolean>()
      for (const ch of channels) {
        try {
          const driver = await getChannelDriver(ch)
          for (const m of await driver.members(ch.name)) {
            if (m.online !== undefined) presence.set(`${ch.name}\0${m.nodeId}`, m.online)
            store.peers.upsert({
              channel: ch.name,
              alias: m.alias,
              nodeId: m.nodeId,
              card: m.card,
              updatedAt: nowIso(),
            })
          }
        } catch (e) {
          if (!isAgentCommError(e, 'HOME_UNREACHABLE')) throw e
        }
      }
      return store.peers.list(input?.channel).map((p) => ({
        alias: p.alias,
        nodeId: p.nodeId,
        channel: p.channel,
        ...(presence.has(`${p.channel}\0${p.nodeId}`)
          ? { online: presence.get(`${p.channel}\0${p.nodeId}`) }
          : {}),
        card: p.card,
      }))
    },

    async publishCard(card: AgentCard, _actor) {
      for (const ch of store.channels.list()) {
        try {
          const driver = await getChannelDriver(ch)
          await driver.updateCard({ channel: ch.name, alias: ch.myAlias, nodeId: identity.nodeId, card })
          store.peers.upsert({
            channel: ch.name,
            alias: ch.myAlias,
            nodeId: identity.nodeId,
            card,
            updatedAt: nowIso(),
          })
        } catch (err) {
          // AgentCard 是跨 membership 的 best-effort presence 更新；一个退役 relay 不应阻断健康频道。
          if (isAgentCommError(err, 'HOME_UNREACHABLE')) continue
          throw err
        }
      }
    },

    async createInvite(input, _actor) {
      const ch = requireChannel(input.channel)
      const driver = await getChannelDriver(ch)
      const maxUses = input.maxUses ?? 1
      const minted = await driver.mintInvite({
        channel: input.channel,
        byNode: identity.nodeId,
        scope: input.scope,
        ttlMs: input.ttlMs,
        maxUses,
      })
      let e2eKey: string | undefined
      if (!ch.home.startsWith('local:') && ch.visibility === 'private') {
        const e2eKeyRef = ch.e2eKeyRef ?? channelKeyPath(ch.name)
        if (ch.e2eKeyRef) {
          e2eKey = loadE2eKey(trustedChannelKeyPath(ch.name, ch.e2eKeyRef))
        } else {
          e2eKey = newE2eKey()
          saveE2eKey(e2eKeyRef, e2eKey)
          store.channels.upsert({ ...ch, e2eKeyRef })
        }
      }
      const link = ch.home.startsWith('local:')
        ? formatLocalInviteLink(hubPathOf(ch.home), minted.joinToken)
        : ch.home.startsWith('http://') || ch.home.startsWith('https://')
          ? formatRelayInviteLink(ch.home, minted.joinToken, e2eKey, ch.visibility)
          : formatTransportInviteLink(ch.home, minted.joinToken, e2eKey)
      store.invitesMinted.insert({
        link,
        channel: input.channel,
        home: ch.home,
        scope: input.scope,
        expiresAt: minted.expiresAt,
        maxUses,
        uses: 0,
        createdAt: nowIso(),
      })
      return { link, expiresAt: minted.expiresAt }
    },

    async connect(input, actor) {
      const parsed = parseInviteLink(input.link)
      if (parsed.kind === 'local' && resolve(parsed.hubPath) !== resolve(profile.defaultHubPath)) {
        throw new AgentCommError(
          'INVITE_INVALID',
          'local invitation must target this installation default hub',
        )
      }
      if (parsed.kind === 'transport' || (parsed.kind === 'relay' && parsed.visibility === 'private')) {
        if (!parsed.e2eKey) {
          throw new AgentCommError('INVITE_INVALID', 'relay 邀请缺少 E2E 密钥 fragment')
        }
        validateE2eKey(parsed.e2eKey)
      }
      const home =
        parsed.kind === 'local'
          ? localHomeString(parsed.hubPath)
          : parsed.kind === 'relay'
            ? parsed.relayUrl
            : parsed.home
      const driver = await getTransportBinding(home)
      const result = await driver.join({
        // local/relay 的兑换都由 token 反查频道,这里的 channel 不被驱动实现使用(见 local-home.ts 注释)
        channel: '',
        joinToken: parsed.joinToken,
        member: {
          alias: input.alias,
          nodeId: identity.nodeId,
          publicKey: identity.publicKey,
          card: input.card,
        },
      })
      const inviteVisibility = parsed.kind === 'relay' ? parsed.visibility : 'private'
      if (parsed.kind !== 'local' && result.visibility !== inviteVisibility) {
        throw new AgentCommError('INVITE_INVALID', 'invite visibility does not match the relay channel')
      }
      const alreadyKnown = store.channels.get(result.channel) !== undefined
      const createdAt = nowIso()
      let e2eKeyRef: string | undefined
      if ((parsed.kind === 'relay' || parsed.kind === 'transport') && result.visibility === 'private') {
        const e2eKey = parsed.e2eKey
        if (!e2eKey) {
          throw new AgentCommError('INVITE_INVALID', 'relay 邀请缺少 E2E 密钥 fragment')
        }
        e2eKeyRef = channelKeyPath(result.channel)
        saveE2eKey(e2eKeyRef, e2eKey)
      }
      store.channels.upsert({
        name: result.channel,
        home,
        mode: result.mode,
        visibility: result.visibility,
        myAlias: input.alias,
        scope: result.scope,
        e2eKeyRef,
        createdAt,
      })
      for (const m of result.members) {
        store.peers.upsert({
          channel: result.channel,
          alias: m.alias,
          nodeId: m.nodeId,
          card: m.card,
          updatedAt: createdAt,
        })
      }
      if (!alreadyKnown) store.syncState.set(result.channel, 0)
      appendAudit({
        event: 'connected',
        channel: result.channel,
        from: input.alias,
        actor,
        detail: `connect(${parsed.kind})`,
      })
      return {
        channel: result.channel,
        myAlias: input.alias,
        peers: result.members.map((m) => ({
          alias: m.alias,
          nodeId: m.nodeId,
          channel: result.channel,
          ...(m.online !== undefined ? { online: m.online } : {}),
          card: m.card,
        })),
      }
    },

    async send(input, actor) {
      const channelName = resolveChannelName(input.channel)
      const ch = requireChannel(channelName)
      checkScope(ch.scope, input.to, input.contentType)
      const driver = await getChannelDriver(ch)
      const messageId = input.messageId ?? newMessageId()
      const injectedByHuman = actor === 'human'
      const envelope: MessageEnvelope = {
        messageId,
        from: ch.myAlias,
        to: input.to,
        channel: channelName,
        traceId: input.traceId ?? messageId,
        replyTo: input.replyTo,
        replyBy: input.replyBy,
        hop: 0,
        contentType: input.contentType,
        payload: input.payload,
        injectedByHuman,
        ts: nowIso(),
      }
      if (envelope.hop > HOP_LIMIT) throw new AgentCommError('HOP_EXCEEDED', 'hop limit exceeded')

      const [result] = await driver.append(channelName, [envelope])
      if (!result) throw new AgentCommError('CONFLICT', 'home did not acknowledge the sent message')

      store.messages.insert({
        messageId,
        channel: channelName,
        seq: result.seq,
        from: ch.myAlias,
        to: input.to,
        traceId: envelope.traceId,
        replyTo: input.replyTo,
        replyBy: input.replyBy,
        hop: 0,
        contentType: input.contentType,
        payload: input.payload,
        status: result.status,
        injectedByHuman,
        ts: envelope.ts,
        deliveredAt: result.status === 'delivered' ? envelope.ts : undefined,
      })
      appendAudit({
        event: injectedByHuman ? 'injected' : 'created',
        messageId,
        channel: channelName,
        from: ch.myAlias,
        to: input.to,
        actor,
      })
      if (result.status === 'held') {
        // 'created'/'injected' 记录的是发送动作本身;intercept 命中是紧接着的一次状态转移,
        // 单独记一条 'held' 让发送方自己的 audit 也能看到这条消息卡住了(I6 事件表完整覆盖)。
        appendAudit({ event: 'held', messageId, channel: channelName, from: ch.myAlias, to: input.to, actor })
      }
      return { messageId, status: result.status }
    },

    async readInbox(input) {
      await engine.syncOnce()
      const rows = store.inbox.listJoined({
        channel: input?.filter?.channel,
        traceId: input?.filter?.traceId,
        contentType: input?.filter?.contentType,
        includeConsumed: input?.filter?.includeConsumed ?? false,
        limit: input?.limit,
      })
      if (input?.consume) {
        const ts = nowIso()
        for (const r of rows) {
          if (!r.consumedAt) store.inbox.markConsumed(r.messageId, ts)
        }
      }
      return rows.map(toProtocolMessage)
    },

    async ack(input) {
      const msg = store.messages.get(input.messageId)
      if (!msg) throw new AgentCommError('MESSAGE_NOT_FOUND', input.messageId)
      store.inbox.markConsumed(input.messageId, nowIso())
    },

    async syncOnce(channelFilter) {
      const channels = channelFilter !== undefined ? [requireChannel(channelFilter)] : store.channels.list()
      let pulled = 0
      for (const ch of channels) {
        try {
          const driver = await getChannelDriver(ch)
          const after = store.syncState.get(ch.name)
          const { messages, head } = await driver.pullAfter(ch.name, after, { limit: DEFAULT_SYNC_LIMIT })

          for (const m of messages) {
            if (m.from === ch.myAlias) {
              // 自己发的:同步家上最新状态(如 intercept 放行后 held→delivered)到本地镜像,不进 inbox
              const mine = store.messages.get(m.messageId)
              if (mine && (mine.status !== m.status || mine.seq !== m.seq)) {
                store.messages.replace({
                  ...mine,
                  seq: m.seq,
                  status: m.status,
                  payload: m.payload,
                  contentType: m.contentType,
                  deliveredAt: m.status === 'delivered' ? (mine.deliveredAt ?? nowIso()) : mine.deliveredAt,
                })
              }
              continue
            }
            if (m.to !== ch.myAlias && m.to !== '*') continue // 不是发给我的
            if (store.messages.get(m.messageId)) continue // messageId 去重(I3)

            if (m.replyBy !== undefined && Date.parse(m.replyBy) < Date.now()) {
              store.messages.insert({ ...fromProtocolMessage(m, ch.name), status: 'dropped' })
              appendAudit({
                event: 'dropped',
                messageId: m.messageId,
                channel: ch.name,
                from: m.from,
                to: m.to,
                actor: `agent:${ch.myAlias}`,
                detail: 'replyBy expired',
              })
              continue
            }

            const ts = nowIso()
            store.messages.insert({
              ...fromProtocolMessage(m, ch.name),
              status: 'delivered',
              deliveredAt: ts,
            })
            store.inbox.insert({ messageId: m.messageId, addedAt: ts })
            appendAudit({
              event: 'delivered',
              messageId: m.messageId,
              channel: ch.name,
              from: m.from,
              to: m.to,
              actor: `agent:${ch.myAlias}`,
            })
            pulled += 1
          }

          await driver.ackCursor(ch.name, identity.nodeId, head)
          store.syncState.set(ch.name, head)
        } catch (err) {
          // 全量后台同步隔离坏频道；显式同步某频道仍返回错误，便于诊断和重试。
          if (channelFilter === undefined && isAgentCommError(err, 'HOME_UNREACHABLE')) continue
          throw err
        }
      }
      enforceInboxCap()
      if (pulled > 0) deps.onInboxChange?.()
      return { pulled, pushed: 0 }
    },

    async listHeld(channelFilter) {
      const channels = channelFilter !== undefined ? [requireChannel(channelFilter)] : store.channels.list()
      const out: HeldMessage[] = []
      for (const ch of channels) {
        const driver = await getChannelDriver(ch)
        let held: Message[]
        try {
          held = await driver.listHeld(ch.name)
        } catch (err) {
          if (
            isAgentCommError(err, 'NOT_IMPLEMENTED') ||
            (channelFilter === undefined && isAgentCommError(err, 'HOME_UNREACHABLE'))
          ) {
            continue
          }
          throw err
        }
        for (const m of held) out.push({ message: m, channel: ch.name })
      }
      return out
    },

    async deliverHeld(input, actor) {
      if (actor !== 'human') throw new AgentCommError('SCOPE_DENIED', 'deliverHeld 仅限 human(I4)')
      const found = await findHeldMessage(input.messageId)
      if (!found) throw new AgentCommError('NOT_HELD', `message not held: ${input.messageId}`)
      const driver = await getTransportBinding(found.home)
      await driver.resolveHeld({
        channel: found.channel,
        messageId: input.messageId,
        resolution: 'deliver',
        actor,
      })
      maybeUpdateLocalMirror(input.messageId, { status: 'delivered' })
      appendAudit({
        event: 'delivered',
        messageId: input.messageId,
        channel: found.channel,
        from: found.message.from,
        to: found.message.to,
        actor,
      })
    },

    async dropHeld(input, actor) {
      if (actor !== 'human') throw new AgentCommError('SCOPE_DENIED', 'dropHeld 仅限 human(I4)')
      const found = await findHeldMessage(input.messageId)
      if (!found) throw new AgentCommError('NOT_HELD', `message not held: ${input.messageId}`)
      const driver = await getTransportBinding(found.home)
      await driver.resolveHeld({
        channel: found.channel,
        messageId: input.messageId,
        resolution: 'drop',
        actor,
      })
      maybeUpdateLocalMirror(input.messageId, { status: 'dropped' })
      appendAudit({
        event: 'dropped',
        messageId: input.messageId,
        channel: found.channel,
        from: found.message.from,
        to: found.message.to,
        actor,
      })
    },

    async editHeld(input, actor) {
      if (actor !== 'human') throw new AgentCommError('SCOPE_DENIED', 'editHeld 仅限 human(I4)')
      const found = await findHeldMessage(input.messageId)
      if (!found) throw new AgentCommError('NOT_HELD', `message not held: ${input.messageId}`)
      const driver = await getTransportBinding(found.home)
      await driver.resolveHeld({
        channel: found.channel,
        messageId: input.messageId,
        resolution: 'deliver',
        actor,
        ...(Object.hasOwn(input, 'payload') ? { editedPayload: input.payload } : {}),
        ...(Object.hasOwn(input, 'contentType') ? { editedContentType: input.contentType } : {}),
      })
      maybeUpdateLocalMirror(input.messageId, {
        status: 'delivered',
        ...(Object.hasOwn(input, 'payload') ? { payload: input.payload } : {}),
        ...(Object.hasOwn(input, 'contentType') ? { contentType: input.contentType } : {}),
      })
      appendAudit({
        event: 'edited',
        messageId: input.messageId,
        channel: found.channel,
        from: found.message.from,
        to: found.message.to,
        actor,
      })
    },

    async setChannelMode(input, actor) {
      if (actor !== 'human') throw new AgentCommError('SCOPE_DENIED', 'setChannelMode 仅限 human(I4)')
      const ch = requireChannel(input.channel)
      const driver = await getChannelDriver(ch)
      await driver.setMode(input.channel, input.mode)
      store.channels.setMode(input.channel, input.mode)
      // 注:协议 AuditEvent 枚举没有"改模式"事件码,此动作不记 audit(见最终汇报)。
    },

    async auditQuery(q) {
      return store.audit
        .query({ channel: q?.channel, messageId: q?.messageId, sinceTs: q?.sinceTs, limit: q?.limit })
        .map((r) => ({
          ts: r.ts,
          event: r.event,
          messageId: r.messageId,
          channel: r.channel,
          from: r.fromAlias,
          to: r.toTarget,
          actor: r.actor,
          detail: r.detail,
        }))
    },

    async close() {
      for (const d of transportBindings.values()) {
        await d.close()
      }
      store.close()
    },
  }

  return engine
}
