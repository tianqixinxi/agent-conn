import type { Message } from '@agent-comm/protocol'
import {
  A2A_MEDIA_TYPE,
  A2ARole,
  A2ATaskState,
  createA2AMessage,
  createA2AStatusUpdate,
  encodeA2AEvent,
  nowIso,
  tryDecodeA2AEvent,
} from '@agent-comm/protocol'
import { describe, expect, it } from 'vitest'
import { createA2AChannelAdapter } from '../src/a2a/channel-adapter.js'
import type { SendInput } from '../src/engine/api.js'
import { FakeEngine } from './fake-engine.js'

function transportMessage(overrides: Partial<Message> = {}): Message {
  return {
    messageId: 'transport-in-1',
    from: 'alice',
    to: 'bob',
    channel: 'duet',
    traceId: 'context-1',
    hop: 0,
    payload: { intent: 'review' },
    injectedByHuman: false,
    ts: nowIso(),
    status: 'delivered',
    ...overrides,
  }
}

function sentInputs(engine: FakeEngine): SendInput[] {
  return engine.calls.filter((call) => call.method === 'send').map((call) => call.args[0] as SendInput)
}

describe('A2A channel adapter', () => {
  it('delegates work as an A2A user message and resolves the only channel automatically', async () => {
    const engine = new FakeEngine({
      memberships: [{ channel: 'duet', alias: 'bob', home: 'local:/duet.db' }],
    })
    const adapter = createA2AChannelAdapter(engine)

    const result = await adapter.delegate(
      { to: 'alice', intent: 'review', context: { target: 'change-42' } },
      'agent:bob',
    )

    const sent = sentInputs(engine)[0]
    const event = tryDecodeA2AEvent(sent?.payload)
    expect(sent).toMatchObject({
      messageId: result.messageId,
      channel: 'duet',
      to: 'alice',
      contentType: A2A_MEDIA_TYPE,
      traceId: result.contextId,
    })
    expect(event?.kind).toBe('message')
    if (event?.kind !== 'message') throw new Error('expected message')
    expect(event.value.role).toBe(A2ARole.ROLE_USER)
    expect(event.value.metadata).toMatchObject({
      'https://agentcomm.dev/extensions/private-channel/v1': {
        channel: 'duet',
        to: 'alice',
        taskId: result.taskId,
      },
    })
  })

  it('replies to delegated work with an agent message, COMPLETED update, then ACKs', async () => {
    const engine = new FakeEngine()
    const adapter = createA2AChannelAdapter(engine)
    const incoming = transportMessage()

    const result = await adapter.reply(incoming, { result: 'done' }, 'agent:bob')

    const sent = sentInputs(engine)
    expect(sent).toHaveLength(2)
    const response = tryDecodeA2AEvent(sent[0]?.payload)
    const completion = tryDecodeA2AEvent(sent[1]?.payload)
    expect(response?.kind).toBe('message')
    if (response?.kind !== 'message') throw new Error('expected message')
    expect(response.value.role).toBe(A2ARole.ROLE_AGENT)
    expect(completion?.kind).toBe('status-update')
    if (completion?.kind !== 'status-update') throw new Error('expected status update')
    expect(completion.value.status?.state).toBe(A2ATaskState.TASK_STATE_COMPLETED)
    expect(result.completion).toBeDefined()
    expect(engine.calls.find((call) => call.method === 'ack')?.args[0]).toEqual({
      messageId: incoming.messageId,
    })
  })

  it('continues an interrupted task with a user message and no completion echo', async () => {
    const engine = new FakeEngine()
    const adapter = createA2AChannelAdapter(engine)
    const update = createA2AStatusUpdate({
      taskId: 'task-1',
      contextId: 'context-1',
      state: A2ATaskState.TASK_STATE_INPUT_REQUIRED,
    })
    const incoming = transportMessage({
      contentType: A2A_MEDIA_TYPE,
      payload: encodeA2AEvent({ kind: 'status-update', value: update }),
    })

    const result = await adapter.reply(incoming, { answer: 'yes' }, 'agent:bob')

    expect(sentInputs(engine)).toHaveLength(1)
    const event = tryDecodeA2AEvent(sentInputs(engine)[0]?.payload)
    expect(event?.kind).toBe('message')
    if (event?.kind !== 'message') throw new Error('expected message')
    expect(event.value.role).toBe(A2ARole.ROLE_USER)
    expect(event.value.taskId).toBe('task-1')
    expect(result.completion).toBeUndefined()
  })

  it('suspends work for approval with AUTH_REQUIRED and ACKs the triggering event', async () => {
    const original = createA2AMessage({
      messageId: 'a2a-in-1',
      role: 'user',
      payload: { intent: 'deploy' },
      contextId: 'context-approval',
      taskId: 'task-approval',
    })
    const incoming = transportMessage({
      contentType: A2A_MEDIA_TYPE,
      payload: encodeA2AEvent({ kind: 'message', value: original }),
    })
    const engine = new FakeEngine()
    const adapter = createA2AChannelAdapter(engine)

    await adapter.requestApproval(
      incoming,
      'Approve production deploy?',
      { action: 'deploy', environment: 'production' },
      'agent:bob',
    )

    const event = tryDecodeA2AEvent(sentInputs(engine)[0]?.payload)
    expect(event?.kind).toBe('status-update')
    if (event?.kind !== 'status-update') throw new Error('expected status update')
    expect(event.value.status?.state).toBe(A2ATaskState.TASK_STATE_AUTH_REQUIRED)
    expect(event.value.metadata).toEqual({
      approval: { action: 'deploy', environment: 'production' },
    })
    expect(engine.calls.find((call) => call.method === 'ack')).toBeDefined()
  })
})
