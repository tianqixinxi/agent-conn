import { AGENTCOMM_LEGACY_RAW_EXTENSION_URI, legacyRawEventSelector } from '@agent-comm/application-spec'
import type { ApplicationConsumer, VerifiedApplicationEvent } from './index.js'

export const LEGACY_RAW_COMPATIBILITY = {
  uri: AGENTCOMM_LEGACY_RAW_EXTENSION_URI,
  version: '1.0.0',
  canDisplay: true,
  canReply: true,
  canCreateTaskAuthorization: false,
  canCarryAuthorizationReceipt: false,
  canInvokeTools: false,
} as const

export interface LegacyRawInput {
  messageId: string
  channelId: string
  from: string
  body: unknown
  contextId?: string | undefined
  receivedAt?: string | undefined
}

/**
 * Adapts a pre-extension raw message into explicit compatibility data.
 * It grants no governance or task-authorization semantics.
 */
export function toLegacyRawApplicationEvent(input: LegacyRawInput): VerifiedApplicationEvent {
  return {
    messageId: input.messageId,
    channelId: input.channelId,
    from: input.from,
    selector: legacyRawEventSelector(),
    body: input.body,
    contextId: input.contextId,
    receivedAt: input.receivedAt,
  }
}

/**
 * Optional consumer for hosts that want legacy messages journaled before showing
 * them to a human/model. `ignored` deliberately keeps normal display/reply flow.
 */
export function createLegacyRawCompatibilityConsumer(): ApplicationConsumer {
  return {
    id: 'agentcomm.legacy-raw-display',
    version: LEGACY_RAW_COMPATIBILITY.version,
    supports: [
      {
        uri: LEGACY_RAW_COMPATIBILITY.uri,
        version: LEGACY_RAW_COMPATIBILITY.version,
      },
    ],
    handle: () => ({
      status: 'ignored',
      effects: [],
      taskState: 'active',
    }),
  }
}
