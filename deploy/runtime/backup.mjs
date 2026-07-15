import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

const source = process.env.RELAY_DB ?? '/var/lib/agent-comm/relay.db'
const backupDir = process.env.RELAY_BACKUP_DIR ?? join(dirname(source), 'backups')
const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const destination = join(backupDir, `relay-${timestamp}.db`)
const temporary = `${destination}.tmp`

mkdirSync(backupDir, { recursive: true, mode: 0o700 })
rmSync(temporary, { force: true })

const database = new DatabaseSync(source, { readOnly: true })
try {
  await backup(database, temporary)
  renameSync(temporary, destination)
  process.stdout.write(`${destination}\n`)
} finally {
  database.close()
  rmSync(temporary, { force: true })
}
