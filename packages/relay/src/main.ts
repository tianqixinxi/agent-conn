import { serve } from '@hono/node-server'
import { createApp } from './app.js'

const port = Number(process.env.PORT ?? 8787)
const dbPath = process.env.RELAY_DB ?? './relay.db'

const app = createApp({ dbPath })
serve({ fetch: app.fetch, port }, (info) => {
  process.stderr.write(`agent-comm relay listening on :${info.port} (db: ${dbPath})\n`)
})
