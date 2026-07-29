import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'

export const BenchmarkLayerSchema = z.enum(['transport', 'application', 'harness', 'model', 'system'])
export type BenchmarkLayer = z.infer<typeof BenchmarkLayerSchema>

export const BenchmarkVariantSchema = z.object({
  transport: z.string().optional(),
  application: z.string().optional(),
  harness: z.string().optional(),
  model: z.string().optional(),
})

export const BenchmarkThresholdsSchema = z.object({
  successRate: z.number().min(0).max(1).default(1),
  correctnessRate: z.number().min(0).max(1).optional(),
  p95LatencyMs: z.number().positive().optional(),
})

export const BenchmarkCaseSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  layer: BenchmarkLayerSchema,
  iterations: z.number().int().positive().default(1),
  warmup: z.number().int().nonnegative().default(0),
  timeoutMs: z.number().int().positive().default(120_000),
  variant: BenchmarkVariantSchema.default({}),
  input: z.unknown(),
  expected: z.unknown().optional(),
  thresholds: BenchmarkThresholdsSchema.default({ successRate: 1 }),
})
export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>

export const BenchmarkSuiteSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  description: z.string().default(''),
  cases: z.array(BenchmarkCaseSchema).min(1),
})
export type BenchmarkSuite = z.infer<typeof BenchmarkSuiteSchema>

export interface BenchmarkExecution {
  success: boolean
  correct?: boolean | undefined
  output?: unknown
  detail?: string | undefined
}

export type BenchmarkExecutor = (
  benchmarkCase: BenchmarkCase,
  iteration: number,
) => Promise<BenchmarkExecution>

export interface BenchmarkCaseReport {
  id: string
  layer: BenchmarkLayer
  variant: z.infer<typeof BenchmarkVariantSchema>
  samples: number
  successes: number
  correct: number
  evaluated: number
  successRate: number
  correctnessRate?: number | undefined
  latencyMs: { min: number; p50: number; p95: number; max: number; mean: number }
  throughputPerSecond: number
  passed: boolean
  failures: string[]
}

export interface BenchmarkReport {
  schemaVersion: 1
  suite: string
  startedAt: string
  finishedAt: string
  passed: boolean
  cases: BenchmarkCaseReport[]
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))
  return sorted[index] ?? 0
}

function fixed(value: number): number {
  return Number(value.toFixed(3))
}

