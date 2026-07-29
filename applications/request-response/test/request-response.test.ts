import { readFileSync } from 'node:fs'
import type { ApplicationConformanceFixture } from '@agent-comm/application-spec'
import { ApplicationExtensionManifestSchema } from '@agent-comm/application-spec'
import {
  ApplicationConsumerRegistry,
  ApplicationRuntime,
  assertApplicationConformance,
  InMemoryApplicationRuntimeStore,
} from '@agent-comm/client-sdk'
import { describe, expect, it } from 'vitest'
import { createRequestResponseConsumer, requestResponseManifest } from '../src/index.js'

describe('request-response application', () => {
  it('keeps its portable manifest aligned with the reference implementation', () => {
    const portable = ApplicationExtensionManifestSchema.parse(
      JSON.parse(readFileSync(new URL('../spec/manifest.json', import.meta.url), 'utf8')),
    )
    expect(portable).toEqual(requestResponseManifest)
  })

  it('passes its portable conformance fixture', async () => {
    const [fixture] = JSON.parse(
      readFileSync(new URL('../spec/conformance.json', import.meta.url), 'utf8'),
    ) as ApplicationConformanceFixture[]
    if (!fixture) throw new Error('missing fixture')
    const registry = new ApplicationConsumerRegistry()
    registry.register(createRequestResponseConsumer({ alias: 'requester' }))
    await expect(assertApplicationConformance(fixture, registry)).resolves.toMatchObject({
      passed: true,
    })
  })

  it('turns a harness result into a protocol-native response event', async () => {
    const registry = new ApplicationConsumerRegistry()
    registry.register(createRequestResponseConsumer({ alias: 'responder' }))
    const runtime = new ApplicationRuntime({
      runtimeInstanceId: 'r-responder',
      profilePrincipal: 'node-responder',
      registry,
      store: new InMemoryApplicationRuntimeStore(),
    })
    await runtime.process({
      messageId: 'm-request',
      channelId: 'c-one',
      from: 'alice',
      selector: {
        uri: requestResponseManifest.uri,
        version: requestResponseManifest.version,
        eventType: 'request.created',
      },
      body: { requestId: 'req-1', prompt: 'Summarize README' },
      contextId: 'ctx-one',
    })
    const resumed = await runtime.resume('m-request', {
      status: 'completed',
      result: { summary: 'done' },
    })
    expect(resumed).toMatchObject({
      status: 'reduced',
      effects: [
        expect.objectContaining({
          effect: expect.objectContaining({
            type: 'publish',
            to: 'alice',
            selector: expect.objectContaining({ eventType: 'response.created' }),
          }),
        }),
      ],
    })
  })
})
