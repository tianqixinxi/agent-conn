import { describe, expect, it, vi } from 'vitest'
import {
  type CodexAppServerClient,
  CodexAppServerIngressAdapter,
  CodexExecIngressAdapter,
} from '../src/index.js'

const event = {
  eventId: 'm-codex',
  eventType: 'task_message',
  source: 'agent-comm',
  content: 'Review the README',
  metadata: { channel: 'c-one' },
  occurredAt: new Date().toISOString(),
}

describe('Codex harness adapters', () => {
  it('reuses one app-server thread per AgentComm channel', async () => {
    const calls: string[] = []
    let notify: ((message: { method?: string; params?: unknown }) => void) | undefined
    const client: CodexAppServerClient = {
      async start() {
        calls.push('start')
      },
      setNotificationHandler(handler) {
        notify = handler
      },
      async startThread({ channelId }) {
        calls.push(`thread:${channelId}`)
        return 'thread-one'
      },
      async startTurn({ threadId }) {
        calls.push(`turn:${threadId}`)
        return { turnId: 'turn-one' }
      },
      async stop() {},
    }
    const adapter = new CodexAppServerIngressAdapter({ client })
    const outcomes: unknown[] = []
    adapter.setOutcomeHandler((outcome) => {
      outcomes.push(outcome)
    })
    await adapter.start()
    await adapter.deliver(event)
    notify?.({
      method: 'item/completed',
      params: {
        threadId: 'thread-one',
        turnId: 'turn-one',
        item: { type: 'agentMessage', text: 'README reviewed' },
      },
    })
    notify?.({
      method: 'turn/completed',
      params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'completed' } },
    })
    await adapter.deliver({ ...event, eventId: 'm-two' })
    expect(calls).toEqual(['start', 'thread:c-one', 'turn:thread-one', 'turn:thread-one'])
    await vi.waitFor(() => {
      expect(outcomes).toEqual([{ eventId: event.eventId, status: 'completed', result: 'README reviewed' }])
    })
  })

  it('feeds Codex Exec over stdin instead of interpolating event text into arguments', async () => {
    let observed: { args: readonly string[]; stdin: string } | undefined
    const adapter = new CodexExecIngressAdapter({
      runner: async (input) => {
        observed = { args: input.args, stdin: input.stdin }
        return { exitCode: 0, stdout: '{"type":"turn.completed"}\n', stderr: '' }
      },
    })
    const outcomes: unknown[] = []
    adapter.setOutcomeHandler((outcome) => {
      outcomes.push(outcome)
    })
    await expect(adapter.deliver(event)).resolves.toMatchObject({ status: 'accepted' })
    expect(observed?.args).not.toContain(event.content)
    expect(observed?.stdin).toContain(event.content)
    expect(outcomes).toEqual([
      { eventId: event.eventId, status: 'completed', result: '{"type":"turn.completed"}' },
    ])
  })
})
