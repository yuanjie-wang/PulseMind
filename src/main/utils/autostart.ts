/**
 * Linux launch-at-login via an XDG autostart entry.
 *
 * `app.setLoginItemSettings` is macOS/Windows-only (Electron d.ts:
 * @platform darwin,win32), so before this module the 开机自启 toggle persisted
 * the preference and reported success while the OS never learned about it —
 * irrelevant on a closed laptop, fatal for the scheduled automations this app
 * is meant to run unattended. Linux's equivalent is a .desktop file under
 * $XDG_CONFIG_HOME/autostart; enabling writes it, disabling deletes it.
 *
 * Deliberately free of `electron` imports (paths and env are passed in) so both
 * the entry builder and the write/remove arms run under plain vitest.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const AUTOSTART_FILE_NAME = 'pulsemind.desktop'

export interface AutostartLaunchTarget {
  /** `process.execPath` — the binary currently running. */
  execPath: string
  /** `process.env.APPIMAGE` — the stable outer path when running as an AppImage. */
  appImagePath?: string
  /** Mirror the `--no-sandbox` the current session was launched with. */
  noSandbox?: boolean
}

export interface AutostartApplyResult {
  ok: boolean
  filePath: string
  error?: string
}

/** $XDG_CONFIG_HOME/autostart/pulsemind.desktop, falling back to ~/.config. */
export function autostartFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  return join(configHome, 'autostart', AUTOSTART_FILE_NAME)
}

/** Quote one Exec argument: the desktop-entry spec reserves whitespace, quotes,
 *  backslashes, backticks and `$` inside a quoted argument. */
function quoteExecArg(arg: string): string {
  if (!/[\s"'\\`$]/.test(arg)) return arg
  return `"${arg.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`
}

/**
 * The Exec value, or null when no path survives a reboot.
 *
 * An AppImage mounts itself under /tmp/.mount_<random> and unmounts on exit, so
 * `process.execPath` points into a directory that will not exist at the next
 * login; $APPIMAGE (the outer file) is the only stable target. Without it we
 * refuse to write an entry that would fail silently every boot.
 */
export function autostartExec(target: AutostartLaunchTarget): string | null {
  const appImage = target.appImagePath?.trim()
  const exec = appImage || target.execPath.trim()
  if (!exec) return null
  if (!appImage && /\/\.mount_[^/]+\//.test(exec)) return null
  return [quoteExecArg(exec), target.noSandbox ? '--no-sandbox' : ''].filter(Boolean).join(' ')
}

export function buildAutostartDesktopEntry(target: AutostartLaunchTarget): string | null {
  const exec = autostartExec(target)
  if (!exec) return null
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=PulseMind',
    `Exec=${exec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

/**
 * Create or remove the autostart entry. Returns a result instead of throwing so
 * the callers (startup and every settings save) can log and continue — a failed
 * autostart write must never take the app down.
 */
export function applyLinuxAutostart(
  enabled: boolean,
  target: AutostartLaunchTarget,
  filePath: string = autostartFilePath(),
): AutostartApplyResult {
  if (!enabled) {
    try {
      rmSync(filePath, { force: true })
      return { ok: true, filePath }
    } catch (err) {
      return { ok: false, filePath, error: errorMessage(err) }
    }
  }
  const entry = buildAutostartDesktopEntry(target)
  if (!entry) {
    return { ok: false, filePath, error: 'no stable executable path (AppImage without $APPIMAGE?)' }
  }
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
    writeFileSync(filePath, entry, { encoding: 'utf8', mode: 0o644 })
    return { ok: true, filePath }
  } catch (err) {
    return { ok: false, filePath, error: errorMessage(err) }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
