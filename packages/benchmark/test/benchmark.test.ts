import { describe, expect, it } from 'vitest'
import {
  type BenchmarkSuite,
  compareBenchmarkReports,
  createProcessBenchmarkExecutor,
  runBenchmarkSuite,
} from '../src/index.js'

const suite: BenchmarkSuite = {
  schemaVersion: 1,
  name: 'p0',
  description: 'layered smoke benchmark',
  cases: [
    {
      id: 'transport-delivery',
      description: 'delivery',
      layer: 'transport',
      iterations: 3,
      warmup: 1,
      timeoutMs: 1_000,
      variant: { transport: 'local' },
      input: { message: 'hello' },
      thresholds: { successRate: 1, correctnessRate: 1, p95LatencyMs: 500 },
    },
  ],
}

describe('layered benchmark runner', () => {
  it('reports latency, throughput, success, correctness, and thresholds', async () => {
    const report = await runBenchmarkSuite(suite, async () => ({
      success: true,
      correct: true,
    }))
    expect(report).toMatchObject({
      passed: true,
      cases: [
        {
          id: 'transport-delivery',
          samples: 3,
          successRate: 1,
          correctnessRate: 1,
          passed: true,
        },
      ],
    })
    expect(report.cases[0]?.throughputPerSecond).toBeGreaterThan(0)
  })

  it('compares the same case across two architecture variants', async () => {
    const baseline = await runBenchmarkSuite(suite, async () => ({
      success: true,
      correct: true,
    }))
    const candidate = structuredClone(baseline)
    if (!candidate.cases[0]) throw new Error('missing case')
    candidate.cases[0].successRate = 0.5
    candidate.cases[0].latencyMs.p95 += 10
    expect(compareBenchmarkReports(baseline, candidate).cases[0]).toMatchObject({
      successRateDelta: -0.5,
      p95LatencyDeltaMs: 10,
    })
  })

  it('rejects NUL bytes before spawning a benchmark executable', () => {
    expect(() =>
      createProcessBenchmarkExecutor({
        command: process.execPath,
        args: ['script.mjs\0ignored'],
        authorizedByOperator: true,
      }),
    ).toThrow('NUL bytes')
  })

  it('requires an explicit local authorization and an absolute executable', () => {
    expect(() =>
      createProcessBenchmarkExecutor({
        command: 'node',
        authorizedByOperator: true,
      }),
    ).toThrow('absolute executable path')
    expect(() =>
      createProcessBenchmarkExecutor({
        command: process.execPath,
        authorizedByOperator: false as true,
      }),
    ).toThrow('was not authorized')
  })

  it('terminates a process executor when a benchmark sample times out', async () => {
    const hangingSuite: BenchmarkSuite = {
      schemaVersion: 1,
      name: 'timeout',
      description: 'process timeout',
      cases: [
        {
          id: 'hanging-process',
          description: 'never returns',
          layer: 'system',
          iterations: 1,
          warmup: 0,
          timeoutMs: 50,
          variant: {},
          input: {},
          thresholds: { successRate: 1 },
        },
      ],
    }
    const executor = createProcessBenchmarkExecutor({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      authorizedByOperator: true,
    })
    const started = Date.now()

    const report = await runBenchmarkSuite(hangingSuite, executor)

    expect(Date.now() - started).toBeLessThan(1_000)
    expect(report.cases[0]).toMatchObject({
      passed: false,
      failures: ['benchmark timed out after 50ms'],
    })
  })
})
