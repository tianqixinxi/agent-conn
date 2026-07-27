import {
  ApplicationClient,
  type ApplicationConsumerContext,
  ApplicationConsumerRegistry,
  type ApplicationTransport,
  type VerifiedApplicationEvent,
} from '@agent-comm/client-sdk'
import { describe, expect, it, vi } from 'vitest'

const extensionUri = 'https://example.com/agentcomm/repository-maintenance'

function consumerContext(): ApplicationConsumerContext {
  return {
    runtimeId: 'claude-session-1',
    profilePrincipal: 'node-alice',
    channelId: 'channel-1',
    extensionUri,
    contextId: 'context-1',
    state: undefined,
    taskState: 'active',
    stale: false,
  }
}

function event(overrides: Partial<VerifiedApplicationEvent> = {}): VerifiedApplicationEvent {
  return {
    messageId: 'm-1',
    channelId: 'channel-1',
    from: 'alice',
    selector: {
      uri: extensionUri,
      version: '1.1.0',
      eventType: 'work.requested',
    },
    body: { goal: 'review README' },
    ...overrides,
  }
}

describe('ApplicationConsumerRegistry', () => {
  it('dispatches a compatible event to a locally registered consumer', async () => {
    const handle = vi.fn(() => ({
      status: 'handled' as const,
      effects: [{ type: 'complete' as const, result: { summary: 'done' } }],
    }))
    const registry = new ApplicationConsumerRegistry()
    registry.register({
      id: 'repo-maintainer',
      supports: [
        {
          uri: extensionUri,
          version: '1.2.0',
          backwardCompatibleFrom: '1.0.0',
        },
      ],
      handle,
    })

    const result = await registry.dispatch(event(), consumerContext())

    expect(handle).toHaveBeenCalledOnce()
    expect(result).toEqual({
      status: 'handled',
      consumerId: 'repo-maintainer',
      effects: [{ type: 'complete', result: { summary: 'done' } }],
    })
  })

  it('fails closed for an unknown extension without executing a consumer', async () => {
    const handle = vi.fn()
    const registry = new ApplicationConsumerRegistry()
    registry.register({
      id: 'repo-maintainer',
      supports: [{ uri: extensionUri, version: '1.1.0' }],
      handle,
    })

    const unknown = event({
      selector: {
        uri: 'https://community.example/debate',
        version: '1.0.0',
        eventType: 'argument.proposed',
      },
    })
    const result = await registry.dispatch(unknown, consumerContext())

    expect(handle).not.toHaveBeenCalled()
    expect(result).toEqual({
      status: 'unsupported',
      selector: unknown.selector,
      effects: [],
    })
  })

  it('does not treat a newer incompatible version as supported', async () => {
    const handle = vi.fn()
    const registry = new ApplicationConsumerRegistry()
    registry.register({
      id: 'repo-maintainer',
      supports: [
        {
          uri: extensionUri,
          version: '1.2.0',
          backwardCompatibleFrom: '1.0.0',
        },
      ],
      handle,
    })

    const result = await registry.dispatch(
      event({ selector: { uri: extensionUri, version: '1.3.0', eventType: 'work.requested' } }),
      consumerContext(),
    )

    expect(handle).not.toHaveBeenCalled()
    expect(result.status).toBe('unsupported')
  })
})

describe('ApplicationClient', () => {
  it('publishes through a harness-owned transport without exposing relay details', async () => {
    const publish = vi.fn(async () => ({
      messageId: 'm-2',
      taskId: 'task-m-2',
      contextId: 'ctx-2',
    }))
    const transport: ApplicationTransport = {
      publish,
      respond: vi.fn(),
    }
    const client = new ApplicationClient(transport)

    await client.publish({
      channelId: 'channel-1',
      to: 'alice',
      selector: {
        uri: extensionUri,
        version: '1.1.0',
        eventType: 'work.requested',
      },
      body: { goal: 'review README' },
    })

    expect(publish).toHaveBeenCalledWith({
      channelId: 'channel-1',
      to: 'alice',
      selector: {
        uri: extensionUri,
        version: '1.1.0',
        eventType: 'work.requested',
      },
      body: { goal: 'review README' },
    })
  })
})
