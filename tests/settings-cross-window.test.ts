// ── Cross-window settings sync (2026-10-30, popout theme bug) ──
// 用户报告：主窗切换主题后弹出窗口不变。根因是 useAppSettings 只在挂载时读一次
// 设置、跨窗口没有变更广播——弹出窗口的 settings.theme 停在打开那一刻。修法照
// CONVERSATION_TITLE_CHANGED 的既有跨窗口扇出模式，补一条 settings:changed 通道。
//
// 本文件钉三层接线，每条都点名非空洞条件（删掉被钉的行即红）：
// channels 常量、settings.handler 的广播、preload 的订阅、useAppSettings 的采用。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

const CHANNELS = read('src', 'shared', 'ipc-channels.ts')
const HANDLER = read('src', 'main', 'ipc', 'settings.handler.ts')
// 2026-11-10：广播随整串「保存后生效动作」搬进共享模块——设置页保存与模板包
// 导入两个入口共用一份，本文件的接线钉在模块上 + 钉保存门确实调用它。
const EFFECTS = read('src', 'main', 'services', 'settings-side-effects.ts')
const PRELOAD = read('src', 'preload', 'index.ts')
const BRIDGE = read('src', 'shared', 'types', 'electron-bridge.ts')
const APP_SETTINGS = read('src', 'renderer', 'src', 'hooks', 'useAppSettings.ts')

describe('settings:changed cross-window broadcast', () => {
  it('declares the channel', () => {
    // Non-vacuous: dropping the constant fails both the handler and preload scans below.
    expect(CHANNELS).toContain("SETTINGS_CHANGED: 'settings:changed'")
  })

  it('SETTINGS_SET fans the store view out to every window after the save', () => {
    // Non-vacuous: removing the loop, the send, or the store read fails here.
    expect(EFFECTS).toContain('BrowserWindow.getAllWindows()')
    expect(EFFECTS).toContain('win.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED')
    // Broadcasts the STORE's view (fresh merged profiles), not the caller's payload.
    expect(EFFECTS).toContain('await settingsStore.get()')
    // The save door must route through the shared block after the write, or a
    // window could read stale state (and the import door would skip the fan-out).
    expect(HANDLER).toContain('applySettingsSideEffects(')
    expect(HANDLER.indexOf('settingsStore.set(settings)')).toBeLessThan(
      HANDLER.indexOf('applySettingsSideEffects(')
    )
  })

  it('preload exposes onSettingsChanged wired to the channel', () => {
    // Non-vacuous: deleting the bridge method fails the contract + the listener scan.
    expect(BRIDGE).toContain('onSettingsChanged: (callback: (settings: AppSettings) => void) => () => void')
    expect(PRELOAD).toContain('onSettingsChanged:')
    expect(PRELOAD).toContain('ipcRenderer.on(IPC_CHANNELS.SETTINGS_CHANGED, listener)')
    expect(PRELOAD).toContain('ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_CHANGED, listener)')
  })

  it('useAppSettings adopts the broadcast into context state', () => {
    // The popout resolves its theme/locale from settings; the subscription is what
    // makes the switch follow without a reload. Non-vacuous: dropping the effect
    // (or the setState) fails here.
    expect(APP_SETTINGS).toContain('window.electronAPI?.onSettingsChanged?.')
    expect(APP_SETTINGS).toMatch(/onSettingsChanged\?\.\(\(next\) => \{\s*setSettings\(next\)/)
  })
})
