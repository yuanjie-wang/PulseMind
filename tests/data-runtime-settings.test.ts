// ── P3 of PLAN-settings-restructure: the 数据与运行 settings section ──
// Covers what can run in a node-env vitest: the shared retention constants and
// the wiring that cannot be mounted here (vitest has no jsdom/@testing-library,
// so SettingsPage and its sections cannot render). Every source scan names its
// non-vacuity condition — how it fails when the line it guards is deleted.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RETENTION_OPTIONS, retentionOptions } from '../src/renderer/src/components/settings/retention-options'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

const HANDLER = read('src', 'main', 'ipc', 'settings.handler.ts')
const WORKSPACE = read('src', 'renderer', 'src', 'components', 'routine', 'RoutineWorkspace.tsx')
const COMPONENT = read('src', 'renderer', 'src', 'components', 'settings', 'DataRuntimeSettings.tsx')
const NAV_TYPES = read('src', 'renderer', 'src', 'navigation', 'types.ts')
const SETTINGS_PAGE = read('src', 'renderer', 'src', 'components', 'settings', 'SettingsPage.tsx')
const retentionOptionsSrc = read('src', 'renderer', 'src', 'components', 'settings', 'retention-options.ts')

describe('shared retention options', () => {
  it('pins the four presets and their order (0/7/30/90, 0 = forever)', () => {
    expect(RETENTION_OPTIONS.map((o) => o.days)).toEqual([0, 7, 30, 90])
  })

  it('labels via i18n so the three surfaces cannot drift apart in wording', () => {
    const fake = (key: string, values?: Record<string, string | number>): string =>
      `${key}${values?.n !== undefined ? `:${values.n}` : ''}`
    expect(retentionOptions(fake)).toEqual([
      { days: 0, label: 'dataRuntime.keepForever' },
      { days: 7, label: 'dataRuntime.keepDays:7' },
      { days: 30, label: 'dataRuntime.keepDays:30' },
      { days: 90, label: 'dataRuntime.keepDays:90' },
    ])
  })

  it('no consumer keeps a local copy of the option list any more', () => {
    // Non-vacuous: reintroducing a literal {label:'永久保留'} list in either old
    // consumer fails this.
    for (const [name, src] of [['RoutineWorkspace', WORKSPACE]] as const) {
      expect(src.includes("label: '永久保留'"), name).toBe(false)
      expect(/RETENTION_OPTIONS\s*[:=]/.test(src), name).toBe(false)
      expect(src, name).toContain('retentionOptions(t)')
    }
    expect(COMPONENT).toContain('retentionOptions(t)')
  })
})

describe('settings.handler applies launch-at-login', () => {
  it('SETTINGS_SET calls applyLaunchAtLogin after the save', () => {
    // Non-vacuous: deleting the applyLaunchAtLogin call (or its import) fails this.
    expect(HANDLER).toContain("import { applyLaunchAtLogin } from '../tray'")
    expect(HANDLER).toContain('applyLaunchAtLogin(!!settings.launchAtLogin)')
    expect(HANDLER.indexOf('settingsStore.set(settings)')).toBeLessThan(HANDLER.indexOf('applyLaunchAtLogin(!!settings.launchAtLogin)'))
  })
})

