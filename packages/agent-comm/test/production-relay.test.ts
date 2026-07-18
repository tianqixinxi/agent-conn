import { describe, expect, it } from 'vitest'
import { createEngine } from '../src/engine/engine.js'
import { createFakeRelay } from './helpers/fake-relay.js'
import { createTmpWorkspace } from './helpers/tmp-profile.js'

describe('engine + production relay + E2E', () => {
  it('connects two profiles through a real HTTP driver and keeps relay payloads encrypted', async () => {
    const ws = createTmpWorkspace()
    const alice = await createEngine(ws.profile('alice'))
    const bob = await createEngine(ws.profile('bob'))
    const aliceIdentity = await alice.identity()
    const bobIdentity = await bob.identity()
    const relay = await createFakeRelay([
      { nodeId: aliceIdentity.nodeId, publicKey: aliceIdentity.publicKey },
      { nodeId: bobIdentity.nodeId, publicKey: bobIdentity.publicKey },
    ])

    try {
      await alice.createChannel({ name: 'claude-duet', alias: 'alice', home: relay.url }, 'agent:alice')
      const { link } = await alice.createInvite({ channel: 'claude-duet', maxUses: 1 }, 'agent:alice')

      expect(link).toMatch(new RegExp(`^${relay.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/j/`))
      expect(new URL(link).hash).toMatch(/^#k=.+/)

      await bob.connect({ link, alias: 'bob' }, 'agent:bob')
      await alice.send(
        {
          channel: 'claude-duet',
          to: 'bob',
          payload: { intent: 'review', secret: 'plaintext-must-not-reach-relay' },
          contentType: 'application/vnd.agentcomm.intent+json',
        },
        'agent:alice',
      )

      const stored = relay.channels.get('claude-duet')?.messages[0]?.envelope
      expect(stored?.payload).toMatchObject({ enc: 'aes-256-gcm' })
      expect(stored?.contentType).toBeUndefined()
      expect(JSON.stringify(stored?.payload)).not.toContain('plaintext-must-not-reach-relay')

      const inbox = await bob.readInbox({ consume: true })
      expect(inbox).toHaveLength(1)
      expect(inbox[0]).toMatchObject({
        from: 'alice',
        to: 'bob',
        channel: 'claude-duet',
        payload: { intent: 'review', secret: 'plaintext-must-not-reach-relay' },
        contentType: 'application/vnd.agentcomm.intent+json',
      })
    } finally {
      await Promise.all([alice.close(), bob.close(), relay.close()])
      ws.cleanup()
    }
  })

  it('keeps public channels plaintext and marks their invitation explicitly public', async () => {
    const ws = createTmpWorkspace()
    const alice = await createEngine(ws.profile('public-alice'))
    const bob = await createEngine(ws.profile('public-bob'))
    const aliceIdentity = await alice.identity()
    const bobIdentity = await bob.identity()
    const relay = await createFakeRelay([
      { nodeId: aliceIdentity.nodeId, publicKey: aliceIdentity.publicKey },
      { nodeId: bobIdentity.nodeId, publicKey: bobIdentity.publicKey },
    ])

    try {
      await alice.createChannel(
        { name: 'open-lab', alias: 'alice', home: relay.url, visibility: 'public' },
        'agent:alice',
      )
      // Public pages are stable join targets; no owner-minted bearer invite is required.
      const publicPage = `${relay.url}/public/open-lab`
      await bob.connect({ link: publicPage, alias: 'bob' }, 'agent:bob')
      await alice.send(
        { channel: 'open-lab', to: '*', payload: { text: 'public update' }, contentType: 'application/json' },
        'agent:alice',
      )

      const stored = relay.channels.get('open-lab')?.messages[0]?.envelope
      expect(stored?.payload).toEqual({ text: 'public update' })
      expect(stored?.contentType).toBe('application/json')
      await expect(bob.readInbox({ consume: true })).resolves.toMatchObject([
        { channel: 'open-lab', payload: { text: 'public update' } },
      ])
    } finally {
      await Promise.all([alice.close(), bob.close(), relay.close()])
      ws.cleanup()
    }
  })
})
