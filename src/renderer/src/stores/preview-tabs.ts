// ── Preview pane tab-list operations (PLAN-preview-pane §设计2) ──
// Pure helpers over the per-conversation tab list — no store, no React — so
// vitest covers them directly. `path` is the tab identity: the same file
// never opens twice.

import { baseName, detectFileKind, type FileKind } from '../../../shared/preview/file-kind'

export interface PreviewTab {
  path: string
  kind: FileKind
  title: string
}

/** Tab-strip ceiling; oldest tab (front) is evicted when exceeded. */
export const MAX_OPEN_TABS = 12

export function makeTab(path: string): PreviewTab {
  return { path, kind: detectFileKind(path), title: baseName(path) || path }
}

/** Append or no-op (already open). Evicts from the front beyond the cap. */
export function openTabInList(tabs: PreviewTab[], path: string): PreviewTab[] {
  if (tabs.some((t) => t.path === path)) return tabs
  const next = [...tabs, makeTab(path)]
  while (next.length > MAX_OPEN_TABS) next.shift()
  return next
}

export interface CloseTabResult {
  tabs: PreviewTab[]
  /** When the closed tab was active: its successor (same index), else the
   *  last tab; null when the strip emptied. Undefined when the closed tab
   *  was not the active one. */
  nextActive: string | null | undefined
}

export function closeTabInList(tabs: PreviewTab[], path: string, activePath: string | null): CloseTabResult {
  const index = tabs.findIndex((t) => t.path === path)
  if (index < 0) return { tabs, nextActive: undefined }
  const next = tabs.filter((t) => t.path !== path)
  if (activePath !== path) return { tabs: next, nextActive: undefined }
  const successor = next[Math.min(index, next.length - 1)]
  return { tabs: next, nextActive: successor ? successor.path : null }
}
