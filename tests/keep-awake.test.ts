/** 运行期间阻止系统休眠 (PLAN-free, user request 2026-09-22).
 *
 * Two layers, per the house pattern for a feature whose interesting half is
 * wiring: the guard itself is driven for real — the vitest electron alias
 * makes `src/main/system/keep-awake.ts` importable and its powerSaveBlocker
 * observable (livePowerSaveBlockers() is the OS-assert surface) — and the
 * session-manager hook points are asserted against source, because vitest
 * here is node-env and a full hosted engine run is what the probes are for.
 *
 * Non-vacuity: every scan asserts an exact marker, and the behavioral tests
 * open with a clean-state guard that also fails if a previous case leaked a
 * hold. */

import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keepAwake, KEEP_AWAKE_ACTIVE_STATUSES } from '../src/main/system/keep-awake'
import { livePowerSaveBlockers } from './stubs/electron'

const source = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf-8')

/** Every engine status that must NOT hold the machine awake: the user-decision
 *  parks and the terminals. Pinned as data so the scope ruling is one list. */
const RELEASE_STATUSES = ['idle', 'completed', 'error', 'awaiting_approval', 'awaiting_user_input', 'awaiting_extension', 'awaiting_continue'] as const

describe('keep-awake guard', () => {
  beforeEach(() => {
    // Restore the switch before asserting: a previous case that failed mid-way
    // must not leave the guard disabled for the rest of the file.
    keepAwake.setEnabled(true)
    // A previous case must have walked itself back to released — this is both
    // the precondition and the leak detector.
    expect(keepAwake.isHolding()).toBe(false)
    expect(keepAwake.activeCount()).toBe(0)
    expect(livePowerSaveBlockers()).toBe(0)
  })

  it('holds while a session is working and releases at terminal statuses', () => {
    keepAwake.update('conv_a', 'executing')
    expect(keepAwake.isHolding()).toBe(true)
    expect(livePowerSaveBlockers()).toBe(1)

    for (const status of RELEASE_STATUSES) {
      keepAwake.update('conv_a', status)
      expect(keepAwake.isHolding(), `status ${status} must release`).toBe(false)
      expect(livePowerSaveBlockers()).toBe(0)
    }
  })

  it('re-acquires when the user answers a park and the engine resumes', () => {
    keepAwake.update('conv_a', 'executing')
    keepAwake.update('conv_a', 'awaiting_approval')
    expect(livePowerSaveBlockers()).toBe(0)
    keepAwake.update('conv_a', 'executing')
    expect(keepAwake.isHolding()).toBe(true)
    expect(livePowerSaveBlockers()).toBe(1)
    keepAwake.update('conv_a', 'completed')
  })

  it('refcounts across sessions and never double-starts the blocker', () => {
    keepAwake.update('conv_a', 'streaming')
    keepAwake.update('sub_b', 'executing')
    expect(livePowerSaveBlockers()).toBe(1) // one OS assert for N workers

    // A session moving between two active statuses must not re-start.
    keepAwake.update('conv_a', 'executing')
    expect(livePowerSaveBlockers()).toBe(1)

    keepAwake.update('conv_a', 'completed')
    expect(keepAwake.isHolding()).toBe(true) // sub_b still working
    expect(livePowerSaveBlockers()).toBe(1)
    keepAwake.update('sub_b', 'idle')
    expect(livePowerSaveBlockers()).toBe(0)
  })

  it('counts queued and retrying as working, parks as not', () => {
    keepAwake.update('conv_a', 'queued')
    expect(keepAwake.isHolding()).toBe(true)
    // Queued → streaming is a replacement, not a second hold.
    keepAwake.update('conv_a', 'streaming')
    expect(livePowerSaveBlockers()).toBe(1)
    keepAwake.update('conv_a', 'retrying')
    expect(keepAwake.isHolding()).toBe(true)
    expect(livePowerSaveBlockers()).toBe(1)
    keepAwake.update('conv_a', 'awaiting_user_input')
    expect(livePowerSaveBlockers()).toBe(0)
  })

  it('forget drops a session whose final status would otherwise pin the lock', () => {
    keepAwake.update('conv_a', 'executing')
    keepAwake.update('sub_b', 'executing')
    keepAwake.forget('conv_a')
    expect(keepAwake.isHolding()).toBe(true) // sub_b survives
    keepAwake.forget('sub_b')
    expect(livePowerSaveBlockers()).toBe(0)
    // Forgetting an unknown id is a no-op, not a crash or a spurious release.
    keepAwake.update('conv_a', 'streaming')
    keepAwake.forget('never_seen')
    expect(keepAwake.isHolding()).toBe(true)
    keepAwake.update('conv_a', 'idle')
  })

  it('pins the scope ruling: working statuses in, user parks out', () => {
    expect([...KEEP_AWAKE_ACTIVE_STATUSES].sort()).toEqual(['executing', 'queued', 'retrying', 'streaming'])
    for (const status of RELEASE_STATUSES) {
      expect(KEEP_AWAKE_ACTIVE_STATUSES.has(status), `status ${status} must not be active`).toBe(false)
    }
  })

  it('the switch releases mid-run and backfills on re-enable without a status event', () => {
    keepAwake.update('conv_a', 'executing')
    expect(livePowerSaveBlockers()).toBe(1)

    // Off mid-run releases immediately — the whole point of the switch.
    keepAwake.setEnabled(false)
    expect(keepAwake.isEnabled()).toBe(false)
    expect(livePowerSaveBlockers()).toBe(0)
    // ...but bookkeeping continues: the session is still known to be working.
    expect(keepAwake.activeCount()).toBe(1)

    // Status changes keep arriving while off (the run goes on) and must not hold.
    keepAwake.update('conv_a', 'streaming')
    expect(livePowerSaveBlockers()).toBe(0)

    // Re-enabling backfills from the live map alone — no new status event needed.
    keepAwake.setEnabled(true)
    expect(keepAwake.isHolding()).toBe(true)
    expect(livePowerSaveBlockers()).toBe(1)

    keepAwake.update('conv_a', 'completed')
  })

  it('the switch is a no-op at rest and repeated pushes do not double-start', () => {
    keepAwake.setEnabled(false)
    expect(livePowerSaveBlockers()).toBe(0)
    keepAwake.setEnabled(true)
    expect(livePowerSaveBlockers()).toBe(0) // idle → flipping changes nothing

    keepAwake.update('conv_a', 'executing')
    keepAwake.setEnabled(true) // already on — must not restart the blocker
    expect(livePowerSaveBlockers()).toBe(1)
    keepAwake.update('conv_a', 'idle')
  })
})

