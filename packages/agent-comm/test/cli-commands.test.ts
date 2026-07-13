import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentCommError } from '@agent-comm/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HostEnv } from '../src/cli/host.js'
import { runCli } from '../src/cli/index.js'
import { FakeEngine, makeHeldMessage } from './fake-engine.js'

/**
 * runCli 的注入缝(见 src/cli/index.ts 的 RunCliOptions / src/cli/context.ts 的 CreateCliContextOptions):
 * - engineFactory:跳过生产 createEngine(profile),直接给一个 FakeEngine
 * - rootDir:resolveProfile 仍然会真的 mkdirSync,这里指向临时目录而不是 ~/.agent-comm
 * - stdout/stderr:收集输出,断言文本 / --json 可解析
 * - hostEnv:替换 join/doctor 里"探测/执行宿主 CLI"的部分,不碰真实子进程
 */

describe('runCli', () => {
  let rootDir: string
  let engine: FakeEngine
  let out: string[]
  let err: string[]

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'agent-comm-cli-'))
    engine = new FakeEngine()
    out = []
    err = []
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  function run(argv: string[], overrides: { engine?: FakeEngine } = {}): Promise<void> {
    const e = overrides.engine ?? engine
    return runCli(argv, {
      rootDir,
      engineFactory: async () => e,
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
    })
  }

  it('exits 0 on success and closes the engine afterwards', async () => {
    await run(['init'])
    expect(process.exitCode).toBe(0)
    expect(engine.closed).toBe(true)
    expect(out.join('')).toContain('n-fake0000')
  })

  it('--json produces exactly one parseable JSON line', async () => {
    await run(['--json', 'init'])
    expect(process.exitCode).toBe(0)
    const lines = out.join('').trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0] ?? '')
    expect(parsed.nodeId).toBe('n-fake0000')
  })

  it('AgentCommError thrown by the engine maps to exit code 1', async () => {
    engine.identity = async () => {
      throw new AgentCommError('STORE_BUSY', 'db locked')
    }
    await run(['init'])
    expect(process.exitCode).toBe(1)
    expect(err.join('')).toContain('STORE_BUSY')
  })

  it('unknown command maps to exit code 2 (usage error)', async () => {
    await run(['this-command-does-not-exist'])
    expect(process.exitCode).toBe(2)
  })

  it('deliver/drop/edit are T3: always call engine with human actor', async () => {
    const held1 = makeHeldMessage({ channel: 'daily' })
    const e1 = new FakeEngine({ held: [held1] })
    await run(['deliver', held1.message.messageId], { engine: e1 })
    expect(e1.calls.find((c) => c.method === 'deliverHeld')?.actor).toBe('human')
    expect(process.exitCode).toBe(0)

    const held2 = makeHeldMessage({ channel: 'daily' })
    const e2 = new FakeEngine({ held: [held2] })
    await run(['drop', held2.message.messageId], { engine: e2 })
    expect(e2.calls.find((c) => c.method === 'dropHeld')?.actor).toBe('human')

    const held3 = makeHeldMessage({ channel: 'daily' })
    const e3 = new FakeEngine({ held: [held3] })
    await run(['edit', held3.message.messageId, '--payload', '{"text":"edited"}'], { engine: e3 })
    const editCall = e3.calls.find((c) => c.method === 'editHeld')
    expect(editCall?.actor).toBe('human')
    expect(editCall?.args[0]).toMatchObject({ payload: { text: 'edited' } })
  })

  it('edit rejects non-JSON --payload as a usage-level AgentCommError (exit 1)', async () => {
    const held = makeHeldMessage({ channel: 'daily' })
    const e = new FakeEngine({ held: [held] })
    await run(['edit', held.message.messageId, '--payload', 'not json'], { engine: e })
    expect(process.exitCode).toBe(1)
    expect(e.calls.some((c) => c.method === 'editHeld')).toBe(false)
  })

  it('held lists pending messages with a summarized payload', async () => {
    const held = makeHeldMessage({ channel: 'daily', payload: { text: 'x'.repeat(300) } })
    const e = new FakeEngine({ held: [held] })
    await run(['held'], { engine: e })
    expect(out.join('')).toContain(held.message.messageId)
  })

  it('send injects with human actor', async () => {
    await run(['send', 'daily', 'bob', 'hello world'])
    const call = engine.calls.find((c) => c.method === 'send')
    expect(call?.actor).toBe('human')
    expect(call?.args[0]).toMatchObject({ channel: 'daily', to: 'bob', payload: 'hello world' })
  })

  it('channels create/mode use human actor; bare "channels" defaults to ls', async () => {
    await run(['channels', 'create', 'daily', 'lead', '--mode', 'intercept'])
    const createCall = engine.calls.find((c) => c.method === 'createChannel')
    expect(createCall?.actor).toBe('human')
    expect(createCall?.args[0]).toMatchObject({ name: 'daily', alias: 'lead', mode: 'intercept' })

    out.length = 0
    await run(['channels'])
    expect(out.join('')).toContain('daily')

    await run(['channels', 'mode', 'daily', 'paused'])
    const modeCall = engine.calls.find((c) => c.method === 'setChannelMode')
    expect(modeCall?.actor).toBe('human')
    expect(modeCall?.args[0]).toMatchObject({ channel: 'daily', mode: 'paused' })
  })

  it('channels create rejects an invalid --mode before calling the engine', async () => {
    await run(['channels', 'create', 'daily', 'lead', '--mode', 'bogus'])
    expect(process.exitCode).toBe(1)
    expect(engine.calls.some((c) => c.method === 'createChannel')).toBe(false)
  })

  it('invite forwards ttl/maxUses and prints the link', async () => {
    await run(['invite', 'daily', '--ttl', '1000', '--max-uses', '3'])
    const call = engine.calls.find((c) => c.method === 'createInvite')
    expect(call?.actor).toBe('human')
    expect(call?.args[0]).toMatchObject({ channel: 'daily', ttlMs: 1000, maxUses: 3 })
    expect(out.join('')).toContain('agentcomm-local:')
  })

  it('audit forwards channel/since/limit', async () => {
    await run(['audit', '--channel', 'daily', '--since', '2026-01-01T00:00:00Z', '--limit', '10'])
    const call = engine.calls.find((c) => c.method === 'auditQuery')
    expect(call?.args[0]).toMatchObject({ channel: 'daily', sinceTs: '2026-01-01T00:00:00Z', limit: 10 })
  })

  it('inbox forwards consume/filter/limit', async () => {
    await run(['inbox', '--consume', '--channel', 'daily', '--limit', '2'])
    const call = engine.calls.find((c) => c.method === 'readInbox')
    expect(call?.args[0]).toMatchObject({ consume: true, limit: 2, filter: { channel: 'daily' } })
  })

  it('peers lists channel members', async () => {
    const e = new FakeEngine({ peers: [{ alias: 'bob', nodeId: 'n-1', channel: 'daily' }] })
    await run(['peers', 'daily'], { engine: e })
    expect(out.join('')).toContain('bob')
  })
})

