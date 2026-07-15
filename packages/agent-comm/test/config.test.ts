import { describe, expect, it } from 'vitest'
import { resolveChannelProfile } from '../src/config.js'
import { createTmpWorkspace } from './helpers/tmp-profile.js'

describe('Claude Channel profile resolution', () => {
  it('derives stable but distinct node profiles from Claude session IDs', () => {
    const ws = createTmpWorkspace()
    try {
      const alice = resolveChannelProfile({
        rootDir: ws.rootDir,
        env: {
          AGENT_COMM_PROFILE: 'inherited-machine-profile',
          CLAUDE_CODE_SESSION_ID: '972ce47b-0d8a-423c-b775-5023aacf0179',
        },
      })
      const bob = resolveChannelProfile({
        rootDir: ws.rootDir,
        env: {
          AGENT_COMM_PROFILE: 'inherited-machine-profile',
          CLAUDE_CODE_SESSION_ID: '59ceeb8f-66b0-4603-9770-1858c52038ee',
        },
      })
      expect(alice.name).toBe('claude-972ce47b0d8a')
      expect(bob.name).toBe('claude-59ceeb8f66b0')
      expect(alice.identityKeyPath).not.toBe(bob.identityKeyPath)
    } finally {
      ws.cleanup()
    }
  })

  it('allows an explicit Channel profile and otherwise falls back outside Claude', () => {
    const ws = createTmpWorkspace()
    try {
      expect(
        resolveChannelProfile({
          rootDir: ws.rootDir,
          env: {
            AGENT_COMM_PROFILE: 'legacy',
            AGENT_COMM_CHANNEL_PROFILE: 'bob',
            CLAUDE_CODE_SESSION_ID: 'session-id',
          },
        }).name,
      ).toBe('bob')
      expect(resolveChannelProfile({ rootDir: ws.rootDir, env: { AGENT_COMM_PROFILE: 'legacy' } }).name).toBe(
        'legacy',
      )
    } finally {
      ws.cleanup()
    }
  })
})
