import type { MessageEnvelope } from '@agent-comm/protocol'
import { isAgentCommError, newMessageId, nowIso } from '@agent-comm/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newE2eKey } from '../src/crypto/e2e.js'
import { createRelayDriver } from '../src/sync/relay-driver.js'
import { withE2e } from '../src/sync/with-e2e.js'
import { createFakeRelay, type FakeRelay } from './helpers/fake-relay.js'
import { generateTestIdentity } from './helpers/keys.js'

function makeEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    messageId: newMessageId(),
    from: 'alice',
    to: '*',
    channel: 'daily',
    traceId: 'trace-1',
    hop: 0,
    payload: { text: 'hello' },
    contentType: 'application/vnd.agentcomm.brief_update+json',
    injectedByHuman: false,
    ts: nowIso(),
    ...overrides,
  }
}

describe('sync/relay-driver: happy path + 错误映射', () => {
  let relay: FakeRelay
  const { identity, signRequest } = generateTestIdentity('n-alice')

  beforeEach(async () => {
    relay = await createFakeRelay([{ nodeId: identity.nodeId, publicKey: identity.publicKey }])
    relay.seedChannel('daily')
    relay.seedInvite('tok-daily', 'daily')
  })

  afterEach(async () => {
    await relay.close()
  })

  it('join → append → pullAfter → ackCursor 全链路 happy path,含 members/mintInvite/updateCard', async () => {
    const driver = createRelayDriver({ relayUrl: relay.url, identity, signRequest })

    const joined = await driver.join({
      channel: 'daily',
      joinToken: 'tok-daily',
      member: { alias: 'alice', nodeId: identity.nodeId, publicKey: identity.publicKey },
    })
    expect(joined.channel).toBe('daily')
    expect(joined.mode).toBe('auto')
    expect(joined.members.some((m) => m.alias === 'alice')).toBe(true)

    const env = makeEnvelope()
    const appended = await driver.append('daily', [env])
    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({ messageId: env.messageId, seq: 1, status: 'delivered' })

    const pulled = await driver.pullAfter('daily', 0)
    expect(pulled.head).toBe(1)
    expect(pulled.messages).toHaveLength(1)
    expect(pulled.messages[0]?.messageId).toBe(env.messageId)
    expect(pulled.messages[0]?.payload).toEqual({ text: 'hello' })

    await expect(driver.ackCursor('daily', identity.nodeId, 1)).resolves.toBeUndefined()

    const members = await driver.members('daily')
    expect(members.some((m) => m.alias === 'alice')).toBe(true)

    const invite = await driver.mintInvite({ channel: 'daily', byNode: identity.nodeId })
    expect(invite.joinToken.length).toBeGreaterThan(0)

    await expect(
      driver.updateCard({
        channel: 'daily',
        alias: 'alice',
        nodeId: identity.nodeId,
        card: { name: 'Alice' },
      }),
    ).resolves.toBeUndefined()

    await driver.close()
  })

  it('join 省略 member.publicKey 时回退到驱动自身身份公钥', async () => {
    const driver = createRelayDriver({ relayUrl: relay.url, identity, signRequest })
    const joined = await driver.join({
      channel: 'daily',
      joinToken: 'tok-daily',
      member: { alias: 'alice', nodeId: identity.nodeId },
    })
    expect(joined.members.some((m) => m.alias === 'alice')).toBe(true)
  })

  it('append 幂等:相同 messageId 重放返回 duplicate:true 且 seq 不变', async () => {
    const driver = createRelayDriver({ relayUrl: relay.url, identity, signRequest })
    await driver.join({
      channel: 'daily',
      joinToken: 'tok-daily',
      member: { alias: 'alice', nodeId: identity.nodeId, publicKey: identity.publicKey },
    })
    const env = makeEnvelope()
    const first = await driver.append('daily', [env])
    const second = await driver.append('daily', [env])
    expect(second[0]?.duplicate).toBe(true)
    expect(second[0]?.seq).toBe(first[0]?.seq)
  })

  it('append 超过 100 条自动分批(每批 ≤100),结果按顺序拼回', async () => {
    const driver = createRelayDriver({ relayUrl: relay.url, identity, signRequest })
    await driver.join({
      channel: 'daily',
      joinToken: 'tok-daily',
      member: { alias: 'alice', nodeId: identity.nodeId, publicKey: identity.publicKey },
    })
    const envs = Array.from({ length: 150 }, (_, i) => makeEnvelope({ traceId: `t-${i}` }))
    const results = await driver.append('daily', envs)
    expect(results).toHaveLength(150)
    expect(new Set(results.map((r) => r.messageId)).size).toBe(150)

    const postCount = relay.requestLog.filter(
      (r) => r.method === 'POST' && r.path.startsWith('/ch/daily/messages'),
    ).length
    expect(postCount).toBe(2)
  })

  it('WireError(RATE_LIMITED) 还原成 AgentCommError,retryAfterMs 进 detail', async () => {
    const driver = createRelayDriver({ relayUrl: relay.url, identity, signRequest })
    await driver.join({
      channel: 'daily',
      joinToken: 'tok-daily',
      member: { alias: 'alice', nodeId: identity.nodeId, publicKey: identity.publicKey },
    })
    relay.forceRateLimitOnce('daily', 2500)
    await expect(driver.append('daily', [makeEnvelope()])).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      detail: { retryAfterMs: 2500 },
    })
  })

  it('网络不可达(relay 已关闭)→ HOME_UNREACHABLE', async () => {
    const deadPort = relay.port
    await relay.close()
    const driver = createRelayDriver({ relayUrl: `http://127.0.0.1:${deadPort}`, identity, signRequest })
    await expect(driver.pullAfter('daily', 0)).rejects.toMatchObject({ code: 'HOME_UNREACHABLE' })
  })

  it('createChannel 走 POST /ch/:c/create bootstrap(D9 回填契约);重复创建→CHANNEL_EXISTS', async () => {
    const driver = createRelayDriver({ relayUrl: relay.url, identity, signRequest })
    await expect(
      driver.createChannel({ name: 'fresh', member: { alias: 'a', nodeId: identity.nodeId } }),
    ).resolves.toBeUndefined()
    // 创建者已是首个成员,可直接铸邀请(证明频道在 relay 侧真实存在)
    await expect(driver.mintInvite({ channel: 'fresh', byNode: identity.nodeId })).resolves.toMatchObject({
      joinToken: expect.any(String),
    })
    await expect(
      driver.createChannel({ name: 'fresh', member: { alias: 'b', nodeId: identity.nodeId } }),
    ).rejects.toMatchObject({ code: 'CHANNEL_EXISTS' })
  })

  it('listHeld/resolveHeld/setMode 在 v1 relay 家上一律 NOT_IMPLEMENTED(远程门在 M3)', async () => {
    const driver = createRelayDriver({ relayUrl: relay.url, identity, signRequest })
    await expect(driver.listHeld('daily')).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
    await expect(
      driver.resolveHeld({ channel: 'daily', messageId: 'm-x', resolution: 'deliver', actor: 'human' }),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
    await expect(driver.setMode('daily', 'paused')).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
  })

  it('leave 按本地语义处理:直接成功,不发起网络请求', async () => {
    const driver = createRelayDriver({ relayUrl: relay.url, identity, signRequest })
    const before = relay.requestLog.length
    await expect(
      driver.leave({ channel: 'daily', alias: 'alice', nodeId: identity.nodeId }),
    ).resolves.toBeUndefined()
    expect(relay.requestLog.length).toBe(before)
  })

  it('未签名/签名错误的请求会被 fake relay 拒绝(顺带验证驱动确实带了三个签名头)', async () => {
    const driver = createRelayDriver({ relayUrl: relay.url, identity, signRequest })
    await driver.join({
      channel: 'daily',
      joinToken: 'tok-daily',
      member: { alias: 'alice', nodeId: identity.nodeId, publicKey: identity.publicKey },
    })
    // 直接裸 fetch,不带签名头,证明 fake relay 确实在校验(而不是形同虚设)
    const res = await fetch(`${relay.url}/ch/daily/members`, { method: 'GET' })
    expect(res.status).toBe(401)
  })
})

