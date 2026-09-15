// ── Workspace-path helpers for the project modal ──
// Pure path logic: instant format feedback + name derivation in the renderer.
// The filesystem probe (existence/writability) is main-side — project.handler
// PROJECT_VALIDATE_DIR → projectStore.validateWorkspaceDir. The main process
// never expands `~` (ensureWorkspaceDir mkdirs the raw string), so a home
// shorthand is a format error rather than a valid path.

/** Why `dir` cannot be a workspace path, or null when the format is fine.
 *  Format-only on purpose: it must answer synchronously on every keystroke. */
export function checkWorkspacePathFormat(dir: string): string | null {
  const value = dir.trim()
  if (!value) return '请填写工作区路径'
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) return '不支持 ~ 简写，请填写完整绝对路径'
  // POSIX absolute, Windows drive (C:\ / C:/) or UNC (\\server\share)
  const isAbsolute = value.startsWith('/') || value.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(value)
  if (!isAbsolute) return '必须是绝对路径（以 / 或盘符开头）'
  if (value.includes('\0')) return '路径包含非法字符'
  return null
}

/** Last non-empty segment of a path, tolerating both separators. A bare drive
 *  segment (`C:`) is dropped along with empty ones, so roots ('/', 'C:\')
 *  return '' — nothing there is worth naming a project after. */
export function basenameOfPath(dir: string): string {
  const parts = dir.trim().split(/[/\\]+/).filter((p) => p && !/^[a-zA-Z]:$/.test(p))
  return parts.length ? parts[parts.length - 1] : ''
}

/** Windows reserved device names — a folder so named can never be created on
 *  Windows (with or without an extension: CON.txt is reserved too). Applied
 *  by the main process only when it actually runs on win32, so a legal
 *  ~/NUL folder on macOS is not a false positive. */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..+)?$/i

export function windowsReservedNameError(dir: string): string | null {
  const parts = dir.trim().split(/[/\\]+/).filter((p) => p && !/^[a-zA-Z]:$/.test(p))
  const hit = parts.find((p) => WINDOWS_RESERVED.test(p))
  return hit ? `「${hit}」是 Windows 保留设备名，不能用作文件夹名` : null
}
