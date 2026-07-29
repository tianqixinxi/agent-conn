import { spawn } from 'node:child_process'
import type {
  RuntimeIngressAdapter,
  RuntimeIngressDeliveryResult,
  RuntimeIngressEvent,
  RuntimeIngressOutcomeHandler,
} from '@agent-comm/runtime-ingress'

export interface ProcessIngressRunInput {
  command: string
  args: readonly string[]
  cwd?: string | undefined
  env: NodeJS.ProcessEnv
  stdin: string
  timeoutMs: number
  killGraceMs: number
  maxStderrBytes: number
}

export interface ProcessIngressRunResult {
  exitCode: number | null
  signal?: NodeJS.Signals | undefined
  stdout?: string | undefined
  stderr: string
  timedOut: boolean
}

export type ProcessIngressRunner = (input: ProcessIngressRunInput) => Promise<ProcessIngressRunResult>

export interface ProcessIngressOptions {
  command: string
  args?: readonly string[] | undefined
  cwd?: string | undefined
  env?: Readonly<Record<string, string>> | undefined
  inheritEnv?: boolean | undefined
  timeoutMs?: number | undefined
  killGraceMs?: number | undefined
  maxConcurrency?: number | undefined
  maxStderrBytes?: number | undefined
  temporaryFailureExitCodes?: readonly number[] | undefined
  unsupportedExitCodes?: readonly number[] | undefined
  runner?: ProcessIngressRunner | undefined
  onResult?:
    | ((event: RuntimeIngressEvent, result: ProcessIngressRunResult) => Promise<void> | void)
    | undefined
}

async function defaultRunner(input: ProcessIngressRunInput): Promise<ProcessIngressRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let forceKillTimer: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), input.killGraceMs)
    }, input.timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      reject(error)
    })
    child.stderr.setEncoding('utf8')
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < input.maxStderrBytes) {
        stderr += chunk.slice(0, input.maxStderrBytes - stderr.length)
      }
    })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      resolve({ exitCode, signal: signal ?? undefined, stdout, stderr, timedOut })
    })
    child.stdin.on('error', () => {
      // A child may exit before consuming stdin. Its exit status remains the
      // authoritative delivery result.
    })
    child.stdin.end(input.stdin)
  })
}

/**
 * Starts one harness process per event and sends the normalized event as JSON on
 * stdin. `shell` is always disabled; command and arguments are never constructed
 * from remote event content.
 */
export class ProcessIngressAdapter implements RuntimeIngressAdapter {
  readonly id = 'process'
  readonly capabilities = {
    delivery: 'process',
    wake: 'process',
    background: true,
    interactiveApproval: false,
    streaming: false,
    durability: 'upstream',
  } as const

  readonly #options: Required<
    Pick<
      ProcessIngressOptions,
      'args' | 'inheritEnv' | 'timeoutMs' | 'killGraceMs' | 'maxConcurrency' | 'maxStderrBytes'
    >
  > &
    ProcessIngressOptions
  readonly #temporaryFailureExitCodes: ReadonlySet<number>
  readonly #unsupportedExitCodes: ReadonlySet<number>
  readonly #runner: ProcessIngressRunner
  #outcomeHandler: RuntimeIngressOutcomeHandler | undefined
  #active = 0

  constructor(options: ProcessIngressOptions) {
    if (!options.command.trim()) throw new Error('process ingress command is required')
    this.#options = {
      ...options,
      args: options.args ?? [],
      inheritEnv: options.inheritEnv ?? false,
      timeoutMs: Math.max(100, options.timeoutMs ?? 120_000),
      killGraceMs: Math.max(100, options.killGraceMs ?? 5_000),
      maxConcurrency: Math.max(1, options.maxConcurrency ?? 1),
      maxStderrBytes: Math.max(0, options.maxStderrBytes ?? 8_192),
    }
    this.#temporaryFailureExitCodes = new Set(options.temporaryFailureExitCodes ?? [75])
    this.#unsupportedExitCodes = new Set(options.unsupportedExitCodes ?? [64, 69])
    this.#runner = options.runner ?? defaultRunner
  }

  setOutcomeHandler(handler: RuntimeIngressOutcomeHandler): void {
    this.#outcomeHandler = handler
  }

  async deliver(event: RuntimeIngressEvent): Promise<RuntimeIngressDeliveryResult> {
    if (this.#active >= this.#options.maxConcurrency) {
      return { status: 'deferred', detail: 'process ingress concurrency limit reached' }
    }
    this.#active += 1
    try {
      const result = await this.#runner({
        command: this.#options.command,
        args: this.#options.args,
        cwd: this.#options.cwd,
        env: {
          ...(this.#options.inheritEnv ? process.env : {}),
          ...this.#options.env,
          AGENTCOMM_EVENT_ID: event.eventId,
          AGENTCOMM_EVENT_TYPE: event.eventType,
        },
        stdin: `${JSON.stringify(event)}\n`,
        timeoutMs: this.#options.timeoutMs,
        killGraceMs: this.#options.killGraceMs,
        maxStderrBytes: this.#options.maxStderrBytes,
      })
      await this.#options.onResult?.(event, result)
      const detail = result.stderr.trim() || undefined
      if (result.timedOut) return { status: 'deferred', detail: detail ?? 'process timed out' }
      if (result.exitCode === 0) {
        const output = result.stdout?.trim()
        await this.#outcomeHandler?.({
          eventId: event.eventId,
          status: 'completed',
          result: output || { ok: true },
        })
        return { status: 'accepted', ...(detail ? { detail } : {}) }
      }
      if (result.exitCode !== null && this.#temporaryFailureExitCodes.has(result.exitCode)) {
        return { status: 'deferred', ...(detail ? { detail } : {}) }
      }
      if (result.exitCode !== null && this.#unsupportedExitCodes.has(result.exitCode)) {
        return { status: 'unsupported', ...(detail ? { detail } : {}) }
      }
      await this.#outcomeHandler?.({
        eventId: event.eventId,
        status: 'failed',
        error: detail ?? `process exited with ${result.exitCode ?? result.signal ?? 'unknown status'}`,
      })
      return {
        status: 'rejected',
        detail: detail ?? `process exited with ${result.exitCode ?? result.signal ?? 'unknown status'}`,
      }
    } catch (error) {
      return {
        status: 'deferred',
        detail: error instanceof Error ? error.message : String(error),
      }
    } finally {
      this.#active -= 1
    }
  }
}
