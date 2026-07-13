import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openHubDb, openStore } from '../src/store/index.js'
import { createTmpWorkspace } from './helpers/tmp-profile.js'

describe('store/openStore (private store repos)', () => {
  const ws = createTmpWorkspace()
  afterEach(() => ws.cleanup())

  it('round-trips channels/peers/messages/inbox/audit through insert+get', () => {
    const store = openStore(join(ws.rootDir, 'a.db'))
    try {
      expect(store.channels.list()).toEqual([])

      store.channels.upsert({
        name: 'daily',
        home: 'local:/tmp/hub.db',
        mode: 'auto',
        myAlias: 'alice',
        scope: { canSendTo: ['bob', '*'] },
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      const ch = store.channels.get('daily')
      expect(ch?.myAlias).toBe('alice')
      expect(ch?.scope).toEqual({ canSendTo: ['bob', '*'] })
      expect(store.channels.count()).toBe(1)

      store.peers.upsert({
        channel: 'daily',
        alias: 'alice',
        nodeId: 'n-1',
        card: { name: 'alice-bot' },
        updatedAt: 'now',
      })
      expect(store.peers.list('daily')).toHaveLength(1)
      expect(store.peers.list('daily')[0]?.card).toEqual({ name: 'alice-bot' })

      const inserted = store.messages.insert({
        messageId: 'm-1',
        channel: 'daily',
        seq: 1,
        from: 'alice',
        to: 'bob',
        traceId: 'm-1',
        hop: 0,
        payload: { hello: 'world' },
        status: 'delivered',
        injectedByHuman: false,
        ts: '2026-01-01T00:00:00.000Z',
        deliveredAt: '2026-01-01T00:00:00.000Z',
      })
      expect(inserted).toBe(true)
      // 幂等:重复 insert 同 messageId 返回 false,且不覆盖原值
      const insertedAgain = store.messages.insert({
        messageId: 'm-1',
        channel: 'daily',
        seq: 1,
        from: 'alice',
        to: 'bob',
        traceId: 'm-1',
        hop: 0,
        payload: { hello: 'CHANGED' },
        status: 'held',
        injectedByHuman: false,
        ts: '2026-01-01T00:00:00.000Z',
      })
      expect(insertedAgain).toBe(false)
      expect(store.messages.get('m-1')?.payload).toEqual({ hello: 'world' })

      store.inbox.insert({ messageId: 'm-1', addedAt: '2026-01-01T00:00:01.000Z' })
      expect(store.inbox.count()).toBe(1)
      const joined = store.inbox.listJoined({})
      expect(joined).toHaveLength(1)
      expect(joined[0]?.payload).toEqual({ hello: 'world' })

      store.audit.append({
        ts: '2026-01-01T00:00:02.000Z',
        event: 'created',
        messageId: 'm-1',
        channel: 'daily',
        actor: 'agent:alice',
      })
      const auditRows = store.audit.query({})
      expect(auditRows).toHaveLength(1)
      expect(auditRows[0]?.event).toBe('created')
    } finally {
      store.close()
    }
  })

  it('inbox eviction helpers order by insertion and respect limit', () => {
    const store = openStore(join(ws.rootDir, 'b.db'))
    try {
      for (let i = 0; i < 3; i += 1) {
        store.messages.insert({
          messageId: `m-${i}`,
          channel: 'daily',
          from: 'alice',
          to: 'bob',
          traceId: `m-${i}`,
          hop: 0,
          payload: i,
          status: 'delivered',
          injectedByHuman: false,
          ts: '2026-01-01T00:00:00.000Z',
        })
        store.inbox.insert({ messageId: `m-${i}`, addedAt: '2026-01-01T00:00:00.000Z' })
      }
      store.inbox.markConsumed('m-0', '2026-01-01T00:00:05.000Z')
      expect(store.inbox.oldestConsumed(10).map((r) => r.messageId)).toEqual(['m-0'])
      expect(store.inbox.oldestUnconsumed(10).map((r) => r.messageId)).toEqual(['m-1', 'm-2'])
      expect(store.inbox.oldestUnconsumed(1).map((r) => r.messageId)).toEqual(['m-1'])
    } finally {
      store.close()
    }
  })

  it('sync_state defaults to 0 and upserts monotonically per write', () => {
    const store = openStore(join(ws.rootDir, 'c.db'))
    try {
      // sync_state.channel 有 FK REFERENCES channels(name),先建一行满足约束
      store.channels.upsert({
        name: 'daily',
        home: 'local:/tmp/hub.db',
        mode: 'auto',
        myAlias: 'alice',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      expect(store.syncState.get('daily')).toBe(0)
      expect(store.syncState.has('daily')).toBe(false)
      store.syncState.set('daily', 5)
      expect(store.syncState.get('daily')).toBe(5)
      expect(store.syncState.has('daily')).toBe(true)
      store.syncState.set('daily', 9)
      expect(store.syncState.get('daily')).toBe(9)
    } finally {
      store.close()
    }
  })
})

describe('store/openHubDb (shared local hub repos)', () => {
  const ws = createTmpWorkspace()
  afterEach(() => ws.cleanup())

  it('round-trips hub_channels/hub_members and assigns monotonic seq via nextSeq', () => {
    const hub = openHubDb(join(ws.rootDir, 'hub.db'))
    try {
      hub.channels.insert({ name: 'daily', mode: 'auto', createdAt: '2026-01-01T00:00:00.000Z' })
      expect(hub.channels.get('daily')?.mode).toBe('auto')

      hub.members.insert({
        channel: 'daily',
        alias: 'alice',
        nodeId: 'n-1',
        joinedAt: '2026-01-01T00:00:00.000Z',
      })
      expect(hub.members.list('daily')).toHaveLength(1)
      expect(hub.members.getByNode('daily', 'n-1')?.alias).toBe('alice')

      expect(hub.messages.nextSeq('daily')).toBe(1)
      hub.messages.insert({
        channel: 'daily',
        seq: 1,
        messageId: 'm-1',
        envelope: {
          messageId: 'm-1',
          from: 'alice',
          to: 'bob',
          channel: 'daily',
          traceId: 'm-1',
          hop: 0,
          payload: null,
          injectedByHuman: false,
          ts: '2026-01-01T00:00:00.000Z',
        },
        status: 'delivered',
        ts: '2026-01-01T00:00:00.000Z',
      })
      expect(hub.messages.nextSeq('daily')).toBe(2)
      expect(hub.messages.getByMessageId('daily', 'm-1')?.seq).toBe(1)
      expect(hub.messages.listFrom('daily', 0, 10)).toHaveLength(1)
      expect(hub.messages.listHeld('daily')).toHaveLength(0)
    } finally {
      hub.close()
    }
  })

  it('hub_cursors upsert keeps the max acked seq (monotonic)', () => {
    const hub = openHubDb(join(ws.rootDir, 'hub2.db'))
    try {
      expect(hub.cursors.get('daily', 'n-1')).toBe(0)
      hub.cursors.upsert('daily', 'n-1', 5, '2026-01-01T00:00:00.000Z')
      expect(hub.cursors.get('daily', 'n-1')).toBe(5)
      hub.cursors.upsert('daily', 'n-1', 2, '2026-01-01T00:00:01.000Z')
      // 不倒退
      expect(hub.cursors.get('daily', 'n-1')).toBe(5)
      hub.cursors.upsert('daily', 'n-1', 9, '2026-01-01T00:00:02.000Z')
      expect(hub.cursors.get('daily', 'n-1')).toBe(9)
    } finally {
      hub.close()
    }
  })

  it('withTx rolls back all writes on error', () => {
    const hub = openHubDb(join(ws.rootDir, 'hub3.db'))
    try {
      hub.channels.insert({ name: 'daily', mode: 'auto', createdAt: '2026-01-01T00:00:00.000Z' })
      expect(() =>
        hub.withTx(() => {
          hub.members.insert({ channel: 'daily', alias: 'alice', nodeId: 'n-1', joinedAt: 'now' })
          throw new Error('boom')
        }),
      ).toThrow('boom')
      expect(hub.members.list('daily')).toHaveLength(0)
    } finally {
      hub.close()
    }
  })
})