describe('keep-awake wiring', () => {
  it('hooks every engine status change in the session manager', () => {
    const src = source('src/main/agent/session-manager.ts')
    expect(src).toContain('keepAwake.update(sessionId, status.status)')
  })

  it('hooks the queued emit (the one status that bypasses engine callbacks)', () => {
    const src = source('src/main/agent/session-manager.ts')
    expect(src).toContain("keepAwake.update(sessionId, 'queued')")
  })

  it('forgets the session on dispose', () => {
    const src = source('src/main/agent/session-manager.ts')
    expect(src).toContain('keepAwake.forget(sessionId)')
  })

  it('requests the system-level (not display) blocker', () => {
    const src = source('src/main/system/keep-awake.ts')
    // Exactly one real call: the screen may sleep; only suspension is prevented.
    expect(src.match(/powerSaveBlocker\.start\('prevent-app-suspension'\)/g)?.length).toBe(1)
    expect(src).not.toContain('prevent-display-sleep')
  })

  it('the save door pushes the switch (effective on save, not next run)', () => {
    // 2026-11-10：动作在共享的保存后生效模块（模板包导入同一份）。
    const src = source('src/main/services/settings-side-effects.ts')
    expect(src).toContain('keepAwake.setEnabled(settings.keepAwakeEnabled ?? false)')
    expect(source('src/main/ipc/settings.handler.ts')).toContain('applySettingsSideEffects(')
  })

  it('startup seeds the switch before any session can start', () => {
    const src = source('src/main/index.ts')
    expect(src).toContain('keepAwake.setEnabled(bootSettings.keepAwakeEnabled ?? false)')
  })

  it('the settings store reads the field with the OFF default in all three doors', () => {
    const src = source('src/main/storage/settings-store.ts')
    // The get() branch is the load-bearing one: get() builds its result
    // field-by-field, FALLBACK is only the corrupt-file path, migrate only the
    // legacy-format one — each must carry the field separately. Default off:
    // every toggle in the 高级 panel defaults off (user ruling 2026-09-22).
    expect(src).toContain('keepAwakeEnabled: parsed.keepAwakeEnabled ?? false')
    expect(src.match(/keepAwakeEnabled: false/g)?.length).toBe(2) // FALLBACK + migrate
    expect(src).not.toContain('keepAwakeEnabled: true')
  })

  it('the guard pre-seeds its module default to OFF to match the product default', () => {
    // The singleton's initial value is unobservable after the first flip, so
    // pin the pre-seed at source: even a missed push cannot hold the machine
    // against the ruling.
    const src = source('src/main/system/keep-awake.ts')
    expect(src).toContain('private enabled = false')
  })

  it('the 高级 tab renders the toggle and writes the field live', () => {
    const ui = source('src/renderer/src/components/settings/DataRuntimeSettings.tsx')
    expect(ui).toContain("toggle('keepAwake', settings.keepAwakeEnabled ?? false")
    expect(ui).toContain('keepAwakeEnabled: value')
  })

  it('both locales carry the toggle copy', () => {
    for (const locale of ['zh', 'en']) {
      const src = source(`src/renderer/src/i18n/locales/${locale}.ts`)
      // prettier 会统一键值引号并折行长字符串——钉内容存在，不钉引号/行形态。
      expect(src, locale).toMatch(/keepAwake: ["']/)
      expect(src, locale).toMatch(/keepAwakeHelp:\s*["']/)
    }
  })
})
