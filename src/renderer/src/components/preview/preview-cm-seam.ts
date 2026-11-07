// ── Preview CM seam (2026-11-02) ──
//
// The preview menus (⋯ 搜索/替换, shared by the address bar and the
// immersive tab strip) act on the on-screen CodeMirror instance — but
// importing CodeMirrorEditor from the menu module would drag the whole lazy
// CM chunk (grammars + prism themes) into the entry graph, breaking
// FileEditor's React.lazy contract. This module is the inverted seam: pure
// state, ZERO runtime imports (type-only ones are erased at compile). The
// editor registers its view and its panel-opener on mount; the menu asks
// through here.

import type { EditorView } from '@codemirror/view'

let activeView: EditorView | null = null
let openPanel: ((view: EditorView) => void) | null = null
let pendingOpen = false

/** Called by CodeMirrorEditor on mount (cleanup on unmount). Only one
 *  preview editor is mounted per window — PreviewContent keys the content
 *  subtree to the active path — so one slot is a faithful registry. */
export function registerPreviewCmView(view: EditorView, openSearchPanelFor: (v: EditorView) => void): void {
  activeView = view
  openPanel = openSearchPanelFor
}

export function unregisterPreviewCmView(view: EditorView): void {
  if (activeView === view) {
    activeView = null
    openPanel = null
  }
}

/** The ⋯ menu's 搜索: opens the search panel on the on-screen editor.
 *  False when none is mounted — the menu's disabled state derives from
 *  kind+mode; this is the belt-and-braces runtime guard. */
export function openPreviewSearchPanel(): boolean {
  if (!activeView || !openPanel) return false
  openPanel(activeView)
  return true
}

/** True when the registered preview editor currently holds focus — the ⌘F
 *  fork's condition (review_20261103 高4). The application menu accelerator
 *  (mac) and the before-input fallback (win/linux) consume the chord BEFORE
 *  any renderer keymap sees it, so a focused editor can never receive
 *  searchKeymap's own ⌘F: AppLayout intercepts the `open-search` action and
 *  routes it here instead of the navigation search page. Reading focus (not
 *  mere existence) keeps ⌘F meaning "search the app" whenever the user is
 *  anywhere else in the UI. */
export function previewCmHasFocus(): boolean {
  return activeView?.hasFocus ?? false
}

/** The menu flipped the pane view→source and wants the panel opened AFTER
 *  the readOnly reconfigure — a panel built under view mode carries no
 *  replace row. Consumed by the editor's mount / mode-flip effects. */
export function parkPreviewPanelOpen(): void {
  pendingOpen = true
}

export function takePreviewPanelOpen(): boolean {
  if (!pendingOpen) return false
  pendingOpen = false
  return true
}
