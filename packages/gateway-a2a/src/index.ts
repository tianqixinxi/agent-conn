import {
  A2A_MEDIA_TYPE,
  A2A_PROTOCOL_VERSION,
  type A2AMessage,
  type A2ASendMessageRequest,
  A2ATaskState,
  a2aAgentCardToJson,
  a2aSendMessageRequestFromJson,
  a2aSendMessageResponseToJson,
  createAgentCommAgentCard,
  encodeA2AEvent,
  readAgentCommRouting,
} from '@agent-comm/a2a-binding'
import { AgentCommError, type MessageEnvelope } from '@agent-comm/core'

export const A2A_GATEWAY_RESPONSE_HEADERS = {
  'content-type': A2A_MEDIA_TYPE,
  'A2A-Version': A2A_PROTOCOL_VERSION,
} as const

export function createA2AGatewayAgentCard(origin: string): unknown {
  return a2aAgentCardToJson(
    createAgentCommAgentCard({
      name: 'AgentComm Relay',
      description: 'Store-and-forward A2A relay for private AgentComm channels.',
      endpoint: `${origin}/a2a/v1`,
      protocolBinding: 'HTTP+JSON',
      skillDescription: 'Route delegated work into an AgentComm channel.',
    }),
  )
}

export function parseA2AGatewayRequest(value: unknown, requestedVersion?: string): A2ASendMessageRequest {
  if (requestedVersion && requestedVersion !== A2A_PROTOCOL_VERSION) {
    throw new AgentCommError(
      'INVALID_INPUT',
      `unsupported A2A version ${requestedVersion}; expected ${A2A_PROTOCOL_VERSION}`,
    )
  }
  let request: A2ASendMessageRequest
  try {
    request = a2aSendMessageRequestFromJson(value)
  } catch (error) {
    throw new AgentCommError(
      'INVALID_INPUT',
      error instanceof Error ? error.message : 'invalid A2A SendMessageRequest',
    )
  }
  if (request.configuration?.returnImmediately !== true) {
    throw new AgentCommError(
      'INVALID_INPUT',
      'AgentComm delivery is asynchronous; configuration.returnImmediately must be true',
    )
  }
  return request
}

export interface A2AGatewayIngress {
  envelope: MessageEnvelope
  channelId: string
  taskId: string
  message: A2AMessage
}

export function readA2AGatewayRouting(request: A2ASendMessageRequest) {
  const message = request.message
  if (!message) throw new AgentCommError('INVALID_INPUT', 'A2A message is required')
  const routing = readAgentCommRouting(message)
  if (!routing) {
    throw new AgentCommError(
      'INVALID_INPUT',
      'message metadata is missing the AgentComm private-channel routing extension',
    )
  }
  return { message, routing }
}

export function toA2AGatewayIngress(
  request: A2ASendMessageRequest,
  memberAlias: string,
  timestamp: string,
): A2AGatewayIngress {
  const { message, routing } = readA2AGatewayRouting(request)
  return {
    channelId: routing.channel,
    taskId: routing.taskId ?? (message.taskId || `task-${message.messageId}`),
    message,
    envelope: {
      messageId: message.messageId,
      from: memberAlias,
      to: routing.to,
      channel: routing.channel,
      traceId: message.contextId || message.messageId,
      ...(routing.replyTo ? { replyTo: routing.replyTo } : {}),
      ...(routing.runtimeInstanceId ? { runtimeInstanceId: routing.runtimeInstanceId } : {}),
      hop: 0,
      contentType: A2A_MEDIA_TYPE,
      payload: encodeA2AEvent({ kind: 'message', value: message }),
      injectedByHuman: false,
      ts: timestamp,
    },
  }
}

export function createA2AGatewaySubmittedResponse(input: {
  message: A2AMessage
  taskId: string
  timestamp: string
  accepted: { status: 'pending' | 'held' | 'delivered' | 'dropped'; seq: number }
}): unknown {
  return a2aSendMessageResponseToJson({
    payload: {
      $case: 'task',
      value: {
        id: input.taskId,
        contextId: input.message.contextId || input.message.messageId,
        status: {
          state:
            input.accepted.status === 'held'
              ? A2ATaskState.TASK_STATE_AUTH_REQUIRED
              : input.accepted.status === 'dropped'
                ? A2ATaskState.TASK_STATE_REJECTED
                : A2ATaskState.TASK_STATE_SUBMITTED,
          message: undefined,
          timestamp: input.timestamp,
        },
        artifacts: [],
        history: [input.message],
        metadata: {
          transport: 'agentcomm-relay',
          transportStatus: input.accepted.status,
          sequence: input.accepted.seq,
        },
      },
    },
  })
}
