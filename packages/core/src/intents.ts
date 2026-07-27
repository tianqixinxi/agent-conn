import { z } from 'zod'

/**
 * L1 消息 profile(spec §8)——可选约定,不属管道。
 * 管道(L0)对 payload 不透明;这里只是发送方/接收方可自愿采用的词表。
 * contentType = `application/vnd.agentcomm.<intent>+json`
 */

export const INTENTS = [
  'brief_update',
  'post_result',
  'ask',
  'request_approval',
  'approval_decision',
  'handoff',
  'ack',
  'error',
] as const
export type Intent = (typeof INTENTS)[number]

export function intentContentType(intent: Intent): string {
  return `application/vnd.agentcomm.${intent}+json`
}

export function parseIntentContentType(contentType: string): Intent | undefined {
  const m = contentType.match(/^application\/vnd\.agentcomm\.([a-z_]+)\+json$/)
  return INTENTS.find((i) => i === m?.[1])
}

export const BriefUpdateSchema = z.object({ text: z.string() })
export const PostResultSchema = z.object({
  /** 大产出用引用(URI),别内联(R8) */
  artifactRef: z.string().optional(),
  data: z.unknown().optional(),
})
export const AskSchema = z.object({ question: z.string() })
export const RequestApprovalSchema = z.object({
  action: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  allowAccept: z.boolean().optional(),
  allowEdit: z.boolean().optional(),
  allowReject: z.boolean().optional(),
})
export const ApprovalDecisionSchema = z.object({
  decision: z.enum(['accept', 'edit', 'reject']),
  args: z.record(z.string(), z.unknown()).optional(),
})
export const HandoffSchema = z.object({ task: z.string(), contextRef: z.string().optional() })
export const AckPayloadSchema = z.object({ messageId: z.string() })
export const ErrorMsgSchema = z.object({
  code: z.enum(['failed', 'not_understood', 'refused']),
  detail: z.string().optional(),
  messageId: z.string().optional(),
})

export const IntentPayloadSchemas: Record<Intent, z.ZodTypeAny> = {
  brief_update: BriefUpdateSchema,
  post_result: PostResultSchema,
  ask: AskSchema,
  request_approval: RequestApprovalSchema,
  approval_decision: ApprovalDecisionSchema,
  handoff: HandoffSchema,
  ack: AckPayloadSchema,
  error: ErrorMsgSchema,
}
