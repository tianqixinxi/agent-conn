import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type ApplicationConformanceFixture,
  ApplicationConformanceFixtureSchema,
  type ApplicationExtensionManifest,
  ApplicationExtensionManifestSchema,
} from '@agent-comm/application-spec'
import { z } from 'zod'

const MAX_REMOTE_MANIFEST_BYTES = 1_000_000

const EnabledApplicationSchema = z.object({
  channelId: z.string().min(1),
  config: z.unknown().optional(),
})

export const InstalledApplicationSchema = z.object({
  uri: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  source: z.string().min(1),
  packageDir: z.string().min(1),
  manifestPath: z.string().min(1),
  installedAt: z.string().datetime(),
  executableTrusted: z.boolean().default(false),
  enabled: z.array(EnabledApplicationSchema).default([]),
})

export type InstalledApplication = z.infer<typeof InstalledApplicationSchema>

const CatalogStateSchema = z.object({
  schemaVersion: z.literal(1),
  applications: z.array(InstalledApplicationSchema).default([]),
})

export const ApplicationRegistryEntrySchema = z.object({
  uri: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(''),
  manifestUrl: z.url(),
  publisher: z.string().optional(),
})

export const ApplicationRegistryIndexSchema = z.object({
  schemaVersion: z.literal(1),
  applications: z.array(ApplicationRegistryEntrySchema),
})

export type ApplicationRegistryEntry = z.infer<typeof ApplicationRegistryEntrySchema>

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return left.localeCompare(right)
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

function manifestCandidate(source: string): string {
  if (!existsSync(source)) throw new Error(`application package does not exist: ${source}`)
  for (const name of ['agentcomm.application.json', 'manifest.json', 'spec/manifest.json']) {
    const candidate = join(source, name)
    if (existsSync(candidate)) return candidate
  }
  return source
}

function readLocalManifest(source: string): {
  manifest: ApplicationExtensionManifest
  manifestPath: string
  packageRoot: string
} {
  const absolute = resolve(source)
  const manifestPath = manifestCandidate(absolute)
  const manifest = ApplicationExtensionManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
  const packageRoot = existsSync(join(absolute, 'agentcomm.application.json'))
    ? absolute
    : basename(manifestPath) === 'manifest.json' && basename(dirname(manifestPath)) === 'spec'
      ? dirname(dirname(manifestPath))
      : dirname(manifestPath)
  return { manifest, manifestPath, packageRoot }
}