describe('sync/relay-driver + withE2e', () => {
  let relay: FakeRelay
  const { identity, signRequest } = generateTestIdentity('n-bob')

  beforeEach(async () => {
    relay = await createFakeRelay([{ nodeId: identity.nodeId, publicKey: identity.publicKey }])
    relay.seedChannel('secret')
    relay.seedInvite('tok-secret', 'secret')
  })

  afterEach(async () => {
    await relay.close()
  })

  it('append 上行是 CipherPayload(不泄漏明文),pullAfter 用正确密钥还原明文', async () => {
    const rawDriver = createRelayDriver({ relayUrl: relay.url, identity, signRequest })
    await rawDriver.join({
      channel: 'secret',
      joinToken: 'tok-secret',
      member: { alias: 'bob', nodeId: identity.nodeId, publicKey: identity.publicKey },
    })

    const key = newE2eKey()
    const driver = withE2e(rawDriver, key)
    const env = makeEnvelope({ channel: 'secret', payload: { text: '机密简报' }, contentType: 'text/plain' })
    await driver.append('secret', [env])

    // 直接查 fake relay 内部存储:线上应是密文,contentType 应被省略
    const ch = relay.channels.get('secret')
    const stored = ch?.messages.find((m) => m.envelope.messageId === env.messageId)
    expect(stored?.envelope.contentType).toBeUndefined()
    expect(stored?.envelope.payload).toMatchObject({ enc: 'aes-256-gcm' })
    expect(JSON.stringify(stored?.envelope.payload)).not.toContain('机密简报')

    const pulled = await driver.pullAfter('secret', 0)
    expect(pulled.messages).toHaveLength(1)
    expect(pulled.messages[0]?.payload).toEqual({ text: '机密简报' })
    expect(pulled.messages[0]?.contentType).toBe('text/plain')
  })

  it('用错误密钥 pullAfter 时,CipherPayload 消息的 open 失败会向上抛 AUTH_FAILED', async () => {
    const rawDriver = createRelayDriver({ relayUrl: relay.url, identity, signRequest })
    await rawDriver.join({
      channel: 'secret',
      joinToken: 'tok-secret',
      member: { alias: 'bob', nodeId: identity.nodeId, publicKey: identity.publicKey },
    })

    const key = newE2eKey()
    const wrongKey = newE2eKey()
    const writer = withE2e(rawDriver, key)
    await writer.append('secret', [makeEnvelope({ channel: 'secret' })])

    const reader = withE2e(rawDriver, wrongKey)
    await expect(reader.pullAfter('secret', 0)).rejects.toMatchObject({ code: 'AUTH_FAILED' })
  })

  it('非 CipherPayload 形状的消息原样透传(混用同一 driver 时的兜底)', async () => {
    const rawDriver = createRelayDriver({ relayUrl: relay.url, identity, signRequest })
    await rawDriver.join({
      channel: 'secret',
      joinToken: 'tok-secret',
      member: { alias: 'bob', nodeId: identity.nodeId, publicKey: identity.publicKey },
    })
    // 不经 withE2e,直接上行明文
    await rawDriver.append('secret', [makeEnvelope({ channel: 'secret', payload: { plain: true } })])

    const key = newE2eKey()
    const reader = withE2e(rawDriver, key)
    const pulled = await reader.pullAfter('secret', 0)
    expect(pulled.messages[0]?.payload).toEqual({ plain: true })
  })
})

describe('isAgentCommError 辅助校验(健全性检查,避免误用协议导出)', () => {
  it('非 AgentCommError 的值返回 false', () => {
    expect(isAgentCommError(new Error('x'), 'HOME_UNREACHABLE')).toBe(false)
  })
})
