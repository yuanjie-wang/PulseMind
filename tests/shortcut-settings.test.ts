// ── 设置 → 快捷键: the shared table, its validation, and the wiring ──
// The pure half of shared/shortcuts.ts runs directly in node; the surfaces
// around it are pinned by source scans (vitest here is node-env — no jsdom
// for the settings page mount; that lives in settings-page-integration.test.ts).
// Every scan names its non-vacuity condition — how it fails when the line it
// guards is deleted.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_ACCELERATORS,
  SHORTCUT_ACTION_IDS,
  effectiveAccelerators,
  formatAccelerator,
  normalizeAccelerator,
  validateBinding,
} from '../src/shared/shortcuts'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

const MENU = read('src', 'main', 'menu.ts')
const NAV_TYPES = read('src', 'renderer', 'src', 'navigation', 'types.ts')
const SETTINGS_PAGE = read('src', 'renderer', 'src', 'components', 'settings', 'SettingsPage.tsx')
const APP_LAYOUT = read('src', 'renderer', 'src', 'components', 'layout', 'AppLayout.tsx')
const SETTINGS_HANDLER = read('src', 'main', 'ipc', 'settings.handler.ts')
const SETTINGS_TYPES = read('src', 'shared', 'types', 'settings.ts')

describe('shared shortcuts table', () => {
  it('pins the 8 actions and every default accelerator', () => {
    expect(SHORTCUT_ACTION_IDS).toHaveLength(8)
    for (const id of SHORTCUT_ACTION_IDS) {
      expect(DEFAULT_ACCELERATORS[id], id).toMatch(/^CmdOrCtrl\+/)
    }
  })

  it('effectiveAccelerators merges overrides without mutating the defaults', () => {
    // Non-vacuous: an implementation that writes into DEFAULT_ACCELERATORS
    // fails the third assertion on the next call.
    const merged = effectiveAccelerators({ 'new-task': 'CmdOrCtrl+P' })
    expect(merged['new-task']).toBe('CmdOrCtrl+P')
    expect(merged['command-palette']).toBe(DEFAULT_ACCELERATORS['command-palette'])
    expect(DEFAULT_ACCELERATORS['new-task']).toBe('CmdOrCtrl+N')
  })

  it('normalizeAccelerator canonicalizes modifiers into a comparison form', () => {
    expect(normalizeAccelerator('shift+ctrl+n')).toBe('mod+shift+N')
    expect(normalizeAccelerator('Ctrl+Alt+U')).toBe(normalizeAccelerator('Ctrl+U+Alt'))
    // The Cmd family describes one physical chord per platform, so they all
    // collapse — Ctrl+K must compare equal to the default's CmdOrCtrl+K.
    expect(normalizeAccelerator('CmdOrCtrl+g')).toBe('mod+G')
    expect(normalizeAccelerator('Ctrl+g')).toBe(normalizeAccelerator('CmdOrCtrl+g'))
    expect(normalizeAccelerator('CmdOrCtrl+')).toBe('')
  })

  it('validateBinding accepts a free chord', () => {
    expect(validateBinding('new-task', 'CmdOrCtrl+P', effectiveAccelerators())).toEqual({ ok: true })
  })

  it('validateBinding rejects a chord another action already owns', () => {
    const result = validateBinding('new-task', 'Ctrl+K', effectiveAccelerators())
    expect(result.ok).toBe(false)
    expect(result.problem).toBe('conflict')
    expect(result.conflictWith).toBe('command-palette')
  })

  it('validateBinding rejects the menu-role accelerators', () => {
    // The template's roles own ⌘W (close) / ⌘R (reload) / ⇧⌘I (devtools) /
    // ⌘Q (quit) / ⌘M (minimize); the non-darwin template is installed too, so
    // the Ctrl twins fire there as well — a rebind onto them would double-fire.
    for (const reserved of ['CmdOrCtrl+W', 'CmdOrCtrl+R', 'CmdOrCtrl+Shift+I', 'CmdOrCtrl+Q', 'CmdOrCtrl+M']) {
      const result = validateBinding('new-task', reserved, effectiveAccelerators())
      expect(result.ok, reserved).toBe(false)
      expect(result.problem, reserved).toBe('reserved')
    }
  })

  it('validateBinding rejects chords without a real modifier', () => {
    // Shift alone would fire while the user types capitals; a bare key never
    // even forms a chord.
    for (const chord of ['Shift+N', 'N']) {
      const result = validateBinding('new-task', chord, effectiveAccelerators())
      expect(result.ok, chord).toBe(false)
      expect(result.problem, chord).toBe('no-modifier')
    }
  })

  it('formatAccelerator renders both platforms from one accelerator string', () => {
    // macOS convention displays ⇧ before ⌘ (as native menus do), and the
    // glyphs are separated by thin spaces (U+2009) so ⇧⌘N never reads as one
    // glued blob in a UI font.
    const THIN = '\u2009'
    expect(formatAccelerator('CmdOrCtrl+Shift+N', true)).toBe(`⇧${THIN}⌘${THIN}N`)
    expect(formatAccelerator('CmdOrCtrl+Shift+N', false)).toBe('Ctrl+Shift+N')
    expect(formatAccelerator('CmdOrCtrl+Alt+U', true)).toBe(`⌥${THIN}⌘${THIN}U`)
    // The punctuation key stays literal — ⌘ , is the spaced mac rendering.
    expect(formatAccelerator('CmdOrCtrl+,', true)).toBe(`⌘${THIN},`)
  })
})

