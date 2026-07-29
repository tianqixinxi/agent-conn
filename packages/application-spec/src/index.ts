import { z } from 'zod'

/**
 * Metadata key used to select a community-maintained application protocol.
 *
 * The selector is encrypted with the A2A message. Relays route the surrounding
 * AgentComm envelope and never need to parse this metadata.
 */
export const AGENTCOMM_APPLICATION_EXTENSION_URI = 'https://agentcomm.dev/extensions/application/v1' as const
export const AGENTCOMM_LEGACY_RAW_EXTENSION_URI = 'urn:agentcomm:legacy/raw-v1' as const

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export const SemanticVersionSchema = z.string().regex(SEMVER_PATTERN, 'expected a semantic version')

function isExtensionUri(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'urn:'
  } catch {
    return false
  }
}

/**
 * HTTPS identifiers are decentralized and dereferenceable. URNs are allowed for
 * built-ins, tests, and environments where dereferencing is intentionally absent.
 */
export const ApplicationExtensionUriSchema = z
  .string()
  .min(1)
  .refine(isExtensionUri, 'extension URI must use https: or urn:')

export const ApplicationEventSelectorSchema = z.object({
  uri: ApplicationExtensionUriSchema,
  version: SemanticVersionSchema,
  eventType: z.string().trim().min(1).max(160),
})

export type ApplicationEventSelector = z.infer<typeof ApplicationEventSelectorSchema>

export const ApplicationEventDefinitionSchema = z.object({
  description: z.string().trim().min(1).max(1_000).optional(),
  uri: ApplicationExtensionUriSchema,
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, 'expected a SHA-256 hex digest')
    .optional(),
})

export const ApplicationRuntimeDefinitionSchema = z.object({
  kind: z.enum(['module']),
  entry: z
    .string()
    .trim()
    .min(1)
    .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
      message: 'runtime entry must be a package-relative path',
    }),
  export: z.string().trim().min(1).max(120).default('createConsumer'),
  permissions: z.array(z.string().trim().min(1).max(160)).default([]),
})

export type ApplicationRuntimeDefinition = z.infer<typeof ApplicationRuntimeDefinitionSchema>

export const ApplicationRendererDefinitionSchema = z.object({
  entry: z
    .string()
    .trim()
    .min(1)
    .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
      message: 'renderer entry must be a package-relative path',
    }),
  mediaType: z.string().trim().min(1).max(160).default('text/html'),
})

export const ApplicationExtensionManifestSchema = z
  .object({
    schemaVersion: z.literal('1'),
    uri: ApplicationExtensionUriSchema,
    name: z.string().trim().min(1).max(120),
    version: SemanticVersionSchema,
    description: z.string().trim().min(1).max(1_000),
    license: z.string().trim().min(1).max(120).optional(),
    baseProtocol: z.literal('a2a/1.0'),
    mediaTypes: z.array(z.string().trim().min(1).max(160)).min(1),
    documentation: z.url().optional(),
    conformanceFixtures: z.url().optional(),
    compatibility: z
      .object({
        major: z.number().int().nonnegative(),
        backwardCompatibleFrom: SemanticVersionSchema.optional(),
      })
      .required(),
    runtime: ApplicationRuntimeDefinitionSchema.optional(),
    renderer: ApplicationRendererDefinitionSchema.optional(),
    eventSchemas: z
      .record(z.string().trim().min(1).max(160), ApplicationEventDefinitionSchema)
      .refine((events) => Object.keys(events).length > 0, 'at least one event is required'),
  })
  .superRefine((manifest, ctx) => {
    const current = parseSemanticVersion(manifest.version)
    if (manifest.compatibility.major !== current.major) {
      ctx.addIssue({
        code: 'custom',
        path: ['compatibility', 'major'],
        message: 'compatibility major must match the manifest version',
      })
    }
    const lower = manifest.compatibility?.backwardCompatibleFrom
      ? parseSemanticVersion(manifest.compatibility.backwardCompatibleFrom)
      : undefined
    if (lower && (lower.major !== current.major || compareSemanticVersions(lower, current) > 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['compatibility', 'backwardCompatibleFrom'],
        message: 'compatibility floor must be in the current major and no newer than version',
      })
    }
  })

export type ApplicationExtensionManifest = z.infer<typeof ApplicationExtensionManifestSchema>

export const SupportedApplicationExtensionSchema = z
  .object({
    uri: ApplicationExtensionUriSchema,
    version: SemanticVersionSchema,
    backwardCompatibleFrom: SemanticVersionSchema.optional(),
  })
  .superRefine((support, ctx) => {
    const current = parseSemanticVersion(support.version)
    const lower = support.backwardCompatibleFrom
      ? parseSemanticVersion(support.backwardCompatibleFrom)
      : current
    if (lower.major !== current.major || compareSemanticVersions(lower, current) > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['backwardCompatibleFrom'],
        message: 'compatibility floor must be in the current major and no newer than version',
      })
    }
  })

export type SupportedApplicationExtension = z.infer<typeof SupportedApplicationExtensionSchema>

export const ApplicationExtensionAdvertisementSchema = SupportedApplicationExtensionSchema.extend({
  description: z.string().trim().min(1).max(1_000).optional(),
})
export type ApplicationExtensionAdvertisement = z.infer<typeof ApplicationExtensionAdvertisementSchema>

