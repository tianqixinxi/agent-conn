import {
  type ApplicationExtensionManifest,
  ApplicationExtensionManifestSchema,
} from '@agent-comm/application-spec'
import type {
  ApplicationConsumer,
  ApplicationConsumerResult,
  ApplicationEffect,
  VerifiedApplicationEvent,
} from '@agent-comm/client-sdk'
import { z } from 'zod'

export const REQUEST_RESPONSE_EXTENSION_URI = 'https://agentcomm.dev/community/request-response/v1' as const
export const REQUEST_RESPONSE_VERSION = '1.0.0' as const

export const REQUEST_RESPONSE_EVENT_TYPES = [
  'request.created',
  'response.created',
  'request.failed',
  'request.cancelled',
] as const

export type RequestResponseEventType = (typeof REQUEST_RESPONSE_EVENT_TYPES)[number]

const RequestSchema = z.object({
  requestId: z.string().min(1),
  prompt: z.string().min(1),
  context: z.unknown().optional(),
})
const ResponseSchema = z.object({ requestId: z.string().min(1), result: z.unknown() })
const FailedSchema = z.object({ requestId: z.string().min(1), error: z.string().min(1) })
const CancelledSchema = z.object({ requestId: z.string().min(1), reason: z.string().optional() })

const schemaByEvent = {
  'request.created': RequestSchema,
  'response.created': ResponseSchema,
  'request.failed': FailedSchema,
  'request.cancelled': CancelledSchema,
} satisfies Record<RequestResponseEventType, z.ZodType>

export interface RequestResponseState {
  requests: Record<
    string,
    {
      prompt: string
      status: 'pending' | 'completed' | 'failed' | 'cancelled'
      result?: unknown
      error?: string | undefined
    }
  >
}

export const requestResponseManifest: ApplicationExtensionManifest = ApplicationExtensionManifestSchema.parse(
  {
    schemaVersion: '1',
    uri: REQUEST_RESPONSE_EXTENSION_URI,
    name: 'Request and response',
    version: REQUEST_RESPONSE_VERSION,
    description: 'A minimal portable request, response, failure, and cancellation protocol.',
    license: 'Apache-2.0',
    baseProtocol: 'a2a/1.0',
    mediaTypes: ['application/json'],
    documentation: `${REQUEST_RESPONSE_EXTENSION_URI}/`,
    conformanceFixtures: `${REQUEST_RESPONSE_EXTENSION_URI}/conformance.json`,
    compatibility: { major: 1, backwardCompatibleFrom: '1.0.0' },
    eventSchemas: Object.fromEntries(
      REQUEST_RESPONSE_EVENT_TYPES.map((eventType) => [
        eventType,
        {
          uri: `${REQUEST_RESPONSE_EXTENSION_URI}/events.schema.json#/$defs/${eventType.replace('.', '_')}`,
        },
      ]),
    ),
  },
)

function selector(eventType: RequestResponseEventType) {
  return {
    uri: REQUEST_RESPONSE_EXTENSION_URI,
    version: REQUEST_RESPONSE_VERSION,
    eventType,
  }
}

export interface RequestResponseConsumerOptions {
  alias: string
  respond?: ((input: { prompt: string; context?: unknown; from: string }) => unknown) | undefined
}

export function createRequestResponseConsumer(options: RequestResponseConsumerOptions): ApplicationConsumer {
  return {
    id: `request-response.${options.alias}`,
    version: REQUEST_RESPONSE_VERSION,
    supports: [
      {
        uri: REQUEST_RESPONSE_EXTENSION_URI,
        version: REQUEST_RESPONSE_VERSION,
        backwardCompatibleFrom: '1.0.0',
      },
    ],
    handle(event, context): ApplicationConsumerResult {
      const eventType = event.selector.eventType as RequestResponseEventType
      const body = schemaByEvent[eventType]?.parse(event.body) as Record<string, unknown>
      if (!body) return { status: 'ignored', effects: [] }
      const state: RequestResponseState = structuredClone(
        (context.state as RequestResponseState | undefined) ?? { requests: {} },
      )
      const requestId = String(body.requestId)
      const effects: ApplicationEffect[] = []
      if (eventType === 'request.created') {
        state.requests[requestId] = { prompt: String(body.prompt), status: 'pending' }
        if (options.respond) {
          const result = options.respond({
            prompt: String(body.prompt),
            context: body.context,
            from: event.from,
          })
          effects.push({
            type: 'publish',
            to: event.from,
            selector: selector('response.created'),
            body: { requestId, result },
            contextId: context.contextId,
          })
        } else {
          effects.push({
            type: 'request-input',
            prompt: String(body.prompt),
            ...(body.context === undefined ? {} : { schema: body.context }),
          })
          return { status: 'handled', state, taskState: 'input-required', effects }
        }
      } else {
        const request = state.requests[requestId]
        if (!request) {
          state.requests[requestId] = {
            prompt: '',
            status:
              eventType === 'response.created'
                ? 'completed'
                : eventType === 'request.failed'
                  ? 'failed'
                  : 'cancelled',
          }
        }
        const current = state.requests[requestId]
        if (!current) throw new Error(`request not found: ${requestId}`)
        if (eventType === 'response.created') {
          current.status = 'completed'
          current.result = body.result
          effects.push({ type: 'complete', result: body.result })
          return { status: 'handled', state, taskState: 'completed', effects }
        }
        if (eventType === 'request.failed') {
          current.status = 'failed'
          current.error = String(body.error)
          return { status: 'handled', state, taskState: 'failed', effects }
        }
        current.status = 'cancelled'
        return { status: 'handled', state, taskState: 'canceled', effects }
      }
      return { status: 'handled', state, taskState: 'active', effects }
    },
    resume(source, outcome, context): ApplicationConsumerResult {
      if (source.selector.eventType !== 'request.created') {
        return { status: 'ignored', effects: [] }
      }
      const request = RequestSchema.parse(source.body)
      const state: RequestResponseState = structuredClone(
        (context.state as RequestResponseState | undefined) ?? { requests: {} },
      )
      const current = state.requests[request.requestId] ?? {
        prompt: request.prompt,
        status: 'pending' as const,
      }
      state.requests[request.requestId] = current
      if (outcome.status === 'failed') {
        current.status = 'failed'
        current.error = outcome.error ?? 'runtime failed'
        return {
          status: 'handled',
          state,
          taskState: 'failed',
          effects: [
            {
              type: 'publish',
              to: source.from,
              selector: selector('request.failed'),
              body: { requestId: request.requestId, error: current.error },
              contextId: context.contextId,
            },
          ],
        }
      }
      current.status = 'completed'
      current.result = outcome.result
      return {
        status: 'handled',
        state,
        taskState: 'completed',
        effects: [
          {
            type: 'publish',
            to: source.from,
            selector: selector('response.created'),
            body: { requestId: request.requestId, result: outcome.result },
            contextId: context.contextId,
          },
        ],
      }
    },
  }
}

export function requestResponseEvent(
  input: Omit<VerifiedApplicationEvent, 'selector'> & { eventType: RequestResponseEventType },
): VerifiedApplicationEvent {
  return { ...input, selector: selector(input.eventType) }
}