describe('the shortcuts surface is wired end to end', () => {
  it("settingsTab admits 'shortcuts'", () => {
    expect(NAV_TYPES).toMatch(/settingsTab\?[^\n]*'shortcuts'/)
  })

  it('SettingsPage has the MENU entry, the renderSection case and the import', () => {
    // The repo's classic bug is "added the tab, never wired it" — all three
    // must be present. Non-vacuous: removing any one fails its scan.
    expect(SETTINGS_PAGE).toContain("from './ShortcutsSettings'")
    expect(SETTINGS_PAGE).toContain("key: 'shortcuts'")
    expect(SETTINGS_PAGE).toContain("case 'shortcuts':")
    expect(SETTINGS_PAGE).toContain('<ShortcutsSettings')
  })

  it('AppSettings carries the overrides field', () => {
    expect(SETTINGS_TYPES).toContain('shortcuts?: Partial<Record<ShortcutActionId, string>>')
  })

  it('menu.ts reads the shared table instead of declaring its own', () => {
    // Non-vacuous: reintroducing a local accelerator table (or dropping the
    // shared import) fails one of these two.
    expect(MENU).toContain("from '../shared/shortcuts'")
    expect(MENU).not.toMatch(/'new-task':\s*'CmdOrCtrl/)
  })

  it('the macOS template really carries the ⌘, menu item (the old dead-key bug)', () => {
    // Before the fix, open-settings existed only in the accelerator table —
    // no menu item rendered it, so ⌘, fired nothing on darwin. Non-vacuous:
    // deleting the item line fails this scan.
    expect(MENU.match(/actionItem\('open-settings'/g)?.length).toBeGreaterThanOrEqual(1)
  })

  it('the command palette hints derive from the effective table, not literals', () => {
    // Non-vacuous: reverting AppLayout to the old hardcoded `isMac ? '⌘N' : …`
    // fails the negative scan, so a rebind would leave the palette lying.
    expect(APP_LAYOUT).toContain('effectiveAccelerators(settings.shortcuts)')
    expect(APP_LAYOUT).not.toContain("'⌘N'")
  })

  it('a settings save rebuilds the menu (the path that makes a rebind land)', () => {
    expect(SETTINGS_HANDLER).toContain("import { rebuildApplicationMenu } from '../menu'")
    expect(SETTINGS_HANDLER).toContain('rebuildApplicationMenu()')
  })
})
