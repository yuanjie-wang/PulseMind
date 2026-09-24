/**
 * Window-level file-drop guard.
 *
 * Dropping an OS file onto a region with no drag handlers makes Chromium
 * navigate to `file://…` — in Electron that replaces the whole app UI with a
 * file viewer. The composer opts in to drops itself (InputArea's dragover
 * calls `stopPropagation`, so its `dropEffect = 'copy'` survives); every OTHER
 * drop lands here and is swallowed with `dropEffect = 'none'` (forbidden
 * cursor).
 *
 * Exported as a plain install function so `App.tsx` mounts it once and
 * `scripts/probe-input-paste-drop.mjs` can install it standalone and assert
 * the swallow without mounting the whole app.
 */

const hasFiles = (e: DragEvent): boolean =>
  Array.from(e.dataTransfer?.types ?? []).includes('Files')

/** Install on `target` (the window). Returns the uninstall function. */
export function installFileDropGuard(target: Window): () => void {
  const onDragEnter = (e: DragEvent): void => {
    if (hasFiles(e)) e.preventDefault()
  }
  const onDragOver = (e: DragEvent): void => {
    // stopPropagation in the composer's own handler runs FIRST (target phase →
    // bubble); reaching here means nobody claimed the drag, so forbid it.
    if (hasFiles(e)) {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    }
  }
  const onDrop = (e: DragEvent): void => {
    if (hasFiles(e)) e.preventDefault()
  }
  target.addEventListener('dragenter', onDragEnter)
  target.addEventListener('dragover', onDragOver)
  target.addEventListener('drop', onDrop)
  return () => {
    target.removeEventListener('dragenter', onDragEnter)
    target.removeEventListener('dragover', onDragOver)
    target.removeEventListener('drop', onDrop)
  }
}
