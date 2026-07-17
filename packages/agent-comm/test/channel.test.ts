import type { Message } from '@agent-comm/protocol'
import {
  A2A_MEDIA_TYPE,
  A2ARole,
  A2ATaskState,
  createA2AStatusUpdate,
  encodeA2AEvent,
  nowIso,
  tryDecodeA2AEvent,
} from '@agent-comm/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { NotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import {
  type ChannelNotification,
  createChannelBridge,
  DEFAULT_CHANNEL_RELAY_URL,
  resolveChannelRelayUrl,
  shouldRehomeDevelopmentChannel,
} from '../src/mcp/channel.js'
import { FakeEngine, makeHeldMessage } from './fake-engine.js'

function message(overrides: Partial<Message> = {}): Message {
  return {
    messageId: 'm-channel-1',
    from: 'alice',
    to: 'bob',
    channel: 'duet',
    traceId: 'trace-channel-1',
    hop: 0,
    payload: { intent: 'review the change' },
    contentType: 'application/vnd.agentcomm.intent+json',
    injectedByHuman: false,
    ts: nowIso(),
    status: 'delivered',
    ...overrides,
  }
}

function firstText(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    throw new Error('expected a CallToolResult-like object')
  }
  const content = (result as { content: unknown }).content
  if (!Array.isArray(content)) throw new Error('expected content array')
  const first = content[0] as { type?: unknown; text?: unknown } | undefined
  if (first?.type !== 'text' || typeof first.text !== 'string') throw new Error('expected text block')
  return first.text
}

async function connectBridge(engine: FakeEngine, notifications: ChannelNotification[] = []) {
  const bridge = createChannelBridge(engine, {
    notify: async (notification) => void notifications.push(notification),
    stderr: () => {},
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'channel-test', version: '0.0.0' }, { capabilities: {} })
  await Promise.all([bridge.server.connect(serverTransport), client.connect(clientTransport)])
  return { bridge, client, notifications }
}

async function activate(client: Client, channel = 'duet'): Promise<void> {
  const result = await client.callTool({
    name: 'agent_comm',
    arguments: { operation: 'activate', channel },
  })
  if (result.isError) throw new Error(`failed to activate ${channel}: ${firstText(result)}`)
}

const channelNotificationSchema = NotificationSchema.extend({
  method: z.literal('notifications/claude/channel'),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.string()),
  }),
})