async function readRemoteManifest(source: string): Promise<ApplicationExtensionManifest> {
  const url = new URL(source)
  if (url.protocol !== 'https:') throw new Error('remote application manifests must use https:')
  const response = await fetch(url, { redirect: 'error' })
  if (!response.ok) throw new Error(`application manifest returned HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length') ?? '0')
  if (length > MAX_REMOTE_MANIFEST_BYTES) throw new Error('application manifest is too large')
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_REMOTE_MANIFEST_BYTES) {
    throw new Error('application manifest is too large')
  }
  return ApplicationExtensionManifestSchema.parse(JSON.parse(text))
}

export interface InstallApplicationOptions {
  allowCode?: boolean | undefined
}

export interface LoadedApplicationConsumerModule {
  createConsumer?: ((config: unknown) => unknown) | undefined
  [key: string]: unknown
}

export class FileApplicationCatalog {
  readonly rootDir: string
  readonly statePath: string
  readonly packagesDir: string

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir)
    this.statePath = join(this.rootDir, 'catalog.json')
    this.packagesDir = join(this.rootDir, 'packages')
    mkdirSync(this.packagesDir, { recursive: true, mode: 0o700 })
  }

  #read(): z.infer<typeof CatalogStateSchema> {
    if (!existsSync(this.statePath)) return { schemaVersion: 1, applications: [] }
    return CatalogStateSchema.parse(JSON.parse(readFileSync(this.statePath, 'utf8')))
  }

  #write(state: z.infer<typeof CatalogStateSchema>): void {
    atomicWrite(this.statePath, CatalogStateSchema.parse(state))
  }

  list(): InstalledApplication[] {
    return this.#read().applications
  }

  get(uri: string, version?: string): InstalledApplication | undefined {
    return this.#read()
      .applications.filter((item) => item.uri === uri && (version === undefined || item.version === version))
      .sort((a, b) => compareVersions(b.version, a.version))[0]
  }

  async install(source: string, options: InstallApplicationOptions = {}): Promise<InstalledApplication> {
    const remote = /^https:\/\//.test(source)
    const local = remote ? undefined : readLocalManifest(source)
    const manifest = remote ? await readRemoteManifest(source) : local?.manifest
    if (!manifest) throw new Error('application manifest could not be loaded')
    if (remote && manifest.runtime) {
      throw new Error(
        'remote executable application packages are not supported; download and review the complete package before installing it locally',
      )
    }
    if (manifest.runtime && !options.allowCode) {
      throw new Error(
        'application includes executable consumer code; repeat installation with allowCode after reviewing it',
      )
    }

    const packageDir = join(this.packagesDir, hash(manifest.uri), manifest.version)
    rmSync(packageDir, { recursive: true, force: true })
    mkdirSync(packageDir, { recursive: true, mode: 0o700 })
    let installedManifestPath: string
    if (local) {
      cpSync(local.packageRoot, packageDir, { recursive: true, force: true })
      const relative = local.manifestPath.slice(local.packageRoot.length).replace(/^[/\\]/, '')
      installedManifestPath = join(packageDir, relative)
    } else {
      installedManifestPath = join(packageDir, 'agentcomm.application.json')
      writeFileSync(installedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    }

    const state = this.#read()
    const previous = state.applications.find(
      (item) => item.uri === manifest.uri && item.version === manifest.version,
    )
    const record: InstalledApplication = InstalledApplicationSchema.parse({
      uri: manifest.uri,
      name: manifest.name,
      version: manifest.version,
      source,
      packageDir,
      manifestPath: installedManifestPath,
      installedAt: new Date().toISOString(),
      executableTrusted: Boolean(manifest.runtime && options.allowCode),
      enabled: previous?.enabled ?? [],
    })
    state.applications = state.applications.filter(
      (item) => !(item.uri === record.uri && item.version === record.version),
    )
    state.applications.push(record)
    this.#write(state)
    return record
  }

  /**
   * Installs a newer package while carrying forward explicit channel bindings.
   * The old version remains installed for rollback; only an explicit update
   * inherits bindings, so a side-by-side install never silently activates code.
   */
  async update(source: string, options: InstallApplicationOptions = {}): Promise<InstalledApplication> {
    const before = this.#read().applications
    const installed = await this.install(source, options)
    const previous = before
      .filter((item) => item.uri === installed.uri && item.version !== installed.version)
      .sort((a, b) => b.installedAt.localeCompare(a.installedAt))[0]
    if (!previous || installed.enabled.length > 0) return installed
    const state = this.#read()
    const current = state.applications.find(
      (item) => item.uri === installed.uri && item.version === installed.version,
    )
    if (!current) return installed
    current.enabled = previous.enabled.map((item) => ({ ...item }))
    this.#write(state)
    return current
  }

  remove(uri: string, version?: string): boolean {
    const state = this.#read()
    const removed = state.applications.filter(
      (item) => item.uri === uri && (version === undefined || item.version === version),
    )
    if (removed.length === 0) return false
    state.applications = state.applications.filter((item) => !removed.includes(item))
    for (const item of removed) rmSync(item.packageDir, { recursive: true, force: true })
    this.#write(state)
    return true
  }

  enable(uri: string, channelId: string, config?: unknown): InstalledApplication {
    const state = this.#read()
    const matches = state.applications
      .filter((item) => item.uri === uri)
      .sort((a, b) => compareVersions(b.version, a.version))
    const application = matches[0]
    if (!application) throw new Error(`application is not installed: ${uri}`)
    application.enabled = application.enabled.filter((item) => item.channelId !== channelId)
    application.enabled.push({ channelId, ...(config === undefined ? {} : { config }) })
    this.#write(state)
    return application
  }

  disable(uri: string, channelId: string): boolean {
    const state = this.#read()
    let changed = false
    for (const application of state.applications.filter((item) => item.uri === uri)) {
      const before = application.enabled.length
      application.enabled = application.enabled.filter((item) => item.channelId !== channelId)
      changed ||= before !== application.enabled.length
    }
    if (changed) this.#write(state)
    return changed
  }

  enabledForChannels(channelIds: readonly string[]): InstalledApplication[] {
    const channels = new Set(channelIds)
    const enabled = this.#read().applications.filter((item) =>
      item.enabled.some((binding) => channels.has(binding.channelId) || binding.channelId === '*'),
    )
    const latest = new Map<string, InstalledApplication>()
    for (const application of enabled) {
      const previous = latest.get(application.uri)
      if (!previous || compareVersions(application.version, previous.version) > 0) {
        latest.set(application.uri, application)
      }
    }
    return [...latest.values()]
  }

  manifest(application: InstalledApplication): ApplicationExtensionManifest {
    return ApplicationExtensionManifestSchema.parse(
      JSON.parse(readFileSync(application.manifestPath, 'utf8')),
    )
  }

  async loadConsumer(application: InstalledApplication): Promise<{
    factory: (config: unknown) => unknown
    configByChannel: ReadonlyMap<string, unknown>
  }> {
    const manifest = this.manifest(application)
    if (!manifest.runtime) throw new Error(`application has no executable consumer: ${application.uri}`)
    if (!application.executableTrusted) {
      throw new Error(`application consumer code is not trusted: ${application.uri}`)
    }
    const entry = resolve(application.packageDir, manifest.runtime.entry)
    if (!entry.startsWith(`${application.packageDir}/`)) throw new Error('runtime entry escaped package root')
    const module = (await import(pathToFileURL(entry).href)) as LoadedApplicationConsumerModule
    const candidate = module[manifest.runtime.export]
    if (typeof candidate !== 'function') {
      throw new Error(`consumer export not found: ${manifest.runtime.export}`)
    }
    return {
      factory: candidate as (config: unknown) => unknown,
      configByChannel: new Map(application.enabled.map((item) => [item.channelId, item.config])),
    }
  }
}

export async function fetchApplicationRegistry(url: string): Promise<ApplicationRegistryEntry[]> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'file:') {
    throw new Error('application registry must use https: or file:')
  }
  const raw =
    parsed.protocol === 'file:'
      ? readFileSync(parsed, 'utf8')
      : await (async () => {
          const response = await fetch(parsed, { redirect: 'error' })
          if (!response.ok) throw new Error(`application registry returned HTTP ${response.status}`)
          return response.text()
        })()
  return ApplicationRegistryIndexSchema.parse(JSON.parse(raw)).applications
}

export async function searchApplicationRegistry(
  url: string,
  query: string,
): Promise<ApplicationRegistryEntry[]> {
  const normalized = query.trim().toLowerCase()
  const entries = await fetchApplicationRegistry(url)
  if (!normalized) return entries
  return entries.filter((entry) =>
    [entry.name, entry.uri, entry.description, entry.publisher ?? ''].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  )
}

export function validateApplicationPackage(source: string): {
  manifest: ApplicationExtensionManifest
  fixtures: ApplicationConformanceFixture[]
} {
  const local = readLocalManifest(source)
  const fixturePathCandidates = [
    join(local.packageRoot, 'conformance.json'),
    join(local.packageRoot, 'spec', 'conformance.json'),
  ]
  const fixturePath = fixturePathCandidates.find(existsSync)
  const rawFixtures = fixturePath ? JSON.parse(readFileSync(fixturePath, 'utf8')) : []
  const fixtures = z.array(ApplicationConformanceFixtureSchema).parse(rawFixtures)
  return { manifest: local.manifest, fixtures }
}

export interface ScaffoldApplicationOptions {
  name: string
  uri: string
  description?: string | undefined
}

export function scaffoldApplicationPackage(directory: string, options: ScaffoldApplicationOptions): string {
  const target = resolve(directory)
  if (existsSync(target)) throw new Error(`target already exists: ${target}`)
  mkdirSync(join(target, 'spec'), { recursive: true, mode: 0o755 })
  const slug = options.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const eventSchemaUri = `${options.uri.replace(/\/$/, '')}/events.schema.json#/$defs/message`
  const manifest = ApplicationExtensionManifestSchema.parse({
    schemaVersion: '1',
    uri: options.uri,
    name: options.name,
    version: '1.0.0',
    description: options.description ?? `${options.name} AgentComm collaboration protocol.`,
    license: 'Apache-2.0',
    baseProtocol: 'a2a/1.0',
    mediaTypes: ['application/json'],
    compatibility: { major: 1, backwardCompatibleFrom: '1.0.0' },
    eventSchemas: { 'message.sent': { uri: eventSchemaUri } },
  })
  atomicWrite(join(target, 'agentcomm.application.json'), manifest)
  atomicWrite(join(target, 'spec', 'events.schema.json'), {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${options.uri.replace(/\/$/, '')}/events.schema.json`,
    $defs: {
      message: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1 } },
      },
    },
  })
  atomicWrite(join(target, 'conformance.json'), [
    {
      name: `${slug || 'application'}-message`,
      extension: { uri: options.uri, version: '1.0.0' },
      events: [{ eventType: 'message.sent', body: { text: 'hello' } }],
      expected: {},
    },
  ])
  writeFileSync(
    join(target, 'README.md'),
    `# ${options.name}\n\nAgentComm application protocol: \`${options.uri}\`.\n`,
  )
  return target
}
