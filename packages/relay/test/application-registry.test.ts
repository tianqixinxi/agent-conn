import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'

describe('public application registry', () => {
  it('lists community protocols and serves validated manifests', async () => {
    const app = createApp({ dbPath: join(mkdtempSync(join(tmpdir(), 'agentcomm-apps-')), 'relay.db') })
    const index = await app.request('http://relay.test/api/public/applications')
    expect(index.status).toBe(200)
    await expect(index.json()).resolves.toMatchObject({
      schemaVersion: 1,
      applications: expect.arrayContaining([
        expect.objectContaining({ name: 'Request and response', version: '1.0.0' }),
      ]),
    })
    const manifest = await app.request(
      'http://relay.test/api/public/applications/request-response/1.0.0/manifest',
    )
    expect(manifest.status).toBe(200)
    await expect(manifest.json()).resolves.toMatchObject({
      baseProtocol: 'a2a/1.0',
      uri: 'https://agentcomm.dev/community/request-response/v1',
      conformanceFixtures:
        'http://relay.test/api/public/applications/request-response/1.0.0/conformance.json',
    })
    const fixtures = await app.request(
      'http://relay.test/api/public/applications/request-response/1.0.0/conformance.json',
    )
    expect(fixtures.status).toBe(200)
    expect(Array.isArray(await fixtures.json())).toBe(true)
    const schema = await app.request(
      'http://relay.test/api/public/applications/manager-workers/1.0.0/events.schema.json',
    )
    expect(schema.status).toBe(200)
    await expect(schema.json()).resolves.toHaveProperty('$defs.taskAssigned')
  })

  it('serves the portable runtime bundle without relay authentication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentcomm-cli-assets-'))
    const app = createApp({
      dbPath: join(root, 'relay.db'),
      cliAssets: {
        'agent-comm-cli.mjs': 'console.log("agentcomm")\n',
        'schema.store.sql': 'select 1;\n',
        'schema.hub.sql': 'select 2;\n',
      },
    })

    const cli = await app.request('http://relay.test/bin/agent-comm-cli.mjs')
    expect(cli.status).toBe(200)
    expect(cli.headers.get('content-type')).toContain('text/javascript')
    expect(await cli.text()).toContain('agentcomm')
    expect((await app.request('http://relay.test/bin/schema.store.sql')).status).toBe(200)
    expect((await app.request('http://relay.test/bin/schema.hub.sql')).status).toBe(200)
  })
})
