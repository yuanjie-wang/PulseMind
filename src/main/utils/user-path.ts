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
      // `env` rather than echoing the shell variable: in fish $PATH is a
      // space-separated list and in csh the quoting rules differ, so the echoed
      // value cannot be split on ':' — `env` prints PATH in the same
      // colon-separated form in every shell.
      ['-lic', 'env'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve(null)
        const shellPath = extractShellPath(stdout)
        if (!shellPath) return resolve(null)
        resolve(mergePath(shellPath, process.env.PATH))
      },
    )
  })
}

/**
 * Pull the PATH value out of `env` output.
 *
 * Interactive shells can print prompt/banner noise around the dump, so scan
 * from the end for the last `PATH=` line (a later assignment wins in a real
 * shell too). The first `=` splits key from value: values may contain '='.
 */
export function extractShellPath(stdout: string): string | null {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/\r$/, '')
    if (!line.startsWith('PATH=')) continue
    const value = line.slice('PATH='.length)
    if (value) return value
  }
  return null
}

export function mergePath(primary: string, fallback?: string): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const dir of [...primary.split(':'), ...(fallback ? fallback.split(':') : [])]) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    parts.push(dir)
  }
  return parts.join(':')
}
