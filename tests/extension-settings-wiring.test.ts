// ── 设置 → 浏览器插件: the independent panel's wiring ──
// Source scans (vitest here is node-env — the panel mount that drives the
// toggle for real lives in settings-page-integration.test.ts). Every scan
// names its non-vacuity condition — how it fails when the line it guards is
// deleted.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

const NAV_TYPES = read('src', 'renderer', 'src', 'navigation', 'types.ts')
const SETTINGS_PAGE = read('src', 'renderer', 'src', 'components', 'settings', 'SettingsPage.tsx')
const PANEL = read('src', 'renderer', 'src', 'components', 'settings', 'ExtensionSettings.tsx')
const CHANNELS = read('src', 'shared', 'ipc-channels.ts')
const HANDLER = read('src', 'main', 'ipc', 'service.handler.ts')
const PRELOAD = read('src', 'preload', 'index.ts')
const BRIDGE = read('src', 'shared', 'types', 'electron-bridge.ts')
const WS_SERVER = read('src', 'main', 'agent', 'ws-server.ts')
const LOCALE_ZH = read('src', 'renderer', 'src', 'i18n', 'locales', 'zh.ts')
const LOCALE_EN = read('src', 'renderer', 'src', 'i18n', 'locales', 'en.ts')
const PKG = JSON.parse(read('package.json')) as { scripts: Record<string, string>; build: { extraResources: Array<{ from: string; to: string }> } }

describe('the extension tab is wired end to end', () => {
  it("settingsTab admits 'extension'", () => {
    expect(NAV_TYPES).toMatch(/settingsTab\?[^\n]*'extension'/)
  })

  it('SettingsPage has the MENU entry, the renderSection case and the import', () => {
    // The repo's classic bug is "added the tab, never wired it" — all three
    // must be present. Non-vacuous: removing any one fails its scan.
    expect(SETTINGS_PAGE).toContain("from './ExtensionSettings'")
    expect(SETTINGS_PAGE).toContain("key: 'extension'")
    expect(SETTINGS_PAGE).toContain("case 'extension':")
    expect(SETTINGS_PAGE).toContain('<ExtensionSettings')
  })

  it('the panel renders all four blocks through i18n, not hardcoded Chinese', () => {
    // The old environment-settings card hardcoded every string; the promoted
    // panel must not regress. Non-vacuous: inlining a literal fails the scan.
    expect(PANEL).toContain('extensionSettings.serviceToggle')
    expect(PANEL).toContain('extensionSettings.download')
    expect(PANEL).toContain('extensionSettings.guide')
    expect(PANEL).not.toMatch(/标题|下载插件包|使用说明/)
  })

  it('the panel drives the service over the existing bridge (toggle + status)', () => {
    expect(PANEL).toContain('serviceSetEnabled(')
    expect(PANEL).toContain('serviceGetStatus()')
    expect(PANEL).toContain('serviceResetToken()')
  })
})

describe('SERVICE_GET_STATUS answers while the service runs (2026-09-20 report)', () => {
  // The report: the toggle never flipped and 已连接的客户端 stayed empty.
  // Root cause: the ws handle exposed no clients(), yet the handler called
  // handle?.clients() — a TypeError on EVERY status fetch while the service
  // was running (auto-started at boot), so the panel always showed the off
  // state. There is no typecheck gate, so pin the method on BOTH ends:
  // removing either the interface member or the handle's implementation, or
  // the handler's read, fails exactly one scan.
  it('the ws handle carries clients() and the handler reads it', () => {
    expect(WS_SERVER).toMatch(/clients\(\):\s*Array<\{\s*clientId: string; sessions: number\s*\}>/)
    expect(WS_SERVER).toContain('clients: () =>')
    expect(HANDLER).toContain('handle?.clients()')
  })

  it('the guide renders chrome://extensions as a link that opens the browser', () => {
    // The user expectation: the chrome://extensions step is directly
    // clickable. Non-vacuous: reverting the step to plain text fails the
    // withExtensionsLink scan; dropping the OS hand-off fails openExternal.
    expect(PANEL).toContain("const EXTENSIONS_PAGE = 'chrome://extensions'")
    expect(PANEL).toContain('withExtensionsLink(t(')
    expect(PANEL).toContain('openExternal(EXTENSIONS_PAGE)')
    // And the failed hand-off tells the user instead of dying silently.
    expect(LOCALE_ZH).toContain('guideOpenFailed')
    expect(LOCALE_EN).toContain('guideOpenFailed')
  })
})

describe('the extension zip export rides the full IPC chain', () => {
  it('the channel is declared once', () => {
    expect(CHANNELS).toContain("EXTENSION_EXPORT_ZIP: 'extension:export-zip'")
  })

  it('the main handler zips the build and saves through a dialog', () => {
    // Non-vacuous: deleting the handler registration, the zip step or the
    // save dialog fails its scan.
    expect(HANDLER).toContain('ipcMain.handle(IPC_CHANNELS.EXTENSION_EXPORT_ZIP')
    expect(HANDLER).toContain('addLocalFolder')
    expect(HANDLER).toContain('showSaveDialog')
  })

  it('a dev checkout without a build self-heals by running the build script', () => {
    // Non-vacuous: dropping the build invocation fails the first scan; making
    // it run in packaged builds too fails the guard scan.
    expect(HANDLER).toContain('buildExtensionInDev()')
    expect(HANDLER).toMatch(/!app\.isPackaged[\s\S]{0,200}buildExtensionInDev/)
  })

  it('preload exposes the method and the bridge types it', () => {
    expect(PRELOAD).toContain('extensionExportZip')
    expect(PRELOAD).toContain('IPC_CHANNELS.EXTENSION_EXPORT_ZIP')
    expect(BRIDGE).toContain('extensionExportZip: () => Promise<{ ok: boolean; path?: string; canceled?: boolean; message?: string }>')
  })
})

describe('the packaged app carries the extension', () => {
  it('the build script produces out/extension before packaging', () => {
    expect(PKG.scripts.build).toContain('build-extension.js')
  })

  it('extraResources copies it to resources/extension (the handler\'s packaged candidate)', () => {
    const shipped = PKG.build.extraResources.find((r) => r.from === 'out/extension')
    expect(shipped, 'extraResources entry for out/extension').toBeDefined()
    expect(shipped!.to).toBe('extension')
  })
})
