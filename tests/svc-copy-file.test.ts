// svcCopyFile both-ends guard (review 2026-09-25 item 1): the copy used to
// trust both spellings outright — SOURCE is an arbitrary read (deny roots must
// apply: ~/.ssh must not be copyable into a place the model can read back) and
// DESTINATION is an arbitrary write (baseline deny roots without a session,
// the workspace jail with one). The module chain reaches better-sqlite3 via
// audit-store (Electron ABI — cannot load under plain node vitest), so the DB
// is mocked and the captured audit rows double as the assertion channel: a
// denied guard must leave a `denied` row, an allowed write an `allowed` row,
// and a passing read must stay SILENT (that is the documented policy).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { svcCopyFile } from '../src/main/services/file-ops'
import { sessionSandbox } from '../src/main/sandbox/session-context'

interface AuditRow {
  actor: string | null
  action: string
  target: string | null
  decision: string
}

const { auditRows } = vi.hoisted(() => ({ auditRows: [] as AuditRow[] }))

// The INSERT's column order is id, ts, scope, actor, action, target, decision,
// policy_json, meta_json — mirror it exactly so a column reorder in the real
// SQL goes red here.
vi.mock('../src/main/storage/database', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes('INSERT INTO audit_log')) {
          auditRows.push({
            actor: (args[3] as string | null) ?? null,
            action: String(args[4]),
            target: (args[5] as string | null) ?? null,
            decision: String(args[6]),
          })
        }
      },
      all: () => [],
    }),
  }),
  initializeDatabase: async () => {},
  ensureDbHealthy: async () => {},
}))

const HOME = homedir() // tests/setup.ts points this at a throwaway dir
let root: string

function fresh(name: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pm-copyfile-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  auditRows.length = 0
})

describe('svcCopyFile — the copy itself', () => {
  it('copies and creates the destination parents', async () => {
    const dir = fresh('happy')
    const src = join(dir, 'data.txt')
    writeFileSync(src, 'hello')
    const dest = join(dir, 'nested', 'deep', 'copy.txt') // parents missing

    const res = await svcCopyFile({ sourceUrl: 'file://' + src, destination: dest })
    expect(res).toEqual({ success: true })
    expect(readFileSync(dest, 'utf-8')).toBe('hello')

    // Passing reads stay silent; the write is audited as allowed.
    expect(auditRows.filter((r) => r.action === 'fs.read')).toHaveLength(0)
    expect(auditRows).toContainEqual(
      expect.objectContaining({ action: 'fs.write', decision: 'allowed' }),
    )
  })

  it('strips the local-file: alias', async () => {
    const dir = fresh('localfile')
    const src = join(dir, 'a.txt')
    writeFileSync(src, 'alias')
    const dest = join(dir, 'copy.txt')
    const res = await svcCopyFile({ sourceUrl: 'local-file://' + src, destination: dest })
    expect(res.success).toBe(true)
    expect(readFileSync(dest, 'utf-8')).toBe('alias')
  })

  it('maps the file:///.pulsemind/ shorthand onto the data dir', async () => {
    mkdirSync(join(HOME, '.pulsemind'), { recursive: true })
    const src = join(HOME, '.pulsemind', 'shorthand-src.txt')
    writeFileSync(src, 'shorthand')
    const dest = join(fresh('shorthand'), 'copy.txt')
    const res = await svcCopyFile({
      sourceUrl: 'file:///.pulsemind/shorthand-src.txt',
      destination: dest,
    })
    expect(res.success).toBe(true)
    expect(readFileSync(dest, 'utf-8')).toBe('shorthand')
  })

  it('refuses an empty source', async () => {
    const res = await svcCopyFile({ sourceUrl: '', destination: join(root, 'x.txt') })
    expect(res).toEqual({ success: false, error: 'copy source is empty' })
  })
})

describe('svcCopyFile — `~` spellings (the guard must judge the file the op touches)', () => {
  it('expands `~` to home on a baseline write', async () => {
    const dir = fresh('tilde-ok')
    const src = join(dir, 'data.txt')
    writeFileSync(src, 'tilde')
    const dest = join(HOME, 'pm-copyfile-tilde.txt')
    const res = await svcCopyFile({ sourceUrl: 'file://' + src, destination: '~/pm-copyfile-tilde.txt' })
    expect(res.success).toBe(true)
    expect(readFileSync(dest, 'utf-8')).toBe('tilde')
    rmSync(dest, { force: true })
  })

  it('refuses a `~/.ssh` destination WITHOUT a session (pre-fix: guard saw a literal `~` dir under cwd, past every deny root)', async () => {
    const dir = fresh('tilde-dest')
    const src = join(dir, 'data.txt')
    writeFileSync(src, 'payload')
    const res = await svcCopyFile({ sourceUrl: 'file://' + src, destination: '~/.ssh/pwned-tilde.txt' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Path is protected/)
    expect(existsSync(join(HOME, '.ssh', 'pwned-tilde.txt'))).toBe(false)
  })

  it('refuses a `~/.ssh` SOURCE (the read half of the same escape)', async () => {
    mkdirSync(join(HOME, '.ssh'), { recursive: true })
    writeFileSync(join(HOME, '.ssh', 'id_rsa'), 'SECRET')
    const dest = join(fresh('tilde-src'), 'stolen.txt')
    const res = await svcCopyFile({ sourceUrl: '~/.ssh/id_rsa', destination: dest })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Path is protected/)
    expect(existsSync(dest)).toBe(false)
  })
})

