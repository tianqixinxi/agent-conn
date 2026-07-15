import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const hook = fileURLToPath(new URL('../../../hooks/require-connect-approval.mjs', import.meta.url))

function runHook(operation: string) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      tool_name: 'mcp__plugin_agent-comm_agent-comm__agent_comm',
      tool_input: { operation },
    }),
    encoding: 'utf8',
  })
}

describe('AgentComm Claude Code permission hook', () => {
  it('forces a host permission prompt before redeeming an invitation', () => {
    const result = runHook('connect')

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
      },
    })
  })

  it('does not interrupt safe post-connect operations', () => {
    const result = runHook('delegate')

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })
})
