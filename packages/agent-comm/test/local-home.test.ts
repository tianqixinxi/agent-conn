import { join } from 'node:path'
import type { MessageEnvelope } from '@agent-comm/protocol'
import { isAgentCommError, newJoinToken, newMessageId } from '@agent-comm/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { openLocalHome } from '../src/engine/local-home.js'
import { createTmpWorkspace, sleep } from './helpers/tmp-profile.js'

function envelope(over: Partial<MessageEnvelope> & { from: string; to: string }): MessageEnvelope {
  const messageId = over.messageId ?? newMessageId()
  return {
    messageId,
    channel: 'daily',
    traceId: messageId,
    hop: 0,
    payload: { text: 'hi' },
    injectedByHuman: false,
    ts: new Date().toISOString(),
    ...over,
  }
}

describe('engine/local-home (HomeDriver over shared hub file)', () => {
  const ws = createTmpWorkspace()
  afterEach(() => ws.cleanup())

  it('createChannel is the authoritative record and rejects duplicates with CHANNEL_EXISTS', async () => {
    const home = await openLocalHome(join(ws.rootDir, 'hub.db'))
    try {
      await home.createChannel({ name: 'daily', member: { alias: 'alice', nodeId: 'n-alice' } })
      await expect(
        home.createChannel({ name: 'daily', member: { alias: 'bob', nodeId: 'n-bob' } }),
      ).rejects.toSatisfy((e: unknown) => isAgentCommError(e, 'CHANNEL_EXISTS'))
    } finally {
      await home.close()
    }
  })

  it('append assigns monotonic seq starting at 1, and is idempotent by messageId', async () => {
    const home = await openLocalHome(join(ws.rootDir, 'hub2.db'))
    try {
      await home.createChannel({ name: 'daily', member: { alias: 'alice', nodeId: 'n-alice' } })
      const env = envelope({ from: 'alice', to: 'bob' })
      const [first] = await home.append('daily', [env])
      expect(first).toEqual({ messageId: env.messageId, seq: 1, status: 'delivered', duplicate: false })

      const env2 = envelope({ from: 'alice', to: 'bob' })
      const [second] = await home.append('daily', [env2])
      expect(second?.seq).toBe(2)

      // 重放同一 messageId → 幂等,返回既有 seq,不产生新行
      const [replay] = await home.append('daily', [env])
      expect(replay).toEqual({ messageId: env.messageId, seq: 1, status: 'delivered', duplicate: true })

      const { messages, head } = await home.pullAfter('daily', 0)
      expect(messages).toHaveLength(2)
      expect(head).toBe(2)
    } finally {
      await home.close()
    }
  })

  it('intercept mode holds messages; paused mode rejects new sends with RATE_LIMITED', async () => {
    const home = await openLocalHome(join(ws.rootDir, 'hub3.db'))
    try {
      await home.createChannel({
        name: 'daily',
        mode: 'intercept',
        member: { alias: 'alice', nodeId: 'n-alice' },
      })
      const [held] = await home.append('daily', [envelope({ from: 'alice', to: 'bob' })])
      expect(held?.status).toBe('held')

      await home.setMode('daily', 'paused')
      await expect(home.append('daily', [envelope({ from: 'alice', to: 'bob' })])).rejects.toSatisfy(
        (e: unknown) => isAgentCommError(e, 'RATE_LIMITED'),
      )
    } finally {
      await home.close()
    }
  })

  it('pullAfter treats held as a barrier: later delivered messages are withheld until resolved', async () => {
    const home = await openLocalHome(join(ws.rootDir, 'hub4.db'))
    try {
      await home.createChannel({ name: 'daily', member: { alias: 'alice', nodeId: 'n-alice' } })
      await home.append('daily', [envelope({ from: 'alice', to: 'bob' })]) // seq 1, delivered
      await home.setMode('daily', 'intercept')
      const [heldMsg] = await home.append('daily', [envelope({ from: 'alice', to: 'bob' })]) // seq 2, held
      await home.setMode('daily', 'auto')
      await home.append('daily', [envelope({ from: 'alice', to: 'bob' })]) // seq 3, delivered

      const firstPull = await home.pullAfter('daily', 0)
      // seq1 放出;seq2 held 挡住后面,所以 seq3 这次不放出,head 停在 1
      expect(firstPull.messages.map((m) => m.seq)).toEqual([1])
      expect(firstPull.head).toBe(1)

      if (!heldMsg) throw new Error('expected held message result')
      await home.resolveHeld({
        channel: 'daily',
        messageId: heldMsg.messageId,
        resolution: 'deliver',
        actor: 'human',
      })

      const secondPull = await home.pullAfter('daily', firstPull.head)
      expect(secondPull.messages.map((m) => m.seq)).toEqual([2, 3])
      expect(secondPull.head).toBe(3)
    } finally {
      await home.close()
    }
  })

  it('pullAfter skips dropped messages from output but still advances the cursor past them', async () => {
    const home = await openLocalHome(join(ws.rootDir, 'hub5.db'))
    try {
      await home.createChannel({
        name: 'daily',
        mode: 'intercept',
        member: { alias: 'alice', nodeId: 'n-alice' },
      })
      const [held] = await home.append('daily', [envelope({ from: 'alice', to: 'bob' })])
      if (!held) throw new Error('expected held result')
      await home.resolveHeld({
        channel: 'daily',
        messageId: held.messageId,
        resolution: 'drop',
        actor: 'human',
      })

      const { messages, head } = await home.pullAfter('daily', 0)
      expect(messages).toHaveLength(0)
      expect(head).toBe(1)
    } finally {
      await home.close()
    }
  })

  it('resolveHeld with editedPayload replaces payload/contentType and only that', async () => {
    const home = await openLocalHome(join(ws.rootDir, 'hub6.db'))
    try {
      await home.createChannel({
        name: 'daily',
        mode: 'intercept',
        member: { alias: 'alice', nodeId: 'n-alice' },
      })
      const original = envelope({
        from: 'alice',
        to: 'bob',
        payload: { text: 'original' },
        contentType: 'text/plain',
      })
      const [held] = await home.append('daily', [original])
      if (!held) throw new Error('expected held result')

      await home.resolveHeld({
        channel: 'daily',
        messageId: held.messageId,
        resolution: 'deliver',
        actor: 'human',
        editedPayload: { text: 'edited' },
      })

      const [msg] = (await home.pullAfter('daily', 0)).messages
      expect(msg?.payload).toEqual({ text: 'edited' })
      expect(msg?.contentType).toBe('text/plain') // 未传 editedContentType,原值保留
      expect(msg?.status).toBe('delivered')
    } finally {
      await home.close()
    }
  })

  it('resolveHeld rejects a message that is not currently held with NOT_HELD', async () => {
    const home = await openLocalHome(join(ws.rootDir, 'hub7.db'))
    try {
      await home.createChannel({ name: 'daily', member: { alias: 'alice', nodeId: 'n-alice' } })
      const [sent] = await home.append('daily', [envelope({ from: 'alice', to: 'bob' })])
      if (!sent) throw new Error('expected sent result')
      await expect(
        home.resolveHeld({
          channel: 'daily',
          messageId: sent.messageId,
          resolution: 'deliver',
          actor: 'human',
        }),
      ).rejects.toSatisfy((e: unknown) => isAgentCommError(e, 'NOT_HELD'))
      await expect(
        home.resolveHeld({
          channel: 'daily',
          messageId: 'm-does-not-exist',
          resolution: 'deliver',
          actor: 'human',
        }),
      ).rejects.toSatisfy((e: unknown) => isAgentCommError(e, 'MESSAGE_NOT_FOUND'))
    } finally {
      await home.close()
    }
  })

  it('mintInvite + join: fresh join succeeds, wrong token INVITE_INVALID, alias conflict ALIAS_TAKEN', async () => {
    const home = await openLocalHome(join(ws.rootDir, 'hub8.db'))
    try {
      await home.createChannel({ name: 'daily', member: { alias: 'alice', nodeId: 'n-alice' } })
      const { joinToken } = await home.mintInvite({ channel: 'daily', byNode: 'n-alice', maxUses: 2 })

      const result = await home.join({
        channel: 'daily',
        joinToken,
        member: { alias: 'bob', nodeId: 'n-bob' },
      })
      expect(result.channel).toBe('daily')
      expect(result.members.map((m) => m.alias).sort()).toEqual(['alice', 'bob'])

      await expect(
        home.join({
          channel: 'daily',
          joinToken: newJoinToken(),
          member: { alias: 'carol', nodeId: 'n-carol' },
        }),
      ).rejects.toSatisfy((e: unknown) => isAgentCommError(e, 'INVITE_INVALID'))

      await expect(
        home.join({ channel: 'daily', joinToken, member: { alias: 'bob', nodeId: 'n-carol-different' } }),
      ).rejects.toSatisfy((e: unknown) => isAgentCommError(e, 'ALIAS_TAKEN'))
    } finally {
      await home.close()
    }
  })

  it('join is idempotent for the same node id re-redeeming, without consuming another use', async () => {
    const home = await openLocalHome(join(ws.rootDir, 'hub9.db'))
    try {
      await home.createChannel({ name: 'daily', member: { alias: 'alice', nodeId: 'n-alice' } })
      const { joinToken } = await home.mintInvite({ channel: 'daily', byNode: 'n-alice', maxUses: 1 })

      const first = await home.join({
        channel: 'daily',
        joinToken,
        member: { alias: 'bob', nodeId: 'n-bob' },
      })
      expect(first.members).toHaveLength(2)

      // 同一 node 重复兑换同一(已用尽 maxUses=1 的)邀请 → 幂等返回现状,不报错
      const second = await home.join({
        channel: 'daily',
        joinToken,
        member: { alias: 'bob', nodeId: 'n-bob' },
      })
      expect(second.channel).toBe('daily')
      expect(second.members).toHaveLength(2)
    } finally {
      await home.close()
    }
  })

  it('join rejects an expired invite with INVITE_EXPIRED', async () => {
    const home = await openLocalHome(join(ws.rootDir, 'hub10.db'))
    try {
      await home.createChannel({ name: 'daily', member: { alias: 'alice', nodeId: 'n-alice' } })
      const { joinToken } = await home.mintInvite({ channel: 'daily', byNode: 'n-alice', ttlMs: 5 })
      await sleep(20)
      await expect(
        home.join({ channel: 'daily', joinToken, member: { alias: 'bob', nodeId: 'n-bob' } }),
      ).rejects.toSatisfy((e: unknown) => isAgentCommError(e, 'INVITE_EXPIRED'))
    } finally {
      await home.close()
    }
  })

  it('join rejects an exhausted invite with INVITE_EXHAUSTED once maxUses is reached by other nodes', async () => {
    const home = await openLocalHome(join(ws.rootDir, 'hub11.db'))
    try {
      await home.createChannel({ name: 'daily', member: { alias: 'alice', nodeId: 'n-alice' } })
      const { joinToken } = await home.mintInvite({ channel: 'daily', byNode: 'n-alice', maxUses: 1 })
      await home.join({ channel: 'daily', joinToken, member: { alias: 'bob', nodeId: 'n-bob' } })
      await expect(
        home.join({ channel: 'daily', joinToken, member: { alias: 'carol', nodeId: 'n-carol' } }),
      ).rejects.toSatisfy((e: unknown) => isAgentCommError(e, 'INVITE_EXHAUSTED'))
    } finally {
      await home.close()
    }
  })

  it('listHeld returns only held messages for the channel', async () => {
    const home = await openLocalHome(join(ws.rootDir, 'hub12.db'))
    try {
      await home.createChannel({
        name: 'daily',
        mode: 'intercept',
        member: { alias: 'alice', nodeId: 'n-alice' },
      })
      await home.append('daily', [envelope({ from: 'alice', to: 'bob' })])
      await home.append('daily', [envelope({ from: 'alice', to: 'bob' })])
      const held = await home.listHeld('daily')
      expect(held).toHaveLength(2)
      expect(held.every((m) => m.status === 'held')).toBe(true)
    } finally {
      await home.close()
    }
  })
})
