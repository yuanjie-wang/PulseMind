// ── Preview pane store (PLAN-preview-pane §设计2) ──
// Renderer-local state for the workbench's file previews (PLAN-workbench W7):
// tab strips scoped per conversation (switching away and back restores them)
// and per-path reload ticks the content components watch to re-read a changed
// file. Pane visibility and width live in workbenchStore — opening the first
// tab of a conversation brings the workbench up on the 工作区 tab, where the
// preview renders beside the tree (the standalone 文件预览 tab is gone, so
// there is no empty-tab fold-back either). Tab-list mutations live in
// preview-tabs.ts (pure, unit-tested).

import { create } from 'zustand'
import { openTabInList, closeTabInList, type PreviewTab } from './preview-tabs'
import { resolvePreviewPath } from '../../../shared/preview/file-kind'
import { useWorkbenchStore } from './workbenchStore'
import type { DraftEntry } from './preview-edit'
import { useHtmlEditStore } from './htmlEditStore'
import type { EditRevealTarget } from '../../../shared/tool-display/edit-reveal'

/** Pane display mode per path (PLAN-html-element-edit M3): html carries all
 *  three — preview / element editing / the advanced source editor (D2 of the
 *  element-edit plan); every other kind only ever uses view/source. */
export type PreviewMode = 'view' | 'element' | 'source'
import { touchRecord } from '../utils/lru-record'

/** Key for conversations that have no id yet (new-task draft). */
export const DRAFT_CONVERSATION_KEY = '__draft__'

/** Per-conversation tab maps kept by recency (insertion order); LRU cap. */
const MAX_CONVERSATION_MAPS = 10

interface PreviewPaneState {
  activeConversationId: string | null
  /** Resolved working directory of the conversation currently on screen —
   *  entry points resolve tool-relative paths against it before opening. */
  workspaceDir: string | null
  tabsByConversation: Record<string, PreviewTab[]>
  /** path of the active tab per conversation */
  activeByConversation: Record<string, string | null>
  /** path → bump counter; content components re-read when it changes */
  reloadTicks: Record<string, number>
  // ── Editing (PLAN-preview-edit D4) ──
  /** path → draft. Kept in the STORE because PreviewContent remounts on every
   *  tab switch (key={active.path}) — component state would drop half an edit. */
  drafts: Record<string, DraftEntry>
  previewModes: Record<string, PreviewMode>
  /** path → true while an external (agent) change is waiting on the user's
   *  conflict decision; the banner must survive remounts too. */
  externalChanges: Record<string, true>
  /** path → the loaded text exceeds the edit size gate (D8); the toolbar's
   *  edit toggle disables on it. */
  oversized: Record<string, true>
  /** path → pending reveal (PLAN-ide-linkage 1b): the scroll + flash
   *  PreviewContent performs once the file text is ready. Producers are the
   *  agent sync (a completed edit lands where the change did) and chat tool
   *  cards (a read card's range start, an edit card's path click). The tick
   *  keeps a second reveal from being consumed by the first one's expiry
   *  timer. */
  revealTargets: Record<string, { tick: number; target: EditRevealTarget }>
  requestReveal: (path: string, target: EditRevealTarget) => void
  consumeReveal: (path: string) => void
  setDraft: (path: string, entry: DraftEntry) => void
  clearDraft: (path: string) => void
  setPreviewMode: (path: string, mode: PreviewMode) => void
  markExternalChange: (path: string) => void
  clearExternalChange: (path: string) => void
  setOversized: (path: string, on: boolean) => void
  openFile: (conversationId: string | null, path: string) => void
  closeTab: (conversationId: string | null, path: string) => void
  setActive: (conversationId: string | null, path: string) => void
  setWorkspaceDir: (dir: string | null) => void
  switchConversation: (conversationId: string | null) => void
  bumpReload: (path: string) => void
  forgetConversation: (conversationId: string) => void
}

const convKey = (id: string | null) => id ?? DRAFT_CONVERSATION_KEY

