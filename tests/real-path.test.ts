// Path-jail symlink fail-closed (review 2026-09-25 item 5): the jail decides
// on the REAL location of a path. The P1 bug was a target that doesn't exist
// yet skipping symlink resolution entirely (realpath ENOENT → lexical stands),
// so a write through a symlinked PARENT escaped the workspace while looking
// legal. `resolveRealTarget` anchors on the nearest existing ancestor instead,
// and fails CLOSED when the path exists but cannot be resolved (dangling or
// looping symlink). Real files on disk — no mocks, no DB in this module's
// import chain.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRealTarget, resolveRealTargetSync } from '../src/main/sandbox/real-path'

let root: string
/** macOS tmpdir (/var/…) is itself a symlink — judge everything against the
 *  real location of the sandbox, like the guard would. */
let realRoot: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pm-realpath-'))
  realRoot = realpathSync(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Fresh subdir per case so no test inherits another's links. */
function fresh(name: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return realpathSync(dir)
}

describe('resolveRealTarget — resolved paths', () => {
  it('returns the real path of an existing file', async () => {
    const dir = fresh('exists')
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x')
    const got = await resolveRealTarget(file)
    expect(got).toEqual({ status: 'resolved', path: realpathSync(file) })
  })

  it('follows a symlink to its target location', async () => {
    const dir = fresh('link')
    const target = join(dir, 'real.txt')
    const link = join(dir, 'alias.txt')
    writeFileSync(target, 'x')
    symlinkSync(target, link)
    const got = await resolveRealTarget(link)
    expect(got).toEqual({ status: 'resolved', path: realpathSync(target) })
  })

  it('anchors a not-yet-created path on its nearest existing ancestor', async () => {
    const dir = fresh('tail')
    const got = await resolveRealTarget(join(dir, 'deep', 'nested', 'new.txt'))
    expect(got).toEqual({ status: 'resolved', path: join(realRoot, 'tail', 'deep', 'nested', 'new.txt') })
  })

  it('resolves a symlinked PARENT of a not-yet-created target (the P1 bug)', async () => {
    // The escape: workspace/link → outside-dir, then write workspace/link/new.txt.
    // Pre-fix shape read "lexical stands" and kept workspace/link/new.txt —
    // legal-looking while the write lands OUTSIDE the workspace.
    const dir = fresh('parent')
    const outside = fresh('outside')
    const link = join(dir, 'link')
    symlinkSync(outside, link)
    const got = await resolveRealTarget(join(link, 'new.txt'))
    expect(got).toEqual({ status: 'resolved', path: join(outside, 'new.txt') })
    expect(got.status === 'resolved' && got.path.startsWith(outside)).toBe(true)
  })
})

describe('resolveRealTarget — fail-closed (unresolvable)', () => {
  it('refuses a dangling symlink (exists, would follow wherever it points)', async () => {
    const dir = fresh('dangling')
    const link = join(dir, 'dangling-link')
    symlinkSync(join(dir, 'never-existed'), link)
    expect(await resolveRealTarget(link)).toEqual({ status: 'unresolvable' })
    expect(resolveRealTargetSync(link)).toEqual({ status: 'unresolvable' })
  })

  it('refuses a symlink loop (ELOOP)', async () => {
    const dir = fresh('loop')
    const a = join(dir, 'a-link')
    symlinkSync(join(dir, 'b-link'), a)
    symlinkSync(a, join(dir, 'b-link'))
    expect(await resolveRealTarget(a)).toEqual({ status: 'unresolvable' })
    expect(resolveRealTargetSync(a)).toEqual({ status: 'unresolvable' })
  })

  it('refuses a NEW file under a dangling symlinked parent', async () => {
    // Walk reaches checkTail with tail [dangling-link, new.txt]: the first
    // tail segment IS a symlink the full realpath could not resolve, so a
    // write would follow it wherever it later points — fail closed.
    const dir = fresh('dangling-parent')
    const link = join(dir, 'link')
    symlinkSync(join(dir, 'gone'), link)
    expect(await resolveRealTarget(join(link, 'new.txt'))).toEqual({ status: 'unresolvable' })
    expect(resolveRealTargetSync(join(link, 'new.txt'))).toEqual({ status: 'unresolvable' })
  })

  it.skipIf(process.getuid?.() === 0)(
    'refuses a path under an unreadable directory (EACCES → cannot vouch)',
    async () => {
      const dir = fresh('eacces')
      const locked = join(dir, 'locked')
      mkdirSync(locked)
      chmodNoAccess(locked)
      try {
        expect(await resolveRealTarget(join(locked, 'x.txt'))).toEqual({ status: 'unresolvable' })
        expect(resolveRealTargetSync(join(locked, 'x.txt'))).toEqual({ status: 'unresolvable' })
      } finally {
        chmodNoAccess(locked, 0o700)
      }
    },
  )
})

function chmodNoAccess(p: string, mode = 0o000): void {
  chmodSync(p, mode)
}

describe('resolveRealTargetSync — the twin matches', () => {
  it('mirrors the async results on the same shapes', async () => {
    const dir = fresh('sync')
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x')
    expect(resolveRealTargetSync(file)).toEqual(await resolveRealTarget(file))

    const missing = join(dir, 'deep', 'new.txt')
    expect(resolveRealTargetSync(missing)).toEqual(await resolveRealTarget(missing))

    const outside = fresh('sync-outside')
    const link = join(dir, 'link')
    symlinkSync(outside, link)
    expect(resolveRealTargetSync(join(link, 'new.txt'))).toEqual({ status: 'resolved', path: join(outside, 'new.txt') })
  })
})

// lstat is what the tail probe uses — pin that a symlink is seen as one
// (the whole fail-closed decision hangs off st.isSymbolicLink()).
it('lstat distinguishes the link itself from its target', () => {
  const dir = fresh('lstat')
  const target = join(dir, 'real.txt')
  const link = join(dir, 'alias.txt')
  writeFileSync(target, 'x')
  symlinkSync(target, link)
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
})
