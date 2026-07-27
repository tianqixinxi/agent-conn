import {
  A2A_MEDIA_TYPE,
  type A2AEvent,
  type A2AMessage,
  A2ARole,
  A2ATaskState,
  createA2AMessage,
  createA2AStatusUpdate,
  encodeA2AEvent,
  readAgentCommRouting,
  tryDecodeA2AEvent,
  withAgentCommRouting,
} from '@agent-comm/a2a-binding'
import {
  type ApplicationEventSelector,
  applicationExtensionUris,
  readApplicationEventSelector,
  withApplicationEventSelector,
} from '@agent-comm/application-spec'
import type { Message as TransportMessage } from '@agent-comm/core'
import { AgentCommError, newMessageId } from '@agent-comm/core'
import type { Actor, Engine, SendResult } from '../engine/api.js'

export interface DelegateA2AInput {
  channel?: string | undefined
  to: string
  intent: string
  context?: unknown
  mediaType?: string | undefined
}

export interface PublishApplicationEventInput {
  channel?: string | undefined
  to: string
  extensionUri: string
  extensionVersion: string
  eventType: string
  body: unknown
  mediaType?: string | undefined
  contextId?: string | undefined
}

export interface RespondApplicationEventInput {
  eventType: string
  body: unknown
  mediaType?: string | undefined
  terminal?: boolean | undefined
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
  publish(input: PublishApplicationEventInput, actor: Actor): Promise<A2ASendResult>
  respond(
    incoming: TransportMessage,
    input: RespondApplicationEventInput,
    actor: Actor,
  ): Promise<A2AReplyResult>
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
  ): Promise<{ taskId: string; contextId: string; update: SendResult }>
  reject(
    incoming: TransportMessage,
    reason: string,
    actor: Actor,
  ): Promise<{ taskId: string; contextId: string; update: SendResult }>
  readInbox(limit: number, channel?: string): Promise<A2AInboundEvent[]>
}

export interface A2AChannelAdapterOptions {
  runtimeInstanceId?: string | undefined
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

function eventApplicationSelector(event: A2AEvent | undefined): ApplicationEventSelector | undefined {
  if (event?.kind === 'message') return readApplicationEventSelector(event.value.metadata)
  if (event?.kind === 'status-update') {
    return readApplicationEventSelector(event.value.status?.message?.metadata)
  }
  return undefined
}

export function createA2AChannelAdapter(
  engine: Engine,
  options: A2AChannelAdapterOptions = {},
): A2AChannelAdapter {
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
  ): Promise<{ taskId: string; contextId: string; update: SendResult }> {
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
        runtimeInstanceId: options.runtimeInstanceId,
      },
      actor,
    )
    return { taskId, contextId, update: result }
  }

  async function publishApplicationEvent(
    input: PublishApplicationEventInput,
    actor: Actor,
  ): Promise<A2ASendResult> {
    const channel = await resolveChannel(input.channel)
    const messageId = newMessageId()
    const contextId = input.contextId ?? newMessageId()
    const taskId = derivedTaskId(messageId)
    const selector = {
      uri: input.extensionUri,
      version: input.extensionVersion,
      eventType: input.eventType,
    }
    const message = createA2AMessage({
      messageId,
      role: 'user',
      payload: input.body,
      mediaType: input.mediaType ?? 'application/json',
      contextId,
      taskId,
      metadata: withApplicationEventSelector(
        withAgentCommRouting(undefined, {
          channel,
          to: input.to,
          taskId,
          runtimeInstanceId: options.runtimeInstanceId,
        }),
        selector,
      ),
      extensions: applicationExtensionUris(selector),
    })
    const transport = await engine.send(
      {
        messageId,
        channel,
        to: input.to,
        payload: encodeA2AEvent({ kind: 'message', value: message }),
        contentType: A2A_MEDIA_TYPE,
        traceId: contextId,
        runtimeInstanceId: options.runtimeInstanceId,
      },
      actor,
    )
    return { taskId, contextId, messageId, transport }
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
          runtimeInstanceId: options.runtimeInstanceId,
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
          runtimeInstanceId: options.runtimeInstanceId,
        },
        actor,
      )
      return { taskId, contextId, messageId, transport }
    },

    publish: publishApplicationEvent,

    async respond(incoming, input, actor) {
      const { event, contextId, taskId } = messageContext(incoming)
      if (!event || (event.kind !== 'message' && event.kind !== 'status-update')) {
        throw new AgentCommError('INVALID_INPUT', 'application responses require an A2A message event')
      }
      const incomingSelector = eventApplicationSelector(event)
      if (!incomingSelector) {
        throw new AgentCommError('INVALID_INPUT', 'event does not declare an application extension')
      }
      const continuingTask =
        (event.kind === 'message' && event.value.role === A2ARole.ROLE_AGENT) ||
        (event.kind === 'status-update' &&
          (event.value.status?.state === A2ATaskState.TASK_STATE_INPUT_REQUIRED ||
            event.value.status?.state === A2ATaskState.TASK_STATE_AUTH_REQUIRED))
      const selector = { ...incomingSelector, eventType: input.eventType }
      const responseId = newMessageId()
      const message = createA2AMessage({
        messageId: responseId,
        role: continuingTask ? 'user' : 'agent',
        payload: input.body,
        mediaType: input.mediaType ?? 'application/json',
        contextId,
        taskId,
        metadata: withApplicationEventSelector(
          withAgentCommRouting(undefined, {
            channel: incoming.channel,
            to: incoming.from,
            from: incoming.to,
            replyTo: incoming.messageId,
            taskId,
            runtimeInstanceId: options.runtimeInstanceId,
          }),
          selector,
        ),
        extensions: applicationExtensionUris(selector),
      })
      const response = await engine.send(
        {
          messageId: responseId,
          channel: incoming.channel,
          to: incoming.from,
          payload: encodeA2AEvent({ kind: 'message', value: message }),
          contentType: A2A_MEDIA_TYPE,
          replyTo: incoming.messageId,
          traceId: contextId,
          runtimeInstanceId: options.runtimeInstanceId,
        },
        actor,
      )
      const completion =
        input.terminal === true
          ? (await sendStatus(incoming, A2ATaskState.TASK_STATE_COMPLETED, actor)).update
          : undefined
      await engine.ack({ messageId: incoming.messageId })
      return { taskId, contextId, response, ...(completion ? { completion } : {}) }
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
          runtimeInstanceId: options.runtimeInstanceId,
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
          runtimeInstanceId: options.runtimeInstanceId,
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
      return result
    },

    async reject(incoming, reason, actor) {
      const { contextId, taskId } = messageContext(incoming)
      const message = createA2AMessage({
        role: 'agent',
        payload: reason,
        mediaType: 'text/plain',
        contextId,
        taskId,
      })
      const result = await sendStatus(incoming, A2ATaskState.TASK_STATE_REJECTED, actor, message)
      await engine.ack({ messageId: incoming.messageId })
      return result
    },

    async readInbox(limit, channel) {
      const messages = await engine.readInbox({
        consume: false,
        limit,
        ...(channel === undefined ? {} : { filter: { channel } }),
      })
      return messages.map((transport) => ({
        transport,
        event: tryDecodeA2AEvent(transport.payload),
      }))
    },
  }
}
