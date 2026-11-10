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
  fallbackComboFor,
  formatAccelerator,
  normalizeAccelerator,
  shouldDispatchMenuAction,
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

  it('validateBinding rejects Cmd/Super modifiers (2026-09-21 review M2)', () => {
    // Cmd/Super name a mac-only chord: on win/linux the fallback table drops
    // the modifier and a Super-only binding lands as a BARE key — every plain
    // press of that letter would preventDefault into the action. normalizeAccelerator
    // collapses cmd/super into `mod`, so the guard must read the raw parts.
    for (const chord of ['Cmd+N', 'Super+N', 'super+shift+p', 'CMD+K']) {
      const result = validateBinding('new-task', chord, effectiveAccelerators())
      expect(result.ok, chord).toBe(false)
      expect(result.problem, chord).toBe('platform-modifier')
    }
    // CmdOrCtrl stays legal — the portable spelling and the recorder's output.
    expect(validateBinding('new-task', 'CmdOrCtrl+P', effectiveAccelerators())).toEqual({ ok: true })
  })

  it('fallbackComboFor maps the modifiers that fire on a PC keyboard, in input order', () => {
    expect(fallbackComboFor('CmdOrCtrl+N')).toBe('ctrl+n')
    expect(fallbackComboFor('Ctrl+Alt+U')).toBe('ctrl+alt+u')
    // A hand-edited 'Shift+Alt+P' must collide with the input's 'alt+shift+p'.
    expect(fallbackComboFor('Shift+Alt+P')).toBe('alt+shift+p')
  })

  it('fallbackComboFor never produces a bare or capitals-only key — the typing-hijack guard', () => {
    // Super/Cmd drop on a PC keyboard, and shift alone is how capital letters
    // get typed; an entry without ctrl/alt left must not be tabled at all.
    // Non-vacuous: weakening the guard to `combo.length` turns 'Super+Shift+N'
    // into 'shift+n' (hijacking capitals), deleting it turns 'Super+N' into 'n'.
    expect(fallbackComboFor('Super+N')).toBeNull()
    expect(fallbackComboFor('Cmd+N')).toBeNull()
    expect(fallbackComboFor('N')).toBeNull()
    expect(fallbackComboFor('Super+Shift+N')).toBeNull()
    expect(fallbackComboFor('Shift+N')).toBeNull()
    // Shift may still RIDE a real modifier.
    expect(fallbackComboFor('Ctrl+Shift+N')).toBe('ctrl+shift+n')
  })

  it('menu.ts builds the fallback table through the shared guard', () => {
    // The guard lives inside fallbackComboFor, so the runtime table is safe
    // exactly while menu.ts routes through it. Non-vacuous: reverting menu.ts
    // to its own inline mapping (the pre-M2 shape) fails this scan.
    expect(MENU).toContain('fallbackComboFor(')
  })

  it('both locales explain the platform-modifier rejection', () => {
    for (const locale of ['zh', 'en']) {
      const dict = read('src', 'renderer', 'src', 'i18n', 'locales', `${locale}.ts`)
      expect(dict, locale).toContain("'platform-modifier':")
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
    // 2026-11-10：重建搬进共享的保存后生效模块；保存门必须调用它。
    const effects = read('src', 'main', 'services', 'settings-side-effects.ts')
    expect(effects).toContain("import { rebuildApplicationMenu } from '../menu'")
    expect(effects).toContain('rebuildApplicationMenu()')
    expect(SETTINGS_HANDLER).toContain('applySettingsSideEffects(')
  })

  it('AppLayout forks open-search to the preview CM panel when it holds focus (review_20261103 高4)', () => {
    // The menu accelerator (mac) / before-input fallback (win+linux) consumes
    // ⌘F before any renderer keymap, so without this fork the chord ALWAYS
    // navigated to the search page and CodeMirror's searchKeymap was dead in
    // the main window. The fork must import through the zero-runtime seam —
    // a direct CodeMirrorEditor import here would break FileEditor's lazy
    // chunk contract (negative scan).
    expect(APP_LAYOUT).toContain('previewCmHasFocus()')
    expect(APP_LAYOUT).toContain('openPreviewSearchPanel()')
    expect(APP_LAYOUT).toContain("from '../preview/preview-cm-seam'")
    expect(APP_LAYOUT).not.toContain('CodeMirrorEditor')
    // The seam really reads focus (not bare registration), so ⌘F elsewhere
    // in the UI still means the navigation search page.
    expect(read('src', 'renderer', 'src', 'components', 'preview', 'preview-cm-seam.ts')).toContain('hasFocus')
  })
})

describe('menu dispatch focus gate', () => {
  it('swallows a keyboard accelerator while the main window is not focused', () => {
    // The mac app menu is app-global: with a popout / immersive window
    // focused, ⌘N used to fire the menu item and the main window answered
    // behind the user's back. Non-vacuous: reverting to an unconditional
    // dispatch flips the first assertion.
    expect(shouldDispatchMenuAction(true, false)).toBe(false)
    expect(shouldDispatchMenuAction(true, true)).toBe(true)
  })

  it('a real menu click always dispatches, focused or not', () => {
    expect(shouldDispatchMenuAction(false, true)).toBe(true)
    expect(shouldDispatchMenuAction(false, false)).toBe(true)
  })

  it('menu.ts hands the triggeredByAccelerator flag into the gate', () => {
    // Non-vacuous: dropping the flag hand-off (click: () => dispatch...)
    // fails the first scan; deleting the gate call fails the second.
    expect(MENU).toContain('event?.triggeredByAccelerator')
    expect(MENU).toContain('shouldDispatchMenuAction(viaAccelerator, win.isFocused())')
  })
})
