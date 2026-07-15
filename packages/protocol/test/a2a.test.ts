import { describe, expect, it } from 'vitest'
import {
  A2A_MEDIA_TYPE,
  A2ARole,
  A2ATaskState,
  AGENTCOMM_A2A_EXTENSION_URI,
  a2aPartsToPayload,
  createA2AMessage,
  createA2AStatusUpdate,
  createAgentCommAgentCard,
  encodeA2AEvent,
  readAgentCommRouting,
  tryDecodeA2AEvent,
  withAgentCommRouting,
} from '../src/index.js'

describe('A2A v1 protocol adapter', () => {
  it('round-trips an official A2A message inside a transport-neutral frame', () => {
    const message = createA2AMessage({
      messageId: 'msg-a2a-1',
      role: 'user',
      payload: { intent: 'review', target: 'change-42' },
      contextId: 'ctx-a2a-1',
      metadata: withAgentCommRouting(undefined, {
        channel: 'duet',
        to: 'bob',
        taskId: 'task-a2a-1',
      }),
    })

    const frame = encodeA2AEvent({ kind: 'message', value: message })
    const decoded = tryDecodeA2AEvent(frame)

    expect(A2A_MEDIA_TYPE).toBe('application/a2a+json')
    expect(frame).toMatchObject({ protocolVersion: '1.0', kind: 'message' })
    expect(decoded?.kind).toBe('message')
    if (decoded?.kind !== 'message') throw new Error('expected message')
    expect(decoded.value.role).toBe(A2ARole.ROLE_USER)
    expect(a2aPartsToPayload(decoded.value.parts)).toEqual({
      intent: 'review',
      target: 'change-42',
    })
    expect(readAgentCommRouting(decoded.value)).toEqual({
      channel: 'duet',
      to: 'bob',
      taskId: 'task-a2a-1',
    })
  })

  it('models governance pauses with the standard AUTH_REQUIRED task state', () => {
    const update = createA2AStatusUpdate({
      taskId: 'task-a2a-2',
      contextId: 'ctx-a2a-2',
      state: A2ATaskState.TASK_STATE_AUTH_REQUIRED,
      metadata: { approval: { kind: 'shell', command: 'deploy' } },
    })
    const decoded = tryDecodeA2AEvent(encodeA2AEvent({ kind: 'status-update', value: update }))

    expect(decoded?.kind).toBe('status-update')
    if (decoded?.kind !== 'status-update') throw new Error('expected status update')
    expect(decoded.value.status?.state).toBe(A2ATaskState.TASK_STATE_AUTH_REQUIRED)
    expect(decoded.value.metadata).toEqual({ approval: { kind: 'shell', command: 'deploy' } })
  })

  it('publishes a standards-shaped AgentCard with the private-channel extension', () => {
    const card = createAgentCommAgentCard({
      name: 'alice',
      endpoint: 'https://relay.example/a2a/v1',
      protocolBinding: 'HTTP+JSON',
    })

    expect(card.supportedInterfaces[0]).toMatchObject({
      url: 'https://relay.example/a2a/v1',
      protocolBinding: 'HTTP+JSON',
      protocolVersion: '1.0',
    })
    expect(card.capabilities?.extensions?.[0]?.uri).toBe(AGENTCOMM_A2A_EXTENSION_URI)
    expect(Object.keys(card.securitySchemes).sort()).toEqual([
      'agentcommNode',
      'agentcommSignature',
      'agentcommTimestamp',
    ])
    expect(card.securityRequirements).toHaveLength(1)
  })
})