export const ApplicationConformanceFixtureSchema = z.object({
  name: z.string().trim().min(1).max(160),
  extension: z.object({
    uri: ApplicationExtensionUriSchema,
    version: SemanticVersionSchema,
  }),
  events: z
    .array(
      z.object({
        eventType: z.string().trim().min(1).max(160),
        body: z.unknown(),
      }),
    )
    .min(1),
  expected: z.unknown(),
})

export type ApplicationConformanceFixture = z.infer<typeof ApplicationConformanceFixtureSchema>

interface ParsedSemanticVersion {
  major: number
  minor: number
  patch: number
  prerelease?: string | undefined
}

function parseSemanticVersion(value: string): ParsedSemanticVersion {
  const match = SEMVER_PATTERN.exec(value)
  if (!match) throw new Error(`invalid semantic version: ${value}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] ? { prerelease: match[4] } : {}),
  }
}

function compareSemanticVersions(a: ParsedSemanticVersion, b: ParsedSemanticVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === undefined) return 1
  if (b.prerelease === undefined) return -1
  return a.prerelease.localeCompare(b.prerelease)
}

function lowerBound(support: SupportedApplicationExtension): ParsedSemanticVersion {
  return parseSemanticVersion(support.backwardCompatibleFrom ?? support.version)
}

/**
 * Chooses the newest version understood by both peers. Compatibility is explicit:
 * no floor means "this exact version only", and major versions never interoperate.
 */
export function negotiateApplicationExtension(
  local: readonly SupportedApplicationExtension[],
  remote: readonly SupportedApplicationExtension[],
): SupportedApplicationExtension | undefined {
  const candidates: SupportedApplicationExtension[] = []
  for (const rawLocal of local) {
    const localSupport = SupportedApplicationExtensionSchema.parse(rawLocal)
    for (const rawRemote of remote) {
      const remoteSupport = SupportedApplicationExtensionSchema.parse(rawRemote)
      if (localSupport.uri !== remoteSupport.uri) continue
      const localMax = parseSemanticVersion(localSupport.version)
      const remoteMax = parseSemanticVersion(remoteSupport.version)
      if (localMax.major !== remoteMax.major) continue
      const negotiated =
        compareSemanticVersions(localMax, remoteMax) <= 0 ? localSupport.version : remoteSupport.version
      const negotiatedVersion = parseSemanticVersion(negotiated)
      if (
        compareSemanticVersions(negotiatedVersion, lowerBound(localSupport)) < 0 ||
        compareSemanticVersions(negotiatedVersion, lowerBound(remoteSupport)) < 0
      ) {
        continue
      }
      candidates.push({ uri: localSupport.uri, version: negotiated })
    }
  }
  return candidates.sort((a, b) =>
    compareSemanticVersions(parseSemanticVersion(b.version), parseSemanticVersion(a.version)),
  )[0]
}

export function withApplicationEventSelector(
  metadata: Record<string, unknown> | undefined,
  selector: ApplicationEventSelector,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [AGENTCOMM_APPLICATION_EXTENSION_URI]: ApplicationEventSelectorSchema.parse(selector),
  }
}

export function readApplicationEventSelector(
  metadata: Record<string, unknown> | undefined,
): ApplicationEventSelector | undefined {
  const parsed = ApplicationEventSelectorSchema.safeParse(metadata?.[AGENTCOMM_APPLICATION_EXTENSION_URI])
  return parsed.success ? parsed.data : undefined
}

export function applicationExtensionUris(selector: ApplicationEventSelector): string[] {
  const parsed = ApplicationEventSelectorSchema.parse(selector)
  return [AGENTCOMM_APPLICATION_EXTENSION_URI, parsed.uri]
}

export function legacyRawEventSelector(eventType = 'message.received'): ApplicationEventSelector {
  return {
    uri: AGENTCOMM_LEGACY_RAW_EXTENSION_URI,
    version: '1.0.0',
    eventType,
  }
}

/**
 * Reads application advertisements from an A2A AgentCard-like value without
 * importing the A2A SDK. Unknown capability extensions are ignored.
 */
export function readApplicationExtensionAdvertisements(card: unknown): ApplicationExtensionAdvertisement[] {
  if (!card || typeof card !== 'object') return []
  const capabilities = (card as { capabilities?: unknown }).capabilities
  if (!capabilities || typeof capabilities !== 'object') return []
  const extensions = (capabilities as { extensions?: unknown }).extensions
  if (!Array.isArray(extensions)) return []
  const result: ApplicationExtensionAdvertisement[] = []
  for (const extension of extensions) {
    if (!extension || typeof extension !== 'object') continue
    const raw = extension as {
      uri?: unknown
      description?: unknown
      params?: unknown
    }
    if (!raw.params || typeof raw.params !== 'object') continue
    const params = raw.params as Record<string, unknown>
    const parsed = ApplicationExtensionAdvertisementSchema.safeParse({
      uri: raw.uri,
      version: params.version,
      backwardCompatibleFrom: params.backwardCompatibleFrom,
      description: raw.description,
    })
    if (parsed.success) result.push(parsed.data)
  }
  return result
}
