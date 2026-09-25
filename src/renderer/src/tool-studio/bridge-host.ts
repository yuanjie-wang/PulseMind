// ── Tool bridge host (PLAN-0.4.0 M6.3) ──
// Renderer-side counterpart of the SDK: injects the SDK into tool HTML,
// listens for bridge requests from a specific iframe, validates the source
// (event.source must be THE iframe's contentWindow — the page's claimed
// toolId is never trusted) and forwards calls to the main process.

import { BRIDGE_SOURCE_RESPONSE, isBridgeRequest, type BridgeResponse, type BridgeErrorCode } from '../../../shared/tool-bridge/protocol'
import { TOOL_SDK_SCRIPT } from './sdk'

export { TOOL_SDK_SCRIPT }

/**
 * Inject the SDK script as the FIRST thing in <head> (or at the top of the
 * document) so `window.pulsemind` exists before any tool script runs.
 */
export function injectToolSdk(html: string): string {
  if (html.includes('pulsemind-tool-host')) return html // already injected
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + TOOL_SDK_SCRIPT)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + TOOL_SDK_SCRIPT)
  return TOOL_SDK_SCRIPT + html
}

/** Per-iframe document record: what was requested, and how far the serving of
 *  it got — `pending` (write in flight), `srcdoc` (no write path: fallback
 *  applied), `url` (local-file URL on the frame). */
interface MountedDoc {
  doc: string
  url: string | null
  applied: 'pending' | 'srcdoc' | 'url'
}
const mountedDoc = new WeakMap<HTMLIFrameElement, MountedDoc>()

/** Absolute fs path → the app's local-file: URL (Windows drive letters ride
 *  the hostname; serveLocalFile's resolveLocalFilePath reads it back). */
function toLocalFileUrl(filePath: string): string {
  return `local-file://${filePath.replace(/\\/g, '/')}`
}

/** FNV-1a + length suffix — a stable, collision-unlikely file stem, so an
 *  unchanged tool document always maps to the same tmp path (and a re-mount
 *  reuses the copy instead of accumulating). Mirrors the card's hashText. */
function stemOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(16)}-${text.length.toString(16)}`
}

/** Put the document on the frame — through a `local-file:` URL over a tmp
 *  copy, via srcdoc for hosts with no write path (jsdom / bridge-less stubs).
 *  srcdoc and blob: are both OUT: the page's `script-src` carries no
 *  'unsafe-inline' (review 2026-09-25 P1) and BOTH inherit the parent CSP —
 *  blob: measured to fire load and still refuse its inline script
 *  (scripts/probe-csp-inheritance.mjs) — which would kill every inline tool
 *  script. The write is async, but it can only make the document appear
 *  LATER than the listener, never earlier — the mount contract below holds. */
function assignToolDocument(iframe: HTMLIFrameElement, doc: string): void {
  const prev = mountedDoc.get(iframe)
  if (prev && prev.doc === doc) {
    // Same document already: a write in flight completes on its own, an
    // applied copy stays (the live re-checks absorb outside mutation).
    if (prev.applied === 'pending') return
    if (prev.applied === 'srcdoc' && iframe.srcdoc === doc) return
    if (prev.applied === 'url' && iframe.src === prev.url) return
  }

  const entry: MountedDoc = { doc, url: null, applied: 'pending' }
  mountedDoc.set(iframe, entry) // becomes the current one BEFORE the write resolves

  const write = async (): Promise<void> => {
    let filePath: string | null = null
    try {
      const paths = await window.electronAPI.getDataPaths()
      // Renderer-layer writes carry no session context: the guard applies only
      // the baseline deny roots, the app's own data dir stays writable.
      filePath = `${paths.dataDir}/tmp/tool-docs/${stemOf(doc)}.html`
      const res = await window.electronAPI.writeFile({ filePath, content: doc })
      if (!res.success) filePath = null
    } catch {
      filePath = null
    }
    if (mountedDoc.get(iframe) !== entry) return // superseded by a newer document
    if (filePath) {
      entry.url = toLocalFileUrl(filePath)
      entry.applied = 'url'
      iframe.src = entry.url
    } else {
      entry.applied = 'srcdoc' // no write path: srcdoc fallback
      if (iframe.srcdoc !== doc) iframe.srcdoc = doc
    }
  }
  void write()
}

/**
 * Mount a tool document into `iframe` with the bridge already listening.
 *
 * The order is the whole point, and it must not be left to React. The
 * document as a JSX prop is applied during the commit, so the tool's script
 * can start running before a `useEffect` ever attaches the message listener —
 * and a tool that calls the bridge while starting up (reading its storage,
 * say) has that request dropped outright, not queued. The SDK only rejects
 * after its 30s timeout, so the bug presents as a hang, not as an error.
 * Attaching first and assigning the document afterwards makes "a listener
 * exists" a precondition of the document existing at all.
 *
 * Re-assigning an unchanged document is skipped: StrictMode double-invokes the
 * effect in dev, and a second assignment would reload the tool on every mount.
 * A genuine reload changes the html or the element (callers key the iframe).
 *
 * The returned detach owns the listener only. The document record stays in
 * the WeakMap (GC ties it to the element) so a StrictMode re-mount of the
 * same document finds the pending/applied state and reloads nothing — the tmp
 * copy outlives the mount by design and tmp-cleanup sweeps it.
 */
export function mountToolDocument(iframe: HTMLIFrameElement, toolId: string, html: string): () => void {
  const detach = connectToolBridge(iframe, toolId)
  assignToolDocument(iframe, injectToolSdk(html))
  return detach
}

/**
 * Attach bridge plumbing to one iframe. Returns a detach function.
 * Requests are forwarded to the main process via `invoke` (default:
 * electronAPI.toolBridgeInvoke); the main process enforces capabilities,
 * paths and audit — the renderer host is transport only.
 */
export function connectToolBridge(
  iframe: HTMLIFrameElement,
  toolId: string,
  invoke?: (toolId: string, method: string, params: Record<string, unknown>) => Promise<unknown>,
): () => void {
  const invoker = invoke ?? ((tid, method, params) => window.electronAPI.toolBridgeInvoke(tid, method, params))

  const reply = (id: string, ok: boolean, result?: unknown, error?: BridgeResponse['error']): void => {
    iframe.contentWindow?.postMessage({ source: BRIDGE_SOURCE_RESPONSE, id, ok, ...(ok ? { result } : { error }) }, '*')
  }

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) return
    if (!isBridgeRequest(event.data)) return
    invoker(toolId, event.data.method, event.data.params ?? {})
      .then((result) => reply(event.data.id, true, result))
      .catch((err: unknown) => {
        const code: BridgeErrorCode =
          err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
            ? (err as { code: BridgeErrorCode }).code
            : 'EXEC_FAILED'
        reply(event.data.id, false, undefined, { code, message: err instanceof Error ? err.message : String(err) })
      })
  }
  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}
