import { execFile } from 'node:child_process'
import { platform } from 'node:os'

let cachedPath: string | null = null
let pending: Promise<string | null> | null = null

/**
 * Resolve the user's login-shell PATH so spawned subprocesses can find tools
 * that live only in the shell profile (e.g. `bunx`, `codegraph`). Packaged
 * apps launched from Finder get a minimal PATH and can't resolve them.
 * Cached after the first successful resolution.
 */
export function initUserPath(): Promise<string | null> {
  if (cachedPath !== null) return Promise.resolve(cachedPath)
  if (pending) return pending
  pending = resolveUserPath()
    .then((p) => {
      cachedPath = p
      return p
    })
    .finally(() => {
      pending = null
    })
  return pending
}

/** Sync accessor for the resolved PATH (null until initUserPath completes). */
export function getUserPath(): string | null {
  return cachedPath
}

function resolveUserPath(): Promise<string | null> {
  // Windows apps inherit the merged system+user PATH at logon, so no augmentation needed.
  if (platform() === 'win32') return Promise.resolve(null)

  const shell = process.env.SHELL || (platform() === 'darwin' ? '/bin/zsh' : '/bin/bash')
  return new Promise((resolve) => {
    execFile(
      shell,
      // `-l` reads login profiles (.zprofile/.zlogin), `-i` reads interactive
      // ones (.zshrc) where most PATH additions (nvm, brew, cargo) live.
      ['-lic', 'echo "$PATH"'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve(null)
        // Interactive shells can print prompt/banner noise; the real PATH is
        // the last non-empty stdout line.
        const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
        const shellPath = lines[lines.length - 1] || ''
        if (!shellPath) return resolve(null)
        resolve(mergePath(shellPath, process.env.PATH))
      },
    )
  })
}

function mergePath(primary: string, fallback?: string): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const dir of [...primary.split(':'), ...(fallback ? fallback.split(':') : [])]) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    parts.push(dir)
  }
  return parts.join(':')
}
