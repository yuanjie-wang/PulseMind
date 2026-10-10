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

// ── HTML artifact card document (PLAN-html-card; chat + extension panel) ──

/** A full HTML document the model wrote as a page, not a fragment. */
export const HTML_ARTIFACT_FULL_DOCUMENT = /<!doctype html|<html[\s>]/i

/** The script a FRAGMENT gets wrapped with: reports the document's scrollHeight
 *  to the card (message type is namespaced and source-checked card-side, so a
 *  hostile fragment can only move the card it lives in). Shared verbatim by the
 *  desktop card and the extension panel — the frame must report height the same
 *  way on both surfaces. */
export const HTML_CARD_MEASURE_SCRIPT = `<script>(function(){var s=function(){try{parent.postMessage({type:'pm-html-card-height',height:Math.ceil(document.documentElement.scrollHeight)},'*')}catch(e){}};window.addEventListener('load',s);document.addEventListener('DOMContentLoaded',s);window.addEventListener('resize',s);if('ResizeObserver' in window){new ResizeObserver(s).observe(document.documentElement)}s()})()</script>`

/** Build the frame's document. Both shapes report height: fragments get a
 *  zero-margin shell carrying the measure script; full documents keep their
 *  markup and get the script injected before the last </body> (appended when
 *  the page omits it — the parser hoists it into body either way). Both get
 *  the meta CSP stripped first — local-file and srcdoc frames alike take their
 *  only CSP from the document itself, and a strict one would kill the model's
 *  own inline scripts AND the measure script (height back to the default,
 *  clipped). */
export function buildCardDocument(code: string): string {
  if (HTML_ARTIFACT_FULL_DOCUMENT.test(code)) return injectBeforeBodyClose(stripCspMeta(code), HTML_CARD_MEASURE_SCRIPT)
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<style>html,body{margin:0;padding:0}</style></head><body>',
    stripCspMeta(code),
    HTML_CARD_MEASURE_SCRIPT,
    '</body></html>',
  ].join('')
}
