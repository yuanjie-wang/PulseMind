/** One dropdown's plumbing: open state, its anchor ref, and the outside-click
 *  close. The panel has no antd Dropdown to do the latter, and three menus need
 *  exactly this much — the composer's 授权/模型 pair and the header's 历史会话
 *  (2026-10-31) — so it is written once instead of three times.
 *
 *  The outside-click test needs TWO listeners, because the panel lives in a
 *  CLOSED shadow root (`content/index.tsx`; production, not the open root the
 *  probes mount) and a closed root truncates `composedPath()` at the host for
 *  any listener registered outside it: a `document` listener sees an in-panel
 *  mousedown as `[host]`, so `path.includes(anchor)` is false even for the
 *  menu's own item — the menu closed on mousedown and the click never landed.
 *  That made every dropdown item dead to the mouse (历史会话 rows, 授权, 模型;
 *  2026-11-03). Listeners registered INSIDE the root still see the full path,
 *  so the in-panel decision is made there, and the document listener only
 *  handles clicks on the page behind the panel. */

import { useEffect, useRef, useState } from 'react'

export function useDropdown(): { open: boolean; anchorRef: React.RefObject<HTMLSpanElement>; toggle: () => void; close: () => void } {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    // `getRootNode()` hands back the closed ShadowRoot to code living inside it.
    const root = anchor?.getRootNode()
    const host = root && 'host' in root ? (root as ShadowRoot).host : null
    /** `getRootNode()` types as Node, whose string-overload listener takes a
     *  plain `Event`; the handler below is deliberately MouseEvent-shaped. */
    const innerRoot = host && root ? (root as unknown as EventTarget) : null

    /** In-panel clicks (full composedPath here, closed root or not). */
    const onInner = (e: Event): void => {
      const path = (e as MouseEvent).composedPath?.() ?? []
      if (!anchor || !path.includes(anchor)) setOpen(false)
    }
    /** Clicks on the page behind the panel. In-panel events are delegated to
     *  `onInner` — closing here would unmount the menu under the user's cursor
     *  before the click lands. */
    const onDoc = (e: Event): void => {
      const path = (e as MouseEvent).composedPath?.() ?? []
      if (host && path.includes(host)) return
      setOpen(false)
    }

    if (innerRoot) innerRoot.addEventListener('mousedown', onInner)
    document.addEventListener('mousedown', onDoc)
    return () => {
      if (innerRoot) innerRoot.removeEventListener('mousedown', onInner)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [open])

  return { open, anchorRef, toggle: () => setOpen((v) => !v), close: () => setOpen(false) }
}
