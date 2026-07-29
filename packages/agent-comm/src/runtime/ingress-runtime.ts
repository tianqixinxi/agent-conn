import type { ApplicationConsumerRegistry, ApplicationRuntime } from '@agent-comm/client-sdk'
import { newRuntimeInstanceId } from '@agent-comm/core'
import type { RuntimeIngressAdapter, RuntimeIngressOutcome } from '@agent-comm/runtime-ingress'
import type { ProfilePaths } from '../config.js'
import type { Engine } from '../engine/api.js'
import {
  createChannelApplicationEffectExecutor,
  createChannelBridge,
  type RuntimeHarnessBridge,
  resolveChannelRelayUrl,
} from '../mcp/channel.js'
import type { StoreHandle, TaskAuthorizationRepo } from '../store/index.js'

export { resolveProfile } from '../config.js'

export interface CreateIngressRuntimeOptions {
  ingress: RuntimeIngressAdapter
  channels: readonly string[]
  pollIntervalMs?: number | undefined
  defaultHome?: string | undefined
  defaultAlias?: string | undefined
  runtimeInstanceId?: string | undefined
  engine?: Engine | undefined
  applicationRuntime?: ApplicationRuntime | undefined
  applicationRegistry?: ApplicationConsumerRegistry | undefined
  taskAuthorizations?: TaskAuthorizationRepo | undefined
  stderr?: ((chunk: string) => void) | undefined
}

export interface IngressRuntime {
  bridge: RuntimeHarnessBridge
  runtimeInstanceId: string
  handleOutcome(outcome: RuntimeIngressOutcome): Promise<boolean>
  close(): Promise<void>
}

/**
 * Starts AgentComm's durable event pump with any runtime ingress adapter.
 *
 * Unlike `runChannel`, this composition does not connect an MCP transport and
 * does not depend on Claude Code. Memberships are activated explicitly by
 * opaque channel id, after which the same inbox/application processing path is
 * used for webhook, polling, process, or third-party harness adapters.
 */
export async function createIngressRuntime(
  profile: ProfilePaths,
  options: CreateIngressRuntimeOptions,
): Promise<IngressRuntime> {
  const engine =
    options.engine ??
    (await (async () => {
      const { createEngine } = await import('../engine/engine.js')
      return createEngine(profile)
    })())
  let storeHandle: StoreHandle | undefined
  let applicationRuntime = options.applicationRuntime
  const runtimeInstanceId =
    options.runtimeInstanceId ?? applicationRuntime?.runtimeInstanceId ?? newRuntimeInstanceId()

  try {
    if (!applicationRuntime) {
      const [{ ApplicationConsumerRegistry, ApplicationRuntime }, { openStore }] = await Promise.all([
        import('@agent-comm/client-sdk'),
        import('../store/index.js'),
      ])
      storeHandle = openStore(profile.storePath)
      const identity = await engine.identity()
      applicationRuntime = new ApplicationRuntime({
        runtimeInstanceId,
        profilePrincipal: identity.nodeId,
        registry: options.applicationRegistry ?? new ApplicationConsumerRegistry(),
        store: storeHandle.applicationRuntime,
        effectExecutor: createChannelApplicationEffectExecutor(
          engine,
          storeHandle.applicationRuntime,
          runtimeInstanceId,
        ),
      })
    }

    const bridge = createChannelBridge(engine, {
      ingress: options.ingress,
      pollIntervalMs: options.pollIntervalMs,
      defaultHome: options.defaultHome ?? resolveChannelRelayUrl(),
      defaultAlias: options.defaultAlias,
      runtimeInstanceId,
      applicationRuntime,
      taskAuthorizations: options.taskAuthorizations ?? storeHandle?.taskAuthorizations,
      stderr: options.stderr,
    })
    for (const channel of options.channels) await bridge.activate(channel)
    bridge.start()

    let closed = false
    return {
      bridge,
      runtimeInstanceId,
      async handleOutcome(outcome) {
        const processed = await applicationRuntime?.resume(outcome.eventId, {
          status: outcome.status,
          result: outcome.result,
          error: outcome.error,
        })
        if (!processed) return false
        if (processed.status === 'failed') throw new Error(processed.error)
        await applicationRuntime?.executePendingEffects(
          (effect) => effect.effect.type === 'publish' || effect.effect.type === 'complete',
        )
        return true
      },
      async close() {
        if (closed) return
        closed = true
        bridge.stop()
        applicationRuntime?.close()
        storeHandle?.close()
        await engine.close()
      },
    }
  } catch (error) {
    applicationRuntime?.close()
    storeHandle?.close()
    await engine.close().catch(() => {})
    throw error
  }
}
