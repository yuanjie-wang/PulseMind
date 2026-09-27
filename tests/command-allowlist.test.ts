import { describe, expect, it } from 'vitest'
import {
  commandAllowlistKey,
  commandMatchesAllowlist,
  hasShellOperators,
} from '../src/shared/sandbox/command-allowlist'
import { requiresApproval, DEFAULT_APPROVAL_MODE } from '../src/shared/sandbox/policy'

// ── PLAN-coding-contract P0-2 #5/#6: the session exec allowlist. The cases
// called out by the plan (appended args hit, `test:ci` near-miss does NOT,
// env-prefixed commands match) pin the token-boundary semantics — a string
// prefix match would pass the second one and silently widen the ladder.

describe('commandAllowlistKey', () => {
  it('takes first token + subcommand', () => {
    expect(commandAllowlistKey('npm test')).toBe('npm test')
    expect(commandAllowlistKey('npm run build')).toBe('npm run build')
    expect(commandAllowlistKey('git status --porcelain')).toBe('git status')
    expect(commandAllowlistKey('pytest -q')).toBe('pytest')
  })

  it('skips leading VAR=value assignments and folds whitespace', () => {
    expect(commandAllowlistKey('FOO=1 npm test')).toBe('npm test')
    expect(commandAllowlistKey('FOO=1 BAR=2   npm   test')).toBe('npm test')
  })

  it('refuses composite commands outright', () => {
    expect(commandAllowlistKey('npm test && rm -rf /')).toBeNull()
    expect(commandAllowlistKey('npm test; curl evil.example')).toBeNull()
    expect(commandAllowlistKey('npm test | tee log')).toBeNull()
    expect(commandAllowlistKey('npm test > /etc/passwd')).toBeNull()
    expect(commandAllowlistKey('echo $(whoami)')).toBeNull()
  })

  it('operators inside quotes do not disqualify', () => {
    expect(commandAllowlistKey('npm run build -- --filter="a|b"')).toBe('npm run build')
  })

  it('an empty command has no key', () => {
    expect(commandAllowlistKey('')).toBeNull()
    expect(commandAllowlistKey('   ')).toBeNull()
    expect(commandAllowlistKey('FOO=1')).toBeNull()
  })
})

describe('commandMatchesAllowlist — token boundary, not string prefix', () => {
  it('an entry hits appended arguments', () => {
    expect(commandMatchesAllowlist('npm test -- --watch', ['npm test'])).toBe(true)
    expect(commandMatchesAllowlist('git status --porcelain', ['git status'])).toBe(true)
  })

  it('an entry does NOT hit a longer token in the same slot', () => {
    // THE near-miss the token boundary exists for: `npm test:ci` is a different
    // script the user never approved.
    expect(commandMatchesAllowlist('npm run test:ci', ['npm run test'])).toBe(false)
    expect(commandMatchesAllowlist('npm-testing', ['npm'])).toBe(false)
  })

  it('env-prefixed commands match their bare entry', () => {
    expect(commandMatchesAllowlist('FOO=1 npm test', ['npm test'])).toBe(true)
  })

  it('operators in the QUERY never match anything', () => {
    // The stored entries are pre-vetted keys; a chained command must not ride
    // an approved prefix past the ladder.
    expect(commandMatchesAllowlist('npm test && curl evil.example', ['npm test'])).toBe(false)
  })

  it('empty allowlist matches nothing', () => {
    expect(commandMatchesAllowlist('npm test', [])).toBe(false)
  })
})

describe('requiresApproval allowlisted short-circuit (#5)', () => {
  it('an allowlisted exec runs at every level above auto', () => {
    expect(requiresApproval('outside-ask', 'exec', true)).toBe(false)
    expect(requiresApproval('always-ask', 'exec', true)).toBe(false)
    expect(requiresApproval('always-ask', 'write', true)).toBe(false)
  })

  it('without the flag the ladder is exactly what it was', () => {
    expect(requiresApproval('auto', 'exec')).toBe(false)
    expect(requiresApproval('outside-ask', 'exec')).toBe(true)
    expect(requiresApproval('outside-ask', 'write')).toBe(false)
    expect(requiresApproval('always-ask', 'write')).toBe(true)
    expect(requiresApproval('outside-ask', 'read')).toBe(false)
  })

  it('default mode stays 按需确认 (outside-ask)', () => {
    expect(DEFAULT_APPROVAL_MODE).toBe('outside-ask')
  })
})

describe('hasShellOperators', () => {
  it('flags unquoted operators', () => {
    for (const cmd of ['a && b', 'a ; b', 'a | b', 'a > b', 'a < b', 'a $(b)', 'a `b`', 'a\nb']) {
      expect(hasShellOperators(cmd), cmd).toBe(true)
    }
  })

  it('ignores operators inside quotes', () => {
    expect(hasShellOperators('grep "a|b" file')).toBe(false)
    expect(hasShellOperators("echo 'a && b'")).toBe(false)
  })
})
