import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/store.js'

describe('relay: database path', () => {
  it('creates a missing parent directory before opening the SQLite file', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-comm-relay-path-'))
    const dbPath = join(root, 'nested', 'data', 'relay.db')
    try {
      const db = openDb(dbPath)
      db.raw.close()
      expect(existsSync(dbPath)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
