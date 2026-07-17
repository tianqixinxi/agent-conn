import { readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureIdentity, signCanonical, verifyCanonical } from '../src/crypto/identity.js'
import { createTmpWorkspace, type TmpWorkspace } from './helpers/tmp-profile.js'

describe('crypto/identity', () => {
  let ws: TmpWorkspace
  beforeEach(() => {
    ws = createTmpWorkspace()
  })
  afterEach(() => ws.cleanup())

  it('generates a keypair on first call and writes the private key file chmod 0600', async () => {
    const keyPath = join(ws.rootDir, 'id', 'identity.key')
    const identity = await ensureIdentity({ identityKeyPath: keyPath })
    expect(identity.nodeId).toMatch(/^n-/)
    expect(identity.publicKey.length).toBeGreaterThan(0)
    expect(identity.privateKeyRef).toBe(keyPath)

    const stat = statSync(keyPath)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('loads the same identity idempotently on subsequent calls', async () => {
    const keyPath = join(ws.rootDir, 'id2', 'identity.key')
    const first = await ensureIdentity({ identityKeyPath: keyPath })
    const second = await ensureIdentity({ identityKeyPath: keyPath })
    expect(second.nodeId).toBe(first.nodeId)
    expect(second.publicKey).toBe(first.publicKey)
  })

  it('produces different identities for different key files', async () => {
    const a = await ensureIdentity({ identityKeyPath: join(ws.rootDir, 'a', 'identity.key') })
    const b = await ensureIdentity({ identityKeyPath: join(ws.rootDir, 'b', 'identity.key') })
    expect(a.nodeId).not.toBe(b.nodeId)
  })

  it('refuses to follow an identity-key symlink', async () => {
    const target = join(ws.rootDir, 'outside.key')
    const keyPath = join(ws.rootDir, 'linked-identity.key')
    writeFileSync(target, 'not a private key')
    symlinkSync(target, keyPath)
    await expect(ensureIdentity({ identityKeyPath: keyPath })).rejects.toThrow()
    expect(readFileSync(target, 'utf8')).toBe('not a private key')
  })

  it('signCanonical/verifyCanonical round-trip, and rejects tampering', async () => {
    const keyPath = join(ws.rootDir, 'c', 'identity.key')
    const identity = await ensureIdentity({ identityKeyPath: keyPath })
    const canonical = 'POST\n/ch/daily/messages\n1234567890\nabc123'
    const sig = await signCanonical(keyPath, canonical)
    expect(verifyCanonical(identity.publicKey, canonical, sig)).toBe(true)
    expect(verifyCanonical(identity.publicKey, 'tampered', sig)).toBe(false)
    expect(verifyCanonical(identity.publicKey, canonical, `${sig.slice(0, -2)}zz`)).toBe(false)
  })
})
