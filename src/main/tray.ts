import { Tray, Menu, app, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface TrayDeps {
  /** Read the persisted launch-at-login preference. */
  getLaunchAtLogin(): Promise<boolean>
  /** One-line service status for the menu header (e.g. '服务运行中 :8765'). */
  getServiceStatus(): Promise<string>
  /** Persist a new launch-at-login preference (caller also applies setLoginItemSettings). */
  onToggleLaunchAtLogin(enabled: boolean): Promise<void>
  /** Show & focus the main window. */
  onShowWindow(): void
  onQuit(): void
}

/** Resolve a runtime resource under resources/ (mirrors index.ts getResourcePath). */
function resourcePath(...segments: string[]): string {
  const prodPath = join(process.resourcesPath, 'resources', ...segments)
  if (existsSync(prodPath)) return prodPath
  return join(__dirname, '../../resources', ...segments)
}

/**
 * Tray residency (PLAN-0.3.5 M2.3): the app stays alive with the window closed
 * (macOS already keeps the process; the tray gives it a visible anchor and an
 * explicit quit), plus a launch-at-login toggle — the base for the scheduled
 * automations and the local agent service.
 */
export function createTray(deps: TrayDeps): Tray {
  // pulseMind_tray.png (16px) + pulseMind_tray@2x.png (32px) — nativeImage picks up
  // both representations automatically. Template image: macOS recolors the badge
  // from its alpha channel, so the knocked-out pulse glyph stays visible on both
  // light and dark menu bars.
  const icon = nativeImage.createFromPath(resourcePath('pulseMind_tray.png'))
  icon.setTemplateImage(true)
  const tray = new Tray(icon)
  tray.setToolTip('PulseMind')

  const rebuild = async (): Promise<void> => {
    const launchAtLogin = await deps.getLaunchAtLogin().catch(() => false)
    const serviceStatus = await deps.getServiceStatus().catch(() => '服务未运行')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开 PulseMind', click: () => deps.onShowWindow() },
        { label: serviceStatus, enabled: false },
        { type: 'separator' },
        {
          label: '开机自启',
          type: 'checkbox',
          checked: launchAtLogin,
          click: (item) => { void deps.onToggleLaunchAtLogin(item.checked).then(() => rebuild()) },
        },
        { type: 'separator' },
        { label: '退出 PulseMind', click: () => deps.onQuit() },
      ]),
    )
  }
  void rebuild()

  // Keep the checkbox in sync if the preference changes elsewhere (settings UI).
  const timer = setInterval(() => { void rebuild() }, 30_000)
  app.on('before-quit', () => clearInterval(timer))

  return tray
}

/** Apply the persisted launch-at-login preference to the OS. */
export function applyLaunchAtLogin(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled })
}