export const usePreviewPaneStore = create<PreviewPaneState>()((set, get) => ({
  activeConversationId: null,
  workspaceDir: null,
  tabsByConversation: {},
  activeByConversation: {},
  reloadTicks: {},
  drafts: {},
  previewModes: {},
  externalChanges: {},
  oversized: {},
  revealTargets: {},

  requestReveal: (path, target) =>
    set((s) => ({
      revealTargets: { ...s.revealTargets, [path]: { tick: (s.revealTargets[path]?.tick ?? 0) + 1, target } },
    })),
  consumeReveal: (path) => set((s) => ({ revealTargets: omitKey(s.revealTargets, path) })),

  setDraft: (path, entry) => set((s) => ({ drafts: { ...s.drafts, [path]: entry } })),
  clearDraft: (path) =>
    set((s) => {
      if (!(path in s.drafts)) return s
      const drafts = { ...s.drafts }
      delete drafts[path]
      return { drafts }
    }),
  setPreviewMode: (path, mode) =>
    set((s) => {
      const previewModes = { ...s.previewModes }
      if (mode !== 'view') previewModes[path] = mode
      else delete previewModes[path]
      return { previewModes }
    }),
  markExternalChange: (path) => set((s) => ({ externalChanges: { ...s.externalChanges, [path]: true } })),
  setOversized: (path, on) =>
    set((s) => {
      if (on) return s.oversized[path] ? s : { oversized: { ...s.oversized, [path]: true as const } }
      if (!(path in s.oversized)) return s
      const oversized = { ...s.oversized }
      delete oversized[path]
      return { oversized }
    }),
  clearExternalChange: (path) =>
    set((s) => {
      if (!(path in s.externalChanges)) return s
      const externalChanges = { ...s.externalChanges }
      delete externalChanges[path]
      return { externalChanges }
    }),

  openFile: (conversationId, path) => {
    const key = convKey(conversationId)
    const tabs = openTabInList(get().tabsByConversation[key] ?? [], path)
    // Plain synchronous write: the burst case is handled one level up
    // (PreviewPane's useDeferredPreviewPath coalesces rapid clicks into one
    // content render), and a transition here delayed every store update's
    // commit — enough to race the probes' immediate assertions.
    set((s) => ({
      activeConversationId: key,
      tabsByConversation: touch(s.tabsByConversation, key, tabs),
      activeByConversation: { ...s.activeByConversation, [key]: path },
    }))
    useWorkbenchStore.getState().openTab(key, 'workspace')
  },

  closeTab: (conversationId, path) => {
    const key = convKey(conversationId)
    const tabs = get().tabsByConversation[key] ?? []
    const activePath = get().activeByConversation[key] ?? null
    const result = closeTabInList(tabs, path, activePath)
    // Closing a tab drops its edit session with it (PLAN-preview-edit D4)
    // and the element-edit session with it (PLAN-html-element-edit M3).
    useHtmlEditStore.getState().forgetFile(path)
    set((s) => ({
      tabsByConversation: { ...s.tabsByConversation, [key]: result.tabs },
      ...(result.nextActive !== undefined
        ? { activeByConversation: { ...s.activeByConversation, [key]: result.nextActive } }
        : {}),
      drafts: omitKey(s.drafts, path),
      previewModes: omitKey(s.previewModes, path),
      externalChanges: omitKey(s.externalChanges, path),
      oversized: omitKey(s.oversized, path),
      revealTargets: omitKey(s.revealTargets, path),
    }))
    // No fold-back when the strip empties: the preview lives beside the 工作区
    // tree now, and closing the last tab just returns the tree to full width —
    // folding the pane would yank it away from a user who is browsing.
  },

  setActive: (conversationId, path) => {
    const key = convKey(conversationId)
    set((s) => ({ activeByConversation: { ...s.activeByConversation, [key]: path } }))
  },

  setWorkspaceDir: (dir) => set({ workspaceDir: dir }),

  switchConversation: (conversationId) => {
    const key = convKey(conversationId)
    if (get().activeConversationId === key) return
    set((s) => {
      const existing = s.tabsByConversation[key]
      // Only conversations holding tabs occupy LRU slots.
      return {
        activeConversationId: key,
        tabsByConversation: existing !== undefined ? touch(s.tabsByConversation, key, existing) : s.tabsByConversation,
      }
    })
  },

  bumpReload: (path) =>
    set((s) => ({ reloadTicks: { ...s.reloadTicks, [path]: (s.reloadTicks[path] ?? 0) + 1 } })),

  forgetConversation: (conversationId) => {
    const paths = (get().tabsByConversation[conversationId] ?? []).map((t) => t.path)
    for (const path of paths) useHtmlEditStore.getState().forgetFile(path)
    set((s) => {
      return {
        tabsByConversation: Object.fromEntries(Object.entries(s.tabsByConversation).filter(([k]) => k !== conversationId)),
        activeByConversation: Object.fromEntries(Object.entries(s.activeByConversation).filter(([k]) => k !== conversationId)),
        drafts: omitKeys(s.drafts, paths),
        previewModes: omitKeys(s.previewModes, paths),
        externalChanges: omitKeys(s.externalChanges, paths),
        oversized: omitKeys(s.oversized, paths),
        revealTargets: omitKeys(s.revealTargets, paths),
      }
    })
  },
}))

/** Copy of `map` without `key` (no-op identity when the key is absent). */
function omitKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}

/** Copy of `map` without every key in `keys`. */
function omitKeys<T>(map: Record<string, T>, keys: string[]): Record<string, T> {
  if (keys.length === 0) return map
  const next = { ...map }
  for (const k of keys) delete next[k]
  return next
}

/** Re-insert a conversation's tab list as most-recently-used, then prune
 *  beyond the LRU cap (insertion order = recency order). */
function touch(map: Record<string, PreviewTab[]>, key: string, tabs: PreviewTab[]): Record<string, PreviewTab[]> {
  return touchRecord(map, key, tabs, MAX_CONVERSATION_MAPS)
}

/** Entry point for chat-side previews (tool cards, file chips): resolves
 *  tool-relative paths against the on-screen conversation's workspace and
 *  opens in the active conversation's tab strip. An optional reveal target
 *  (PLAN-ide-linkage 1c) rides the same resolution — the store keys reveals
 *  by the RESOLVED path, so both producers must resolve identically. */
export function openInPreviewPane(rawPath: string, reveal?: EditRevealTarget): void {
  const s = usePreviewPaneStore.getState()
  const abs = resolvePreviewPath(rawPath, s.workspaceDir)
  s.openFile(s.activeConversationId, abs)
  if (reveal) s.requestReveal(abs, reveal)
}
