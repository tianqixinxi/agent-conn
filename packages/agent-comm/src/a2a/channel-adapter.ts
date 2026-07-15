import type { Message as TransportMessage } from '@agent-comm/protocol'
import {
  A2A_MEDIA_TYPE,
  type A2AEvent,
  type A2AMessage,
  A2ARole,
  A2ATaskState,
  AgentCommError,
  createA2AMessage,
  createA2AStatusUpdate,
  encodeA2AEvent,
  newMessageId,
  readAgentCommRouting,
  tryDecodeA2AEvent,
  withAgentCommRouting,
} from '@agent-comm/protocol'
import type { Actor, Engine, SendResult } from '../engine/api.js'

export interface DelegateA2AInput {
  channel?: string | undefined
  to: string
  intent: string
  context?: unknown
  mediaType?: string | undefined
}

export interface A2ASendResult {
  taskId: string
  contextId: string
  messageId: string
  transport: SendResult
}

export interface A2AReplyResult {
  taskId: string
  contextId: string
  response: SendResult
  completion?: SendResult | undefined
}

export interface A2AInboundEvent {
  transport: TransportMessage
  event?: A2AEvent | undefined
}

export interface A2AChannelAdapter {
  delegate(input: DelegateA2AInput, actor: Actor): Promise<A2ASendResult>
  reply(
    incoming: TransportMessage,
    response: unknown,
    actor: Actor,
    mediaType?: string | undefined,
  ): Promise<A2AReplyResult>
  complete(incoming: TransportMessage, actor: Actor): Promise<{ taskId?: string | undefined }>
  requestInput(
    incoming: TransportMessage,
    prompt: string,
    actor: Actor,
  ): Promise<{ taskId: string; update: SendResult }>
  requestApproval(
    incoming: TransportMessage,
    prompt: string,
    approval: unknown,
    actor: Actor,
  ): Promise<{ taskId: string; update: SendResult }>
  readInbox(limit: number): Promise<A2AInboundEvent[]>
}

function derivedTaskId(messageId: string): string {
  return `task-${messageId}`
}

function messageContext(incoming: TransportMessage): {
  event: A2AEvent | undefined
  message: A2AMessage | undefined
  contextId: string
  taskId: string
} {
  const event = tryDecodeA2AEvent(incoming.payload)
  const message = event?.kind === 'message' ? event.value : undefined
  const routing = message ? readAgentCommRouting(message) : undefined
  const eventContextId =
    event?.kind === 'task' || event?.kind === 'status-update' || event?.kind === 'artifact-update'
      ? event.value.contextId
      : undefined
  const eventTaskId =
    event?.kind === 'task'
      ? event.value.id
      : event?.kind === 'status-update' || event?.kind === 'artifact-update'
        ? event.value.taskId
        : undefined
  return {
    event,
    message,
    contextId: message?.contextId || eventContextId || incoming.traceId,
    taskId:
      message?.taskId ||
      eventTaskId ||
      routing?.taskId ||
      derivedTaskId(message?.messageId ?? incoming.messageId),
  }
}

