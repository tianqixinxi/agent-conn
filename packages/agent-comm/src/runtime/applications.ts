import { FileApplicationCatalog, type InstalledApplication } from '@agent-comm/application-catalog'
import { type ApplicationConsumer, ApplicationConsumerRegistry } from '@agent-comm/client-sdk'
import { createManagerWorkersConsumer, MANAGER_WORKERS_EXTENSION_URI } from '@agent-comm/manager-workers'
import { createRequestResponseConsumer, REQUEST_RESPONSE_EXTENSION_URI } from '@agent-comm/request-response'
import type { ProfilePaths } from '../config.js'

function objectConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function builtInConsumer(
  application: InstalledApplication,
  rawConfig: unknown,
  defaultAlias: string,
): ApplicationConsumer | undefined {
  const config = objectConfig(rawConfig)
  if (application.uri === MANAGER_WORKERS_EXTENSION_URI) {
    const role = config.role === 'manager' ? 'manager' : 'worker'
    return createManagerWorkersConsumer({
      role,
      alias: typeof config.alias === 'string' ? config.alias : defaultAlias,
      managerAlias: typeof config.managerAlias === 'string' ? config.managerAlias : undefined,
      autoResult: config.autoResult,
    })
  }
  if (application.uri === REQUEST_RESPONSE_EXTENSION_URI) {
    return createRequestResponseConsumer({
      alias: typeof config.alias === 'string' ? config.alias : defaultAlias,
      ...(config.staticResponse === undefined
        ? {}
        : { respond: () => structuredClone(config.staticResponse) }),
    })
  }
  return undefined
}

/**
 * Loads only applications explicitly enabled for one of this runtime's
 * channels. Remote messages never reach this function and therefore cannot
 * install or activate code.
 */
export async function createConfiguredApplicationRegistry(
  profile: ProfilePaths,
  channels: readonly string[],
): Promise<ApplicationConsumerRegistry> {
  const registry = new ApplicationConsumerRegistry()
  const catalog = new FileApplicationCatalog(`${profile.rootDir}/applications`)
  for (const application of catalog.enabledForChannels(channels)) {
    const bindings = application.enabled.filter(
      (binding) => binding.channelId === '*' || channels.includes(binding.channelId),
    )
    for (const binding of bindings) {
      const builtIn = builtInConsumer(application, binding.config, profile.name)
      if (builtIn) {
        registry.register(builtIn, { channels: [binding.channelId] })
        continue
      }
      const loaded = await catalog.loadConsumer(application)
      const consumer = loaded.factory(binding.config)
      if (!consumer || typeof consumer !== 'object') {
        throw new Error(`application consumer factory returned an invalid value: ${application.uri}`)
      }
      registry.register(consumer as ApplicationConsumer, { channels: [binding.channelId] })
    }
  }
  return registry
}
