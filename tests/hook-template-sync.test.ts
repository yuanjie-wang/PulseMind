import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir as osTmpdir } from 'node:os'

import { ensureDataDir, DATA_DIR, HOOKS_DIR } from '../src/main/storage/index'
import { app } from './stubs/electron'

/**
 * hooks/ 模板的每次启动覆盖（user ruling 2026-10-30，copyTemplatesToDataDir
 * 「从不覆盖」契约的唯一例外）。
 *
 * The drift this file pins: the template copy condition was a bare
 * `!existsSync(destPath)` — "never overwrite user data" — so a hook script
 * seeded by ANY older release stayed frozen on an upgraded install forever
 * while the bundled template moved on (measured on the dev machine: the
 * watchdog guidance from 630ed7c never reached the on-disk copy). The ruling
 * makes the hooks subtree follow the template on every launch: a user-modified
 * hook file is replaced, identical bytes are skipped (no mtime churn on an
 * unchanged launch), files no template carries (llm-request.js is purely
 * user-created, never seeded) and any other disk-only extra are never
 * deleted, and OUTSIDE hooks/ the never-overwrite contract stands unchanged.
 */

const TEMPLATE_ROOT = join(osTmpdir(), `pulsemind-hook-sync-${process.pid}-${Date.now()}`)
const TEMPLATES_PULSEMIND = join(TEMPLATE_ROOT, 'templates', 'pulsemind')
const HOOK_TEMPLATE = join(TEMPLATES_PULSEMIND, 'hooks', 'app-start.js')
const DISK_HOOK = join(HOOKS_DIR, 'app-start.js')
const USER_ONLY_HOOK = join(HOOKS_DIR, 'llm-request.js')

const V1 = '// template v1 — the skeleton a previous release shipped\n'
const V2 = '// template v2 — improved skeleton with watchdog guidance\n'
const V3 = '// template v3 — a same-day second update state\n'
const V4 = '// template v4 — a later bundle text\n'

const originalGetAppPath = app.getAppPath

beforeAll(() => {
  app.getAppPath = () => TEMPLATE_ROOT
  mkdirSync(join(TEMPLATES_PULSEMIND, 'hooks'), { recursive: true })
  writeFileSync(HOOK_TEMPLATE, V1, 'utf-8')
})

afterAll(() => {
  app.getAppPath = originalGetAppPath
  rmSync(TEMPLATE_ROOT, { recursive: true, force: true })
  rmSync(DISK_HOOK, { force: true })
  rmSync(USER_ONLY_HOOK, { force: true })
  rmSync(join(DATA_DIR, 'notes.md'), { force: true })
  rmSync(join(HOOKS_DIR, 'app-start.js.20260315.bak'), { force: true })
})

describe('hooks template sync — the hooks subtree follows the template', () => {
  it('a fresh install still seeds the hook from the template', () => {
    ensureDataDir()
    expect(readFileSync(DISK_HOOK, 'utf-8')).toBe(V1)
  })

  it('a version upgrade ships the new template over a user-modified hook', () => {
    // The user edited the seeded hook (the dev machine had exactly this:
    // an uncommented ctx.browser.open line on top of the old seed).
    writeFileSync(DISK_HOOK, '// MY LOCAL EDIT\n' + V1, 'utf-8')
    writeFileSync(HOOK_TEMPLATE, V2, 'utf-8')

    ensureDataDir()

    // The ruling: the template wins. This is the assertion the old
    // !existsSync guard made impossible — the edit survived every upgrade.
    expect(readFileSync(DISK_HOOK, 'utf-8')).toBe(V2)
    expect(readFileSync(DISK_HOOK, 'utf-8')).not.toContain('MY LOCAL EDIT')
  })

  it('identical bytes are skipped — an unchanged launch does not touch the file', () => {
    const before = statSync(DISK_HOOK).mtimeMs
    ensureDataDir()
    expect(statSync(DISK_HOOK).mtimeMs).toBe(before)
    expect(readFileSync(DISK_HOOK, 'utf-8')).toBe(V2)
  })

  it('a hook file no template carries survives every resync', () => {
    writeFileSync(USER_ONLY_HOOK, '// the user runs this on every LLM request\n', 'utf-8')

    ensureDataDir()

    expect(readFileSync(USER_ONLY_HOOK, 'utf-8')).toBe('// the user runs this on every LLM request\n')
  })

  it('outside hooks/ the never-overwrite contract stands', () => {
    writeFileSync(join(TEMPLATES_PULSEMIND, 'notes.md'), 'template v1', 'utf-8')
    ensureDataDir()
    expect(readFileSync(join(DATA_DIR, 'notes.md'), 'utf-8')).toBe('template v1')

    // The template moved on — a plain template file must NOT follow it.
    writeFileSync(join(TEMPLATES_PULSEMIND, 'notes.md'), 'template v2 — changed', 'utf-8')
    ensureDataDir()
    expect(readFileSync(join(DATA_DIR, 'notes.md'), 'utf-8')).toBe('template v1')
  })
})

describe('hooks template backup — a replaced file stays recoverable', () => {
  // The .bak name carries the LOCAL date (user ruling 2026-10-30:
  // app-start.js -> app-start.js.yyyyMMdd.bak). Freezing the clock keeps the
  // name deterministic; the hardcoded stamp also pins the format itself.
  const BAK_PATH = join(HOOKS_DIR, 'app-start.js.20260315.bak')

  it('an update backs the replaced bytes up next to the file before overwriting', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 15, 10, 0, 0)) // 2026-03-15
    try {
      writeFileSync(DISK_HOOK, '// MY LOCAL EDIT\n' + V2, 'utf-8')
      writeFileSync(HOOK_TEMPLATE, V3, 'utf-8')
      rmSync(BAK_PATH, { force: true })

      ensureDataDir()

      expect(existsSync(BAK_PATH)).toBe(true)
      expect(readFileSync(BAK_PATH, 'utf-8')).toBe('// MY LOCAL EDIT\n' + V2)
      expect(readFileSync(DISK_HOOK, 'utf-8')).toBe(V3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the day\u2019s first backup survives a same-day second update', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 15, 18, 0, 0)) // still 2026-03-15
    try {
      const firstBackup = readFileSync(BAK_PATH, 'utf-8')

      // Template churns again the same day (dev machine or two installs);
      // disk currently holds V3, so an update fires — but the existing .bak
      // must not be replaced by the V3 intermediate state.
      writeFileSync(HOOK_TEMPLATE, V4, 'utf-8')
      ensureDataDir()

      expect(readFileSync(DISK_HOOK, 'utf-8')).toBe(V4)
      expect(readFileSync(BAK_PATH, 'utf-8')).toBe(firstBackup)
      expect(readFileSync(BAK_PATH, 'utf-8')).toBe('// MY LOCAL EDIT\n' + V2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('identical bytes and a fresh seed create no backup', () => {
    rmSync(BAK_PATH, { force: true })

    // Skip path: disk already equals the template.
    ensureDataDir()
    expect(existsSync(BAK_PATH)).toBe(false)

    // Fresh seed: nothing is replaced, so there is nothing to back up.
    rmSync(DISK_HOOK, { force: true })
    ensureDataDir()
    expect(readFileSync(DISK_HOOK, 'utf-8')).toBe(V4)
    expect(existsSync(BAK_PATH)).toBe(false)
  })
})
