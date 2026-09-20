// ── Application menu + accelerators ──
// The app previously shipped with no application menu at all: macOS fell back
// to Electron's default, and Windows/Linux (titleBarStyle 'hidden', no visible
// menu bar) had no accelerators whatsoever — Cmd/Ctrl+N, Cmd/Ctrl+K, Cmd/Ctrl+,
// all dead. This module owns both halves:
//
//   macOS — a real, visible application menu. Menu accelerators fire natively;
//   the Edit roles keep Cmd+C/V working in read-only regions (editable fields
//   always worked — Chromium builds those in).
//
//   Windows/Linux — deliberately NO application menu: with the hidden title
//   bar a visible menu strip would break the custom header layout, and menu
//   accelerators are unreliable on frameless windows anyway. The same action
//   keys are handled by attachShortcutFallback(), a webContents
//   before-input-event guard, so the accelerators behave identically across
//   platforms.
//
// Both halves funnel through one dispatchMenuAction → MENU_ACTION IPC push;
// the renderer (AppLayout) owns what the actions actually do.
//
// Labels are a local zh/en map rather than the renderer's i18n locales: those
// live under src/renderer/src and the main bundle must not reach into
// renderer sources. Rebuilt on startup and on every settings save, so a
// locale switch applies immediately.

import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { settingsStore } from './storage/settings-store'
import { effectiveAccelerators, fallbackComboFor, type ShortcutActionId } from '../shared/shortcuts'

export type MenuActionId = ShortcutActionId

const LABELS = {
  zh: {
    app: 'PulseMind',
    file: '文件',
    newTask: '新建任务',
    newProject: '新建项目',
    closeWindow: '关闭窗口',
    edit: '编辑',
    view: '视图',
    commandPalette: '命令面板',
    toggleSidebar: '收起 / 展开侧边栏',
    toggleWorkbench: '打开 / 收起工作台',
    openSearch: '搜索',
    openUsage: '用量统计',
    openSettings: '设置…',
    window: '窗口',
  },
  en: {
    app: 'PulseMind',
    file: 'File',
    newTask: 'New Task',
    newProject: 'New Project',
    closeWindow: 'Close Window',
    edit: 'Edit',
    view: 'View',
    commandPalette: 'Command Palette',
    toggleSidebar: 'Toggle Sidebar',
    toggleWorkbench: 'Toggle Workbench',
    openSearch: 'Search',
    openUsage: 'Usage',
    openSettings: 'Settings…',
    window: 'Window',
  },
} as const

let getWindow: (() => BrowserWindow | null) | null = null

function dispatchMenuAction(action: MenuActionId): void {
  const win = getWindow?.()
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC_CHANNELS.MENU_ACTION, action)
}

function actionItem(action: MenuActionId, label: string, withAccelerator: boolean, accelerators: Record<MenuActionId, string>): MenuItemConstructorOptions {
  return {
    label,
    accelerator: withAccelerator ? accelerators[action] : undefined,
    click: () => dispatchMenuAction(action),
  }
}

function buildTemplate(locale: 'zh' | 'en', accelerators: Record<MenuActionId, string>): MenuItemConstructorOptions[] {
  const l = LABELS[locale]
  const darwin = process.platform === 'darwin'
  // Windows/Linux get no accelerators here — before-input-event owns those keys.
  const withAcc = darwin

  const viewMenu: MenuItemConstructorOptions = {
    label: l.view,
    submenu: [
      actionItem('command-palette', l.commandPalette, withAcc, accelerators),
      actionItem('toggle-sidebar', l.toggleSidebar, withAcc, accelerators),
      actionItem('toggle-workbench', l.toggleWorkbench, withAcc, accelerators),
      actionItem('open-search', l.openSearch, withAcc, accelerators),
      actionItem('open-usage', l.openUsage, withAcc, accelerators),
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
      ...(darwin ? [{ type: 'separator' as const }, { role: 'togglefullscreen' as const }] : []),
    ],
  }

  const fileMenu: MenuItemConstructorOptions = {
    label: l.file,
    submenu: [
      actionItem('new-task', l.newTask, withAcc, accelerators),
      actionItem('new-project', l.newProject, withAcc, accelerators),
      { type: 'separator' },
      ...(darwin ? [{ role: 'close' as const }] : [{ role: 'minimize' as const }, { role: 'close' as const }]),
    ],
  }

  if (darwin) {
    return [
      {
        label: l.app,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          // macOS convention puts 设置 under the app menu — and this item is
          // what makes ⌘, actually fire (it used to exist only in the
          // accelerator table with no menu item to carry it).
          actionItem('open-settings', l.openSettings, withAcc, accelerators),
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      fileMenu,
      {
        label: l.edit,
        submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
      },
      viewMenu,
      { label: l.window, submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    ]
  }

  // Windows/Linux: the template is still installed (an About/right-click path
  // and the role items) but stays invisible under the hidden title bar.
  return [
    fileMenu,
    {
      label: l.edit,
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    viewMenu,
    { label: l.window, submenu: [{ role: 'minimize' }, { role: 'close' }] },
  ]
}

/** Rebuild the menu from the freshly saved locale (settings.handler calls
 *  this after SETTINGS_SET). No-op before the first install. */
export async function rebuildApplicationMenu(): Promise<void> {
  if (!getWindow) return
  await installApplicationMenu(getWindow)
}

/** Install the application menu from the stored locale + shortcut overrides.
 *  Idempotent — call again after a settings save to rebuild in place (the
 *  settings handler does this on every SETTINGS_SET, so a locale switch or a
 *  rebind applies immediately). Also refreshes the non-darwin fallback table. */
export async function installApplicationMenu(getWin: () => BrowserWindow | null): Promise<void> {
  getWindow = getWin
  const stored = await settingsStore.get().catch(() => null)
  const locale = stored?.locale === 'en' ? 'en' : 'zh'
  const accelerators = effectiveAccelerators(stored?.shortcuts)
  refreshFallbackCombos(accelerators)
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(locale, accelerators)))
}

/** Non-darwin only (see module header): route the action accelerators through
 *  before-input-event, which fires even without a visible menu bar. Matches
 *  the current effective combos (defaults + settings overrides — refreshed by
 *  installApplicationMenu); anything else passes through untouched. Attach
 *  once per main window (createWindow) — the window can be recreated after
 *  close (tray relaunch path), so this rides window creation, not app startup. */
let fallbackCombos: Record<string, MenuActionId> = {}

function refreshFallbackCombos(accelerators: Record<MenuActionId, string>): void {
  // The notation mapping lives in shared/shortcuts.ts (fallbackComboFor) so
  // the bare-key guard it carries is testable and cannot drift from the input
  // side's modifier order. A null combo (no ctrl/alt left — a hand-edited
  // Super-only or Shift-only binding) is simply not tabled.
  const combos: Record<string, MenuActionId> = {}
  for (const [action, accelerator] of Object.entries(accelerators) as [MenuActionId, string][]) {
    const combo = fallbackComboFor(accelerator)
    if (combo) combos[combo] = action
  }
  fallbackCombos = combos
}

export function attachShortcutFallback(win: BrowserWindow): void {
  if (process.platform === 'darwin') return
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.meta) return
    const parts = ['ctrl', 'alt', 'shift'].flatMap((flag) => {
      if (flag === 'ctrl' && !input.control) return []
      if (flag === 'alt' && !input.alt) return []
      if (flag === 'shift' && !input.shift) return []
      return [flag]
    })
    parts.push(input.key.toLowerCase())
    const action = fallbackCombos[parts.join('+')]
    if (!action) return
    event.preventDefault()
    dispatchMenuAction(action)
  })
}