async function runWithTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`benchmark timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runBenchmarkSuite(
  rawSuite: BenchmarkSuite,
  executors: BenchmarkExecutor | Partial<Record<BenchmarkLayer, BenchmarkExecutor>>,
): Promise<BenchmarkReport> {
  const suite = BenchmarkSuiteSchema.parse(rawSuite)
  const startedAt = new Date().toISOString()
  const reports: BenchmarkCaseReport[] = []
  for (const benchmarkCase of suite.cases) {
    const executor = typeof executors === 'function' ? executors : executors[benchmarkCase.layer]
    if (!executor) throw new Error(`no benchmark executor for layer ${benchmarkCase.layer}`)
    for (let index = 0; index < benchmarkCase.warmup; index += 1) {
      await runWithTimeout(executor(benchmarkCase, -index - 1), benchmarkCase.timeoutMs)
    }
    const latencies: number[] = []
    const failures: string[] = []
    let successes = 0
    let correct = 0
    let evaluated = 0
    const caseStarted = performance.now()
    for (let index = 0; index < benchmarkCase.iterations; index += 1) {
      const sampleStarted = performance.now()
      try {
        const result = await runWithTimeout(executor(benchmarkCase, index), benchmarkCase.timeoutMs)
        if (result.success) successes += 1
        if (result.correct !== undefined) {
          evaluated += 1
          if (result.correct) correct += 1
        }
        if (!result.success || result.correct === false) {
          failures.push(result.detail ?? `iteration ${index} failed`)
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      } finally {
        latencies.push(performance.now() - sampleStarted)
      }
    }
    const durationSeconds = Math.max((performance.now() - caseStarted) / 1_000, 0.001)
    const successRate = successes / benchmarkCase.iterations
    const correctnessRate = evaluated > 0 ? correct / evaluated : undefined
    const latency = {
      min: fixed(Math.min(...latencies)),
      p50: fixed(percentile(latencies, 0.5)),
      p95: fixed(percentile(latencies, 0.95)),
      max: fixed(Math.max(...latencies)),
      mean: fixed(latencies.reduce((total, value) => total + value, 0) / latencies.length),
    }
    const passed =
      successRate >= benchmarkCase.thresholds.successRate &&
      (benchmarkCase.thresholds.correctnessRate === undefined ||
        (correctnessRate ?? 0) >= benchmarkCase.thresholds.correctnessRate) &&
      (benchmarkCase.thresholds.p95LatencyMs === undefined ||
        latency.p95 <= benchmarkCase.thresholds.p95LatencyMs)
    reports.push({
      id: benchmarkCase.id,
      layer: benchmarkCase.layer,
      variant: benchmarkCase.variant,
      samples: benchmarkCase.iterations,
      successes,
      correct,
      evaluated,
      successRate: fixed(successRate),
      ...(correctnessRate === undefined ? {} : { correctnessRate: fixed(correctnessRate) }),
      latencyMs: latency,
      throughputPerSecond: fixed(benchmarkCase.iterations / durationSeconds),
      passed,
      failures: failures.slice(0, 20),
    })
  }
  return {
    schemaVersion: 1,
    suite: suite.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    passed: reports.every((report) => report.passed),
    cases: reports,
  }
}

export function createProcessBenchmarkExecutor(input: {
  command: string
  args?: readonly string[] | undefined
  cwd?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
}): BenchmarkExecutor {
  const command = input.command.trim()
  if (!command) throw new Error('benchmark command is required')
  if (command.includes('\0') || (input.args ?? []).some((argument) => argument.includes('\0'))) {
    throw new Error('benchmark command and arguments cannot contain NUL bytes')
  }
  return async (benchmarkCase, iteration) =>
    new Promise<BenchmarkExecution>((resolve, reject) => {
      // The executable and argv are supplied explicitly by the local benchmark operator. shell:false
      // is the security boundary: suite/event data is passed over stdin and environment variables,
      // never interpolated into the command line.
      // codeql[js/command-line-injection]
      const child = spawn(command, input.args ?? [], {
        cwd: input.cwd,
        env: {
          ...(input.env ?? process.env),
          AGENTCOMM_BENCHMARK_CASE: benchmarkCase.id,
          AGENTCOMM_BENCHMARK_LAYER: benchmarkCase.layer,
          AGENTCOMM_BENCHMARK_ITERATION: String(iteration),
        },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.once('error', reject)
      child.once('close', (exitCode) => {
        if (exitCode !== 0) {
          resolve({
            success: false,
            correct: false,
            detail: stderr.trim() || `executor exited ${exitCode}`,
          })
          return
        }
        try {
          const line = stdout.trim().split(/\r?\n/).at(-1) ?? ''
          resolve(
            z
              .object({
                success: z.boolean(),
                correct: z.boolean().optional(),
                output: z.unknown().optional(),
                detail: z.string().optional(),
              })
              .parse(JSON.parse(line)),
          )
        } catch (error) {
          resolve({
            success: false,
            correct: false,
            detail: `invalid executor output: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
      })
      child.stdin.end(`${JSON.stringify({ case: benchmarkCase, iteration })}\n`)
    })
}

export function compareBenchmarkReports(
  baseline: BenchmarkReport,
  candidate: BenchmarkReport,
): {
  cases: {
    id: string
    successRateDelta: number
    correctnessRateDelta?: number | undefined
    p95LatencyDeltaMs: number
  }[]
} {
  const baselineById = new Map(baseline.cases.map((item) => [item.id, item]))
  return {
    cases: candidate.cases.flatMap((item) => {
      const previous = baselineById.get(item.id)
      if (!previous) return []
      return [
        {
          id: item.id,
          successRateDelta: fixed(item.successRate - previous.successRate),
          ...(item.correctnessRate === undefined || previous.correctnessRate === undefined
            ? {}
            : {
                correctnessRateDelta: fixed(item.correctnessRate - previous.correctnessRate),
              }),
          p95LatencyDeltaMs: fixed(item.latencyMs.p95 - previous.latencyMs.p95),
        },
      ]
    }),
  }
}
