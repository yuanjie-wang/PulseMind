// ── Preview-copy string surgery (PLAN-html-element-edit D2, §2.1) ──
// Pure transforms shared by the main-process protocol handler (which owns the
// picker script source) and the probe harness (which rebuilds preview copies
// over stubbed fixtures). No node imports: both a main bundle and a browser
// bundle swallow this file.

/** True when the URL asks for the element-editable preview copy. */
export function isPreviewUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.get('pmPreview') === '1'
  } catch {
    return false
  }
}

/** Remove <meta http-equiv="Content-Security-Policy"> tags. local-file has
 *  no response headers, so meta is the only CSP vector — without stripping
 *  it, strictly-CSP pages would silently refuse to run the picker. */
export function stripCspMeta(html: string): string {
  return html.replace(/<meta\b[^>]*>/gi, (tag) =>
    /http-equiv\s*=\s*["']?content-security-policy["']?/i.test(tag) ? '' : tag,
  )
}

/** Inject the picker IIFE before the last </body> (or append when a page
 *  omits it — the parser hoists the script into body either way). */
export function injectPickerScript(html: string, pickerScript: string): string {
  const tag = `<script id="pm-picker-script">${pickerScript}</script>`
  const closer = /<\/body\s*>\s*<\/html\s*>\s*$/i.exec(html)
  if (closer) {
    const at = closer.index
    return `${html.slice(0, at)}${tag}${html.slice(at)}`
  }
  const bodyCloser = /<\/body\s*>/gi
  let last: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  while ((match = bodyCloser.exec(html)) !== null) last = match
  if (last) return `${html.slice(0, last.index)}${tag}${html.slice(last.index)}`
  return `${html}${tag}`
}

/** The full preview copy for a file's text: CSP stripped, picker injected.
 *  Injection happens ONLY on the served copy — the disk file is never
 *  touched (D3). Both edits land after the last real body element, so the
 *  picker's element indices still match the untouched disk source (D4). */
export function buildPreviewCopy(html: string, pickerScript: string): string {
  return injectPickerScript(stripCspMeta(html), pickerScript)
}
