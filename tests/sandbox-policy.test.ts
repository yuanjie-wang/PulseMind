import { describe, it, expect } from 'vitest'
import { normalizeSandboxPolicy, toSandboxApprovalMode, pickApprovalMode, requiresApproval, DEFAULT_SANDBOX_POLICY } from '../src/shared/sandbox/policy'

describe('normalizeSandboxPolicy', () => {
  it('falls back to defaults for null/garbage', () => {
    expect(normalizeSandboxPolicy(null)).toEqual(DEFAULT_SANDBOX_POLICY)
    expect(normalizeSandboxPolicy('nope')).toEqual(DEFAULT_SANDBOX_POLICY)
  })
  it('fills defaults for partial objects (old rows)', () => {
    expect(normalizeSandboxPolicy({})).toEqual(DEFAULT_SANDBOX_POLICY)
    expect(normalizeSandboxPolicy({ fs: 'read-only' })).toEqual({ ...DEFAULT_SANDBOX_POLICY, fs: 'read-only' })
  })
  it('rejects invalid enum values', () => {
    expect(normalizeSandboxPolicy({ fs: 'yolo' })).toEqual(DEFAULT_SANDBOX_POLICY)
  })
  it('drops approval from stored rows — it belongs to conversations now', () => {
    const p = normalizeSandboxPolicy({ approval: 'always-ask', network: 'deny' })
    expect('approval' in p).toBe(false)
    expect(p.network).toBe('deny')
  })
  it('keeps valid extraRoots and drops junk entries', () => {
    const p = normalizeSandboxPolicy({ extraRoots: ['/a', '', 42, '/b'] })
    expect(p.extraRoots).toEqual(['/a', '/b'])
  })
  it('hardIsolation requires explicit true', () => {
    expect(normalizeSandboxPolicy({ hardIsolation: 'yes' }).hardIsolation).toBe(false)
    expect(normalizeSandboxPolicy({ hardIsolation: true }).hardIsolation).toBe(true)
  })
})

describe('toSandboxApprovalMode', () => {
  it('accepts the three ladder levels and nothing else', () => {
    expect(toSandboxApprovalMode('auto')).toBe('auto')
    expect(toSandboxApprovalMode('outside-ask')).toBe('outside-ask')
    expect(toSandboxApprovalMode('always-ask')).toBe('always-ask')
    expect(toSandboxApprovalMode('yolo')).toBeUndefined()
    expect(toSandboxApprovalMode(true)).toBeUndefined()
    expect(toSandboxApprovalMode(undefined)).toBeUndefined()
  })
})

describe('pickApprovalMode (one precedence rule for every resolver)', () => {
  it('takes the most specific candidate that is set', () => {
    expect(pickApprovalMode('always-ask', 'auto')).toBe('always-ask')
    expect(pickApprovalMode(undefined, 'outside-ask')).toBe('outside-ask')
    expect(pickApprovalMode(null, undefined, 'always-ask')).toBe('always-ask')
  })
  it("falls back to 'auto' when nothing is set", () => {
    expect(pickApprovalMode()).toBe('auto')
    expect(pickApprovalMode(undefined, null)).toBe('auto')
  })
})

describe('requiresApproval (the ladder)', () => {
  it('never gates reads, at any level', () => {
    for (const mode of ['auto', 'outside-ask', 'always-ask'] as const) {
      expect(requiresApproval(mode, 'read')).toBe(false)
    }
  })
  it("'auto' runs everything", () => {
    expect(requiresApproval('auto', 'write')).toBe(false)
    expect(requiresApproval('auto', 'exec')).toBe(false)
  })
  it("'outside-ask' gates calls that leave the workspace, not writes", () => {
    expect(requiresApproval('outside-ask', 'write')).toBe(false)
    expect(requiresApproval('outside-ask', 'exec')).toBe(true)
  })
  it("'always-ask' gates writes too", () => {
    expect(requiresApproval('always-ask', 'write')).toBe(true)
    expect(requiresApproval('always-ask', 'exec')).toBe(true)
  })
})