export function createA2AChannelAdapter(engine: Engine): A2AChannelAdapter {
  async function resolveChannel(channel: string | undefined): Promise<string> {
    if (channel) return channel
    const who = await engine.whoami()
    const only = who.memberships[0]
    if (who.memberships.length === 1 && only) return only.channel
    throw new AgentCommError(
      'INVALID_INPUT',
      who.memberships.length === 0
        ? 'not connected to a channel'
        : 'channel is required when connected to multiple channels',
    )
  }

  async function sendStatus(
    incoming: TransportMessage,
    state: A2ATaskState,
    actor: Actor,
    statusMessage?: A2AMessage,
    metadata?: Record<string, unknown>,
  ): Promise<{ taskId: string; update: SendResult }> {
    const { contextId, taskId } = messageContext(incoming)
    const update = createA2AStatusUpdate({ taskId, contextId, state, message: statusMessage, metadata })
    const messageId = newMessageId()
    const result = await engine.send(
      {
        messageId,
        channel: incoming.channel,
        to: incoming.from,
        payload: encodeA2AEvent({ kind: 'status-update', value: update }),
        contentType: A2A_MEDIA_TYPE,
        replyTo: incoming.messageId,
        traceId: contextId,
      },
      actor,
    )
    return { taskId, update: result }
  }

  return {
    async delegate(input, actor) {
      const channel = await resolveChannel(input.channel)
      const messageId = newMessageId()
      const contextId = newMessageId()
      const taskId = derivedTaskId(messageId)
      const payload = {
        intent: input.intent,
        ...(input.context === undefined ? {} : { context: input.context }),
      }
      const message = createA2AMessage({
        messageId,
        role: 'user',
        payload,
        mediaType: input.mediaType ?? 'application/json',
        contextId,
        metadata: withAgentCommRouting(undefined, {
          channel,
          to: input.to,
          taskId,
        }),
      })
      const transport = await engine.send(
        {
          messageId,
          channel,
          to: input.to,
          payload: encodeA2AEvent({ kind: 'message', value: message }),
          contentType: A2A_MEDIA_TYPE,
          traceId: contextId,
        },
        actor,
      )
      return { taskId, contextId, messageId, transport }
    },

    async reply(incoming, response, actor, mediaType) {
      const { event, contextId, taskId } = messageContext(incoming)
      if (event?.kind === 'task' || event?.kind === 'artifact-update') {
        throw new AgentCommError('INVALID_INPUT', `cannot reply to A2A ${event.kind} event`)
      }
      const continuingTask =
        (event?.kind === 'message' && event.value.role === A2ARole.ROLE_AGENT) ||
        (event?.kind === 'status-update' &&
          (event.value.status?.state === A2ATaskState.TASK_STATE_INPUT_REQUIRED ||
            event.value.status?.state === A2ATaskState.TASK_STATE_AUTH_REQUIRED))
      const responseId = newMessageId()
      const message = createA2AMessage({
        messageId: responseId,
        role: continuingTask ? 'user' : 'agent',
        payload: response,
        mediaType: mediaType ?? 'application/json',
        contextId,
        taskId,
        metadata: withAgentCommRouting(undefined, {
          channel: incoming.channel,
          to: incoming.from,
          from: incoming.to,
          replyTo: incoming.messageId,
          taskId,
        }),
      })
      const responseResult = await engine.send(
        {
          messageId: responseId,
          channel: incoming.channel,
          to: incoming.from,
          payload: encodeA2AEvent({ kind: 'message', value: message }),
          contentType: A2A_MEDIA_TYPE,
          replyTo: incoming.messageId,
          traceId: contextId,
        },
        actor,
      )
      const completion = continuingTask
        ? undefined
        : (await sendStatus(incoming, A2ATaskState.TASK_STATE_COMPLETED, actor)).update
      await engine.ack({ messageId: incoming.messageId })
      return {
        taskId,
        contextId,
        response: responseResult,
        ...(completion ? { completion } : {}),
      }
    },

    async complete(incoming, actor) {
      const { event, message, taskId } = messageContext(incoming)
      // Only a client/user message creates work. A task update or agent response is informational and
      // acknowledging it must not create an infinite completion loop.
      if ((!event || event.kind === 'message') && (!message || message.role === A2ARole.ROLE_USER)) {
        await sendStatus(incoming, A2ATaskState.TASK_STATE_COMPLETED, actor)
      }
      await engine.ack({ messageId: incoming.messageId })
      return { taskId }
    },

    async requestInput(incoming, prompt, actor) {
      const { contextId, taskId } = messageContext(incoming)
      const message = createA2AMessage({
        role: 'agent',
        payload: prompt,
        mediaType: 'text/plain',
        contextId,
        taskId,
      })
      const result = await sendStatus(incoming, A2ATaskState.TASK_STATE_INPUT_REQUIRED, actor, message)
      await engine.ack({ messageId: incoming.messageId })
      return result
    },

    async requestApproval(incoming, prompt, approval, actor) {
      const { contextId, taskId } = messageContext(incoming)
      const message = createA2AMessage({
        role: 'agent',
        payload: prompt,
        mediaType: 'text/plain',
        contextId,
        taskId,
      })
      const result = await sendStatus(incoming, A2ATaskState.TASK_STATE_AUTH_REQUIRED, actor, message, {
        approval,
      })
      await engine.ack({ messageId: incoming.messageId })
      return result
    },

    async readInbox(limit) {
      const messages = await engine.readInbox({ consume: false, limit })
      return messages.map((transport) => ({
        transport,
        event: tryDecodeA2AEvent(transport.payload),
      }))
    },
  }
}
