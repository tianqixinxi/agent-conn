import { readFileSync } from 'node:fs'
import {
  type ApplicationConformanceFixture,
  ApplicationExtensionManifestSchema,
} from '@agent-comm/application-spec'
import {
  ApplicationConsumerRegistry,
  type ApplicationEffectExecutor,
  ApplicationRuntime,
  assertApplicationConformance,
  InMemoryApplicationRuntimeStore,
  type JournaledApplicationEffect,
} from '@agent-comm/client-sdk'
import {
  createManagerWorkersConsumer,
  MANAGER_WORKERS_EXTENSION_URI,
  MANAGER_WORKERS_VERSION,
  managerWorkersEvent,
  managerWorkersManifest,
} from '@agent-comm/manager-workers'
import { describe, expect, it } from 'vitest'

function registry(role: 'manager' | 'worker', alias: string) {
  const value = new ApplicationConsumerRegistry()
  value.register(
    createManagerWorkersConsumer({
      role,
      alias,
      managerAlias: 'manager',
      autoResult: { summary: 'three verified points' },
    }),
  )
  return value
}

describe('manager-workers community application', () => {
  it('publishes a valid manifest without depending on transport or harness packages', () => {
    expect(managerWorkersManifest).toMatchObject({
      uri: MANAGER_WORKERS_EXTENSION_URI,
      version: MANAGER_WORKERS_VERSION,
      baseProtocol: 'a2a/1.0',
      compatibility: { major: 1, backwardCompatibleFrom: '1.0.0' },
    })
    expect(Object.keys(managerWorkersManifest.eventSchemas)).toContain('task.authorization-required')
    const portableManifest = ApplicationExtensionManifestSchema.parse(
      JSON.parse(readFileSync(new URL('../spec/manifest.json', import.meta.url), 'utf8')),
    )
    expect(portableManifest).toEqual(managerWorkersManifest)
  })

  it('passes a portable reducer conformance fixture', async () => {
    const fixture: ApplicationConformanceFixture = {
      name: 'manager-assigns-reviews-and-approves',
      extension: {
        uri: MANAGER_WORKERS_EXTENSION_URI,
        version: MANAGER_WORKERS_VERSION,
      },
      events: [
        {
          eventType: 'worker.registered',
          body: { worker: 'worker', capabilities: ['repository-review'] },
        },
        {
          eventType: 'task.requested',
          body: { taskId: 'task-1', goal: 'Review README', worker: 'worker' },
        },
        { eventType: 'task.progress', body: { taskId: 'task-1', progress: 50 } },
        {
          eventType: 'task.completed',
          body: { taskId: 'task-1', result: { summary: 'three verified points' } },
        },
        {
          eventType: 'review.approved',
          body: { taskId: 'task-1', reviewer: 'manager', note: 'accepted' },
        },
      ],
      expected: {
        state: {
          workers: {
            worker: { capabilities: ['repository-review'], status: 'available' },
          },
          tasks: {
            'task-1': {
              taskId: 'task-1',
              goal: 'Review README',
              status: 'approved',
              assignedTo: 'worker',
              progress: 100,
              result: { summary: 'three verified points' },
              review: 'accepted',
            },
          },
        },
        taskState: 'completed',
        effects: [
          {
            type: 'publish',
            to: 'worker',
            selector: {
              uri: MANAGER_WORKERS_EXTENSION_URI,
              version: MANAGER_WORKERS_VERSION,
              eventType: 'task.assigned',
            },
            body: { taskId: 'task-1', goal: 'Review README', worker: 'worker' },
            contextId: 'fixture:manager-assigns-reviews-and-approves',
          },
          {
            type: 'publish',
            to: 'worker',
            selector: {
              uri: MANAGER_WORKERS_EXTENSION_URI,
              version: MANAGER_WORKERS_VERSION,
              eventType: 'review.requested',
            },
            body: { taskId: 'task-1', reviewer: 'manager', note: 'verify completion' },
            contextId: 'fixture:manager-assigns-reviews-and-approves',
          },
          { type: 'complete', result: { summary: 'three verified points' } },
        ],
        eventStatuses: ['reduced', 'reduced', 'reduced', 'reduced', 'reduced'],
      },
    }

    await expect(
      assertApplicationConformance(fixture, registry('manager', 'manager')),
    ).resolves.toMatchObject({ passed: true })
  })

  it('runs manager → worker → review end to end with exact-once state and restart recovery', async () => {
    const managerStore = new InMemoryApplicationRuntimeStore()
    const workerStore = new InMemoryApplicationRuntimeStore()
    let sequence = 0
    let managerRuntime: ApplicationRuntime
    let workerRuntime: ApplicationRuntime

    const route = async (from: string, effect: JournaledApplicationEffect): Promise<void> => {
      if (effect.effect.type !== 'publish') return
      sequence += 1
      const target = effect.effect.to === 'manager' ? managerRuntime : workerRuntime
      const delivered = {
        messageId: `routed-${sequence}`,
        channelId: 'team-channel',
        from,
        selector: effect.effect.selector,
        body: effect.effect.body,
        contextId: effect.effect.contextId ?? 'task-context',
        receivedAt: '2026-01-01T00:00:00.000Z',
      }
      const first = await target.process(delivered)
      const duplicate = await target.process(delivered)
      expect(first.status).toBe('reduced')
      expect(duplicate).toMatchObject({ duplicate: true })
    }
    const managerExecutor: ApplicationEffectExecutor = {
      execute: (effect) => route('manager', effect),
    }
    const workerExecutor: ApplicationEffectExecutor = {
      execute: (effect) => route('worker', effect),
    }
    managerRuntime = new ApplicationRuntime({
      runtimeInstanceId: 'r-manager-runtime-001',
      profilePrincipal: 'node-manager',
      registry: registry('manager', 'manager'),
      store: managerStore,
      effectExecutor: managerExecutor,
    })
    workerRuntime = new ApplicationRuntime({
      runtimeInstanceId: 'r-worker-runtime-001',
      profilePrincipal: 'node-worker',
      registry: registry('worker', 'worker'),
      store: workerStore,
      effectExecutor: workerExecutor,
    })

    const contextId = 'task-context'
    await managerRuntime.process(
      managerWorkersEvent({
        messageId: 'register-worker',
        channelId: 'team-channel',
        from: 'worker',
        eventType: 'worker.registered',
        body: { worker: 'worker', capabilities: ['repository-review'] },
        contextId,
      }),
    )
    const requested = managerWorkersEvent({
      messageId: 'request-task',
      channelId: 'team-channel',
      from: 'manager',
      eventType: 'task.requested',
      body: { taskId: 'task-1', goal: 'Review README', worker: 'worker' },
      contextId,
    })
    await managerRuntime.process(requested)
    await expect(managerRuntime.process(requested)).resolves.toMatchObject({ duplicate: true })

    // Four rounds drain: assign, worker progress+completion, review request,
    // review approval, and the manager's local completion effect.
    for (let round = 0; round < 5; round += 1) {
      await managerRuntime.executePendingEffects()
      await workerRuntime.executePendingEffects()
    }

    const managerState = managerStore.getState({
      profilePrincipal: 'node-manager',
      channelId: 'team-channel',
      extensionUri: MANAGER_WORKERS_EXTENSION_URI,
      contextId,
    })
    expect(managerState).toMatchObject({
      taskState: 'completed',
      state: {
        tasks: {
          'task-1': {
            status: 'approved',
            result: { summary: 'three verified points' },
          },
        },
      },
    })
    expect(managerRuntime.unfinished('team-channel')).toEqual([])

    managerRuntime.close()
    const restarted = new ApplicationRuntime({
      runtimeInstanceId: 'r-manager-runtime-002',
      profilePrincipal: 'node-manager',
      registry: registry('manager', 'manager'),
      store: managerStore,
    })
    expect(restarted.unfinished('team-channel')).toEqual([])
    await expect(
      restarted.process(
        managerWorkersEvent({
          messageId: 'late-progress',
          channelId: 'team-channel',
          from: 'worker',
          eventType: 'task.progress',
          body: { taskId: 'task-1', progress: 100 },
          contextId,
        }),
      ),
    ).resolves.toMatchObject({ status: 'ignored-terminal', autoAck: true })
    restarted.close()
    workerRuntime.close()
  })
})
