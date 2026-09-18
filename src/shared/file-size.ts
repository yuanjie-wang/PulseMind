// ── Byte formatting (shared) ── The one place that turns a byte count into
//  the human string the preview pane shows. It had been copied ad hoc into the
//  fallback card and the tool executors; sharing it keeps the two preview
//  footers and the card from disagreeing about a file's size.

/** `1234` → `1.2 KB`，`null`/`undefined` → `''`（调用方可以直接插值，
 *  空串时整段省略，不用自己判空）。 */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}
