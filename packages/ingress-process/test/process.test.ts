import { ProcessIngressAdapter, type ProcessIngressRunner } from '@agent-comm/ingress-process'
import type { RuntimeIngressEvent } from '@agent-comm/runtime-ingress'
import { describe, expect, it, vi } from 'vitest'

const event: RuntimeIngressEvent = {
  eventId: 'm-process',
  eventType: 'task',
  source: 'agent-comm',
  content: 'run',
  metadata: { remote: 'data is never a command' },
  occurredAt: '2026-07-28T00:00:00.000Z',
}

describe('ProcessIngressAdapter', () => {
  it('passes the event on stdin without constructing a shell command', async () => {
    const runner = vi.fn<ProcessIngressRunner>(async (input) => {
      expect(input.command).toBe('/usr/bin/runtime')
      expect(input.args).toEqual(['--event-stdin'])
      expect(JSON.parse(input.stdin)).toEqual(event)
      expect(input.env.AGENTCOMM_EVENT_ID).toBe(event.eventId)
      return { exitCode: 0, stdout: 'finished', stderr: '', timedOut: false }
    })
    const ingress = new ProcessIngressAdapter({
      command: '/usr/bin/runtime',
      args: ['--event-stdin'],
      runner,
    })
    let outcome: unknown
    ingress.setOutcomeHandler((value) => {
      outcome = value
    })

    await expect(ingress.deliver(event)).resolves.toEqual({ status: 'accepted' })
    expect(outcome).toEqual({
      eventId: event.eventId,
      status: 'completed',
      result: 'finished',
    })
  })

  it('maps temporary and unsupported exit codes', async () => {
    const results = [
      { exitCode: 75, stderr: 'busy', timedOut: false },
      { exitCode: 69, stderr: 'not supported', timedOut: false },
      { exitCode: 1, stderr: 'denied', timedOut: false },
    ]
    const ingress = new ProcessIngressAdapter({
      command: '/usr/bin/runtime',
      runner: async () => results.shift() ?? { exitCode: 0, stderr: '', timedOut: false },
    })

    await expect(ingress.deliver(event)).resolves.toMatchObject({ status: 'deferred' })
    await expect(ingress.deliver(event)).resolves.toMatchObject({ status: 'unsupported' })
    await expect(ingress.deliver(event)).resolves.toMatchObject({ status: 'rejected' })
  })
})
