import {
  ApplicationConsumerRegistry,
  ApplicationRuntime,
  InMemoryApplicationRuntimeStore,
  type VerifiedApplicationEvent,
} from '@agent-comm/client-sdk'
import { describe, expect, it, vi } from 'vitest'

const extensionUri = 'https://community.example/manager-workers'

function event(
  messageId: string,
  eventType = 'task.requested',
  body: unknown = { taskId: 'task-1' },
): VerifiedApplicationEvent {
  return {
    messageId,
    channelId: 'channel-1',
    from: 'manager',
    selector: { uri: extensionUri, version: '1.0.0', eventType },
    body,
    contextId: 'context-1',
    taskId: 'task-1',
    receivedAt: '2026-01-01T00:00:00.000Z',
  }
}

function registry(handle: ReturnType<typeof vi.fn>): ApplicationConsumerRegistry {
  const result = new ApplicationConsumerRegistry()
  result.register({
    id: 'manager-workers-reference',
    version: '1.0.0',
    supports: [{ uri: extensionUri, version: '1.0.0' }],
    handle,
  })
  return result
}

describe('ApplicationRuntime', () => {
  it('commits state and effect journal once before allowing transport ACK', async () => {
    const handle = vi.fn((_event, context) => ({
      status: 'handled' as const,
      state: { count: ((context.state as { count?: number } | undefined)?.count ?? 0) + 1 },
      taskState: 'active' as const,
      effects: [
        {
          type: 'publish' as const,
          to: 'worker',
          selector: {
            uri: extensionUri,
            version: '1.0.0',
            eventType: 'task.assigned',
          },
          body: { taskId: 'task-1' },
        },
      ],
    }))
    const store = new InMemoryApplicationRuntimeStore()
    const runtime = new ApplicationRuntime({
      runtimeInstanceId: 'r-current',
      profilePrincipal: 'node-manager',
      registry: registry(handle),
      store,
      now: () => new Date('2026-01-02T00:00:00.000Z'),
    })

    const first = await runtime.process(event('m-1'))
    const duplicate = await runtime.process(event('m-1'))

    expect(first).toMatchObject({ status: 'reduced', duplicate: false, autoAck: true })
    expect(duplicate).toMatchObject({ status: 'reduced', duplicate: true, autoAck: true })
    expect(handle).toHaveBeenCalledTimes(1)
    expect(store.states.values().next().value).toMatchObject({
      state: { count: 1 },
      lastEventId: 'm-1',
    })
    expect(store.effects.size).toBe(1)
  })

  it('turns an interrupted external effect into needs-reconciliation on restart', async () => {
    const store = new InMemoryApplicationRuntimeStore()
    const firstRuntime = new ApplicationRuntime({
      runtimeInstanceId: 'r-old',
      profilePrincipal: 'node-manager',
      registry: registry(
        vi.fn(() => ({
          status: 'handled' as const,
          effects: [
            { type: 'store-artifact' as const, name: 'result', mediaType: 'text/plain', content: 'x' },
          ],
        })),
      ),
      store,
    })
    await firstRuntime.process(event('m-effect'))
    store.markEffect('effect:m-effect:0', 'executing', {
      runtimeInstanceId: 'r-old',
      updatedAt: '2026-01-01T00:00:01.000Z',
    })

    new ApplicationRuntime({
      runtimeInstanceId: 'r-new',
      profilePrincipal: 'node-manager',
      registry: registry(vi.fn()),
      store,
    })

    expect(store.effects.get('effect:m-effect:0')?.status).toBe('needs-reconciliation')
  })

  it('persists unknown extensions without executing code and allows ACK', async () => {
    const store = new InMemoryApplicationRuntimeStore()
    const runtime = new ApplicationRuntime({
      runtimeInstanceId: 'r-current',
      profilePrincipal: 'node-manager',
      registry: new ApplicationConsumerRegistry(),
      store,
    })

    const result = await runtime.process(event('m-unknown'))

    expect(result).toEqual({
      status: 'unsupported',
      duplicate: false,
      autoAck: true,
      effects: [],
    })
    expect(store.events.get('m-unknown')?.status).toBe('unsupported')
  })

  it('treats terminal state as absorbing and does not produce reply effects', async () => {
    const handle = vi
      .fn()
      .mockReturnValueOnce({
        status: 'handled',
        state: { done: true },
        taskState: 'completed',
        effects: [],
      })
      .mockReturnValue({
        status: 'handled',
        state: { done: false },
        effects: [{ type: 'complete', result: 'should not run' }],
      })
    const store = new InMemoryApplicationRuntimeStore()
    const runtime = new ApplicationRuntime({
      runtimeInstanceId: 'r-current',
      profilePrincipal: 'node-manager',
      registry: registry(handle),
      store,
    })

    await runtime.process(event('m-terminal', 'task.completed'))
    const late = await runtime.process(event('m-late', 'task.progress'))

    expect(late).toMatchObject({
      status: 'ignored-terminal',
      autoAck: true,
      taskState: 'completed',
      effects: [],
    })
    expect(handle).toHaveBeenCalledTimes(1)
  })

  it('lets the application protocol translate a harness outcome exactly once', async () => {
    const store = new InMemoryApplicationRuntimeStore()
    const consumers = new ApplicationConsumerRegistry()
    const resume = vi.fn((_source, outcome) => ({
      status: 'handled' as const,
      state: { result: outcome.result },
      taskState: 'completed' as const,
      effects: [
        {
          type: 'publish' as const,
          to: 'manager',
          selector: { uri: extensionUri, version: '1.0.0', eventType: 'task.completed' },
          body: { taskId: 'task-1', result: outcome.result },
        },
      ],
    }))
    consumers.register({
      id: 'resumable',
      supports: [{ uri: extensionUri, version: '1.0.0' }],
      handle: () => ({
        status: 'handled',
        taskState: 'input-required',
        state: { waiting: true },
        effects: [{ type: 'request-input', prompt: 'do the work' }],
      }),
      resume,
    })
    const runtime = new ApplicationRuntime({
      runtimeInstanceId: 'r-resume',
      profilePrincipal: 'node-worker',
      registry: consumers,
      store,
    })
    await runtime.process(event('m-resume'))

    const first = await runtime.resume('m-resume', { status: 'completed', result: 'done' })
    const duplicate = await runtime.resume('m-resume', { status: 'completed', result: 'ignored' })

    expect(first).toMatchObject({ status: 'reduced', duplicate: false, taskState: 'completed' })
    expect(duplicate).toBeUndefined()
    expect(resume).toHaveBeenCalledOnce()
    expect(store.effects.get('effect:m-resume:0')?.status).toBe('applied')
    expect(store.effects.get('effect:m-resume:harness-outcome:0')?.effect).toMatchObject({
      type: 'publish',
      body: { result: 'done' },
    })
  })
})
