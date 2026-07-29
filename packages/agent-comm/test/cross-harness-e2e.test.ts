import {
  ApplicationConsumerRegistry,
  ApplicationRuntime,
  InMemoryApplicationRuntimeStore,
} from '@agent-comm/client-sdk'
import { ClaudeCodeChannelIngressAdapter } from '@agent-comm/harness-claude-code'
import { CodexExecIngressAdapter } from '@agent-comm/harness-codex'
import {
  createRequestResponseConsumer,
  REQUEST_RESPONSE_EXTENSION_URI,
  REQUEST_RESPONSE_VERSION,
} from '@agent-comm/request-response'
import { describe, expect, it, vi } from 'vitest'
import { createA2AChannelAdapter } from '../src/a2a/channel-adapter.js'
import { createEngine } from '../src/engine/engine.js'
import { createChannelApplicationEffectExecutor } from '../src/mcp/channel.js'
import type { IngressRuntime } from '../src/runtime/ingress-runtime.js'
import { createIngressRuntime } from '../src/runtime/ingress-runtime.js'
import { createTmpWorkspace } from './helpers/tmp-profile.js'

function applicationRuntime(runtimeInstanceId: string, principal: string): ApplicationRuntime {
  return new ApplicationRuntime({
    runtimeInstanceId,
    profilePrincipal: principal,
    registry: new ApplicationConsumerRegistry(),
    store: new InMemoryApplicationRuntimeStore(),
  })
}

