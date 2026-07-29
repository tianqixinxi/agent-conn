import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..', '..')

function sourceFiles(directory: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) result.push(...sourceFiles(path))
    else if (path.endsWith('.ts')) result.push(path)
  }
  return result
}

function source(directory: string): string {
  return sourceFiles(directory)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
}

describe('foundation package boundaries', () => {
  it('keeps core and relay core free from the A2A SDK', () => {
    expect(source(join(root, 'packages/core/src'))).not.toContain('@a2a-js/sdk')
    expect(source(join(root, 'packages/relay/src'))).not.toContain('@a2a-js/sdk')
    expect(source(join(root, 'packages/a2a-binding/src'))).toContain('@a2a-js/sdk')
  })

  it('keeps the community manager-workers app independent from communication internals', () => {
    const application = source(join(root, 'applications/manager-workers/src'))
    for (const forbidden of [
      '@agent-comm/core',
      '@agent-comm/delivery',
      '@agent-comm/a2a-binding',
      '@agent-comm/harness-claude-code',
      '@agent-comm/protocol',
      'agent-comm/channel',
    ]) {
      expect(application).not.toContain(forbidden)
    }
  })

  it('uses the protocol package only as a compatibility facade', () => {
    const protocol = source(join(root, 'packages/protocol/src'))
    expect(protocol).toContain("export * from '@agent-comm/core'")
    expect(protocol).toContain("export * from '@agent-comm/a2a-binding'")
    expect(readdirSync(join(root, 'packages/protocol/src')).sort()).toEqual(['index.ts'])
  })

  it('keeps runtime ingress and its adapters independent from communication internals', () => {
    const contract = source(join(root, 'packages/runtime-ingress/src'))
    for (const forbidden of [
      '@agent-comm/core',
      '@agent-comm/delivery',
      '@agent-comm/a2a-binding',
      '@agent-comm/client-sdk',
      '@modelcontextprotocol/sdk',
      'agent-comm/channel',
    ]) {
      expect(contract).not.toContain(forbidden)
    }

    for (const packageName of [
      'harness-claude-code',
      'ingress-polling',
      'ingress-process',
      'ingress-webhook',
    ]) {
      const adapter = source(join(root, `packages/${packageName}/src`))
      expect(adapter).toContain('@agent-comm/runtime-ingress')
      expect(adapter).not.toContain('@agent-comm/core')
      expect(adapter).not.toContain('@agent-comm/delivery')
      expect(adapter).not.toContain('@agent-comm/a2a-binding')
      expect(adapter).not.toContain('agent-comm/channel')
    }
  })
})
