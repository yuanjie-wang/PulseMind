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
import { appendFileSync, mkdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { homedir } from 'node:os'
import { buildPreviewCopy, isPreviewUrl } from '../../shared/preview/html-inject'
import { PICKER_SCRIPT } from './picker-source.generated'
import { takePreviewNonce } from './nonce-registry'

export { stripCspMeta, injectPickerScript, isPreviewUrl } from '../../shared/preview/html-inject'

/** One line per html serve / every refusal into ~/.pulsemind/logs/main.log
 *  (2026-10-29 白屏排查). The renderer console is ephemeral and the main
 *  console is invisible in a packaged run, so this file is the only durable
 *  record of whether a preview request arrived and what came back — the
 *  evidence that decides 「帧没发起导航」vs「响应没被帧接受」. Image/icon
 *  serves stay silent (chat avatars and screenshots would flood the log);
 *  failures of ANY kind are logged. Line format matches index.ts writeLog. */
function logServe(level: 'INFO' | 'WARN', message: string): void {
  // vitest drives this module from plain Node — the unit tests must not write
  // into the developer's real main.log.
  if (!process.versions.electron) return
  try {
    const dir = join(homedir(), '.pulsemind', 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'main.log'), `[${new Date().toISOString()}] [${level}] local-file: ${message}\n`)
  } catch {
    // Logging must never break serving (the request path is failure-tolerant
    // by design); a broken log sink degrades to the console only.
  }
}

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
  return isPreviewUrl(url)
}

/** True when the URL path carries a `..` segment (either separator) — the
 *  traversal this surface must refuse. Defense-in-depth (2026-10-10 audit #8):
 *  local-file:// is the one read surface that never meets the path jail. The
 *  scheme is unprivileged (no registerSchemesAsPrivileged, no CORS headers on
 *  the responses), so remote page content cannot fetch it — but nothing else
 *  constrained the URL either, while every other file read answers to
 *  guardFsTarget. */
export function hasPathTraversal(path: string): boolean {
  return path.split(/[\\/]/).includes('..')
}

/** The traversal gate, run on the RAW wire URL: the URL constructor COLLAPSES
 *  dot segments (`..` and its `%2e` spellings) while parsing, so a check on
 *  the parsed path can never see them — resolveLocalFilePath is handed an
 *  already-clean absolute path. Returns true (refuse) when the raw path has a
 *  `..` segment OR is not decodable (a malformed %-sequence never comes from
 *  our own renderer; fail closed). */
export function urlRefusedForTraversal(rawUrl: string): boolean {
  const rawPath = rawUrl.split('?')[0] ?? ''
  try {
    return hasPathTraversal(decodeURIComponent(rawPath))
  } catch {
    return true
  }
}

/** The whole protocol handler: unchanged file-serving branch plus the
 *  preview copy branch. Async on purpose (see the call site's comment in
 *  src/main/index.ts) — a sync read of a large file would freeze every IPC
 *  handler with it. */
export async function serveLocalFile(request: Request): Promise<Response> {
  const startedAt = Date.now()
  // Gate ONE — raw wire URL (the URL constructor collapses dot segments, so
  // the parsed path can never show them; see urlRefusedForTraversal).
  if (urlRefusedForTraversal(request.url)) {
    console.warn('[local-file] Traversal refused:', request.url)
    logServe('WARN', `traversal refused (wire) ${request.url}`)
    return new Response('Forbidden', { status: 403 })
  }
  const filePath = resolveLocalFilePath(request.url)
  // Gate TWO — the decoded path: catches the win32 hostname branch and the
  // URL-constructor-failure fallback, which never went through the parser.
  if (hasPathTraversal(filePath)) {
    console.warn('[local-file] Traversal refused:', filePath)
    logServe('WARN', `traversal refused (decoded) ${filePath}`)
    return new Response('Forbidden', { status: 403 })
  }
  const ext = extname(filePath).toLowerCase()
  const previewCopy = isPreviewRequest(request.url) && (ext === '.html' || ext === '.htm')
  try {
    if (previewCopy) {
      const text = await readFile(filePath, 'utf8')
      // The nonce comes from the per-mount registry the renderer filled over
      // IPC (M10) — never from the query string, which the served page's own
      // scripts read trivially via location.search.
      const nonce = takePreviewNonce(filePath)
      logServe('INFO', `serve 200 (preview copy) ${Date.now() - startedAt}ms ${filePath}`)
      return new Response(buildPreviewCopy(text, PICKER_SCRIPT, nonce), {
        status: 200,
        headers: { 'Content-Type': MIME[ext] },
      })
    }
    const content = await readFile(filePath)
    const mime = MIME[ext] || 'application/octet-stream'
    if (ext === '.html' || ext === '.htm') logServe('INFO', `serve 200 ${Date.now() - startedAt}ms ${content.byteLength}B ${filePath}`)
    return new Response(content, {
      status: 200,
      headers: { 'Content-Type': mime },
    })
  } catch (err) {
    console.error('[local-file] Read failed:', filePath, err)
    const code = (err as NodeJS.ErrnoException).code
    logServe('WARN', `serve failed ${code ?? 'unknown'} ${filePath}`)
    if (code === 'ENOENT') return new Response('Not Found', { status: 404 })
    if (code === 'EACCES') return new Response('Forbidden', { status: 403 })
    return new Response('Internal Error', { status: 500 })
  }
}
