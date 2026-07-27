import {
  type ApplicationConformanceFixture,
  ApplicationConformanceFixtureSchema,
} from '@agent-comm/application-spec'
import type { ApplicationConsumerRegistry, VerifiedApplicationEvent } from './index.js'
import { ApplicationRuntime, InMemoryApplicationRuntimeStore } from './runtime.js'

export interface ApplicationConformanceObservation {
  state: unknown
  taskState: string
  effects: unknown[]
  eventStatuses: string[]
}

export interface ApplicationConformanceResult {
  fixture: string
  passed: boolean
  expected: unknown
  actual: ApplicationConformanceObservation
}

export interface RunApplicationConformanceOptions {
  profilePrincipal?: string | undefined
  channelId?: string | undefined
  contextId?: string | undefined
  from?: string | undefined
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Runs a portable fixture against a registered application reducer.
 *
 * The runner is intentionally transport-free: community packages can verify
 * application semantics without standing up a relay, MCP server, or model.
 */
export async function runApplicationConformanceFixture(
  rawFixture: ApplicationConformanceFixture,
  registry: ApplicationConsumerRegistry,
  options: RunApplicationConformanceOptions = {},
): Promise<ApplicationConformanceResult> {
  const fixture = ApplicationConformanceFixtureSchema.parse(rawFixture)
  const profilePrincipal = options.profilePrincipal ?? 'conformance-profile'
  const channelId = options.channelId ?? 'conformance-channel'
  const contextId = options.contextId ?? `fixture:${fixture.name}`
  const store = new InMemoryApplicationRuntimeStore()
  const runtime = new ApplicationRuntime({
    runtimeInstanceId: 'r-conformance-runtime',
    profilePrincipal,
    registry,
    store,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  })
  const eventStatuses: string[] = []

  for (const [index, input] of fixture.events.entries()) {
    const event: VerifiedApplicationEvent = {
      messageId: `fixture:${fixture.name}:${index}`,
      channelId,
      from: options.from ?? 'fixture-peer',
      selector: {
        uri: fixture.extension.uri,
        version: fixture.extension.version,
        eventType: input.eventType,
      },
      body: input.body,
      contextId,
      receivedAt: '2026-01-01T00:00:00.000Z',
    }
    const result = await runtime.process(event)
    eventStatuses.push(result.status)
  }

  const snapshot = store.getState({
    profilePrincipal,
    channelId,
    extensionUri: fixture.extension.uri,
    contextId,
  })
  const actual: ApplicationConformanceObservation = {
    state: snapshot?.state,
    taskState: snapshot?.taskState ?? 'unsupported',
    effects: store
      .listEffects(['pending', 'executing', 'applied', 'failed', 'needs-reconciliation'])
      .map((item) => item.effect),
    eventStatuses,
  }
  runtime.close()
  return {
    fixture: fixture.name,
    passed: canonicalJson(actual) === canonicalJson(fixture.expected),
    expected: fixture.expected,
    actual,
  }
}

export async function assertApplicationConformance(
  fixture: ApplicationConformanceFixture,
  registry: ApplicationConsumerRegistry,
  options?: RunApplicationConformanceOptions,
): Promise<ApplicationConformanceResult> {
  const result = await runApplicationConformanceFixture(fixture, registry, options)
  if (!result.passed) {
    throw new Error(
      `application conformance failed for ${result.fixture}\nexpected: ${JSON.stringify(
        result.expected,
      )}\nactual: ${JSON.stringify(result.actual)}`,
    )
  }
  return result
}
