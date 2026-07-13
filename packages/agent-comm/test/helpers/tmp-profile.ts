import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProfilePaths } from '../../src/config.js'
import { resolveProfile } from '../../src/config.js'

/**
 * W1 测试帮助函数:每个用例一个独立临时目录,多个 profile 共享同一 rootDir(从而共享
 * 同一个 defaultHubPath,D5)。不与其他工单的 test/helpers/* 同名。
 */
export interface TmpWorkspace {
  rootDir: string
  profile(name: string): ProfilePaths
  cleanup(): void
}

export function createTmpWorkspace(): TmpWorkspace {
  const rootDir = mkdtempSync(join(tmpdir(), 'agent-comm-w1-test-'))
  return {
    rootDir,
    profile(name: string): ProfilePaths {
      return resolveProfile({ profile: name, rootDir })
    },
    cleanup(): void {
      rmSync(rootDir, { recursive: true, force: true })
    },
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