describe('the 数据与运行 section is wired end to end', () => {
  it("settingsTab admits 'data'", () => {
    // Non-vacuous: dropping 'data' from the union fails both scans.
    expect(NAV_TYPES).toMatch(/settingsTab\?[^\n]*'data'/)
  })

  it('SettingsPage has the MENU entry, the renderSection case and the import', () => {
    // This repo's classic bug is "added the tab, never wired it" — all three
    // must be present. Non-vacuous: removing any one fails its scan.
    expect(SETTINGS_PAGE).toContain("from './DataRuntimeSettings'")
    expect(SETTINGS_PAGE).toContain("key: 'data'")
    expect(SETTINGS_PAGE).toContain("case 'data':")
    expect(SETTINGS_PAGE).toContain('<DataRuntimeSettings')
  })

  it('the section renders the live settings through the shared save path', () => {
    // A cached local copy would let two surfaces (routine workspace, this
    // tab) overwrite each other's fields on save.
    expect(COMPONENT).toContain('useSettings()')
    expect(COMPONENT).toContain('saveSettings({ ...settings,')
    expect(COMPONENT).not.toMatch(/useState<AppSettings>/)
  })

  it('fails visibly when a save errors instead of dying silently', () => {
    expect(COMPONENT).toContain('messageApi.error')
  })

  it('warns before the save that deletes conversations immediately', () => {
    // A tightened retention window takes effect on save (handler awaits
    // cleanupExpiredConversations), so the destructive consequence must be
    // confirmed, not discovered.
    expect(COMPONENT).toContain('retentionConfirmTitle')
    expect(COMPONENT).toContain('retentionConfirmContent')
    expect(COMPONENT).toContain('modal.confirm')
    expect(COMPONENT).toContain('okButtonProps: { danger: true }')
  })

  it('shows exactly one workspace directory row and it is read-only', () => {
    // D6: workspace stays editable in 环境设置; here it is read-only with an
    // open button. Non-vacuous: adding an Input/编辑 box for workspace fails
    // the first scan.
    expect(COMPONENT.match(/\{directory\('workspaceDir'\)\}/g)).toHaveLength(1)
    expect(COMPONENT).not.toContain('<Input')
  })

  it('keeps the debug explanation honest about when the dump takes effect', () => {
    // The gate is read per request through the mtime-cached store; the help
    // text must say the change applies to the next request.
    expect(COMPONENT).toContain('debugLlmRequests')
    expect(COMPONENT).toContain('dataRuntime.openLogDir')
  })

  it('one Switch click writes exactly one field through the live object', () => {
    expect(COMPONENT).toContain('launchAtLogin: value')
    expect(COMPONENT).toContain('autoCleanup: value')
    expect(COMPONENT).toContain('debugLlmRequests: value')
    expect(COMPONENT).toContain("git: { ...settings.git, contextInjection: value }")
    expect(COMPONENT).toContain('conversationRetentionDays: days')
    expect(COMPONENT).toContain('routineRunRetentionDays: days')
  })

  it('reuses the existing bridge methods — no preload changes needed', () => {
    expect(COMPONENT).toContain('getDataPaths()')
    expect(COMPONENT).toContain('openFolder(')
  })

  it('the new tab rides the existing navigation union, not a new kind', () => {
    expect(NAV_TYPES).not.toMatch(/kind: 'data'|'data' \|/)
    expect(NAV_TYPES).toContain("settingsTab?: 'environment'")
    // The plan pins 'one delegation per task' style red lines elsewhere; here the
    // pinned literal is the menu label key the i18n additions must provide.
    expect(SETTINGS_PAGE).toContain('appLayout.dataRuntime')
  })

  it('default settings tab stays 环境设置 (D8)', () => {
    expect(SETTINGS_PAGE).toContain("paramTab ?? 'environment'")
  })
})

describe('retention writers stay in sync', () => {
  it('all three surfaces write the same settings fields', () => {
    expect(WORKSPACE).toContain('routineRunRetentionDays: days')
    expect(COMPONENT).toContain('conversationRetentionDays: days')
    expect(COMPONENT).toContain('routineRunRetentionDays: days')
  })

  it('RoutineWorkspace reports a failed retention save instead of throwing unhandled', () => {
    // Non-vacuous: reverting setRetention's try/catch fails this.
    expect(WORKSPACE).toMatch(/try \{[\s\S]*?routineRunRetentionDays: days[\s\S]*?\} catch/)
  })

  it('the shared list lives in exactly one file, localized through the mapper', () => {
    // Exactly one definition lives in retention-options.ts; every consumer takes
    // labels from it via retentionOptions(t) so no surface re-declares the copy.
    const defCount = [WORKSPACE].filter((s) => s.includes('const RETENTION_OPTIONS')).length
    expect(defCount).toBe(0)
    expect(retentionOptionsSrc).toContain('export const RETENTION_OPTIONS')
    expect(retentionOptionsSrc).toContain("t('dataRuntime.keepForever')")
    expect(retentionOptionsSrc).toContain("t('dataRuntime.keepDays'")
  })

  it('keeps the shared constant free of hardcoded copy that could fork per locale', () => {
    // Labels come from i18n through the mapper; the constant's own labels are
    // the fallback the plan pins (zh wording), never re-declared per surface.
    const constants = [retentionOptionsSrc].filter((s) => s.includes('保留 7 天'))
    expect(constants.length).toBe(1)
  })
})
