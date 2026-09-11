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