describe('svcCopyFile — SOURCE read guard', () => {
  it('refuses a deny-root source and records the denial', async () => {
    const ssh = join(HOME, '.ssh')
    mkdirSync(ssh, { recursive: true })
    writeFileSync(join(ssh, 'id_rsa'), 'SECRET')
    const dest = join(fresh('src-guard'), 'stolen.txt')

    const res = await svcCopyFile({ sourceUrl: 'file://' + join(ssh, 'id_rsa'), destination: dest })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Path is protected/)
    expect(existsSync(dest)).toBe(false) // nothing landed
    expect(auditRows).toContainEqual(
      expect.objectContaining({ action: 'fs.read', decision: 'denied' }),
    )
  })
})

describe('svcCopyFile — DESTINATION write guard', () => {
  it('refuses a deny-root destination and records the denial', async () => {
    const dir = fresh('dest-guard')
    const src = join(dir, 'data.txt')
    writeFileSync(src, 'payload')
    const dest = join(HOME, '.ssh', 'pwned.txt')

    const res = await svcCopyFile({ sourceUrl: 'file://' + src, destination: dest })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Path is protected/)
    expect(existsSync(dest)).toBe(false)
    expect(auditRows).toContainEqual(
      expect.objectContaining({ action: 'fs.write', decision: 'denied' }),
    )
  })
})

describe('svcCopyFile — session workspace jail', () => {
  function inSession<T>(workspaceDir: string, fn: () => Promise<T>): Promise<T> {
    return sessionSandbox.run({ sessionId: 'sess_test', workspaceDir }, fn)
  }

  it('allows a write inside the workspace and audits it with the session id', async () => {
    const dir = fresh('sess-inside')
    const ws = join(dir, 'workspace')
    mkdirSync(ws)
    const src = join(dir, 'data.txt')
    writeFileSync(src, 'ok')
    const dest = join(ws, 'out', 'copy.txt')

    const res = await inSession(ws, () => svcCopyFile({ sourceUrl: 'file://' + src, destination: dest }))
    expect(res.success).toBe(true)
    expect(readFileSync(dest, 'utf-8')).toBe('ok')
    expect(auditRows).toContainEqual(
      expect.objectContaining({ action: 'fs.write', decision: 'allowed', actor: 'sess_test' }),
    )
  })

  it('refuses a write outside the workspace', async () => {
    const dir = fresh('sess-outside')
    const ws = join(dir, 'workspace')
    mkdirSync(ws)
    const src = join(dir, 'data.txt')
    writeFileSync(src, 'ok')
    const dest = join(dir, 'elsewhere.txt') // absolute, outside ws

    const res = await inSession(ws, () => svcCopyFile({ sourceUrl: 'file://' + src, destination: dest }))
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Write blocked by sandbox/)
    expect(existsSync(dest)).toBe(false)
    expect(auditRows).toContainEqual(
      expect.objectContaining({ action: 'fs.write', decision: 'denied' }),
    )
  })

  it('resolves a relative destination against the workspace', async () => {
    const dir = fresh('sess-relative')
    const ws = join(dir, 'workspace')
    mkdirSync(ws)
    const src = join(dir, 'data.txt')
    writeFileSync(src, 'rel')

    const res = await inSession(ws, () => svcCopyFile({ sourceUrl: 'file://' + src, destination: 'sub/copy.txt' }))
    expect(res.success).toBe(true)
    expect(readFileSync(join(ws, 'sub', 'copy.txt'), 'utf-8')).toBe('rel')
  })

  it('refuses a workspace-internal symlink pointing OUTSIDE (item 5, the P1 escape)', async () => {
    // Lexically ws/link/x.txt is inside the workspace — only the realpath
    // shows the write lands outside. Pre-fail-closed this passed.
    const dir = fresh('sess-escape')
    const ws = join(dir, 'workspace')
    const outside = join(dir, 'outside')
    mkdirSync(ws)
    mkdirSync(outside)
    symlinkSync(outside, join(ws, 'link'))
    const src = join(dir, 'data.txt')
    writeFileSync(src, 'escape')

    const res = await inSession(ws, () =>
      svcCopyFile({ sourceUrl: 'file://' + src, destination: join(ws, 'link', 'x.txt') }),
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Write blocked by sandbox/)
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
    expect(auditRows).toContainEqual(
      expect.objectContaining({ action: 'fs.write', decision: 'denied' }),
    )
  })

  it('refuses a `~/.ssh` destination under a session (pre-fix: judged the literal ~ segment INSIDE the workspace, wrote the real home)', async () => {
    const dir = fresh('sess-tilde')
    const ws = join(dir, 'workspace')
    mkdirSync(ws)
    const src = join(dir, 'data.txt')
    writeFileSync(src, 'x')

    const res = await inSession(ws, () =>
      svcCopyFile({ sourceUrl: 'file://' + src, destination: '~/.ssh/pwned-tilde.txt' }),
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Path is protected/)
    expect(existsSync(join(HOME, '.ssh', 'pwned-tilde.txt'))).toBe(false)
  })

  it('refuses a destination that IS a dangling symlink (fail-closed)', async () => {
    const dir = fresh('dangling-dest')
    const ws = join(dir, 'workspace')
    mkdirSync(ws)
    const src = join(dir, 'data.txt')
    writeFileSync(src, 'x')
    const dest = join(ws, 'link.txt')
    symlinkSync(join(dir, 'never.txt'), dest)

    const res = await inSession(ws, () => svcCopyFile({ sourceUrl: 'file://' + src, destination: dest }))
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/cannot be resolved/)
    expect(lstatSync(dest).isSymbolicLink()).toBe(true) // still a link…
    expect(existsSync(join(dir, 'never.txt'))).toBe(false) // …and it never fired
    expect(auditRows).toContainEqual(
      expect.objectContaining({ action: 'fs.write', decision: 'denied' }),
    )
  })
})
