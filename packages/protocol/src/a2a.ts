import type {
  AgentCard as SdkAgentCard,
  Artifact as SdkArtifact,
  Message as SdkMessage,
  Part as SdkPart,
  SendMessageRequest as SdkSendMessageRequest,
  SendMessageResponse as SdkSendMessageResponse,
  Task as SdkTask,
  TaskArtifactUpdateEvent as SdkTaskArtifactUpdateEvent,
  TaskStatusUpdateEvent as SdkTaskStatusUpdateEvent,
} from '@a2a-js/sdk'
import {
  AgentCard as AgentCardCodec,
  Artifact as ArtifactCodec,
  Message as MessageCodec,
  Role,
  SendMessageRequest as SendMessageRequestCodec,
  SendMessageResponse as SendMessageResponseCodec,
  TaskArtifactUpdateEvent as TaskArtifactUpdateEventCodec,
  Task as TaskCodec,
  TaskState,
  TaskStatusUpdateEvent as TaskStatusUpdateEventCodec,
} from '@a2a-js/sdk'
import { z } from 'zod'
import { newMessageId, nowIso } from './ids.js'
import { WIRE_HEADERS } from './wire.js'

/** A2A v1 is the canonical AgentComm application protocol. */
export const A2A_PROTOCOL_VERSION = '1.0' as const
export const A2A_MEDIA_TYPE = 'application/a2a+json' as const

/**
 * AgentComm keeps invitation, channel membership and encrypted routing as an A2A extension. The
 * task/message/artifact objects themselves remain the official A2A v1 data model.
 */
export const AGENTCOMM_A2A_EXTENSION_URI = 'https://agentcomm.dev/extensions/private-channel/v1' as const
export const AGENTCOMM_LOCAL_BINDING_URI = 'https://agentcomm.dev/bindings/local-store-forward/v1' as const
export const AGENTCOMM_RELAY_BINDING_URI = 'https://agentcomm.dev/bindings/http-store-forward/v1' as const
export const AGENTCOMM_NATS_BINDING_URI = 'https://agentcomm.dev/bindings/nats-jetstream/v1' as const
export const AGENTCOMM_SLIM_BINDING_URI = 'https://agentcomm.dev/bindings/agntcy-slim/v1' as const

export { Role as A2ARole, TaskState as A2ATaskState }
export type A2AAgentCard = SdkAgentCard
export type A2AArtifact = SdkArtifact
export type A2AMessage = SdkMessage
export type A2ASendMessageRequest = SdkSendMessageRequest
export type A2ASendMessageResponse = SdkSendMessageResponse
export type A2APart = SdkPart
export type A2ATask = SdkTask
export type A2ATaskArtifactUpdateEvent = SdkTaskArtifactUpdateEvent
export type A2ATaskStatusUpdateEvent = SdkTaskStatusUpdateEvent

export type A2AEvent =
  | { kind: 'message'; value: A2AMessage }
  | { kind: 'task'; value: A2ATask }
  | { kind: 'status-update'; value: A2ATaskStatusUpdateEvent }
  | { kind: 'artifact-update'; value: A2ATaskArtifactUpdateEvent }

const A2AFrameSchema = z.object({
  protocolVersion: z.literal(A2A_PROTOCOL_VERSION),
  kind: z.enum(['message', 'task', 'status-update', 'artifact-update']),
  value: z.unknown(),
})

export type A2AFrame = z.infer<typeof A2AFrameSchema>

function assertNonEmpty(value: string, field: string): void {
  if (!value) throw new Error(`invalid A2A event: ${field} is required`)
}

/** Serialize official SDK objects into a transport-neutral A2A frame. */
export function encodeA2AEvent(event: A2AEvent): A2AFrame {
  switch (event.kind) {
    case 'message':
      return {
        protocolVersion: A2A_PROTOCOL_VERSION,
        kind: event.kind,
        value: MessageCodec.toJSON(event.value),
      }
    case 'task':
      return {
        protocolVersion: A2A_PROTOCOL_VERSION,
        kind: event.kind,
        value: TaskCodec.toJSON(event.value),
      }
    case 'status-update':
      return {
        protocolVersion: A2A_PROTOCOL_VERSION,
        kind: event.kind,
        value: TaskStatusUpdateEventCodec.toJSON(event.value),
      }
    case 'artifact-update':
      return {
        protocolVersion: A2A_PROTOCOL_VERSION,
        kind: event.kind,
        value: TaskArtifactUpdateEventCodec.toJSON(event.value),
      }
  }
}

