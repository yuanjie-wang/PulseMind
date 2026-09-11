import { describe, it, expect } from 'vitest'
import { normalizeSandboxPolicy, DEFAULT_SANDBOX_POLICY } from '../src/shared/sandbox/policy'

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
    expect(normalizeSandboxPolicy({ fs: 'yolo', approval: 'never' })).toEqual(DEFAULT_SANDBOX_POLICY)
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
