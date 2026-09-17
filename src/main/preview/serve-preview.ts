// ── local-file:// protocol handler (extracted from src/main/index.ts;
//    PLAN-html-element-edit M1) ──
// The inline handler had grown to the point of needing a second branch: when
// a request carries ?pmPreview=1 and names an HTML file, the response is the
// preview copy — CSP meta stripped (local files have no response headers, so
// a strict page's meta CSP would block the injected picker; same class of
// problem as the extension's CDP fallback for CSP sites) and the picker
// script injected before </body>.
//
// Injection happens ONLY on the served copy — the disk file is never touched
// (D3). The two string surgeries (meta strip, script inject) both happen
// after the last real element of <body>, so element indices the picker
// computes in the live DOM still match the untouched disk source the parent
// resolves patches against (D4) — and the picker additionally excludes its
// own nodes from every sibling count.

import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { homedir } from 'node:os'
import { PICKER_SCRIPT } from './picker-source.generated'

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
}

/** Extract the filesystem path from a local-file:// URL — Windows drive
 *  letters land in the URL hostname (local-file://C:/Users/… → host "c")
 *  and /.pulsemind/ abbreviates the data dir (LLM output drops the prefix). */
export function resolveLocalFilePath(url: string): string {
  let filePath: string
  try {
    const parsed = new URL(url)
    filePath = decodeURIComponent(parsed.pathname)
    if (process.platform === 'win32' && parsed.hostname && /^[A-Za-z]$/.test(parsed.hostname)) {
      filePath = `${parsed.hostname}:${filePath}`
    }
  } catch {
    // Fallback for URLs the URL constructor can't parse
    filePath = decodeURIComponent(url.replace(/^local-file:/, '').replace(/^\/\//, '/'))
  }
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1)
  }
  if (filePath.startsWith('/.pulsemind/')) {
    filePath = join(homedir(), '.pulsemind', filePath.slice('/.pulsemind/'.length))
  }
  return filePath
}

/** True when the URL asks for the element-editable preview copy. */
export function isPreviewRequest(url: string): boolean {
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
export function injectPickerScript(html: string): string {
  const tag = `<script id="pm-picker-script">${PICKER_SCRIPT}</script>`
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

/** The whole protocol handler: unchanged file-serving branch plus the
 *  preview copy branch. Async on purpose (see the call site's comment in
 *  src/main/index.ts) — a sync read of a large file would freeze every IPC
 *  handler with it. */
export async function serveLocalFile(request: Request): Promise<Response> {
  const filePath = resolveLocalFilePath(request.url)
  const ext = extname(filePath).toLowerCase()
  const previewCopy = isPreviewRequest(request.url) && (ext === '.html' || ext === '.htm')
  try {
    if (previewCopy) {
      const text = await readFile(filePath, 'utf8')
      return new Response(injectPickerScript(stripCspMeta(text)), {
        status: 200,
        headers: { 'Content-Type': MIME[ext] },
      })
    }
    const content = await readFile(filePath)
    const mime = MIME[ext] || 'application/octet-stream'
    return new Response(content, {
      status: 200,
      headers: { 'Content-Type': mime },
    })
  } catch (err) {
    console.error('[local-file] Read failed:', filePath, err)
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return new Response('Not Found', { status: 404 })
    if (code === 'EACCES') return new Response('Forbidden', { status: 403 })
    return new Response('Internal Error', { status: 500 })
  }
}