/** Parse a frame with the official SDK codecs. Returns undefined for legacy opaque payloads. */
export function tryDecodeA2AEvent(input: unknown): A2AEvent | undefined {
  const frame = A2AFrameSchema.safeParse(input)
  if (!frame.success) return undefined
  switch (frame.data.kind) {
    case 'message': {
      const value = MessageCodec.fromJSON(frame.data.value)
      assertNonEmpty(value.messageId, 'message.messageId')
      return { kind: frame.data.kind, value }
    }
    case 'task': {
      const value = TaskCodec.fromJSON(frame.data.value)
      assertNonEmpty(value.id, 'task.id')
      assertNonEmpty(value.contextId, 'task.contextId')
      return { kind: frame.data.kind, value }
    }
    case 'status-update': {
      const value = TaskStatusUpdateEventCodec.fromJSON(frame.data.value)
      assertNonEmpty(value.taskId, 'statusUpdate.taskId')
      assertNonEmpty(value.contextId, 'statusUpdate.contextId')
      return { kind: frame.data.kind, value }
    }
    case 'artifact-update': {
      const value = TaskArtifactUpdateEventCodec.fromJSON(frame.data.value)
      assertNonEmpty(value.taskId, 'artifactUpdate.taskId')
      assertNonEmpty(value.contextId, 'artifactUpdate.contextId')
      return { kind: frame.data.kind, value }
    }
  }
}

export function payloadToA2AParts(payload: unknown, mediaType = 'application/json'): A2APart[] {
  if (typeof payload === 'string' && mediaType.startsWith('text/')) {
    return [
      {
        content: { $case: 'text', value: payload },
        metadata: undefined,
        filename: '',
        mediaType,
      },
    ]
  }
  return [
    {
      content: { $case: 'data', value: payload },
      metadata: undefined,
      filename: '',
      mediaType,
    },
  ]
}

export function a2aPartsToPayload(parts: A2APart[]): unknown {
  const values = parts.map((part) => {
    switch (part.content?.$case) {
      case 'text':
      case 'url':
      case 'data':
        return part.content.value
      case 'raw':
        return Buffer.from(part.content.value).toString('base64')
      default:
        return undefined
    }
  })
  return values.length === 1 ? values[0] : values
}

export interface CreateA2AMessageInput {
  messageId?: string | undefined
  role: 'user' | 'agent'
  payload: unknown
  mediaType?: string | undefined
  contextId?: string | undefined
  taskId?: string | undefined
  metadata?: Record<string, unknown> | undefined
  referenceTaskIds?: string[] | undefined
}

export function createA2AMessage(input: CreateA2AMessageInput): A2AMessage {
  return {
    messageId: input.messageId ?? newMessageId(),
    contextId: input.contextId ?? '',
    taskId: input.taskId ?? '',
    role: input.role === 'user' ? Role.ROLE_USER : Role.ROLE_AGENT,
    parts: payloadToA2AParts(input.payload, input.mediaType),
    metadata: input.metadata,
    extensions: [AGENTCOMM_A2A_EXTENSION_URI],
    referenceTaskIds: input.referenceTaskIds ?? [],
  }
}

export interface CreateA2AStatusUpdateInput {
  taskId: string
  contextId: string
  state: TaskState
  message?: A2AMessage | undefined
  metadata?: Record<string, unknown> | undefined
}

export function createA2AStatusUpdate(input: CreateA2AStatusUpdateInput): A2ATaskStatusUpdateEvent {
  return {
    taskId: input.taskId,
    contextId: input.contextId,
    status: { state: input.state, message: input.message, timestamp: nowIso() },
    metadata: input.metadata,
  }
}

export function isA2ATerminalState(state: TaskState): boolean {
  return (
    state === TaskState.TASK_STATE_COMPLETED ||
    state === TaskState.TASK_STATE_FAILED ||
    state === TaskState.TASK_STATE_CANCELED ||
    state === TaskState.TASK_STATE_REJECTED
  )
}

export interface AgentCommRoutingMetadata {
  channel: string
  to: string
  from?: string | undefined
  replyTo?: string | undefined
  taskId?: string | undefined
}

