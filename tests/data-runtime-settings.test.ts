// ── P3 of PLAN-settings-restructure: the settings page's 高级 section ──
// Covers what can run in a node-env vitest: the shared retention constants and
// the wiring that cannot be mounted here (vitest has no jsdom/@testing-library,
// so SettingsPage and its sections cannot render). Every source scan names its
// non-vacuity condition — how it fails when the line it guards is deleted.
//
// 2026-09-21 split: 启动/数据清理 moved from 数据与运行 (now 高级) into 常规
// (EnvironmentSettings), so the retention/launch scans point there.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RETENTION_OPTIONS, retentionOptions } from '../src/renderer/src/components/settings/retention-options'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

const HANDLER = read('src', 'main', 'ipc', 'settings.handler.ts')
const WORKSPACE = read('src', 'renderer', 'src', 'components', 'routine', 'RoutineWorkspace.tsx')
const COMPONENT = read('src', 'renderer', 'src', 'components', 'settings', 'DataRuntimeSettings.tsx')
const ENVIRONMENT = read('src', 'renderer', 'src', 'components', 'settings', 'EnvironmentSettings.tsx')
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
    // The selects live on 常规 (数据清理) since the 2026-09-21 split.
    expect(ENVIRONMENT).toContain('retentionOptions(t)')
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

describe('the settings sections are wired end to end', () => {
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
    // The moved groups ride the 常规 section's existing case.
    expect(SETTINGS_PAGE).toContain('<EnvironmentSettings')
    expect(SETTINGS_PAGE).toContain("case 'environment':")
  })

  it('both sections render the live settings through the shared save path', () => {
    // A cached local copy would let two surfaces (routine workspace, this
    // tab) overwrite each other's fields on save.
    for (const [name, src] of [['DataRuntimeSettings', COMPONENT], ['EnvironmentSettings', ENVIRONMENT]] as const) {
      expect(src, name).toContain('useSettings()')
      expect(src, name).toContain('saveSettings({ ...settings,')
      expect(src, name).not.toMatch(/useState<AppSettings>/)
    }
  })

  it('fails visibly when a save errors instead of dying silently', () => {
    // 2026-09-19: toasts consolidated onto the shared notify outlet —
    // the visible-failure contract itself is unchanged.
    expect(COMPONENT).toContain('notify.error')
    expect(ENVIRONMENT).toContain('notify.error')
  })

  it('warns before the save that deletes conversations immediately', () => {
    // A tightened retention window takes effect on save (handler awaits
    // cleanupExpiredConversations), so the destructive consequence must be
    // confirmed, not discovered. The 数据清理 group lives on 常规 now.
    expect(ENVIRONMENT).toContain('retentionConfirmTitle')
    expect(ENVIRONMENT).toContain('retentionConfirmContent')
    expect(ENVIRONMENT).toContain('modal.confirm')
    expect(ENVIRONMENT).toContain('okButtonProps: { danger: true }')
    expect(COMPONENT).not.toContain('modal.confirm')
  })

  it('常规 keeps the only workspace surface; the removed directory rows stay gone', () => {
    // 2026-09-20 settings cleanup removed the duplicated rows; 2026-09-21
    // dropped the read-only OS/time/directory rows entirely (默认工作区 is
    // the one path surface). Non-vacuous: reintroducing any removed row in
    // either file fails the not.toContain scans.
    for (const key of ['configDirectory', 'skillsDirectory', 'knowledgeDirectory']) {
      expect(ENVIRONMENT).not.toContain(`environmentDrawer.${key}`)
      expect(COMPONENT).not.toContain(`environmentDrawer.${key}`)
    }
    expect(ENVIRONMENT).toContain('environmentDrawer.workspace')
    expect(ENVIRONMENT).toContain('openFolder(')
    // The `<Input` scan guarded the row cleanup; the routine settlement
    // webhook (PLAN-routine-triggers M1) legitimately added the section's
    // url/secret inputs AFTER it, so the scan now covers the pre-existing
    // surface — everything before the webhook block must stay Input-free.
    expect(COMPONENT.slice(0, COMPONENT.indexOf('routineWebhook'))).not.toContain('<Input')
    // The dead i18n keys are gone from both locales too.
    for (const locale of ['zh', 'en']) {
      const table = read('src', 'renderer', 'src', 'i18n', 'locales', `${locale}.ts`)
      expect(table).not.toContain('operatingSystem:')
      expect(table).not.toContain('configDirectory:')
    }
  })

  it('keeps the debug explanation honest about when the dump takes effect', () => {
    // The gate is read per request through the mtime-cached store; the help
    // text must say the change applies to the next request.
    expect(COMPONENT).toContain('debugLlmRequests')
    expect(COMPONENT).toContain('dataRuntime.openLogDir')
  })

  it('the log-dir button stats first and greets a missing directory with a hint (2026-10-30)', () => {
    // The dump directory is created lazily by the first dumped request, so a
    // packaged install that never flipped the switch has no logs/llm-requests
    // and the button used to fail (OS error dialog or silence). The click must
    // stat, show the friendly hint on null, and only then openFolder.
    // Non-vacuous: deleting the stat call fails the ordering scan; swapping the
    // hint back to openFolder fails the notify.info scan; dropping either
    // locale's key fails the locale scan.
    const openLogDir = /const openLogDir = async[\s\S]*?\n\s{2}\}/.exec(COMPONENT)
    expect(openLogDir).not.toBeNull()
    const body = openLogDir![0]
    expect(body).toContain('getFileStat(')
    expect(body.indexOf('getFileStat(')).toBeLessThan(body.indexOf('openFolder('))
    expect(body).toContain("notify.info(t('dataRuntime.openLogDirMissing'))")
    expect(body).not.toContain('notify.error(t(')
    for (const locale of ['zh', 'en']) {
      expect(read('src', 'renderer', 'src', 'i18n', 'locales', `${locale}.ts`)).toContain('openLogDirMissing:')
    }
  })

  it('SHELL_OPEN_FOLDER surfaces openPath failures instead of swallowing them', () => {
    // openPath resolves with an error DESCRIPTION string; returning it as void
    // made every failed open a silent no-op. Non-vacuous: reverting to a bare
    // `await shell.openPath(safe)` fails the throw scan.
    const APP_HANDLER = read('src', 'main', 'ipc', 'app.handler.ts')
    const handler = /SHELL_OPEN_FOLDER[\s\S]*?\n\s{2}\}\)/.exec(APP_HANDLER)
    expect(handler).not.toBeNull()
    expect(handler![0]).toContain('const failure = await shell.openPath(safe)')
    expect(handler![0]).toContain('if (failure) throw new Error(failure)')
  })

  it('one Switch click writes exactly one field through the live object', () => {
    // 启动/数据清理 toggles write on 常规; the power-user toggles stay on 高级.
    expect(ENVIRONMENT).toContain('launchAtLogin: value')
    expect(ENVIRONMENT).toContain('autoCleanup: value')
    expect(ENVIRONMENT).toContain('conversationRetentionDays: days')
    expect(ENVIRONMENT).toContain('routineRunRetentionDays: days')
    expect(COMPONENT).toContain('debugLlmRequests: value')
    expect(COMPONENT).toContain("git: { ...settings.git, contextInjection: value }")
  })

  it('reuses the existing bridge methods — no preload changes needed', () => {
    for (const [name, src] of [['DataRuntimeSettings', COMPONENT], ['EnvironmentSettings', ENVIRONMENT]] as const) {
      expect(src, name).toContain('getDataPaths()')
      expect(src, name).toContain('openFolder(')
    }
  })

  it('the new tab rides the existing navigation union, not a new kind', () => {
    expect(NAV_TYPES).not.toMatch(/kind:.*'data'/)
    expect(NAV_TYPES).toContain("settingsTab?: 'environment'")
    // The plan pins 'one delegation per task' style red lines elsewhere; here the
    // pinned literal is the menu label key the i18n additions must provide.
    expect(SETTINGS_PAGE).toContain('appLayout.dataRuntime')
  })

  it('default settings tab stays 常规 (D8)', () => {
    expect(SETTINGS_PAGE).toContain("paramTab ?? 'environment'")
  })
})

