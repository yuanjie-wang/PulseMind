// ── HTML element-edit store (PLAN-html-element-edit §设计1, D5/D8) ──
// One session per open file tab: the file text every patch chains from, the
// selection the panel renders, the scroll position a reload restores, the
// per-file undo stack and the AI run state. Element editing has NO drafts —
// every committed change is patched, verified and written immediately (D5) —
// so this store is independent from previewPaneStore's draft machinery; the
// one bridge is reload ticks, which the COMPONENTS bump (the store never
// reaches into previewPaneStore, which cleans sessions up on tab close).
//
// The write pipeline in one place: resolve against session.fileText → span
// patch → verifyPatch → writeFile → undo push → fileText adopted → live-DOM
// message to the frame (direct edits). Structural edits (delete / AI / undo /
// restore) write and leave a pendingReselect — the frame's pm:ready handler
// consumes it after the reload (reselect + scroll restore).
//
// Failures return false and leave the reason in consumeFailure() for the
// panel to toast — zustand actions stay boolean-simple and React-free.

import { create } from 'zustand'
import type { ParentToFrameMessage, ElementRect, ElementAncestor, ComputedSnapshot } from '../../../shared/html-edit/messages'
import { resolveElement } from '../../../shared/html-edit/resolve'
import {
  applyInnerHtml,
  escapeHtmlText,
  removeElement,
  setAttributes,
  setInlineStyle,
  verifyPatch,
} from '../../../shared/html-edit/patch'

/** Undo depth per file (D8, default 20). */
export const MAX_UNDO_STEPS = 20

export interface ElementSelection {
  pmPath: string
  tag: string
  rect: ElementRect
  text: string
  ancestors: ElementAncestor[]
  computed: ComputedSnapshot
}

export interface UndoEntry {
  /** File text before the edit (what undo writes back). */
  before: string
  after: string
  /** Selection to restore after the undo reload. */
  selectPath: string | null
  scrollY: number
}

export interface HtmlEditSession {
  /** The file text every patch chains from — updated on every accepted
   *  write and on every external change. NOT the draft machinery. */
  fileText: string
  /** The text the session opened with — what 恢复原始 writes back. */
  originalText: string
  selection: ElementSelection | null
  scrollY: number
  undo: UndoEntry[]
  /** Set by structural edits; the frame's pm:ready consumes it (send
   *  pm:reselect + pm:scroll-to) and clears it. */
  pendingReselect: { pmPath: string | null } | null
  aiBusy: boolean
  aiError: string | null
}

interface HtmlEditState {
  sessions: Record<string, HtmlEditSession>
  initSession: (path: string, diskText: string) => void
  forgetFile: (path: string) => void
  select: (path: string, selection: ElementSelection) => void
  deselect: (path: string) => void
  setScroll: (path: string, y: number) => void
  /** D8: an external (agent) write → new text, empty undo stack, pending
   *  reload. The component toasts and bumps the tick. */
  handleExternalChange: (path: string, diskText: string) => void
  consumePendingReselect: (path: string) => { pmPath: string | null } | null
  /** Direct edits: live DOM + background write, no reload (D5). */
  applyStyle: (path: string, decls: Record<string, string | null>) => Promise<boolean>
  applyAttrs: (path: string, attrs: Record<string, string | null>) => Promise<boolean>
  /** Panel text edit — escaped text replaces the inner span. */
  applyText: (path: string, text: string) => Promise<boolean>
  /** In-place contenteditable commit (D7) — the frame's inner HTML verbatim. */
  commitInPlaceText: (path: string, pmPath: string, html: string) => Promise<boolean>
  /** Structural edits: write, then the caller reloads. */
  deleteElement: (path: string) => Promise<boolean>
  undo: (path: string) => Promise<boolean>
  restoreOriginal: (path: string) => Promise<boolean>
  setAiBusy: (path: string, busy: boolean, error?: string | null) => void
}

/** The frame's postMessage sender, registered by HtmlPreview on mount — the
 *  store stays React-free and reaches the live DOM through this. */
const frameSenders = new Map<string, (msg: ParentToFrameMessage) => void>()

export function registerFrameSender(path: string, send: (msg: ParentToFrameMessage) => void): void {
  frameSenders.set(path, send)
}

export function unregisterFrameSender(path: string): void {
  frameSenders.delete(path)
}

export function sendToFrame(path: string, message: ParentToFrameMessage): void {
  frameSenders.get(path)?.(message)
}

/** The reason of the most recent failed action — the panel toasts it right
 *  after a false return. */
let lastFailure = ''
export function consumeFailure(): string {
  const msg = lastFailure
  lastFailure = ''
  return msg
}

