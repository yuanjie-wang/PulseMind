import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── full_20261011 M8-F1 (P0-5): the git write gate jailed the CWD but not
// the PATHSPEC. `cwd` inside the workspace with `files: ['../../x']` reached
// `git restore -- ../../x` and discarded uncommitted changes OUTSIDE the
// workspace but inside the repo — irreversible data loss from one model tool
// call, zero preconditions. The gate now checks every file against the same
// two-coordinate roots (lexical + realpath) the cwd check uses.

let sandbox: { workspaceDir: string; execAllowlist: Set<string> } | null = null

vi.mock('../src/main/sandbox/session-context', () => ({
  currentSessionSandbox: () => sandbox,
}))

import { invokeGitAction } from '../src/main/git/git.service'

const ws = mkdtempSync(join(tmpdir(), 'pm-gitjail-'))
// A monorepo shape: the conversation workspace is a SUBDIR of the repo, which
// is exactly the case where the cwd gate passes and the pathspec escapes.
const repoDir = join(ws, 'repo')
const workspaceDir = join(repoDir, 'packages', 'app')
mkdirSync(workspaceDir, { recursive: true })
writeFileSync(join(repoDir, 'user-work.js'), 'const user = 1\n', 'utf-8')
writeFileSync(join(workspaceDir, 'in-ws.js'), 'const inWs = 1\n', 'utf-8')

beforeEach(() => {
  sandbox = { workspaceDir, execAllowlist: new Set() }
})

describe('invokeGitAction — pathspec rides the same jail as cwd (M8-F1)', () => {
  it('restore with a workspace-escaping pathspec is refused', async () => {
    const r = await invokeGitAction({ action: 'restore', cwd: workspaceDir, files: ['../../user-work.js'], confirm: true } as never)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).toContain('blocked by sandbox')
    expect(r.error.message).toContain('outside the conversation workspace')
  })

  it('commit with a workspace-escaping pathspec is refused', async () => {
    const r = await invokeGitAction({ action: 'commit', cwd: workspaceDir, message: 'x', files: ['../../user-work.js'] } as never)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).toContain('blocked by sandbox')
  })

  it('an absolute pathspec outside the workspace is refused too', async () => {
    const r = await invokeGitAction({ action: 'restore', cwd: workspaceDir, files: [join(ws, 'elsewhere.txt')], confirm: true } as never)
    expect(r.ok).toBe(false)
  })

  it('a pathspec that stays inside the workspace passes the gate (reaches git itself)', async () => {
    // No repo here on purpose: the gate must let it THROUGH (the failure is
    // git's own "not a repository", never the sandbox message).
    const r = await invokeGitAction({ action: 'restore', cwd: workspaceDir, files: ['in-ws.js'], confirm: true } as never)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).not.toContain('blocked by sandbox')
  })

  it('without a session sandbox the ladder is untouched (renderer git panel)', async () => {
    sandbox = null
    const r = await invokeGitAction({ action: 'restore', cwd: repoDir, files: ['whatever.js'], confirm: true } as never)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).not.toContain('blocked by sandbox')
  })
})