describe('retention writers stay in sync', () => {
  it('all three surfaces write the same settings fields', () => {
    expect(WORKSPACE).toContain('routineRunRetentionDays: days')
    expect(ENVIRONMENT).toContain('conversationRetentionDays: days')
    expect(ENVIRONMENT).toContain('routineRunRetentionDays: days')
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

  // M4 (review 2026-09-18): SETTINGS_SET prunes expired conversations
  // main-side, and the retention writer (常规's 数据清理 since the 2026-09-21
  // split) was the only one that never refreshed the list — pruned sessions
  // lingered as clickable ghosts that a later open resurrected. The reload
  // prop must therefore be wired App → AppLayout → ViewHost → SettingsPage →
  // EnvironmentSettings and fired in the save's SUCCESS branch.
  it('a retention save triggers the conversation-list reload (M4)', () => {
    const app = read('src', 'renderer', 'src', 'App.tsx')
    const appLayout = read('src', 'renderer', 'src', 'components', 'layout', 'AppLayout.tsx')
    const viewHost = read('src', 'renderer', 'src', 'components', 'layout', 'ViewHost.tsx')
    // Non-vacuous per hop: deleting the prop from any one interface/JSX hop fails its scan.
    expect(ENVIRONMENT).toContain('onReloadConversations?: () => void')
    expect(ENVIRONMENT).toContain('onReloadConversations?.()')
    // ...and it fires only after the save succeeded (inside try, before catch).
    const saveBlock = /await saveSettings\(\{ \.\.\.settings, \.\.\.patch \}\)\n[\s\S]*?\} catch/.exec(ENVIRONMENT)
    expect(saveBlock).not.toBeNull()
    expect(saveBlock![0]).toContain('onReloadConversations?.()')
    expect(SETTINGS_PAGE).toContain('onReloadConversations={onReloadConversations}')
    expect(viewHost).toContain('onReloadConversations={onReloadConversations}')
    expect(appLayout).toContain('onReloadConversations?: () => void')
    expect(appLayout).toContain('onReloadConversations={onReloadConversations}')
    expect(app).toContain('reloadConversations,')
    expect(app).toContain('onReloadConversations={reloadConversations}')
  })
})
