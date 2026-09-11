import { describe, it, expect } from 'vitest'
import { guardPath, buildDenyRoots, buildBaselineDenyRoots, resolveTarget } from '../src/shared/sandbox/path-jail'
import { DEFAULT_SANDBOX_POLICY } from '../src/shared/sandbox/policy'

const HOME = '/Users/dev'
const WORKSPACE = '/Users/dev/code/my-app'
const denyRoots = buildDenyRoots(HOME, 'darwin')
const base = { denyRoots, workspaceDir: WORKSPACE, policy: { ...DEFAULT_SANDBOX_POLICY } }

describe('resolveTarget', () => {
  it('hangs relative paths off the workspace', () => {
    expect(resolveTarget(WORKSPACE, 'src/a.ts')).toBe(`${WORKSPACE}/src/a.ts`)
  })
  it('keeps absolute paths', () => {
    expect(resolveTarget(WORKSPACE, '/etc/hosts')).toBe('/etc/hosts')
  })
})

describe('guardPath — reads', () => {
  it('allow reads inside the workspace', () => {
    expect(guardPath({ ...base, target: 'src/a.ts', operation: 'read' }).ok).toBe(true)
  })
  it('allow reads outside the workspace (agent may look around)', () => {
    expect(guardPath({ ...base, target: '/usr/local/share/x.json', operation: 'read' }).ok).toBe(true)
  })
  it('deny reads of protected roots', () => {
    const d = guardPath({ ...base, target: `${HOME}/.ssh/id_rsa`, operation: 'read' })
    expect(d.ok).toBe(false)
  })
  it('deny reads resolved through symlinks into protected roots', () => {
    const d = guardPath({ ...base, target: '/tmp/idrsa', operation: 'read', realTarget: `${HOME}/.ssh/id_rsa` })
    expect(d.ok).toBe(false)
  })
})

describe('guardPath — writes (workspace-write)', () => {
  it('allow writes inside the workspace', () => {
    expect(guardPath({ ...base, target: 'src/out.ts', operation: 'write' }).ok).toBe(true)
  })
  it('deny writes outside the workspace', () => {
    const d = guardPath({ ...base, target: '/Users/dev/Desktop/evil.txt', operation: 'write' })
    expect(d.ok).toBe(false)
    expect(d.ok ? '' : d.reason).toMatch(/outside the project workspace/)
  })
  it('block traversal that escapes the workspace lexically', () => {
    const d = guardPath({ ...base, target: '../escape.txt', operation: 'write' })
    expect(d.ok).toBe(false)
  })
  it('deny writes into ~/.pulsemind even from a workspace session', () => {
    const d = guardPath({ ...base, target: `${HOME}/.pulsemind/db/pulsemind.db`, operation: 'write' })
    expect(d.ok).toBe(false)
  })
  it('allow writes through a symlink landing inside the workspace', () => {
    const d = guardPath({ ...base, target: '/tmp/link-out.txt', operation: 'write', realTarget: `${WORKSPACE}/out.txt` })
    expect(d.ok).toBe(true)
  })
  it('deny writes through a symlink landing outside the workspace', () => {
    const d = guardPath({ ...base, target: `${WORKSPACE}/link`, operation: 'write', realTarget: '/Users/dev/Desktop/evil.txt' })
    expect(d.ok).toBe(false)
  })
  it('honor extraRoots', () => {
    const policy = { ...DEFAULT_SANDBOX_POLICY, extraRoots: ['/Users/dev/shared'] }
    expect(guardPath({ ...base, policy, target: '/Users/dev/shared/a.txt', operation: 'write' }).ok).toBe(true)
  })
  it('treat the workspace root itself as writable', () => {
    expect(guardPath({ ...base, target: WORKSPACE, operation: 'write' }).ok).toBe(true)
  })
})

describe('guardPath — policy modes', () => {
  it('read-only denies writes but still allows reads', () => {
    const policy = { ...DEFAULT_SANDBOX_POLICY, fs: 'read-only' as const }
    expect(guardPath({ ...base, policy, target: 'src/out.ts', operation: 'write' }).ok).toBe(false)
    expect(guardPath({ ...base, policy, target: 'src/out.ts', operation: 'read' }).ok).toBe(true)
  })
  it('full-access writes anywhere outside deny roots', () => {
    const policy = { ...DEFAULT_SANDBOX_POLICY, fs: 'full-access' as const }
    expect(guardPath({ ...base, policy, target: '/Users/dev/Desktop/ok.txt', operation: 'write' }).ok).toBe(true)
    expect(guardPath({ ...base, policy, target: `${HOME}/.ssh/id_rsa`, operation: 'write' }).ok).toBe(false)
  })
})

describe('guardPath — baseline (no session)', () => {
  const baselineRoots = buildBaselineDenyRoots(HOME, 'darwin')
  it('allows app-internal writes into ~/.pulsemind', () => {
    const d = guardPath({ denyRoots: baselineRoots, target: `${HOME}/.pulsemind/knowledge/raw/a.md`, operation: 'write' })
    expect(d.ok).toBe(true)
  })
  it('still denies secrets', () => {
    expect(guardPath({ denyRoots: baselineRoots, target: `${HOME}/.ssh/id_rsa`, operation: 'read' }).ok).toBe(false)
  })
})

describe('buildDenyRoots', () => {
  it('adds the macOS keychain only on darwin', () => {
    expect(buildDenyRoots(HOME, 'darwin').some((r) => r.includes('Keychains'))).toBe(true)
    expect(buildDenyRoots(HOME, 'linux').some((r) => r.includes('Keychains'))).toBe(false)
  })
})
