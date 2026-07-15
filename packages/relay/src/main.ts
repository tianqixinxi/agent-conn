import { serve } from '@hono/node-server'
import { createApp } from './app.js'

const port = Number(process.env.PORT ?? 8787)
const dbPath = process.env.RELAY_DB ?? './relay.db'

const enableA2AIngress = process.env.AGENT_COMM_A2A_INGRESS === '1'
const app = createApp({ dbPath, enableA2AIngress })
serve({ fetch: app.fetch, port }, (info) => {
  process.stderr.write(
    `agent-comm relay listening on :${info.port} (db: ${dbPath}, a2a-ingress: ${enableA2AIngress ? 'trusted/plaintext' : 'off'})\n`,
  )
})
