import {
  readApplicationEventSelector,
  readApplicationExtensionAdvertisements,
  withApplicationEventSelector,
} from '@agent-comm/application-spec'
import {
  ApplicationConsumerRegistry,
  ApplicationRuntime,
  InMemoryApplicationRuntimeStore,
} from '@agent-comm/client-sdk'
import { createClaudeCodeChannelIngress } from '@agent-comm/harness-claude-code'
import { PollingIngressAdapter } from '@agent-comm/ingress-polling'
import type { AuthorizationReceipt, Message, TaskAuthorization } from '@agent-comm/protocol'
import {
  A2A_MEDIA_TYPE,
  A2ARole,
  A2ATaskState,
  createA2AMessage,
  createA2AStatusUpdate,
  createAgentCommAgentCard,
  encodeA2AEvent,
  nowIso,
  tryDecodeA2AEvent,
} from '@agent-comm/protocol'
import { createCallbackIngressAdapter } from '@agent-comm/runtime-ingress'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { NotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import {
  type ChannelBridge,
  type ChannelBridgeOptions,
  type ChannelNotification,
  createChannelApplicationEffectExecutor,
  createChannelBridge,
  DEFAULT_CHANNEL_RELAY_URL,
  resolveChannelRelayUrl,
  shouldRehomeDevelopmentChannel,
} from '../src/mcp/channel.js'
import type { TaskAuthorizationRepo } from '../src/store/index.js'
import { FakeEngine, makeHeldMessage } from './fake-engine.js'

const REPOSITORY_EXTENSION = 'https://community.example/repository-maintenance'

function applicationCard(
  version = '1.0.0',
  backwardCompatibleFrom?: string,
): Record<string, unknown> & { name: string } {
  const card = createAgentCommAgentCard({
    name: 'alice-runtime',
    endpoint: 'https://relay.example',
    protocolBinding: 'HTTP+JSON',
    applicationExtensions: [
      {
        uri: REPOSITORY_EXTENSION,
        version,
        ...(backwardCompatibleFrom ? { backwardCompatibleFrom } : {}),
      },
    ],
  })
  return { ...card } as Record<string, unknown> & { name: string }
}

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

async function connectBridge(
  engine: FakeEngine,
  notifications: ChannelNotification[] = [],
  options: Partial<ChannelBridgeOptions> = {},
) {
  const bridge = createChannelBridge(engine, {
    ...options,
    notify: async (notification) => void notifications.push(notification),
    stderr: () => {},
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'channel-test', version: '0.0.0' }, { capabilities: {} })
  await Promise.all([bridge.server.connect(serverTransport), client.connect(clientTransport)])
  return { bridge, client, notifications }
}

class MemoryTaskAuthorizationRepo implements TaskAuthorizationRepo {
  readonly values = new Map<string, TaskAuthorization>()

  create(authorization: TaskAuthorization): boolean {
    if (this.values.has(authorization.authorizationId)) return false
    this.values.set(authorization.authorizationId, authorization)
    return true
  }

  get(authorizationId: string): TaskAuthorization | undefined {
    return this.values.get(authorizationId)
  }

  listPending(channelId?: string): TaskAuthorization[] {
    return [...this.values.values()].filter(
      (item) => item.status === 'pending' && (channelId === undefined || item.channelId === channelId),
    )
  }

  decide(authorizationId: string, receipt: AuthorizationReceipt): TaskAuthorization {
    const current = this.values.get(authorizationId)
    if (!current) throw new Error(`unknown authorization: ${authorizationId}`)
    const updated: TaskAuthorization = {
      ...current,
      status: receipt.decision === 'approve' ? 'approved' : 'rejected',
      receipt,
    }
    this.values.set(authorizationId, updated)
    return updated
  }
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

  it('advertises locally registered application extensions when a runtime activates', async () => {
    const registry = new ApplicationConsumerRegistry()
    registry.register({
      id: 'repository-maintenance',
      version: '1.2.0',
      supports: [
        {
          uri: REPOSITORY_EXTENSION,
          version: '1.2.0',
          backwardCompatibleFrom: '1.0.0',
        },
      ],
      handle: () => ({ status: 'handled', effects: [] }),
    })
    const applicationRuntime = new ApplicationRuntime({
      runtimeInstanceId: 'r-card-runtime-001',
      profilePrincipal: 'node-bob',
      registry,
      store: new InMemoryApplicationRuntimeStore(),
    })
    const engine = new FakeEngine({
      memberships: [{ channel: 'duet', alias: 'bob', home: 'https://relay.example' }],
    })
    const { client } = await connectBridge(engine, [], { applicationRuntime })

    await activate(client, 'duet')

    const published = engine.calls.find((call) => call.method === 'publishCard')
    expect(readApplicationExtensionAdvertisements(published?.args[0])).toEqual([
      {
        uri: REPOSITORY_EXTENSION,
        version: '1.2.0',
        backwardCompatibleFrom: '1.0.0',
        description: `AgentComm application extension ${REPOSITORY_EXTENSION} 1.2.0.`,
      },
    ])
    applicationRuntime.close()
  })

  it('delegates only through a channel activated by the current runtime', async () => {
    const engine = new FakeEngine({
      memberships: [
        { channel: 'old', alias: 'bob', home: 'local:/old.db' },
        { channel: 'duet', alias: 'bob', home: 'local:/duet.db' },
      ],
      peers: [{ channel: 'duet', alias: 'alice', nodeId: 'n-alice', online: true }],
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

    const unknown = await client.callTool({
      name: 'agent_comm',
      arguments: { operation: 'delegate', to: 'missing-peer', intent: 'do work' },
    })
    expect(unknown.isError).toBe(true)
    expect(JSON.parse(firstText(unknown))).toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('lists members and presence only for an active channel', async () => {
    const engine = new FakeEngine({
      memberships: [
        { channel: 'duet', alias: 'bob', home: 'local:/duet.db' },
        { channel: 'old', alias: 'bob', home: 'local:/old.db' },
      ],
      peers: [
        { channel: 'duet', alias: 'bob', nodeId: 'n-bob', online: true },
        { channel: 'duet', alias: 'alice', nodeId: 'n-alice', online: false },
        { channel: 'old', alias: 'carol', nodeId: 'n-carol', online: true },
      ],
    })
    const { client } = await connectBridge(engine)

    const inactive = await client.callTool({
      name: 'agent_comm',
      arguments: { operation: 'members', channel: 'duet' },
    })
    expect(inactive.isError).toBe(true)
    expect(JSON.parse(firstText(inactive))).toMatchObject({ code: 'INVALID_INPUT' })

    await activate(client, 'duet')
    const result = await client.callTool({
      name: 'agent_comm',
      arguments: { operation: 'members' },
    })

    expect(result.isError).toBeFalsy()
    expect(JSON.parse(firstText(result))).toEqual({
      channel: 'duet',
      members: [
        { channel: 'duet', alias: 'bob', nodeId: 'n-bob', online: true },
        { channel: 'duet', alias: 'alice', nodeId: 'n-alice', online: false },
      ],
    })
    expect(engine.calls.find((call) => call.method === 'listPeers')?.args).toEqual([{ channel: 'duet' }])
  })

  it('broadcasts readable messages to every participant without inventing a delegate recipient', async () => {
    const engine = new FakeEngine({
      memberships: [{ channel: 'duet', alias: 'bob', home: 'https://relay.example' }],
    })
    const { client } = await connectBridge(engine)
    await activate(client, 'duet')

    const result = await client.callTool({
      name: 'agent_comm',
      arguments: { operation: 'broadcast', prompt: 'Cold start connected.' },
    })

    expect(result.isError).toBeFalsy()
    expect(JSON.parse(firstText(result))).toMatchObject({
      channel: 'duet',
      to: '*',
      status: 'delivered',
    })
    expect(engine.calls.find((call) => call.method === 'send')?.args[0]).toMatchObject({
      channel: 'duet',
      to: '*',
      payload: 'Cold start connected.',
      contentType: 'text/plain; charset=utf-8',
    })
  })

  it('publishes a versioned community application event through the single high-level tool', async () => {
    const engine = new FakeEngine({
      memberships: [{ channel: 'duet', alias: 'bob', home: 'https://relay.example' }],
      peers: [
        {
          channel: 'duet',
          alias: 'alice',
          nodeId: 'n-alice',
          online: true,
          card: applicationCard(),
        },
      ],
    })
    const { client } = await connectBridge(engine)
    await activate(client, 'duet')

    const result = await client.callTool({
      name: 'agent_comm',
      arguments: {
        operation: 'publish',
        to: 'alice',
        extensionUri: REPOSITORY_EXTENSION,
        extensionVersion: '1.0.0',
        eventType: 'work.requested',
        body: { goal: 'review README' },
      },
    })

    expect(result.isError).toBeFalsy()
    const send = engine.calls.find((call) => call.method === 'send')
    const event = tryDecodeA2AEvent((send?.args[0] as { payload?: unknown } | undefined)?.payload)
    expect(event?.kind).toBe('message')
    if (event?.kind !== 'message') throw new Error('expected A2A message')
    expect(readApplicationEventSelector(event.value.metadata)).toEqual({
      uri: REPOSITORY_EXTENSION,
      version: '1.0.0',
      eventType: 'work.requested',
    })
  })

  it('fails closed before publishing to a peer that did not advertise the extension', async () => {
    const engine = new FakeEngine({
      memberships: [{ channel: 'duet', alias: 'bob', home: 'https://relay.example' }],
      peers: [{ channel: 'duet', alias: 'alice', nodeId: 'n-alice', online: true }],
    })
    const { client } = await connectBridge(engine)
    await activate(client, 'duet')

    const result = await client.callTool({
      name: 'agent_comm',
      arguments: {
        operation: 'publish',
        to: 'alice',
        extensionUri: REPOSITORY_EXTENSION,
        extensionVersion: '1.0.0',
        eventType: 'work.requested',
        body: { goal: 'review README' },
      },
    })

    expect(result.isError).toBe(true)
    expect(JSON.parse(firstText(result))).toMatchObject({ code: 'EXTENSION_NOT_SUPPORTED' })
    expect(engine.calls.some((call) => call.method === 'send')).toBe(false)
  })

  it('fails closed when a peer advertises an incompatible extension version', async () => {
    const engine = new FakeEngine({
      memberships: [{ channel: 'duet', alias: 'bob', home: 'https://relay.example' }],
      peers: [
        {
          channel: 'duet',
          alias: 'alice',
          nodeId: 'n-alice',
          online: true,
          card: applicationCard('2.0.0'),
        },
      ],
    })
    const { client } = await connectBridge(engine)
    await activate(client, 'duet')

    const result = await client.callTool({
      name: 'agent_comm',
      arguments: {
        operation: 'publish',
        to: 'alice',
        extensionUri: REPOSITORY_EXTENSION,
        extensionVersion: '1.0.0',
        eventType: 'work.requested',
        body: { goal: 'review README' },
      },
    })

    expect(result.isError).toBe(true)
    expect(JSON.parse(firstText(result))).toMatchObject({
      code: 'EXTENSION_VERSION_UNSUPPORTED',
    })
    expect(engine.calls.some((call) => call.method === 'send')).toBe(false)
  })

  it('shows application metadata readably and responds in the same extension', async () => {
    const extensionUri = 'https://community.example/repository-maintenance'
    const original = createA2AMessage({
      messageId: 'a2a-application-1',
      role: 'user',
      payload: { goal: 'review README' },
      contextId: 'ctx-application',
      taskId: 'task-application',
      metadata: withApplicationEventSelector(undefined, {
        uri: extensionUri,
        version: '1.0.0',
        eventType: 'work.requested',
      }),
    })
    const inbound = message({
      messageId: 'transport-application-1',
      contentType: A2A_MEDIA_TYPE,
      payload: encodeA2AEvent({ kind: 'message', value: original }),
    })
    const engine = new FakeEngine({
      inbox: [inbound],
      memberships: [{ channel: 'duet', alias: 'bob', home: 'local:/duet.db' }],
    })
    const { bridge, client, notifications } = await connectBridge(engine)
    await activate(client)
    await bridge.pollOnce()

    expect(notifications[0]?.meta).toMatchObject({
      event_type: 'application_event',
      application_extension_uri: extensionUri,
      application_extension_version: '1.0.0',
      application_event_type: 'work.requested',
    })
    expect(notifications[0]?.content).toContain(`Application: ${extensionUri} @ 1.0.0`)
    expect(notifications[0]?.content).toContain('Event: work.requested')

    const result = await client.callTool({
      name: 'agent_comm',
      arguments: {
        operation: 'respond',
        eventId: inbound.messageId,
        eventType: 'work.completed',
        body: { summary: 'done' },
        terminal: true,
      },
    })
    expect(result.isError).toBeFalsy()
    const sends = engine.calls.filter((call) => call.method === 'send')
    const response = tryDecodeA2AEvent((sends[0]?.args[0] as { payload?: unknown } | undefined)?.payload)
    expect(response?.kind).toBe('message')
    if (response?.kind !== 'message') throw new Error('expected A2A message')
    expect(readApplicationEventSelector(response.value.metadata)).toEqual({
      uri: extensionUri,
      version: '1.0.0',
      eventType: 'work.completed',
    })
    expect(sends).toHaveLength(2)
  })

  it('executes a consumer publish effect through the real Channel adapter after state commit', async () => {
    const original = createA2AMessage({
      messageId: 'a2a-effect-source',
      role: 'user',
      payload: { goal: 'review README' },
      contextId: 'ctx-effect',
      taskId: 'task-effect',
      metadata: withApplicationEventSelector(undefined, {
        uri: REPOSITORY_EXTENSION,
        version: '1.0.0',
        eventType: 'work.requested',
      }),
    })
    const inbound = message({
      messageId: 'transport-effect-source',
      contentType: A2A_MEDIA_TYPE,
      payload: encodeA2AEvent({ kind: 'message', value: original }),
    })
    const engine = new FakeEngine({
      inbox: [inbound],
      memberships: [{ channel: 'duet', alias: 'bob', home: 'local:/duet.db' }],
      peers: [
        {
          channel: 'duet',
          alias: 'alice',
          nodeId: 'n-alice',
          online: true,
          card: applicationCard(),
        },
      ],
    })
    const registry = new ApplicationConsumerRegistry()
    registry.register({
      id: 'repository-maintenance',
      version: '1.0.0',
      supports: [{ uri: REPOSITORY_EXTENSION, version: '1.0.0' }],
      handle: (_event, context) => ({
        status: 'handled',
        state: { accepted: true },
        effects: [
          {
            type: 'publish',
            to: 'alice',
            selector: {
              uri: REPOSITORY_EXTENSION,
              version: '1.0.0',
              eventType: 'work.accepted',
            },
            body: { acceptedBy: 'bob' },
            contextId: context.contextId,
          },
        ],
      }),
    })
    const store = new InMemoryApplicationRuntimeStore()
    const applicationRuntime = new ApplicationRuntime({
      runtimeInstanceId: 'r-effect-runtime-001',
      profilePrincipal: 'node-bob',
      registry,
      store,
      effectExecutor: createChannelApplicationEffectExecutor(engine, store, 'r-effect-runtime-001'),
    })
    const { bridge, client, notifications } = await connectBridge(engine, [], { applicationRuntime })
    await activate(client)
    await bridge.pollOnce()

    expect(notifications).toEqual([])
    const sent = engine.calls.find((call) => call.method === 'send')
    const sentEvent = tryDecodeA2AEvent((sent?.args[0] as { payload?: unknown } | undefined)?.payload)
    expect(sent?.args[0]).toMatchObject({
      channel: 'duet',
      to: 'alice',
      runtimeInstanceId: 'r-effect-runtime-001',
    })
    expect(sentEvent?.kind).toBe('message')
    if (sentEvent?.kind !== 'message') throw new Error('expected application effect message')
    expect(readApplicationEventSelector(sentEvent.value.metadata)).toEqual({
      uri: REPOSITORY_EXTENSION,
      version: '1.0.0',
      eventType: 'work.accepted',
    })
    expect(store.listEffects(['applied'])).toHaveLength(1)
    applicationRuntime.close()
  })

  it('advertises the Channel capability and emits the real MCP notification method', async () => {
    const inbound = message()
    const bridge = createChannelBridge(
      new FakeEngine({
        inbox: [inbound],
        memberships: [{ channel: 'duet', alias: 'bob', home: 'local:/duet.db' }],
      }),
      {
        ingressFactory: (server) => createClaudeCodeChannelIngress(server.server),
        stderr: () => {},
      },
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
    expect(notifications[0]?.content).toContain('AgentComm: alice sent a message')
    expect(notifications[0]?.content).toContain('review the change')
    expect(notifications[0]?.content).toContain(`Event ID: ${inbound.messageId}`)
    expect(notifications[0]?.content.trimStart().startsWith('{')).toBe(false)
  })

  it('registers pending work before a non-MCP ingress completes it synchronously', async () => {
    const inbound = message({ messageId: 'm-sync-complete' })
    const engine = new FakeEngine({
      inbox: [inbound],
      memberships: [{ channel: 'duet', alias: 'bob', home: 'local:/duet.db' }],
    })
    let bridge: ChannelBridge
    const ingress = createCallbackIngressAdapter('sync-runtime', async (event) => {
      await bridge.complete(event.eventId)
      return { status: 'accepted' }
    })
    bridge = createChannelBridge(engine, { ingress, stderr: () => {} })
    await bridge.activate('duet')

    await bridge.pollOnce()

    expect(engine.calls.some((call) => call.method === 'send')).toBe(true)
    expect(engine.calls.some((call) => call.method === 'ack')).toBe(true)
  })

  it('reoffers unfinished pull work after the polling adapter acknowledges its lease', async () => {
    const inbound = message({ messageId: 'm-pull-redelivery' })
    const engine = new FakeEngine({
      inbox: [inbound],
      memberships: [{ channel: 'duet', alias: 'bob', home: 'local:/duet.db' }],
    })
    const ingress = new PollingIngressAdapter()
    const bridge = createChannelBridge(engine, { ingress, stderr: () => {} })
    await bridge.activate('duet')
    await bridge.pollOnce()

    const first = ingress.poll({ limit: 1 })[0]
    expect(first?.event.eventId).toBe(inbound.messageId)
    expect(ingress.ack(inbound.messageId)).toBe(true)
    expect(ingress.size()).toBe(0)

    await bridge.pollOnce()
    expect(ingress.size()).toBe(1)
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
    expect(notifications[0]?.content).toContain('AgentComm: alice sent a message')
    expect(notifications[0]?.content).toContain(`Event ID: ${inbound.messageId}`)
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

  it('creates a public channel with readable metadata and returns its stable observation URL', async () => {
    const engine = new FakeEngine({ profileName: 'alice' })
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
      arguments: {
        operation: 'share',
        channel: 'open-lab',
        displayName: 'Open Lab',
        description: 'A public place to watch Claude sessions work together.',
        visibility: 'public',
        mode: 'auto',
      },
    })

    expect(result.isError).toBeFalsy()
    expect(JSON.parse(firstText(result))).toMatchObject({
      channel: 'open-lab',
      visibility: 'public',
      displayName: 'Open Lab',
      description: 'A public place to watch Claude sessions work together.',
      link: 'https://relay.example/public/open-lab',
      browserReady: true,
    })
    expect(engine.calls.find((call) => call.method === 'createChannel')?.args[0]).toMatchObject({
      name: 'open-lab',
      alias: 'alice',
      displayName: 'Open Lab',
      description: 'A public place to watch Claude sessions work together.',
      visibility: 'public',
      mode: 'auto',
      home: 'https://relay.example',
    })
    expect(engine.calls.some((call) => call.method === 'createInvite')).toBe(false)
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
    expect(notifications[0]?.content).toContain('AgentComm approval required')
    expect(notifications[0]?.content).toContain(`Delivery hold ID: ${held.message.messageId}`)
    expect(notifications[0]?.content.trimStart().startsWith('{')).toBe(false)

    const result = await client.callTool({
      name: 'agent_comm',
      arguments: { operation: 'resolve_approval', messageId: held.message.messageId, decision: 'approve' },
    })
    expect(result.isError).toBeFalsy()
    const deliver = engine.calls.find((call) => call.method === 'deliverHeld')
    expect(deliver?.actor).toBe('human')
    expect(deliver?.args[0]).toEqual({ messageId: held.message.messageId, channel: 'duet' })
  })

  it('suspends and resumes the same task with a persisted task-authorization receipt', async () => {
    const original = createA2AMessage({
      messageId: 'a2a-sensitive-task',
      role: 'user',
      payload: { intent: 'deploy production' },
      contextId: 'ctx-sensitive',
      taskId: 'task-sensitive',
    })
    const inbound = message({
      messageId: 'transport-sensitive-task',
      contentType: A2A_MEDIA_TYPE,
      payload: encodeA2AEvent({ kind: 'message', value: original }),
    })
    const engine = new FakeEngine({
      inbox: [inbound],
      memberships: [{ channel: 'duet', alias: 'bob', home: 'local:/duet.db' }],
    })
    const authorizations = new MemoryTaskAuthorizationRepo()
    const { bridge, client } = await connectBridge(engine, [], {
      taskAuthorizations: authorizations,
    })
    await activate(client)
    await bridge.pollOnce()

    const requested = await client.callTool({
      name: 'agent_comm',
      arguments: {
        operation: 'request_task_authorization',
        eventId: inbound.messageId,
        prompt: 'Allow production deploy?',
        approval: { action: 'deploy', environment: 'production' },
      },
    })
    expect(requested.isError).toBeFalsy()
    const requestPayload = JSON.parse(firstText(requested)) as {
      authorization: { authorizationId: string; taskId: string; contextId: string }
    }
    expect(requestPayload.authorization).toMatchObject({
      taskId: 'task-sensitive',
      contextId: 'ctx-sensitive',
    })
    expect(engine.calls.some((call) => call.method === 'ack')).toBe(false)

    const resolved = await client.callTool({
      name: 'agent_comm',
      arguments: {
        operation: 'resolve_task_authorization',
        authorizationId: requestPayload.authorization.authorizationId,
        decision: 'approve',
        source: 'local-host',
        assurance: 'host-reported',
      },
    })
    expect(resolved.isError).toBeFalsy()
    expect(JSON.parse(firstText(resolved))).toMatchObject({
      resumedSameTask: true,
      taskId: 'task-sensitive',
      contextId: 'ctx-sensitive',
    })

    const completed = await client.callTool({
      name: 'agent_comm',
      arguments: {
        operation: 'reply',
        eventId: inbound.messageId,
        response: { result: 'deployed' },
      },
    })
    expect(completed.isError).toBeFalsy()
    expect(engine.calls.find((call) => call.method === 'ack')?.args[0]).toEqual({
      messageId: inbound.messageId,
    })
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
    expect(notifications[0]?.content).toContain('needs more input to continue a task')
    expect(notifications[0]?.content).toContain('Task status: input required')
    expect(notifications[1]?.content).toContain('needs authorization to continue a task')
    expect(notifications[1]?.content).toContain('Task status: auth required')
    expect(notifications.every((item) => item.content.includes('Event ID:'))).toBe(true)
  })

  it('absorbs terminal task events and auto-acks agent results without reply ping-pong', async () => {
    const completed = createA2AStatusUpdate({
      taskId: 'task-completed',
      contextId: 'ctx-completed',
      state: A2ATaskState.TASK_STATE_COMPLETED,
    })
    const resultMessage = createA2AMessage({
      messageId: 'a2a-result',
      role: 'agent',
      payload: { result: 'done' },
      contextId: 'ctx-result',
      taskId: 'task-result',
    })
    const engine = new FakeEngine({
      memberships: [{ channel: 'duet', alias: 'bob', home: 'local:/duet.db' }],
      inbox: [
        message({
          messageId: 'm-completed',
          contentType: A2A_MEDIA_TYPE,
          payload: encodeA2AEvent({ kind: 'status-update', value: completed }),
        }),
        message({
          messageId: 'm-agent-result',
          contentType: A2A_MEDIA_TYPE,
          payload: encodeA2AEvent({ kind: 'message', value: resultMessage }),
        }),
      ],
    })
    const { bridge, client, notifications } = await connectBridge(engine)
    await activate(client)
    await bridge.pollOnce()

    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.meta).toMatchObject({
      event_type: 'task_message',
      event_id: 'm-agent-result',
    })
    expect(
      engine.calls
        .filter((call) => call.method === 'ack')
        .map((call) => (call.args[0] as { messageId: string }).messageId),
    ).toEqual(['m-completed', 'm-agent-result'])

    const duplicateReply = await client.callTool({
      name: 'agent_comm',
      arguments: {
        operation: 'reply',
        eventId: 'm-agent-result',
        response: 'unnecessary echo',
      },
    })
    expect(duplicateReply.isError).toBe(true)
    expect(JSON.parse(firstText(duplicateReply))).toMatchObject({ code: 'MESSAGE_NOT_FOUND' })
  })
})
