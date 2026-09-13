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

/**
 * Mount a tool document into `iframe` with the bridge already listening.
 *
 * The order is the whole point, and it must not be left to React. `srcDoc` as a
 * JSX prop is applied during the commit, so the tool's script can start running
 * before a `useEffect` ever attaches the message listener — and a tool that
 * calls the bridge while starting up (reading its storage, say) has that
 * request dropped outright, not queued. The SDK only rejects after its 30s
 * timeout, so the bug presents as a hang, not as an error. Attaching first and
 * assigning srcdoc afterwards makes "a listener exists" a precondition of the
 * document existing at all.
 *
 * Re-assigning an unchanged document is skipped: StrictMode double-invokes the
 * effect in dev, and a second assignment would reload the tool on every mount.
 * A genuine reload changes the html or the element (callers key the iframe).
 */
export function mountToolDocument(iframe: HTMLIFrameElement, toolId: string, html: string): () => void {
  const detach = connectToolBridge(iframe, toolId)
  const doc = injectToolSdk(html)
  if (iframe.srcdoc !== doc) iframe.srcdoc = doc
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
