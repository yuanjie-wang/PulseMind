// ── Session file-change ledger (2026-10-28 工作区树会话改动着色) ──
// What the conversation's own tools did to the workspace, kept so the 工作区
// tree can paint the rows: created files one colour, rewritten files another,
// their folders following. Pure and DOM-free — ToolExecutor records into it
// from the main process, the tree reads the derived marks in the renderer, and
// vitest pins both halves without either host.

import type { SessionFileChange, SessionFileChangeKind } from '../agent-protocol'

/**
 * Path → kind at FIRST touch. A second touch of a known path is a no-op — a
 * file the session created and then edited five times is still "created", and
 * `onChange` stays silent (nothing the consumer sees moved). `clear` is the
 * conversation reset's hook and the only way an entry leaves.
 */
export class SessionFileLedger {
  private readonly kinds = new Map<string, SessionFileChangeKind>()
  /** Fires after the ledger ACTUALLY changed, with the full list (small, and
   *  the consumer wants the set). Owned by the engine that hosts the session;
   *  sub-engines share the instance and never set their own. */
  onChange?: (changes: SessionFileChange[]) => void

  note(path: string, kind: SessionFileChangeKind): boolean {
    if (!path || this.kinds.has(path)) return false
    this.kinds.set(path, kind)
    this.onChange?.(this.list())
    return true
  }

  list(): SessionFileChange[] {
    return [...this.kinds].map(([path, kind]) => ({ path, kind }))
  }

  get size(): number {
    return this.kinds.size
  }

  clear(): void {
    if (this.kinds.size === 0) return
    this.kinds.clear()
    this.onChange?.([])
  }
}

/** Index of the last path separator — both spellings, since main's path.join
 *  builds the tree's keys with the OS separator while a relative tool path can
 *  bring the other one along (resolveToolFilePath joins with the workspace's
 *  separator and leaves the model's own segments alone). */
function lastSep(p: string): number {
  return Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
}

/** `.`/`..` segments and doubled separators folded away, separators kept as
 *  written — the tree's keys come from path.join, which normalizes exactly
 *  this much, so a ledger entry spelled `<ws>/./a//b.md` must still land on
 *  the row `<ws>/a/b.md`. */
export function normalizeChangePath(p: string): string {
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/'
  const absolute = p.startsWith('/') || p.startsWith('\\')
  const out: string[] = []
  for (const seg of p.split(/[/\\]/)) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(seg)
  }
  return (absolute ? sep : '') + out.join(sep)
}

/**
 * The tree's paint map: every changed path under `workspaceDir` → its kind,
 * plus every folder strictly between the root and a changed file → the kind
 * of its subtree. A folder with only created files inside is `created` (a new
 * folder reads as new), one with any rewritten file is `modified` — the
 * VS Code decoration rule. Entries outside the workspace are not the tree's
 * to paint and are skipped; the root itself is never marked (it has no row).
 */
export function fileChangeMarks(
  changes: readonly SessionFileChange[],
  workspaceDir: string | null | undefined,
): Map<string, SessionFileChangeKind> {
  const marks = new Map<string, SessionFileChangeKind>()
  if (!workspaceDir || changes.length === 0) return marks
  const root = normalizeChangePath(workspaceDir)
  for (const change of changes) {
    const path = normalizeChangePath(change.path)
    if (!path.startsWith(`${root}/`) && !path.startsWith(`${root}\\`)) continue
    marks.set(path, change.kind)
    for (let dir = path.slice(0, lastSep(path)); dir.length > root.length; dir = dir.slice(0, lastSep(dir))) {
      const prev = marks.get(dir)
      if (prev === 'modified') continue
      if (prev === undefined || change.kind === 'modified') marks.set(dir, change.kind)
    }
  }
  return marks
}
