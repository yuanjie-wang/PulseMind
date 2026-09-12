// ── Tool HTML export (M5R) ──
// Shared by the list row's 导出 op and the runner header — one implementation,
// per the house rule against private copies of the same logic.

/** Download a tool's app.html as `<name>.html`. Throws when the tool has no
 *  content yet so the caller can surface a warning. */
export async function exportToolHtml(tool: { id: string; name: string }): Promise<void> {
  const html = await window.electronAPI.toolReadHtml(tool.id)
  if (!html) throw new Error('该工具还没有内容')
  const blob = new Blob([html], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${tool.name}.html`
  a.click()
  URL.revokeObjectURL(url)
}
