#!/usr/bin/env node

let raw = ''
for await (const chunk of process.stdin) raw += chunk

let input
try {
  input = JSON.parse(raw)
} catch {
  process.exit(0)
}

if (input?.tool_input?.operation !== 'connect') process.exit(0)

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'AgentComm wants to join a channel and establish a new trust relationship.',
    },
  }),
)
