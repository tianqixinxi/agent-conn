import type { ApplicationConformanceFixture } from '@agent-comm/application-spec'
import { describe, expect, it } from 'vitest'
import {
  ApplicationConsumerRegistry,
  assertApplicationConformance,
  LEGACY_RAW_COMPATIBILITY,
  toLegacyRawApplicationEvent,
} from '../src/index.js'

describe('application conformance runner', () => {
  it('runs a community reducer without any relay or harness', async () => {
    const uri = 'https://community.example/counter'
    const registry = new ApplicationConsumerRegistry()
    registry.register({
      id: 'counter',
      version: '1.0.0',
      supports: [{ uri, version: '1.0.0' }],
      handle(event, context) {
        const state = (context.state as { count: number } | undefined) ?? { count: 0 }
        const next = { count: state.count + Number((event.body as { by: number }).by) }
        return {
          status: 'handled',
          state: next,
          taskState: next.count >= 3 ? 'completed' : 'active',
          effects: next.count >= 3 ? [{ type: 'complete', result: next }] : [],
        }
      },
    })
    const fixture: ApplicationConformanceFixture = {
      name: 'counter-completes',
      extension: { uri, version: '1.0.0' },
      events: [
        { eventType: 'counter.incremented', body: { by: 1 } },
        { eventType: 'counter.incremented', body: { by: 2 } },
      ],
      expected: {
        state: { count: 3 },
        taskState: 'completed',
        effects: [{ type: 'complete', result: { count: 3 } }],
        eventStatuses: ['reduced', 'reduced'],
      },
    }

    await expect(assertApplicationConformance(fixture, registry)).resolves.toMatchObject({
      passed: true,
    })
  })

  it('keeps legacy compatibility display-only and unable to mint authorization', () => {
    const event = toLegacyRawApplicationEvent({
      messageId: 'legacy-1',
      channelId: 'duet',
      from: 'alice',
      body: 'hello',
    })

    expect(event.selector.uri).toBe(LEGACY_RAW_COMPATIBILITY.uri)
    expect(LEGACY_RAW_COMPATIBILITY).toMatchObject({
      canDisplay: true,
      canReply: true,
      canCreateTaskAuthorization: false,
      canCarryAuthorizationReceipt: false,
      canInvokeTools: false,
    })
  })
})
