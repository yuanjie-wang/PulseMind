// ── Data-directory permission hardening (PLAN-security-hardening P0) ──
// ~/.pulsemind held its default-umask modes (0644/0755), which on a shared
// machine let every other local user read settings.json (plaintext apiKey
// when no ${ENV} placeholder is used), the WS service-token, the SQLite
// files (whole conversation history), the llm-request dumps (full request
// bodies) and MEMORY.md. The umask(0o077) set in main/index.ts covers every
// file created from now on; this module repairs the EXISTING tree.
//
// The checklist is explicit and deliberately NOT a recursive walk of
// ~/.pulsemind: workspace/, knowledge/ and tools/ hold large user content
// where the marginal gain is below the risk, and a project workspace (the
// jail root) may point OUTSIDE the data dir entirely — a recursive chmod
// would touch files the app does not own. New nested files are covered by
// the umask; pre-existing nested sensitive files (e.g. knowledge raw) stay
// a recorded boundary, not a bug.

import { chmodSync, existsSync, readdirSync, lstatSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, SETTINGS_PATH, MEMORY_MD_PATH } from './index'

export const SERVICE_TOKEN_PATH = join(DATA_DIR, 'service-token')

export interface PermissionTarget {
  path: string
  mode: number
  kind: 'dir' | 'file'
}

/** The pure half: which paths get which mode. Vitest walks this so the
 *  checklist's shape is pinned without touching a real filesystem. */
export function buildPermissionPlan(dataDir: string, opts?: { settingsPath?: string; memoryPath?: string; serviceTokenPath?: string }): PermissionTarget[] {
  const settingsPath = opts?.settingsPath ?? join(dataDir, 'settings.json')
  const memoryPath = opts?.memoryPath ?? join(dataDir, 'memory', 'MEMORY.md')
  const serviceTokenPath = opts?.serviceTokenPath ?? join(dataDir, 'service-token')
  const dbDir = join(dataDir, 'db')
  const logsDir = join(dataDir, 'logs')
  const llmRequestsDir = join(logsDir, 'llm-requests')
  const tmpDir = join(dataDir, 'tmp')
  const memoryDir = join(dataDir, 'memory')
  const experienceDir = join(dataDir, 'experience')

  const plan: PermissionTarget[] = [
    { path: dataDir, mode: 0o700, kind: 'dir' },
    { path: dbDir, mode: 0o700, kind: 'dir' },
    { path: logsDir, mode: 0o700, kind: 'dir' },
    { path: llmRequestsDir, mode: 0o700, kind: 'dir' },
    { path: memoryDir, mode: 0o700, kind: 'dir' },
    { path: tmpDir, mode: 0o700, kind: 'dir' },
    // 经验磁盘真源（2026-11-12 经验 SKILL 化）：EXPERIENCE.md 正文是会话衍生内容，
    // 根目录钉 0700；页内嵌套文件由 umask 兜住新建（清单不做递归走，见头注）。
    { path: experienceDir, mode: 0o700, kind: 'dir' },
    { path: settingsPath, mode: 0o600, kind: 'file' },
    { path: serviceTokenPath, mode: 0o600, kind: 'file' },
    { path: memoryPath, mode: 0o600, kind: 'file' },
  ]
  // db/ first level: every database artifact — the .db files, their -wal/-shm
  // siblings, AND the unmanaged backup files an older era left there (they
  // held the same conversation bytes as the db itself). Anything that is a
  // regular file in db/ is by construction app-owned.
  plan.push(...listRegularFiles(dbDir).map((path): PermissionTarget => ({ path, mode: 0o600, kind: 'file' })))
  // llm-requests first level: full request bodies = conversation transcripts.
  plan.push(...listRegularFiles(llmRequestsDir).map((path): PermissionTarget => ({ path, mode: 0o600, kind: 'file' })))
  return plan
}

function listRegularFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return (readdirSync(dir) as string[])
      .map((name) => join(dir, name))
      .filter((p) => {
        try {
          const st = lstatSync(p)
          return st.isFile()
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
}

/**
 * Idempotent, best-effort: a failure on one entry warns and counts but never
 * blocks startup (a permission this process cannot fix does not get better by
 * refusing to boot). Symbolic links are skipped via lstat — chmod would follow
 * the link and touch the TARGET, which may live anywhere.
 */
export function hardenDataDirPermissions(): { applied: number; skipped: number; failed: number } {
  const plan = buildPermissionPlan(DATA_DIR, { settingsPath: SETTINGS_PATH, memoryPath: MEMORY_MD_PATH, serviceTokenPath: SERVICE_TOKEN_PATH })
  let applied = 0
  let skipped = 0
  let failed = 0
  for (const target of plan) {
    try {
      if (!existsSync(target.path)) {
        skipped++
        continue
      }
      const st = lstatSync(target.path)
      if (st.isSymbolicLink()) {
        skipped++
        continue
      }
      // Shape changed under us (a "file" entry that is now a directory) —
      // skip rather than chmod the wrong shape.
      if ((target.kind === 'file') !== statSync(target.path).isFile()) {
        skipped++
        continue
      }
      if ((st.mode & 0o777) === target.mode) {
        skipped++ // already right — idempotent re-runs are the common case
        continue
      }
      chmodSync(target.path, target.mode)
      applied++
    } catch {
      failed++
    }
  }
  console.log(`[permissions] data dir hardened: ${applied} fixed, ${skipped} already ok/absent, ${failed} failed`)
  return { applied, skipped, failed }
}
