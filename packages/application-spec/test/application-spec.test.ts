import {
  AGENTCOMM_APPLICATION_EXTENSION_URI,
  ApplicationExtensionManifestSchema,
  negotiateApplicationExtension,
  readApplicationEventSelector,
  withApplicationEventSelector,
} from '@agent-comm/application-spec'
import { describe, expect, it } from 'vitest'

const repositoryExtension = 'https://example.com/agentcomm/repository-maintenance'

describe('application extension specification', () => {
  it('validates a declarative community manifest without executable code', () => {
    const manifest = ApplicationExtensionManifestSchema.parse({
      schemaVersion: '1',
      uri: repositoryExtension,
      name: 'Repository maintenance',
      version: '1.2.0',
      description: 'Coordinates repository maintenance work.',
      baseProtocol: 'a2a/1.0',
      mediaTypes: ['application/json'],
      compatibility: { major: 1, backwardCompatibleFrom: '1.0.0' },
      eventSchemas: {
        'work.requested': {
          uri: `${repositoryExtension}/schemas/work-requested.json`,
        },
      },
    })

    expect(manifest.eventSchemas['work.requested']?.uri).toContain('work-requested.json')
    expect(manifest).not.toHaveProperty('entrypoint')
    expect(manifest).not.toHaveProperty('script')
  })

  it('rejects a compatibility floor from a different major version', () => {
    const result = ApplicationExtensionManifestSchema.safeParse({
      schemaVersion: '1',
      uri: repositoryExtension,
      name: 'Repository maintenance',
      version: '2.0.0',
      description: 'Coordinates repository maintenance work.',
      baseProtocol: 'a2a/1.0',
      mediaTypes: ['application/json'],
      compatibility: { major: 2, backwardCompatibleFrom: '1.0.0' },
      eventSchemas: {
        'work.requested': {
          uri: `${repositoryExtension}/schemas/work-requested.json`,
        },
      },
    })

    expect(result.success).toBe(false)
  })

  it('rejects a compatibility major that disagrees with the manifest version', () => {
    const result = ApplicationExtensionManifestSchema.safeParse({
      schemaVersion: '1',
      uri: repositoryExtension,
      name: 'Repository maintenance',
      version: '1.2.0',
      description: 'Coordinates repository maintenance work.',
      baseProtocol: 'a2a/1.0',
      mediaTypes: ['application/json'],
      compatibility: { major: 2 },
      eventSchemas: {
        'work.requested': {
          uri: `${repositoryExtension}/schemas/work-requested.json`,
        },
      },
    })

    expect(result.success).toBe(false)
  })

  it('negotiates the newest mutually compatible version', () => {
    const negotiated = negotiateApplicationExtension(
      [{ uri: repositoryExtension, version: '1.4.0', backwardCompatibleFrom: '1.1.0' }],
      [{ uri: repositoryExtension, version: '1.2.0', backwardCompatibleFrom: '1.0.0' }],
    )

    expect(negotiated).toEqual({ uri: repositoryExtension, version: '1.2.0' })
    expect(
      negotiateApplicationExtension(
        [{ uri: repositoryExtension, version: '2.0.0' }],
        [{ uri: repositoryExtension, version: '1.9.0', backwardCompatibleFrom: '1.0.0' }],
      ),
    ).toBeUndefined()
  })

  it('round-trips an application selector under the stable metadata key', () => {
    const metadata = withApplicationEventSelector(undefined, {
      uri: repositoryExtension,
      version: '1.2.0',
      eventType: 'work.requested',
    })

    expect(metadata).toHaveProperty(AGENTCOMM_APPLICATION_EXTENSION_URI)
    expect(readApplicationEventSelector(metadata)).toEqual({
      uri: repositoryExtension,
      version: '1.2.0',
      eventType: 'work.requested',
    })
  })
})