describe('Claude Code channel bridge', () => {
  it('defaults marketplace channels to the official relay while allowing self-hosted overrides', () => {
    expect(resolveChannelRelayUrl({})).toBe(DEFAULT_CHANNEL_RELAY_URL)
    expect(resolveChannelRelayUrl({ AGENT_COMM_RELAY_URL: 'https://relay.example' })).toBe(
      'https://relay.example',
    )
  })

  it('migrates only legacy development homes to the official relay', () => {
    expect(shouldRehomeDevelopmentChannel('http://127.0.0.1:8787', DEFAULT_CHANNEL_RELAY_URL)).toBe(true)
    expect(shouldRehomeDevelopmentChannel('http://localhost:8787', DEFAULT_CHANNEL_RELAY_URL)).toBe(true)
    expect(shouldRehomeDevelopmentChannel('local:/tmp/agent-comm.db', DEFAULT_CHANNEL_RELAY_URL)).toBe(true)
    expect(shouldRehomeDevelopmentChannel('https://self-hosted.example', DEFAULT_CHANNEL_RELAY_URL)).toBe(
      false,
    )
  })

  it('exposes one intent-level tool instead of the legacy fine-grained tool surface', async () => {
    const { client } = await connectBridge(new FakeEngine())
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(['agent_comm'])
  })

  it('keeps durable memberships dormant until this runtime explicitly activates one channel', async () => {
    const engine = new FakeEngine({
      profileName: 'bob',
      memberships: [
        { channel: 'old', alias: 'bob', home: 'http://127.0.0.1:8787' },
        { channel: 'duet', alias: 'bob', home: 'https://relay.example' },
      ],
      inbox: [
        message({ messageId: 'm-old', channel: 'old' }),
        message({ messageId: 'm-duet', channel: 'duet' }),
      ],
      held: [
        makeHeldMessage({ messageId: 'h-old', channel: 'old' }),
        makeHeldMessage({ messageId: 'h-duet', channel: 'duet' }),
      ],
    })
    const { bridge, client, notifications } = await connectBridge(engine)

    await bridge.pollOnce()
    expect(notifications).toEqual([])
    expect(engine.calls.some((call) => call.method === 'readInbox')).toBe(false)
    expect(engine.calls.some((call) => call.method === 'listHeld')).toBe(false)

    await activate(client, 'duet')
    const published = engine.calls.find((call) => call.method === 'publishCard')
    expect(published?.args[1]).toBe('duet')
    expect(
      (published?.args[0] as { supportedInterfaces?: unknown[] } | undefined)?.supportedInterfaces,
    ).toHaveLength(1)

    engine.calls.length = 0
    await bridge.pollOnce()
    expect(notifications.map((item) => item.meta.channel)).toEqual(['duet', 'duet'])
    expect(engine.calls.find((call) => call.method === 'readInbox')?.args[0]).toMatchObject({
      filter: { channel: 'duet' },
    })
    expect(engine.calls.find((call) => call.method === 'listHeld')?.args[0]).toBe('duet')

    const afterRestart: ChannelNotification[] = []
    const restartedBridge = createChannelBridge(engine, {
      notify: async (notification) => void afterRestart.push(notification),
      stderr: () => {},
    })
    engine.calls.length = 0
    await restartedBridge.pollOnce()
    expect(afterRestart).toEqual([])
    expect(engine.calls.some((call) => call.method === 'readInbox')).toBe(false)
    expect(engine.calls.some((call) => call.method === 'listHeld')).toBe(false)
  })

  it('delegates only through a channel activated by the current runtime', async () => {
    const engine = new FakeEngine({
      memberships: [
        { channel: 'old', alias: 'bob', home: 'local:/old.db' },
        { channel: 'duet', alias: 'bob', home: 'local:/duet.db' },
      ],
    })
    const { client } = await connectBridge(engine)
    await activate(client, 'duet')

    const inactive = await client.callTool({
      name: 'agent_comm',
      arguments: { operation: 'delegate', channel: 'old', to: 'alice', intent: 'do work' },
    })
    expect(inactive.isError).toBe(true)
    expect(JSON.parse(firstText(inactive))).toMatchObject({ code: 'INVALID_INPUT' })
    expect(engine.calls.some((call) => call.method === 'send')).toBe(false)

    const active = await client.callTool({
      name: 'agent_comm',
      arguments: { operation: 'delegate', to: 'alice', intent: 'do work' },
    })
    expect(active.isError).toBeFalsy()
    expect(engine.calls.find((call) => call.method === 'send')?.args[0]).toMatchObject({
      channel: 'duet',
    })
  })

  it('advertises the Channel capability and emits the real MCP notification method', async () => {
    const inbound = message()
    const bridge = createChannelBridge(
      new FakeEngine({
        inbox: [inbound],
        memberships: [{ channel: 'duet', alias: 'bob', home: 'local:/duet.db' }],
      }),
      { stderr: () => {} },
    )
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'channel-host-test', version: '0.0.0' }, { capabilities: {} })
    const notifications: ChannelNotification[] = []
    client.setNotificationHandler(channelNotificationSchema, async (notification) => {
      notifications.push(notification.params)
    })

    await Promise.all([bridge.server.connect(serverTransport), client.connect(clientTransport)])
    await activate(client)
    await bridge.pollOnce()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(client.getServerCapabilities()?.experimental).toMatchObject({ 'claude/channel': {} })
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.meta).toMatchObject({
      event_type: 'message',
      event_id: inbound.messageId,
    })
  })

  it('pushes an inbound message but keeps it unconsumed until Claude reports completion', async () => {
    const inbound = message()
    const engine = new FakeEngine({
      inbox: [inbound],
      memberships: [{ channel: 'duet', alias: 'bob', home: 'local:/duet.db' }],
    })
    const { bridge, client, notifications } = await connectBridge(engine)

    await activate(client)
    await bridge.pollOnce()

    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.meta).toMatchObject({
      event_type: 'message',
      event_id: inbound.messageId,
      from: 'alice',
      channel: 'duet',
    })
    expect(engine.calls.find((call) => call.method === 'readInbox')?.args[0]).toEqual({
      consume: false,
      limit: 1000,
      filter: { channel: 'duet' },
    })
    expect(engine.calls.some((call) => call.method === 'ack')).toBe(false)
  })

  it('leaves an inbound message unconsumed when delivery into Claude Code fails', async () => {
    const engine = new FakeEngine({
      inbox: [message()],
      memberships: [{ channel: 'duet', alias: 'bob', home: 'local:/duet.db' }],
    })
    const stderr: string[] = []
    const bridge = createChannelBridge(engine, {
      notify: async () => {
        throw new Error('host unavailable')
      },
      stderr: (chunk) => void stderr.push(chunk),
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'channel-test', version: '0.0.0' }, { capabilities: {} })
    await Promise.all([bridge.server.connect(serverTransport), client.connect(clientTransport)])

    await activate(client)
    await bridge.pollOnce()

    expect(engine.calls.some((call) => call.method === 'ack')).toBe(false)
    expect(stderr.join('')).toContain('host unavailable')
  })

  it('routes a reply to the event sender without exposing channel plumbing to Claude', async () => {
    const inbound = message({ from: 'alice', to: 'bob', channel: 'duet', traceId: 'trace-42' })
    const engine = new FakeEngine({
      inbox: [inbound],
      memberships: [{ channel: 'duet', alias: 'bob', home: 'local:/duet.db' }],
    })
    const { bridge, client } = await connectBridge(engine)
    await activate(client)
    await bridge.pollOnce()

    const result = await client.callTool({
      name: 'agent_comm',
      arguments: { operation: 'reply', eventId: inbound.messageId, response: { result: 'done' } },
    })

    expect(result.isError).toBeFalsy()
    expect(JSON.parse(firstText(result))).toMatchObject({
      response: { status: 'delivered' },
      completion: { status: 'delivered' },
    })
    const sends = engine.calls.filter((call) => call.method === 'send')
    expect(sends).toHaveLength(2)
    const send = sends[0]
    expect(send?.actor).toBe('agent:bob')
    expect(send?.args[0]).toMatchObject({
      channel: 'duet',
      to: 'alice',
      contentType: A2A_MEDIA_TYPE,
      replyTo: inbound.messageId,
      traceId: 'trace-42',
    })
    const sendInput = send?.args[0] as { payload: unknown } | undefined
    const responseEvent = tryDecodeA2AEvent(sendInput?.payload)
    expect(responseEvent?.kind).toBe('message')
    if (responseEvent?.kind !== 'message') throw new Error('expected A2A message')
    expect(responseEvent.value.role).toBe(A2ARole.ROLE_AGENT)
    expect(engine.calls.find((call) => call.method === 'ack')?.args[0]).toEqual({
      messageId: inbound.messageId,
    })
  })

  it('ACKs a no-reply event only after the complete operation', async () => {
    const inbound = message()
    const engine = new FakeEngine({
      inbox: [inbound],
      memberships: [{ channel: 'duet', alias: 'bob', home: 'local:/duet.db' }],
    })
    const { bridge, client } = await connectBridge(engine)
    await activate(client)
    await bridge.pollOnce()

    const result = await client.callTool({
      name: 'agent_comm',
      arguments: { operation: 'complete', eventId: inbound.messageId },
    })

    expect(result.isError).toBeFalsy()
    expect(engine.calls.find((call) => call.method === 'ack')?.args[0]).toEqual({
      messageId: inbound.messageId,
    })
  })

  it('shares a browser-ready one-use invite through one high-level operation', async () => {
    const engine = new FakeEngine({ profileName: 'alice' })
    engine.createInvite = async (input, actor) => {
      engine.calls.push({ method: 'createInvite', args: [input], actor })
      return { link: 'https://relay.example/j/token#k=secret' }
    }
    const bridge = createChannelBridge(engine, {
      defaultHome: 'https://relay.example',
      notify: async () => {},
      stderr: () => {},
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'channel-test', version: '0.0.0' }, { capabilities: {} })
    await Promise.all([bridge.server.connect(serverTransport), client.connect(clientTransport)])

    const result = await client.callTool({
      name: 'agent_comm',
      arguments: { operation: 'share', channel: 'duet' },
    })

    expect(JSON.parse(firstText(result))).toMatchObject({
      channel: 'duet',
      browserReady: true,
      link: 'https://relay.example/j/token#k=secret',
    })
    expect(engine.calls.find((call) => call.method === 'createChannel')?.args[0]).toMatchObject({
      name: 'duet',
      alias: 'alice',
      mode: 'auto',
      home: 'https://relay.example',
    })
    expect(engine.calls.find((call) => call.method === 'createInvite')?.args[0]).toEqual({
      channel: 'duet',
      maxUses: 1,
    })
    expect(engine.calls.find((call) => call.method === 'publishCard')?.args[1]).toBe('duet')
  })

  it('activates only the channel returned by a successful invitation connect', async () => {
    const inbound = message({ messageId: 'm-connected', channel: 'fake-channel' })
    const engine = new FakeEngine({ profileName: 'bob', inbox: [inbound] })
    const { bridge, client, notifications } = await connectBridge(engine)

    const result = await client.callTool({
      name: 'agent_comm',
      arguments: { operation: 'connect', link: 'https://relay.example/j/token', alias: 'bob' },
    })
    expect(result.isError).toBeFalsy()
    expect(engine.calls.find((call) => call.method === 'publishCard')?.args[1]).toBe('fake-channel')

    await bridge.pollOnce()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.meta).toMatchObject({
      event_id: 'm-connected',
      channel: 'fake-channel',
    })
  })

  it('re-homes a stale localhost channel before creating its invite', async () => {
    const engine = new FakeEngine({
      profileName: 'alice',
      channels: [
        {
          name: 'claude-duet-0716',
          home: 'http://127.0.0.1:8787',
          mode: 'auto',
          visibility: 'private',
          createdAt: nowIso(),
        },
      ],
      memberships: [{ channel: 'claude-duet-0716', alias: 'alice', home: 'http://127.0.0.1:8787' }],
    })
    engine.createInvite = async (input, actor) => {
      engine.calls.push({ method: 'createInvite', args: [input], actor })
      return { link: `${DEFAULT_CHANNEL_RELAY_URL}/j/token#k=secret` }
    }
    const bridge = createChannelBridge(engine, {
      defaultHome: DEFAULT_CHANNEL_RELAY_URL,
      notify: async () => {},
      stderr: () => {},
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'channel-test', version: '0.0.0' }, { capabilities: {} })
    await Promise.all([bridge.server.connect(serverTransport), client.connect(clientTransport)])

    const result = await client.callTool({
      name: 'agent_comm',
      arguments: { operation: 'share', channel: 'claude-duet-0716', alias: 'alice' },
    })

    expect(result.isError).toBeFalsy()
    expect(engine.calls.find((call) => call.method === 'createChannel')?.args[0]).toMatchObject({
      name: 'claude-duet-0716',
      alias: 'alice',
      home: DEFAULT_CHANNEL_RELAY_URL,
    })
  })

  it('notifies only for held approvals and applies an explicit decision with the human actor', async () => {
    const held = makeHeldMessage({ messageId: 'm-held-1', channel: 'duet', from: 'alice', to: 'bob' })
    const engine = new FakeEngine({
      held: [held],
      memberships: [{ channel: 'duet', alias: 'bob', home: 'local:/duet.db' }],
    })
    const { bridge, client, notifications } = await connectBridge(engine)

    await activate(client)
    await bridge.pollOnce()
    await bridge.pollOnce()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.meta.event_type).toBe('approval_required')

    const result = await client.callTool({
      name: 'agent_comm',
      arguments: { operation: 'resolve_approval', messageId: held.message.messageId, decision: 'approve' },
    })
    expect(result.isError).toBeFalsy()
    const deliver = engine.calls.find((call) => call.method === 'deliverHeld')
    expect(deliver?.actor).toBe('human')
    expect(deliver?.args[0]).toEqual({ messageId: held.message.messageId, channel: 'duet' })
  })

  it('classifies A2A interrupted task updates so only authorization requires user governance', async () => {
    const inputRequired = createA2AStatusUpdate({
      taskId: 'task-input',
      contextId: 'ctx-input',
      state: A2ATaskState.TASK_STATE_INPUT_REQUIRED,
    })
    const authRequired = createA2AStatusUpdate({
      taskId: 'task-auth',
      contextId: 'ctx-auth',
      state: A2ATaskState.TASK_STATE_AUTH_REQUIRED,
    })
    const engine = new FakeEngine({
      memberships: [{ channel: 'duet', alias: 'bob', home: 'local:/duet.db' }],
      inbox: [
        message({
          messageId: 'm-input',
          contentType: A2A_MEDIA_TYPE,
          payload: encodeA2AEvent({ kind: 'status-update', value: inputRequired }),
        }),
        message({
          messageId: 'm-auth',
          contentType: A2A_MEDIA_TYPE,
          payload: encodeA2AEvent({ kind: 'status-update', value: authRequired }),
        }),
      ],
    })
    const { bridge, client, notifications } = await connectBridge(engine)

    await activate(client)
    await bridge.pollOnce()

    expect(notifications.map((item) => item.meta.event_type)).toEqual([
      'task_input_required',
      'task_authorization_required',
    ])
    expect(notifications.every((item) => item.meta.protocol === 'A2A/1.0')).toBe(true)
  })
})