export const useHtmlEditStore = create<HtmlEditState>()((set, get) => ({
  sessions: {},

  initSession: (path, diskText) => {
    if (get().sessions[path]) return
    set((s) => ({
      sessions: {
        ...s.sessions,
        [path]: {
          fileText: diskText,
          originalText: diskText,
          selection: null,
          scrollY: 0,
          undo: [],
          pendingReselect: null,
          aiBusy: false,
          aiError: null,
        },
      },
    }))
  },

  forgetFile: (path) =>
    set((s) => {
      if (!(path in s.sessions)) return s
      const sessions = { ...s.sessions }
      delete sessions[path]
      return { sessions }
    }),

  select: (path, selection) =>
    set((s) => {
      const session = s.sessions[path]
      if (!session) return s
      return { sessions: { ...s.sessions, [path]: { ...session, selection } } }
    }),

  deselect: (path) =>
    set((s) => {
      const session = s.sessions[path]
      if (!session || !session.selection) return s
      return { sessions: { ...s.sessions, [path]: { ...session, selection: null } } }
    }),

  setScroll: (path, y) =>
    set((s) => {
      const session = s.sessions[path]
      if (!session || session.scrollY === y) return s
      return { sessions: { ...s.sessions, [path]: { ...session, scrollY: y } } }
    }),

  handleExternalChange: (path, diskText) =>
    set((s) => {
      const session = s.sessions[path]
      if (!session) return s
      return {
        sessions: {
          ...s.sessions,
          [path]: { ...session, fileText: diskText, originalText: diskText, undo: [] },
        },
      }
    }),

  consumePendingReselect: (path) => {
    const pending = get().sessions[path]?.pendingReselect ?? null
    if (pending) {
      set((s) => {
        const session = s.sessions[path]
        if (!session) return s
        return { sessions: { ...s.sessions, [path]: { ...session, pendingReselect: null } } }
      })
    }
    return pending
  },

  applyStyle: async (path, decls) => {
    const session = get().sessions[path]
    if (!session?.selection) return false
    const resolved = resolveElement(session.fileText, session.selection.pmPath)
    if (!resolved.ok) return fail(resolved.reason)
    const patched = setInlineStyle(session.fileText, resolved.location, decls)
    const applied = Object.keys(decls).filter((k) => decls[k] !== null)
    const verified = verifyPatch(patched, {
      pmPath: session.selection.pmPath,
      tag: session.selection.tag,
      styleProps: applied,
    })
    if (!verified.ok) return fail(verified.reason)
    const ok = await writeDirect(path, session, patched)
    if (ok) sendToFrame(path, { type: 'pm:apply-style', pmPath: session.selection.pmPath, decls })
    return ok
  },

  applyAttrs: async (path, attrs) => {
    const session = get().sessions[path]
    if (!session?.selection) return false
    const resolved = resolveElement(session.fileText, session.selection.pmPath)
    if (!resolved.ok) return fail(resolved.reason)
    const patched = setAttributes(session.fileText, resolved.location, attrs)
    const verified = verifyPatch(patched, { pmPath: session.selection.pmPath, tag: session.selection.tag })
    if (!verified.ok) return fail(verified.reason)
    const ok = await writeDirect(path, session, patched)
    if (ok) sendToFrame(path, { type: 'pm:apply-attrs', pmPath: session.selection.pmPath, attrs })
    return ok
  },

  applyText: async (path, text) => {
    const session = get().sessions[path]
    if (!session?.selection) return false
    return commitInner(path, session, escapeHtmlText(text), { textContains: text })
  },

  commitInPlaceText: async (path, pmPath, html) => {
    const session = get().sessions[path]
    if (!session?.selection || session.selection.pmPath !== pmPath) return false
    return commitInner(path, session, html)
  },

  deleteElement: async (path) => {
    const session = get().sessions[path]
    if (!session?.selection) return false
    const selectPath = session.selection.pmPath
    const parentPath = parentPathOf(selectPath)
    const resolved = resolveElement(session.fileText, selectPath)
    if (!resolved.ok) return fail(resolved.reason)
    const patched = removeElement(session.fileText, resolved.location)
    // Structural verification: the PARENT must still resolve — a cut that
    // lacerated the tree refuses here (the removed element's own path
    // refusing is the expected outcome, not a failure).
    if (resolveElement(patched, parentPath).ok === false) {
      return fail('删除校验失败：父元素不再可解析，已拒绝写入')
    }
    // The undo entry reselects the parent too — the deleted element is back
    // in `before`, and the parent is where the user looks for it.
    const ok = await writeStructural(path, session, patched, parentPath)
    if (ok) {
      set((s) => {
        const cur = s.sessions[path]
        if (!cur) return s
        return { sessions: { ...s.sessions, [path]: { ...cur, selection: null, pendingReselect: { pmPath: parentPath } } } }
      })
    }
    return ok
  },

  undo: async (path) => {
    const session = get().sessions[path]
    if (!session || session.undo.length === 0) return false
    const entry = session.undo[session.undo.length - 1]
    const res = await window.electronAPI.writeFile({ filePath: path, content: entry.before })
    if (res && res.success === false) return fail(res.error || '写入失败')
    set((s) => {
      const cur = s.sessions[path]
      if (!cur) return s
      return {
        sessions: {
          ...s.sessions,
          [path]: {
            ...cur,
            fileText: entry.before,
            undo: cur.undo.slice(0, -1),
            selection: null,
            pendingReselect: { pmPath: entry.selectPath },
          },
        },
      }
    })
    return true
  },

  restoreOriginal: async (path) => {
    const session = get().sessions[path]
    if (!session) return false
    const res = await window.electronAPI.writeFile({ filePath: path, content: session.originalText })
    if (res && res.success === false) return fail(res.error || '写入失败')
    set((s) => {
      const cur = s.sessions[path]
      if (!cur) return s
      return {
        sessions: {
          ...s.sessions,
          [path]: { ...cur, fileText: cur.originalText, undo: [], selection: null, pendingReselect: { pmPath: null } },
        },
      }
    })
    return true
  },

  setAiBusy: (path, busy, error = null) =>
    set((s) => {
      const session = s.sessions[path]
      if (!session) return s
      return { sessions: { ...s.sessions, [path]: { ...session, aiBusy: busy, aiError: error } } }
    }),
}))

