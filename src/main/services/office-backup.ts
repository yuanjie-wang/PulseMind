// ── Office original backup (PLAN-office-editing L10) ──
// Before the FIRST modification of an office document, copy the original to
// DATA_DIR/tmp/docx-backups/<stem>-<stamp><ext>, keep 10 per stem. The write
// itself is atomic and gated — the backup only serves "我想反悔"; failure
// downgrades to a warning and never blocks.

import { readdir, mkdir, copyFile, unlink } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { DATA_DIR } from '../storage'

const pReaddir = promisify(readdir)
const pMkdir = promisify(mkdir)
const pCopyFile = promisify(copyFile)
const pUnlink = promisify(unlink)

const BACKUP_DIR = join(DATA_DIR, 'tmp', 'docx-backups')
const BACKUPS_PER_NAME = 10

/** Backup file name for one stamp — the exact shape the prune below matches. */
function backupFileName(stem: string, stamp: string, ext: string): string {
  return `${stem}-${stamp}${ext}`
}

/** The prune set is THIS file's own restore points, not every file sharing a
 *  prefix: `报告.docx` used to count (and evict) `报告-终稿-<stamp>.docx`'s
 *  backups because `startsWith('报告-')` matched them too (M5). The stamp is
 *  always an ISO date head, so anchor on it. */
function ownBackupFiles(names: string[], stem: string, ext: string): string[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${esc(stem)}-\\d{4}-\\d{2}-\\d{2}T.*${esc(ext)}$`)
  return names.filter((f) => re.test(f))
}

export async function backupOfficeOriginal(safePath: string): Promise<{ backup?: string; warning?: string }> {
  try {
    const name = basename(safePath)
    const stem = name.replace(/\.[^.]+$/, '')
    const ext = name.match(/\.[^.]+$/)?.[0] ?? ''
    await pMkdir(BACKUP_DIR, { recursive: true })
    const existing = await pReaddir(BACKUP_DIR)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = join(BACKUP_DIR, backupFileName(stem, stamp, ext))
    await pCopyFile(safePath, backupPath)
    const mine = ownBackupFiles(existing, stem, ext).sort()
    const excess = mine.slice(0, Math.max(0, mine.length + 1 - BACKUPS_PER_NAME))
    for (const old of excess) {
      try { await pUnlink(join(BACKUP_DIR, old)) } catch { /* best effort */ }
    }
    return { backup: backupPath }
  } catch (err) {
    return { warning: `备份失败（不影响写入）: ${err instanceof Error ? err.message : String(err)}` }
  }
}