describe('cross-harness runtime E2E', () => {
  it('delegates from a Claude native channel and receives a Codex exec result', async () => {
    const workspace = createTmpWorkspace()
    const aliceEngine = await createEngine(workspace.profile('alice'))
    const bobEngine = await createEngine(workspace.profile('bob'))
    let aliceRuntime: IngressRuntime | undefined
    let bobRuntime: IngressRuntime | undefined
    try {
      const channel = await aliceEngine.createChannel(
        { name: 'cross-harness', alias: 'alice' },
        'agent:alice',
      )
      const channelId = channel.channelId ?? channel.name
      const invite = await aliceEngine.createInvite({ channel: channelId }, 'agent:alice')
      await bobEngine.connect({ link: invite.link, alias: 'bob' }, 'agent:bob')

      const notifications: string[] = []
      const claudeIngress = new ClaudeCodeChannelIngressAdapter({
        async notification(input) {
          notifications.push(input.params.content)
        },
      })
      aliceRuntime = await createIngressRuntime(workspace.profile('alice'), {
        engine: aliceEngine,
        channels: [channelId],
        ingress: claudeIngress,
        pollIntervalMs: 100,
        applicationRuntime: applicationRuntime('r-alice-e2e', 'alice'),
        runtimeInstanceId: 'r-alice-e2e',
        stderr: () => {},
      })

      const codexIngress = new CodexExecIngressAdapter({
        runner: async ({ stdin }) => {
          expect(stdin).toContain('summarize the README')
          return {
            exitCode: 0,
            stdout:
              '{"type":"item.completed","item":{"type":"agent_message","text":"Three verified E2E points"}}\n' +
              '{"type":"turn.completed"}\n',
            stderr: '',
          }
        },
      })
      codexIngress.setOutcomeHandler(async (outcome) => {
        if (!bobRuntime) throw new Error('bob runtime was not ready')
        await bobRuntime.bridge.reply(outcome.eventId, outcome.result)
      })
      bobRuntime = await createIngressRuntime(workspace.profile('bob'), {
        engine: bobEngine,
        channels: [channelId],
        ingress: codexIngress,
        pollIntervalMs: 100,
        applicationRuntime: applicationRuntime('r-bob-e2e', 'bob'),
        runtimeInstanceId: 'r-bob-e2e',
        stderr: () => {},
      })

      const delegated = await createA2AChannelAdapter(aliceEngine).delegate(
        {
          channel: channelId,
          to: 'bob',
          intent: 'summarize the README in three points',
        },
        'agent:alice',
      )
      expect(delegated.transport.status).toBe('delivered')

      await vi.waitFor(
        () => {
          expect(notifications.some((content) => content.includes('Three verified E2E points'))).toBe(true)
        },
        { timeout: 3_000, interval: 50 },
      )
    } finally {
      await bobRuntime?.close()
      await aliceRuntime?.close()
      workspace.cleanup()
    }
  })

  it('lets the application protocol translate a Codex result before routing it back', async () => {
    const workspace = createTmpWorkspace()
    const aliceEngine = await createEngine(workspace.profile('alice-app'))
    const bobEngine = await createEngine(workspace.profile('bob-app'))
    let aliceRuntime: IngressRuntime | undefined
    let bobRuntime: IngressRuntime | undefined
    try {
      const channel = await aliceEngine.createChannel(
        { name: 'application-e2e', alias: 'alice' },
        'agent:alice',
      )
      const channelId = channel.channelId ?? channel.name
      const invite = await aliceEngine.createInvite({ channel: channelId }, 'agent:alice')
      await bobEngine.connect({ link: invite.link, alias: 'bob' }, 'agent:bob')

      const aliceStore = new InMemoryApplicationRuntimeStore()
      const aliceRegistry = new ApplicationConsumerRegistry()
      aliceRegistry.register(createRequestResponseConsumer({ alias: 'alice' }))
      const aliceApplications = new ApplicationRuntime({
        runtimeInstanceId: 'r-alice-app-e2e',
        profilePrincipal: 'alice',
        registry: aliceRegistry,
        store: aliceStore,
        effectExecutor: createChannelApplicationEffectExecutor(aliceEngine, aliceStore, 'r-alice-app-e2e'),
      })
      const unexpectedNotifications: string[] = []
      aliceRuntime = await createIngressRuntime(workspace.profile('alice-app'), {
        engine: aliceEngine,
        channels: [channelId],
        ingress: new ClaudeCodeChannelIngressAdapter({
          async notification(input) {
            unexpectedNotifications.push(input.params.content)
          },
        }),
        pollIntervalMs: 100,
        applicationRuntime: aliceApplications,
        runtimeInstanceId: 'r-alice-app-e2e',
        stderr: () => {},
      })

      const bobStore = new InMemoryApplicationRuntimeStore()
      const bobRegistry = new ApplicationConsumerRegistry()
      bobRegistry.register(createRequestResponseConsumer({ alias: 'bob' }))
      const bobApplications = new ApplicationRuntime({
        runtimeInstanceId: 'r-bob-app-e2e',
        profilePrincipal: 'bob',
        registry: bobRegistry,
        store: bobStore,
        effectExecutor: createChannelApplicationEffectExecutor(bobEngine, bobStore, 'r-bob-app-e2e'),
      })
      const codexIngress = new CodexExecIngressAdapter({
        runner: async ({ stdin }) => {
          expect(stdin).toContain('Summarize the architecture')
          return {
            exitCode: 0,
            stdout:
              '{"type":"item.completed","item":{"type":"agent_message","text":"Layered and extensible"}}\n',
            stderr: '',
          }
        },
      })
      codexIngress.setOutcomeHandler(async (outcome) => {
        if (!bobRuntime || !(await bobRuntime.handleOutcome(outcome))) {
          throw new Error('application outcome was not handled')
        }
      })
      bobRuntime = await createIngressRuntime(workspace.profile('bob-app'), {
        engine: bobEngine,
        channels: [channelId],
        ingress: codexIngress,
        pollIntervalMs: 100,
        applicationRuntime: bobApplications,
        runtimeInstanceId: 'r-bob-app-e2e',
        stderr: () => {},
      })

      await createA2AChannelAdapter(aliceEngine).publish(
        {
          channel: channelId,
          to: 'bob',
          extensionUri: REQUEST_RESPONSE_EXTENSION_URI,
          extensionVersion: REQUEST_RESPONSE_VERSION,
          eventType: 'request.created',
          body: { requestId: 'req-e2e', prompt: 'Summarize the architecture' },
          contextId: 'ctx-app-e2e',
        },
        'agent:alice',
      )

      await vi.waitFor(
        () => {
          expect(
            aliceStore.getState({
              profilePrincipal: 'alice',
              channelId,
              extensionUri: REQUEST_RESPONSE_EXTENSION_URI,
              contextId: 'ctx-app-e2e',
            }),
          ).toMatchObject({
            taskState: 'completed',
            state: {
              requests: {
                'req-e2e': {
                  status: 'completed',
                  result: 'Layered and extensible',
                },
              },
            },
          })
        },
        { timeout: 3_000, interval: 50 },
      )
      expect(unexpectedNotifications).toEqual([])
    } finally {
      await bobRuntime?.close()
      await aliceRuntime?.close()
      workspace.cleanup()
    }
  })
})