// ── Pipeline helpers ──

function parentPathOf(pmPath: string): string {
  const idx = pmPath.lastIndexOf('>')
  return idx > 0 ? pmPath.slice(0, idx) : 'html'
}

function fail(error: string): false {
  lastFailure = error
  console.warn(`[html-edit] ${error}`)
  return false
}

/** Direct edit write path: undo push + fileText adopt; the live DOM is
 *  updated by the caller's frame message. */
async function writeDirect(path: string, session: HtmlEditSession, patched: string): Promise<boolean> {
  return writeAndRecord(path, session, patched, session.selection?.pmPath ?? null)
}

/** Structural edit write path: same record; the caller bumps the reload. */
async function writeStructural(path: string, session: HtmlEditSession, patched: string, selectPath: string | null): Promise<boolean> {
  return writeAndRecord(path, session, patched, selectPath)
}

async function writeAndRecord(path: string, session: HtmlEditSession, patched: string, selectPath: string | null): Promise<boolean> {
  const res = await window.electronAPI.writeFile({ filePath: path, content: patched })
  if (res && res.success === false) return fail(res.error || '写入失败')
  useHtmlEditStore.setState((s) => {
    const cur = s.sessions[path]
    if (!cur) return s
    const undo = [...cur.undo, { before: session.fileText, after: patched, selectPath, scrollY: cur.scrollY }]
    return {
      sessions: {
        ...s.sessions,
        [path]: { ...cur, fileText: patched, undo: undo.slice(-MAX_UNDO_STEPS) },
      },
    }
  })
  return true
}

/** Shared inner-HTML commit (panel text box + in-place editable). The frame
 *  ALREADY carries the change for in-place commits; apply-text is harmless
 *  there (same bytes) and load-bearing for panel-typed text. */
async function commitInner(
  path: string,
  session: HtmlEditSession,
  newInner: string,
  extra?: { textContains?: string },
): Promise<boolean> {
  const selection = session.selection
  if (!selection) return false
  if (/<script[\s>]/i.test(newInner) || /<style[\s>]/i.test(newInner)) {
    return fail('内联编辑不允许写入 script/style 节点')
  }
  const resolved = resolveElement(session.fileText, selection.pmPath)
  if (!resolved.ok) return fail(resolved.reason)
  if (resolved.location.hasScriptLikeChildren) {
    return fail('该元素包含 script/style/template 子节点，不能整体改写内部 HTML')
  }
  const patched = applyInnerHtml(session.fileText, resolved.location, newInner)
  const verified = verifyPatch(patched, {
    pmPath: selection.pmPath,
    tag: selection.tag,
    textContains: extra?.textContains,
  })
  if (!verified.ok) return fail(verified.reason)
  const ok = await writeDirect(path, session, patched)
  if (ok) sendToFrame(path, { type: 'pm:apply-text', pmPath: selection.pmPath, html: newInner })
  return ok
}