describe('runCli doctor', () => {
  let rootDir: string
  let out: string[]
  let err: string[]

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'agent-comm-cli-doctor-'))
    out = []
    err = []
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  function run(argv: string[], hostEnv: HostEnv, engineFactory: () => Promise<FakeEngine>): Promise<void> {
    return runCli(argv, {
      rootDir,
      engineFactory,
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
      hostEnv,
    })
  }

  it('reports all green (exit 0) when engine and host CLIs are all available', async () => {
    const hostEnv: HostEnv = { detect: () => true, exec: () => {} }
    await run(['doctor'], hostEnv, async () => new FakeEngine())
    expect(process.exitCode).toBe(0)
    const text = out.join('')
    expect(text).toContain('✓')
    expect(text).not.toContain('✗')
  })

  it('still runs every check (and marks it ✗) even when engine construction throws', async () => {
    const hostEnv: HostEnv = { detect: () => false, exec: () => {} }
    await run(['doctor'], hostEnv, async () => {
      throw new AgentCommError('NOT_IMPLEMENTED', 'engine 尚未实现')
    })
    expect(process.exitCode).toBe(1)
    const text = out.join('')
    expect(text).toContain('✗')
    expect(text).toContain('store 可开')
    expect(text).toContain('宿主 CLI: claude')
    expect(text).toContain('宿主 CLI: codex')
  })

  it('--json emits a single parseable report with a per-check breakdown', async () => {
    const hostEnv: HostEnv = { detect: () => true, exec: () => {} }
    await runCli(['--json', 'doctor'], {
      rootDir,
      engineFactory: async () => new FakeEngine(),
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
      hostEnv,
    })
    const parsed = JSON.parse(out.join('').trim())
    expect(parsed.ok).toBe(true)
    expect(Array.isArray(parsed.checks)).toBe(true)
    expect(parsed.checks.length).toBeGreaterThanOrEqual(4)
  })
})
