import {
  formatLocalInviteLink,
  formatPublicChannelLink,
  formatRelayInviteLink,
  formatTransportInviteLink,
  isValidName,
  parseInviteLink,
} from '@agent-comm/protocol'
import { describe, expect, it } from 'vitest'

describe('invite links', () => {
  it('round-trips relay link with e2e key in fragment', () => {
    const link = formatRelayInviteLink('https://relay.example.com/', 'tok_abc-123', 'KEYKEY')
    expect(link).toBe('https://relay.example.com/j/tok_abc-123#k=KEYKEY')
    const p = parseInviteLink(link)
    expect(p).toEqual({
      kind: 'relay',
      relayUrl: 'https://relay.example.com',
      joinToken: 'tok_abc-123',
      visibility: 'private',
      e2eKey: 'KEYKEY',
    })
  })

  it('removes every trailing slash without a backtracking regular expression', () => {
    const link = formatRelayInviteLink('https://relay.example.com////', 'tok_many_slashes', 'KEYKEY')
    expect(link).toBe('https://relay.example.com/j/tok_many_slashes#k=KEYKEY')
  })

  it('round-trips a public relay invitation without an E2E key', () => {
    const link = formatRelayInviteLink('https://relay.example.com', 'tok_public', undefined, 'public')
    expect(link).toBe('https://relay.example.com/j/tok_public#v=public')
    expect(parseInviteLink(link)).toEqual({
      kind: 'relay',
      relayUrl: 'https://relay.example.com',
      joinToken: 'tok_public',
      visibility: 'public',
    })
  })

  it('uses a public channel page itself as a stable join target', () => {
    const link = formatPublicChannelLink('https://relay.example.com/', 'open-lab')
    expect(link).toBe('https://relay.example.com/public/open-lab')
    expect(parseInviteLink(link)).toEqual({
      kind: 'public',
      relayUrl: 'https://relay.example.com',
      channel: 'open-lab',
    })
  })

  it('round-trips local link', () => {
    const link = formatLocalInviteLink('/Users/x/.agent-comm/local-hub.db', 't0k')
    const p = parseInviteLink(link)
    expect(p).toEqual({ kind: 'local', hubPath: '/Users/x/.agent-comm/local-hub.db', joinToken: 't0k' })
  })

  it('round-trips a pluggable transport link with its E2E key', () => {
    const link = formatTransportInviteLink('nats://broker.example:4222', 'tok_nats', 'KEYKEY')
    expect(parseInviteLink(link)).toEqual({
      kind: 'transport',
      home: 'nats://broker.example:4222',
      joinToken: 'tok_nats',
      e2eKey: 'KEYKEY',
    })
  })

  it('rejects garbage', () => {
    expect(() => parseInviteLink('ftp://nope')).toThrow()
    expect(() => parseInviteLink('https://relay.example.com/join/abc')).toThrow()
    expect(() => parseInviteLink('https://relay.example.com/j/a/b')).toThrow()
    expect(() => parseInviteLink('https://relay.example.com/public/a/b')).toThrow()
    expect(() => parseInviteLink('https://relay.example.com/j/token#v=secret')).toThrow()
  })
})

describe('names', () => {
  it('validates channel/alias names', () => {
    expect(isValidName('daily_report-1')).toBe(true)
    expect(isValidName('Bad Name')).toBe(false)
    expect(isValidName('')).toBe(false)
  })
})
