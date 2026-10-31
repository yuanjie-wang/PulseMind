/** One dropdown's plumbing: open state, its anchor ref, and the outside-click
 *  close. The panel has no antd Dropdown to do the latter, and three menus need
 *  exactly this much — the composer's 授权/模型 pair and the header's 历史会话
 *  (2026-10-31) — so it is written once instead of three times. */

import { useEffect, useRef, useState } from 'react'

export function useDropdown(): { open: boolean; anchorRef: React.RefObject<HTMLSpanElement>; toggle: () => void; close: () => void } {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      // `composedPath()`, NOT `e.target`: the panel renders inside a Shadow Root,
      // and a listener outside that root sees every inner event retargeted to the
      // *host* element — so `anchor.contains(e.target)` is false for a click on
      // our own menu item, the menu closes on mousedown, and the click never
      // lands. (Measured: the 授权 dropdown was dead to the mouse for exactly
      // this reason.) composedPath() crosses the shadow boundary and names the
      // real innermost node.
      const path = e.composedPath?.() ?? []
      const anchor = anchorRef.current
      if (anchor && !path.includes(anchor)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return { open, anchorRef, toggle: () => setOpen((v) => !v), close: () => setOpen(false) }
}