export function withAgentCommRouting(
  metadata: Record<string, unknown> | undefined,
  routing: AgentCommRoutingMetadata,
): Record<string, unknown> {
  return { ...(metadata ?? {}), [AGENTCOMM_A2A_EXTENSION_URI]: routing }
}

export function readAgentCommRouting(message: A2AMessage): AgentCommRoutingMetadata | undefined {
  const raw = message.metadata?.[AGENTCOMM_A2A_EXTENSION_URI]
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.channel !== 'string' || typeof record.to !== 'string') return undefined
  return {
    channel: record.channel,
    to: record.to,
    ...(typeof record.from === 'string' ? { from: record.from } : {}),
    ...(typeof record.replyTo === 'string' ? { replyTo: record.replyTo } : {}),
    ...(typeof record.taskId === 'string' ? { taskId: record.taskId } : {}),
  }
}

export interface CreateAgentCommAgentCardInput {
  name: string
  description?: string | undefined
  endpoint: string
  protocolBinding: 'HTTP+JSON' | 'JSONRPC' | 'GRPC' | string
  skillDescription?: string | undefined
}

export function createAgentCommAgentCard(input: CreateAgentCommAgentCardInput): A2AAgentCard {
  const signedHeaders = {
    agentcommNode: {
      scheme: {
        $case: 'apiKeySecurityScheme' as const,
        value: {
          description: 'AgentComm Ed25519 node identity.',
          location: 'header',
          name: WIRE_HEADERS.node,
        },
      },
    },
    agentcommTimestamp: {
      scheme: {
        $case: 'apiKeySecurityScheme' as const,
        value: {
          description: 'Unix epoch milliseconds included in the request signature.',
          location: 'header',
          name: WIRE_HEADERS.ts,
        },
      },
    },
    agentcommSignature: {
      scheme: {
        $case: 'apiKeySecurityScheme' as const,
        value: {
          description: 'Base64url Ed25519 signature over the AgentComm canonical request.',
          location: 'header',
          name: WIRE_HEADERS.signature,
        },
      },
    },
  }
  const securityRequirement = {
    schemes: {
      agentcommNode: { list: [] },
      agentcommTimestamp: { list: [] },
      agentcommSignature: { list: [] },
    },
  }
  const card: A2AAgentCard = {
    name: input.name,
    description: input.description ?? `AgentComm runtime ${input.name}`,
    supportedInterfaces: [
      {
        url: input.endpoint,
        protocolBinding: input.protocolBinding,
        tenant: '',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: undefined,
    version: '0.1.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [
        {
          uri: AGENTCOMM_A2A_EXTENSION_URI,
          description: 'Private invitation, channel membership, routing and E2E metadata.',
          required: true,
          params: undefined,
        },
      ],
    },
    securitySchemes: signedHeaders,
    securityRequirements: [securityRequirement],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      {
        id: 'private-channel-collaboration',
        name: 'Private channel collaboration',
        description: input.skillDescription ?? 'Receive, execute and report delegated work.',
        tags: ['collaboration', 'delegation', 'private-channel'],
        examples: [],
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['text/plain', 'application/json'],
        securityRequirements: [securityRequirement],
      },
    ],
    signatures: [],
  }
  // Round-trip once through the official codec so SDK/schema drift fails close during development.
  return AgentCardCodec.fromJSON(AgentCardCodec.toJSON(card))
}

export function a2aEventToJson(event: A2AEvent): unknown {
  return encodeA2AEvent(event).value
}

export function a2aMessageFromJson(value: unknown): A2AMessage {
  const message = MessageCodec.fromJSON(value)
  assertNonEmpty(message.messageId, 'message.messageId')
  return message
}

export function a2aSendMessageRequestFromJson(value: unknown): A2ASendMessageRequest {
  const request = SendMessageRequestCodec.fromJSON(value)
  if (!request.message) throw new Error('invalid A2A request: message is required')
  assertNonEmpty(request.message.messageId, 'message.messageId')
  return request
}

export function a2aSendMessageResponseToJson(value: A2ASendMessageResponse): unknown {
  return SendMessageResponseCodec.toJSON(value)
}

export function a2aTaskToJson(task: A2ATask): unknown {
  return TaskCodec.toJSON(task)
}

export function a2aAgentCardToJson(card: A2AAgentCard): unknown {
  return AgentCardCodec.toJSON(card)
}

export function a2aArtifactToJson(artifact: A2AArtifact): unknown {
  return ArtifactCodec.toJSON(artifact)
}
