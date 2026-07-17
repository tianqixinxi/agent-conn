import { join } from 'node:path'
import { AgentCommError, isAgentCommError } from '@agent-comm/protocol'
import { describe, expect, it } from 'vitest'
import type { Engine, EngineDeps, TransportBindingFactory } from '../src/engine/api.js'
import { createEngine } from '../src/engine/engine.js'
import { openLocalHome } from '../src/engine/local-home.js'
import { createTmpWorkspace, sleep, type TmpWorkspace } from './helpers/tmp-profile.js'

/**
 * W1 集成测试:两三个 profile 经同一本机 hub(D5)跑通 DESIGN.md F1-F5。
 * 每个用例独立临时工作区,结束时关闭全部 engine 并删除目录。
 */
interface Ctx {
  ws: TmpWorkspace
  makeEngine(name: string, deps?: EngineDeps): Promise<Engine>
}

async function withCtx(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const ws = createTmpWorkspace()
  const engines: Engine[] = []
  try {
    await fn({
      ws,
      async makeEngine(name, deps) {
        const e = await createEngine(ws.profile(name), deps)
        engines.push(e)
        return e
      },
    })
  } finally {
    for (const e of engines) await e.close()
    ws.cleanup()
  }
}

describe('engine (F1-F5 over a shared local hub)', () => {
  it('F1+F2+F3: A creates channel, mints invite, B connects, A sends directed, B reads and consumes', async () => {
    await withCtx(async ({ makeEngine }) => {
      const alice = await makeEngine('alice')
      const bob = await makeEngine('bob')

      const channel = await alice.createChannel({ name: 'daily', alias: 'alice' }, 'agent:alice')
      expect(channel.home).toMatch(/^local:/)
      expect(channel.mode).toBe('auto')

      const { link } = await alice.createInvite({ channel: 'daily' }, 'agent:alice')
      expect(link.startsWith('agentcomm-local:')).toBe(true)

      const connected = await bob.connect({ link, alias: 'bob' }, 'agent:bob')
      expect(connected.channel).toBe('daily')
      expect(connected.myAlias).toBe('bob')
      expect(connected.peers.map((p) => p.alias).sort()).toEqual(['alice', 'bob'])

      const sent = await alice.send(
        { channel: 'daily', to: 'bob', payload: { text: 'standup' } },
        'agent:alice',
      )
      expect(sent.status).toBe('delivered')

      const inboxFirst = await bob.readInbox({ consume: true })
      expect(inboxFirst).toHaveLength(1)
      expect(inboxFirst[0]?.payload).toEqual({ text: 'standup' })
      expect(inboxFirst[0]?.from).toBe('alice')
      expect(inboxFirst[0]?.to).toBe('bob')

      // 默认 filter 排除已消费,第二次读为空
      const inboxSecond = await bob.readInbox({})
      expect(inboxSecond).toHaveLength(0)
      // includeConsumed 仍能查回
      const inboxAll = await bob.readInbox({ filter: { includeConsumed: true } })
      expect(inboxAll).toHaveLength(1)
    })
  })

  it('broadcast to "*" reaches other members in both directions but never the sender itself', async () => {
    await withCtx(async ({ makeEngine }) => {
      const alice = await makeEngine('alice')
      const bob = await makeEngine('bob')
      await alice.createChannel({ name: 'daily', alias: 'alice' }, 'agent:alice')
      const { link } = await alice.createInvite({ channel: 'daily' }, 'agent:alice')
      await bob.connect({ link, alias: 'bob' }, 'agent:bob')

      await alice.send({ channel: 'daily', to: '*', payload: { text: 'good morning all' } }, 'agent:alice')
      expect(await alice.readInbox({ consume: true })).toHaveLength(0) // 发送者不收自己的广播
      const bobInbox = await bob.readInbox({ consume: true })
      expect(bobInbox).toHaveLength(1)
      expect(bobInbox[0]?.to).toBe('*')

      await bob.send({ channel: 'daily', to: '*', payload: { text: 'hi back' } }, 'agent:bob')
      expect(await bob.readInbox({ consume: true })).toHaveLength(0)
      const aliceInbox = await alice.readInbox({ consume: true })
      expect(aliceInbox).toHaveLength(1)
      expect(aliceInbox[0]?.from).toBe('bob')
    })
  })

  it('messageId idempotency: re-syncing without new hub activity does not duplicate inbox entries', async () => {
    await withCtx(async ({ makeEngine }) => {
      const alice = await makeEngine('alice')
      const bob = await makeEngine('bob')
      await alice.createChannel({ name: 'daily', alias: 'alice' }, 'agent:alice')
      const { link } = await alice.createInvite({ channel: 'daily' }, 'agent:alice')
      await bob.connect({ link, alias: 'bob' }, 'agent:bob')
      await alice.send({ channel: 'daily', to: 'bob', payload: 'once' }, 'agent:alice')

      const firstSync = await bob.syncOnce()
      expect(firstSync.pulled).toBe(1)
      const secondSync = await bob.syncOnce()
      expect(secondSync.pulled).toBe(0)
      const thirdSync = await bob.syncOnce('daily')
      expect(thirdSync.pulled).toBe(0)

      const inbox = await bob.readInbox({ filter: { includeConsumed: true } })
      expect(inbox).toHaveLength(1)
    })
  })

  it('intercept mode: held message is invisible to B; agent actor cannot deliverHeld (SCOPE_DENIED); human can', async () => {
    await withCtx(async ({ makeEngine }) => {
      const alice = await makeEngine('alice')
      const bob = await makeEngine('bob')
      await alice.createChannel({ name: 'daily', alias: 'alice', mode: 'intercept' }, 'agent:alice')
      const { link } = await alice.createInvite({ channel: 'daily' }, 'agent:alice')
      await bob.connect({ link, alias: 'bob' }, 'agent:bob')

      const sent = await alice.send(
        { channel: 'daily', to: 'bob', payload: { text: 'careful' } },
        'agent:alice',
      )
      expect(sent.status).toBe('held')
      expect(await bob.readInbox({})).toHaveLength(0)

      await expect(alice.deliverHeld({ messageId: sent.messageId }, 'agent:alice')).rejects.toSatisfy(
        (e: unknown) => isAgentCommError(e, 'SCOPE_DENIED'),
      )
      // 仍然 held,没有被 agent actor 的失败尝试放行
      expect(await bob.readInbox({})).toHaveLength(0)

      await alice.deliverHeld({ messageId: sent.messageId }, 'human')
      const inbox = await bob.readInbox({})
      expect(inbox).toHaveLength(1)
      expect(inbox[0]?.payload).toEqual({ text: 'careful' })
    })
  })

  it('editHeld replaces payload/contentType before release; recipient sees the edited content', async () => {
    await withCtx(async ({ makeEngine }) => {
      const alice = await makeEngine('alice')
      const bob = await makeEngine('bob')
      await alice.createChannel({ name: 'daily', alias: 'alice', mode: 'intercept' }, 'agent:alice')
      const { link } = await alice.createInvite({ channel: 'daily' }, 'agent:alice')
      await bob.connect({ link, alias: 'bob' }, 'agent:bob')

      const sent = await alice.send(
        { channel: 'daily', to: 'bob', payload: { text: 'draft' }, contentType: 'text/plain' },
        'agent:alice',
      )
      await alice.editHeld({ messageId: sent.messageId, payload: { text: 'final' } }, 'human')

      const inbox = await bob.readInbox({})
      expect(inbox).toHaveLength(1)
      expect(inbox[0]?.payload).toEqual({ text: 'final' })
      expect(inbox[0]?.contentType).toBe('text/plain') // 未编辑的字段保留原值
    })
  })

  it('scope.canSendTo restricts who a connected member may send to (SCOPE_DENIED / allowed)', async () => {
    await withCtx(async ({ makeEngine }) => {
      const alice = await makeEngine('alice')
      const bob = await makeEngine('bob')
      await alice.createChannel({ name: 'daily', alias: 'alice' }, 'agent:alice')
      const { link } = await alice.createInvite(
        { channel: 'daily', scope: { canSendTo: ['alice'] } },
        'agent:alice',
      )
      await bob.connect({ link, alias: 'bob' }, 'agent:bob')

      await expect(bob.send({ channel: 'daily', to: '*', payload: 'x' }, 'agent:bob')).rejects.toSatisfy(
        (e: unknown) => isAgentCommError(e, 'SCOPE_DENIED'),
      )
      const ok = await bob.send({ channel: 'daily', to: 'alice', payload: 'x' }, 'agent:bob')
      expect(ok.status).toBe('delivered')
    })
  })

  it('messages with an expired replyBy are dropped rather than delivered to inbox', async () => {
    await withCtx(async ({ makeEngine }) => {
      const alice = await makeEngine('alice')
      const bob = await makeEngine('bob')
      await alice.createChannel({ name: 'daily', alias: 'alice' }, 'agent:alice')
      const { link } = await alice.createInvite({ channel: 'daily' }, 'agent:alice')
      await bob.connect({ link, alias: 'bob' }, 'agent:bob')

      const past = new Date(Date.now() - 60_000).toISOString()
      await alice.send({ channel: 'daily', to: 'bob', payload: 'late', replyBy: past }, 'agent:alice')

      expect(await bob.readInbox({})).toHaveLength(0)
      const audit = await bob.auditQuery({})
      expect(audit.some((a) => a.event === 'dropped' && a.detail === 'replyBy expired')).toBe(true)
    })
  })

  it('inbox cap evicts oldest entries once exceeded and audits the eviction', async () => {
    await withCtx(async ({ makeEngine }) => {
      const alice = await makeEngine('alice')
      const bob = await makeEngine('bob', { inboxCap: 3 })
      await alice.createChannel({ name: 'daily', alias: 'alice' }, 'agent:alice')
      const { link } = await alice.createInvite({ channel: 'daily' }, 'agent:alice')
      await bob.connect({ link, alias: 'bob' }, 'agent:bob')

      for (let i = 0; i < 5; i += 1) {
        await alice.send({ channel: 'daily', to: 'bob', payload: { i } }, 'agent:alice')
      }

      const inbox = await bob.readInbox({ filter: { includeConsumed: true } })
      expect(inbox.length).toBeLessThanOrEqual(3)

      const audit = await bob.auditQuery({})
      expect(audit.some((a) => a.event === 'dropped' && a.detail === 'inbox cap eviction')).toBe(true)
    })
  })

  it('records audit entries across the lifecycle: connected/created/held/dropped/edited/delivered', async () => {
    await withCtx(async ({ makeEngine }) => {
      const alice = await makeEngine('alice')
      const bob = await makeEngine('bob')
      await alice.createChannel({ name: 'daily', alias: 'alice', mode: 'intercept' }, 'agent:alice')
      const { link } = await alice.createInvite({ channel: 'daily' }, 'agent:alice')
      await bob.connect({ link, alias: 'bob' }, 'agent:bob')

      const first = await alice.send({ channel: 'daily', to: 'bob', payload: 'a' }, 'agent:alice')
      await alice.dropHeld({ messageId: first.messageId }, 'human')

      const second = await alice.send({ channel: 'daily', to: 'bob', payload: 'b' }, 'agent:alice')
      await alice.editHeld({ messageId: second.messageId, payload: 'b-edited' }, 'human')
      await bob.readInbox({})

      const aliceEvents = new Set((await alice.auditQuery({})).map((a) => a.event))
      expect(aliceEvents.has('connected')).toBe(true)
      expect(aliceEvents.has('created')).toBe(true)
      expect(aliceEvents.has('held')).toBe(true)
      expect(aliceEvents.has('dropped')).toBe(true)
      expect(aliceEvents.has('edited')).toBe(true)

      const bobEvents = new Set((await bob.auditQuery({})).map((a) => a.event))
      expect(bobEvents.has('connected')).toBe(true)
      expect(bobEvents.has('delivered')).toBe(true)
    })
  })

  it('a human-injected send is audited as "injected" rather than "created"', async () => {
    await withCtx(async ({ makeEngine }) => {
      const alice = await makeEngine('alice')
      await alice.createChannel({ name: 'daily', alias: 'alice' }, 'agent:alice')
      await alice.send({ channel: 'daily', to: '*', payload: 'from a human' }, 'human')
      const events = (await alice.auditQuery({})).map((a) => a.event)
      expect(events).toContain('injected')
      expect(events).not.toContain('created')
    })
  })

  it('connect: expired invite -> INVITE_EXPIRED, exhausted invite -> INVITE_EXHAUSTED', async () => {
    await withCtx(async ({ makeEngine }) => {
      const alice = await makeEngine('alice')
      const bob = await makeEngine('bob')
      const carol = await makeEngine('carol')
      await alice.createChannel({ name: 'daily', alias: 'alice' }, 'agent:alice')

      const expiring = await alice.createInvite({ channel: 'daily', ttlMs: 5 }, 'agent:alice')
      await sleep(20)
      await expect(bob.connect({ link: expiring.link, alias: 'bob' }, 'agent:bob')).rejects.toSatisfy(
        (e: unknown) => isAgentCommError(e, 'INVITE_EXPIRED'),
      )

      const singleUse = await alice.createInvite({ channel: 'daily', maxUses: 1 }, 'agent:alice')
      await bob.connect({ link: singleUse.link, alias: 'bob' }, 'agent:bob')
      await expect(carol.connect({ link: singleUse.link, alias: 'carol' }, 'agent:carol')).rejects.toSatisfy(
        (e: unknown) => isAgentCommError(e, 'INVITE_EXHAUSTED'),
      )
    })
  })

  it('rejects local invitations that point outside this installation default hub', async () => {
    await withCtx(async ({ ws, makeEngine }) => {
      const bob = await makeEngine('bob')
      const otherHub = join(ws.rootDir, 'attacker-selected.db')
      const link = `agentcomm-local:?path=${encodeURIComponent(otherHub)}&t=tok_abc`
      await expect(bob.connect({ link, alias: 'bob' }, 'agent:bob')).rejects.toSatisfy((e: unknown) =>
        isAgentCommError(e, 'INVITE_INVALID'),
      )
    })
  })

  it('connect is idempotent: the same node reconnecting via the same link returns current state, no error', async () => {
    await withCtx(async ({ makeEngine }) => {
      const alice = await makeEngine('alice')
      const bob = await makeEngine('bob')
      await alice.createChannel({ name: 'daily', alias: 'alice' }, 'agent:alice')
      const { link } = await alice.createInvite({ channel: 'daily', maxUses: 1 }, 'agent:alice')

      const first = await bob.connect({ link, alias: 'bob' }, 'agent:bob')
      const second = await bob.connect({ link, alias: 'bob' }, 'agent:bob')
      expect(second.channel).toBe(first.channel)
      expect(second.myAlias).toBe('bob')
    })
  })

  it('send resolves the channel automatically only when exactly one is joined', async () => {
    await withCtx(async ({ makeEngine }) => {
      const alice = await makeEngine('alice')
      await expect(alice.send({ to: 'bob', payload: 'x' }, 'agent:alice')).rejects.toSatisfy((e: unknown) =>
        isAgentCommError(e, 'INVALID_INPUT'),
      )

      await alice.createChannel({ name: 'daily', alias: 'alice' }, 'agent:alice')
      const result = await alice.send({ to: '*', payload: 'x' }, 'agent:alice')
      expect(result.status).toBe('delivered')

      await alice.createChannel({ name: 'second', alias: 'alice2' }, 'agent:alice')
      await expect(alice.send({ to: 'bob', payload: 'x' }, 'agent:alice')).rejects.toSatisfy((e: unknown) =>
        isAgentCommError(e, 'INVALID_INPUT'),
      )
    })
  })

  it('sending on a channel the profile never joined raises NOT_MEMBER', async () => {
    await withCtx(async ({ makeEngine }) => {
      const alice = await makeEngine('alice')
      await expect(alice.send({ channel: 'nope', to: 'bob', payload: 'x' }, 'agent:alice')).rejects.toSatisfy(
        (e: unknown) => isAgentCommError(e, 'NOT_MEMBER'),
      )
    })
  })

  it('relay homes use the production driver by default and map connection failures to HOME_UNREACHABLE', async () => {
    await withCtx(async ({ makeEngine }) => {
      const alice = await makeEngine('alice')
      const e2eKey = Buffer.alloc(32, 7).toString('base64url')
      await expect(
        alice.connect({ link: `http://127.0.0.1:1/j/tok_abc#k=${e2eKey}`, alias: 'alice' }, 'agent:alice'),
      ).rejects.toSatisfy((e: unknown) => isAgentCommError(e, 'HOME_UNREACHABLE'))
    })
  })

  it('isolates an unreachable legacy channel from healthy background work', async () => {
    await withCtx(async ({ ws, makeEngine }) => {
      let staleOffline = false
      let healthyCardUpdates = 0
      const factory: TransportBindingFactory = async ({ home }) => {
        if (home !== 'nats://stale.example' && home !== 'nats://healthy.example') return undefined
        const local = await openLocalHome(
          join(ws.rootDir, home === 'nats://stale.example' ? 'stale.db' : 'healthy.db'),
        )
        const stale = home === 'nats://stale.example'
        return {
          ...local,
          kind: 'nats',
          home,
          async updateCard(input) {
            if (stale && staleOffline) throw new AgentCommError('HOME_UNREACHABLE', 'stale relay offline')
            if (!stale) healthyCardUpdates += 1
            await local.updateCard(input)
          },
          async pullAfter(channel, after, opts) {
            if (stale && staleOffline) throw new AgentCommError('HOME_UNREACHABLE', 'stale relay offline')
            return local.pullAfter(channel, after, opts)
          },
          async listHeld(channel) {
            if (stale && staleOffline) throw new AgentCommError('HOME_UNREACHABLE', 'stale relay offline')
            return local.listHeld(channel)
          },
        }
      }
      const alice = await makeEngine('alice', { transportBindingFactories: [factory] })
      await alice.createChannel(
        { name: 'stale', alias: 'alice', home: 'nats://stale.example' },
        'agent:alice',
      )
      await alice.createChannel(
        { name: 'healthy', alias: 'alice', home: 'nats://healthy.example' },
        'agent:alice',
      )
      staleOffline = true

      await expect(alice.publishCard({ name: 'alice' }, 'agent:alice')).resolves.toBeUndefined()
      expect(healthyCardUpdates).toBe(1)
      healthyCardUpdates = 0
      await expect(alice.publishCard({ name: 'alice' }, 'agent:alice', 'healthy')).resolves.toBeUndefined()
      expect(healthyCardUpdates).toBe(1)
      await expect(alice.publishCard({ name: 'alice' }, 'agent:alice', 'stale')).rejects.toSatisfy(
        (e: unknown) => isAgentCommError(e, 'HOME_UNREACHABLE'),
      )
      await expect(alice.readInbox({})).resolves.toEqual([])
      await expect(alice.readInbox({ filter: { channel: 'healthy' } })).resolves.toEqual([])
      await expect(alice.listHeld()).resolves.toEqual([])

      await expect(alice.syncOnce('stale')).rejects.toSatisfy((e: unknown) =>
        isAgentCommError(e, 'HOME_UNREACHABLE'),
      )
      await expect(alice.listHeld('stale')).rejects.toSatisfy((e: unknown) =>
        isAgentCommError(e, 'HOME_UNREACHABLE'),
      )
    })
  })

  it('routes a custom home through the transport factory registry without changing A2A/E2E delivery', async () => {
    await withCtx(async ({ ws, makeEngine }) => {
      const backingHub = join(ws.rootDir, 'nats-binding-test.db')
      const factory: TransportBindingFactory = async ({ home }) => {
        if (!home.startsWith('nats://')) return undefined
        const local = await openLocalHome(backingHub)
        return { ...local, kind: 'nats', home }
      }
      const deps = { transportBindingFactories: [factory] }
      const alice = await makeEngine('alice', deps)
      const bob = await makeEngine('bob', deps)

      await alice.createChannel(
        { name: 'portable', alias: 'alice', home: 'nats://broker.example:4222' },
        'agent:alice',
      )
      const { link } = await alice.createInvite({ channel: 'portable' }, 'agent:alice')
      expect(link).toMatch(/^agentcomm-transport:/)
      await bob.connect({ link, alias: 'bob' }, 'agent:bob')

      await alice.send(
        { channel: 'portable', to: 'bob', payload: { intent: 'portable delivery' } },
        'agent:alice',
      )
      const inbox = await bob.readInbox({})
      expect(inbox[0]?.payload).toEqual({ intent: 'portable delivery' })
    })
  })

  it('whoami reports nodeId/profile/memberships; identity persists across engine restarts on the same profile', async () => {
    await withCtx(async ({ ws, makeEngine }) => {
      const alice = await makeEngine('alice')
      await alice.createChannel({ name: 'daily', alias: 'alice' }, 'agent:alice')
      const who = await alice.whoami()
      expect(who.profile).toBe('alice')
      expect(who.memberships).toEqual([{ channel: 'daily', alias: 'alice', home: who.memberships[0]?.home }])

      const restarted = await createEngine(ws.profile('alice'))
      try {
        const who2 = await restarted.whoami()
        expect(who2.nodeId).toBe(who.nodeId)
        expect(who2.memberships).toHaveLength(1)
      } finally {
        await restarted.close()
      }
    })
  })
})
