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

/** Inject a snippet before the last </body> (or append when a page omits it —
 *  the parser hoists trailing content into body either way). */
export function injectBeforeBodyClose(html: string, snippet: string): string {
  const bodyCloser = /<\/body\s*>/gi
  let last: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  while ((match = bodyCloser.exec(html)) !== null) last = match
  if (last) return `${html.slice(0, last.index)}${snippet}${html.slice(last.index)}`
  return `${html}${snippet}`
}

/** Inject the picker IIFE before the last </body> (or append when a page
 *  omits it — the parser hoists the script into body either way). */
export function injectPickerScript(html: string, pickerScript: string): string {
  return injectBeforeBodyClose(html, `<script id="pm-picker-script">${pickerScript}</script>`)
}

/** The nonce placeholder inside the generated PICKER_SCRIPT (the picker
 *  source carries it as a string literal). buildPreviewCopy replaces it with
 *  the parent's per-mount nonce before serving; an unserved literal can only
 *  produce messages the parent rejects. */
export const PICKER_NONCE_TOKEN = '__PM_NONCE__'

/** Stamp the per-mount nonce into the picker source. The bundler emits the
 *  placeholder as a QUOTED literal (either quote style), so the replacement
 *  consumes the quotes too — replacing the bare token would leave
 *  `""nonce""` behind, a syntax error in every served page. */
export function withPickerNonce(pickerScript: string, nonce: string | undefined): string {
  const value = JSON.stringify(nonce ?? '')
  return pickerScript
    .split(`"${PICKER_NONCE_TOKEN}"`)
    .join(value)
    .split(`'${PICKER_NONCE_TOKEN}'`)
    .join(value)
}

/** The full preview copy for a file's text: CSP stripped, picker injected.
 *  Injection happens ONLY on the served copy — the disk file is never
 *  touched (D3). Both edits land after the last real body element, so the
 *  picker's element indices still match the untouched disk source (D4). */
export function buildPreviewCopy(html: string, pickerScript: string, nonce?: string): string {
  return injectPickerScript(stripCspMeta(html), withPickerNonce(pickerScript, nonce))
}
