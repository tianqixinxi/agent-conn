import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FileApplicationCatalog,
  scaffoldApplicationPackage,
  searchApplicationRegistry,
  validateApplicationPackage,
} from '../src/index.js'

describe('application catalog', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('scaffolds, installs, enables, disables, and removes a data-only package', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentcomm-catalog-'))
    const source = scaffoldApplicationPackage(join(root, 'source'), {
      name: 'Pair Review',
      uri: 'https://example.test/pair-review/v1',
    })
    expect(validateApplicationPackage(source).manifest.name).toBe('Pair Review')
    const catalog = new FileApplicationCatalog(join(root, 'catalog'))
    const installed = await catalog.install(source)
    expect(installed.executableTrusted).toBe(false)
    expect(catalog.enable(installed.uri, 'c-one', { role: 'reviewer' }).enabled).toHaveLength(1)
    expect(catalog.enabledForChannels(['c-one'])).toHaveLength(1)
    expect(catalog.disable(installed.uri, 'c-one')).toBe(true)
    expect(catalog.remove(installed.uri)).toBe(true)
  })

  it('searches a file registry without executing package code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentcomm-registry-'))
    const path = join(root, 'registry.json')
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        applications: [
          {
            uri: 'https://example.test/debate/v1',
            name: 'Debate',
            version: '1.0.0',
            description: 'Structured debate',
            manifestUrl: 'https://example.test/debate/manifest.json',
          },
        ],
      }),
    )
    const result = await searchApplicationRegistry(pathToFileURL(path).href, 'debate')
    expect(result).toHaveLength(1)
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(1)
  })

  it('updates without silently losing explicit channel bindings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentcomm-update-'))
    const v1 = scaffoldApplicationPackage(join(root, 'v1'), {
      name: 'Review',
      uri: 'https://example.test/review/v1',
    })
    const catalog = new FileApplicationCatalog(join(root, 'catalog'))
    const installed = await catalog.install(v1)
    catalog.enable(installed.uri, 'c-one', { role: 'reviewer' })

    const v2 = scaffoldApplicationPackage(join(root, 'v2'), {
      name: 'Review',
      uri: installed.uri,
    })
    const manifestPath = join(v2, 'agentcomm.application.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.version = '1.1.0'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const updated = await catalog.update(v2)

    expect(updated.version).toBe('1.1.0')
    expect(updated.enabled).toEqual([{ channelId: 'c-one', config: { role: 'reviewer' } }])
    expect(catalog.list()).toHaveLength(2)
  })

  it('never installs executable code from a remote manifest alone', async () => {
    const manifest = {
      schemaVersion: '1',
      uri: 'https://example.test/remote-worker/v1',
      name: 'Remote Worker',
      version: '1.0.0',
      description: 'Executable application fixture',
      baseProtocol: 'a2a/1.0',
      mediaTypes: ['application/json'],
      compatibility: { major: 1, backwardCompatibleFrom: '1.0.0' },
      runtime: {
        kind: 'module',
        entry: 'runtime/index.js',
        export: 'createConsumer',
        permissions: [],
      },
      eventSchemas: {
        'task.created': { uri: 'https://example.test/remote-worker/task-created.schema.json' },
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(manifest), { status: 200 })),
    )
    const root = mkdtempSync(join(tmpdir(), 'agentcomm-remote-code-'))
    const catalog = new FileApplicationCatalog(join(root, 'catalog'))

    await expect(
      catalog.install('https://example.test/remote-worker/manifest.json', { allowCode: true }),
    ).rejects.toThrow('download and review the complete package')
    expect(catalog.list()).toEqual([])
  })
})
