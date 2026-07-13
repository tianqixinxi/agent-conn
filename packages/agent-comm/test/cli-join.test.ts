import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HostEnv } from '../src/cli/host.js'
import { runCli } from '../src/cli/index.js'
import { FakeEngine } from './fake-engine.js'

/**
 * D8 安装边界 + R10 引导:join 默认只探测宿主、打印建议命令,绝不擅自改宿主配置;
 * 只有 claude 有确认过的、不涉及直接写持久指令文件的注册子命令,--register 才会真的执行它;
 * codex 目前没有确认过的安全注册方式,--register 对它永远只打印不执行(见 src/cli/host.ts 注释)。
 */
describe('runCli join', () => {
  let rootDir: string
  let engine: FakeEngine
  let out: string[]
  let err: string[]
  let execCalls: { bin: string; args: string[] }[]

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'agent-comm-cli-join-'))
    engine = new FakeEngine()
    out = []
    err = []
    execCalls = []
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  function hostEnv(detected: string[]): HostEnv {
    return {
      detect: (bin: string) => detected.includes(bin),
      exec: (bin: string, args: string[]) => {
        execCalls.push({ bin, args })
      },
    }
  }

  function run(argv: string[], detected: string[]): Promise<void> {
    return runCli(argv, {
      rootDir,
      engineFactory: async () => engine,
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
      hostEnv: hostEnv(detected),
    })
  }

  it('exchanges the invite link via engine.connect with human actor', async () => {
    await run(['join', 'agentcomm-local:?path=/x&t=tok', '--alias', 'bob'], [])
    const call = engine.calls.find((c) => c.method === 'connect')
    expect(call?.actor).toBe('human')
    expect(call?.args[0]).toMatchObject({ link: 'agentcomm-local:?path=/x&t=tok', alias: 'bob' })
    expect(process.exitCode).toBe(0)
  })

  it('defaults --alias to the profile name when omitted', async () => {
    await runCli(['--profile', 'bob-profile', 'join', 'agentcomm-local:?path=/x&t=tok'], {
      rootDir,
      engineFactory: async () => engine,
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
      hostEnv: hostEnv([]),
    })
    const call = engine.calls.find((c) => c.method === 'connect')
    expect(call?.args[0]).toMatchObject({ alias: 'bob-profile' })
  })

  it('no known host detected: says so, executes nothing', async () => {
    await run(['join', 'agentcomm-local:?path=/x&t=tok', '--alias', 'me'], [])
    expect(execCalls).toHaveLength(0)
    expect(out.join('')).toContain('未检测到已知宿主')
  })

  it('claude detected: prints the registration hint but does NOT execute it without --register', async () => {
    await run(['join', 'agentcomm-local:?path=/x&t=tok', '--alias', 'me'], ['claude'])
    expect(out.join('')).toContain('claude mcp add agent-comm')
    expect(execCalls).toHaveLength(0)
  })

  it('claude detected + --register: actually runs the registration command', async () => {
    await run(['join', 'agentcomm-local:?path=/x&t=tok', '--alias', 'me', '--register'], ['claude'])
    expect(execCalls).toEqual([
      { bin: 'claude', args: ['mcp', 'add', 'agent-comm', '--', 'npx', '-y', 'agent-comm', 'serve'] },
    ])
  })

  it('codex detected + --register: never executes anything (no confirmed non-file-write path, D8)', async () => {
    await run(['join', 'agentcomm-local:?path=/x&t=tok', '--alias', 'me', '--register'], ['codex'])
    expect(execCalls).toHaveLength(0)
    expect(out.join('')).toContain('codex')
  })

  it('both hosts detected: prints both, --register only runs the claude command', async () => {
    await run(['join', 'agentcomm-local:?path=/x&t=tok', '--alias', 'me', '--register'], ['claude', 'codex'])
    expect(execCalls).toEqual([
      { bin: 'claude', args: ['mcp', 'add', 'agent-comm', '--', 'npx', '-y', 'agent-comm', 'serve'] },
    ])
  })

  it('--json output is a single parseable line, free of the human-readable instructions text', async () => {
    await runCli(['--json', 'join', 'agentcomm-local:?path=/x&t=tok', '--alias', 'me'], {
      rootDir,
      engineFactory: async () => engine,
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
      hostEnv: hostEnv(['claude']),
    })
    const lines = out.join('').trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0] ?? '')
    expect(parsed.hostsDetected).toEqual(['claude'])
    expect(execCalls).toHaveLength(0)
  })
})
