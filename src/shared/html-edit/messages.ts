// ── Frame ⇄ parent message protocol (PLAN-html-element-edit §2.3) ──
// The preview iframe is cross-origin (opaque origin under sandbox="allow-
// scripts"), so the picker inside it and the renderer's preview pane talk
// only through postMessage. The parent verifies `event.source ===
// iframe.contentWindow` before trusting any inbound message.

import type { PmPathSegment } from './pm-path'

/** Human-readable ancestor info for the breadcrumb and the AI context. */
export interface ElementAncestor {
  tag: string
  id: string | null
  classes: string[]
  /** The pmPath of THIS ancestor (a prefix of the selected element's). */
  pmPath: string
}

/** Subset of getComputedStyle the typed controls initialize from. */
export type ComputedSnapshot = Record<string, string>

export interface ElementRect {
  x: number
  y: number
  w: number
  h: number
}

/** Frame → parent. */
export type FrameToParentMessage =
  | { type: 'pm:ready' }
  | { type: 'pm:hover'; pmPath: string | null; tag: string | null }
  | {
      type: 'pm:select'
      pmPath: string
      tag: string
      rect: ElementRect
      /** textContent, trimmed and capped by the picker. */
      text: string
      /** Ancestor chain INCLUDING the element itself (last entry). */
      ancestors: ElementAncestor[]
      computed: ComputedSnapshot
    }
  | { type: 'pm:deselect' }
  /** In-place contenteditable commit (D7): the frame's inner HTML for the
   *  element. The parent patches the FILE with it; the live DOM already
   *  carries the change. */
  | { type: 'pm:commit-text'; pmPath: string; html: string }
  | { type: 'pm:scroll'; y: number }

/** Parent → frame. */
export type ParentToFrameMessage =
  | { type: 'pm:mode'; on: boolean }
  | { type: 'pm:apply-style'; pmPath: string; decls: Record<string, string | null> }
  | { type: 'pm:apply-attrs'; pmPath: string; attrs: Record<string, string | null> }
  /** Replace the element's inner HTML from the panel's text control. */
  | { type: 'pm:apply-text'; pmPath: string; html: string }
  | { type: 'pm:enable-edit'; pmPath: string }
  | { type: 'pm:reselect'; pmPath: string }
  | { type: 'pm:scroll-to'; y: number }

export function isFrameToParentMessage(data: unknown): data is FrameToParentMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { type?: unknown }).type === 'string' &&
    ((data as { type: string }).type === 'pm:ready' ||
      (data as { type: string }).type === 'pm:hover' ||
      (data as { type: string }).type === 'pm:select' ||
      (data as { type: string }).type === 'pm:deselect' ||
      (data as { type: string }).type === 'pm:commit-text' ||
      (data as { type: string }).type === 'pm:scroll')
  )
}

export type { PmPathSegment }
