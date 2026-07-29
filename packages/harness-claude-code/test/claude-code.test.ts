import { createClaudeCodeChannelIngress } from '@agent-comm/harness-claude-code'
import type { RuntimeIngressEvent } from '@agent-comm/runtime-ingress'
import { describe, expect, it, vi } from 'vitest'

const event: RuntimeIngressEvent = {
  eventId: 'm-claude',
  eventType: 'message',
  source: 'agent-comm',
  content: 'hello Claude',
  metadata: { channel: 'c-1' },
  occurredAt: '2026-07-28T00:00:00.000Z',
}

describe('ClaudeCodeChannelIngressAdapter', () => {
  it('maps a generic ingress event to one Claude Channel notification', async () => {
    const notification = vi.fn(async () => {})
    const ingress = createClaudeCodeChannelIngress({ notification })

    await expect(ingress.deliver(event)).resolves.toEqual({ status: 'accepted' })
    expect(notification).toHaveBeenCalledWith({
      method: 'notifications/claude/channel',
      params: {
        content: 'hello Claude',
        meta: {
          channel: 'c-1',
          event_type: 'message',
          event_id: 'm-claude',
          source: 'agent-comm',
        },
      },
    })
  })

  it('defers until the MCP host is connected', async () => {
    const notification = vi.fn(async () => {})
    const ingress = createClaudeCodeChannelIngress(
      { notification },
      {
        isConnected: () => false,
      },
    )

    await expect(ingress.deliver(event)).resolves.toMatchObject({ status: 'deferred' })
    expect(notification).not.toHaveBeenCalled()
  })
})
