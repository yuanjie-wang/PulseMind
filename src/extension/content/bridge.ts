/** Panel ⇄ service-worker channel, content-script side (PLAN-browser-extension §3.6).
 *
 * Keeps chrome.runtime out of the React tree: the UI calls `request()` and
 * subscribes to `onNotification()`, both of which are plain promises/callbacks. */

import { isPageToolRequest, type PanelNotification, type PanelRequest, type PanelResponse } from '../bridge'
import { runPageTool } from './page-tools'

type Listener = (msg: PanelNotification) => void

const listeners = new Set<Listener>()

const PANEL_NOTIFICATION_PREFIX = 'panel/'

/** Subscribe to worker pushes. Returns an unsubscribe function. */
export function onNotification(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Ask the worker for something. Never rejects: a dead worker reads as ok:false. */
export async function request(msg: PanelRequest): Promise<PanelResponse> {
  try {
    const res = (await chrome.runtime.sendMessage(msg)) as PanelResponse | undefined
    return res ?? { ok: false, error: '后台无响应' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Wires the worker's messages into the local listener set, and answers the
 *  worker's `page_*` tool calls. Called once by the content-script entry point. */
export function listen(): void {
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    // Page tools share this channel with panel notifications (both are
    // chrome.runtime messages), so dispatch before forwarding to the UI.
    if (isPageToolRequest(msg)) {
      // Never rejects — runPageTool converts failures into ok:false.
      void runPageTool(msg.tool, msg.args).then(sendResponse)
      return true // async reply
    }
    if (!isPanelNotification(msg)) return false
    for (const listener of listeners) {
      try {
        listener(msg)
      } catch (err) {
        console.warn('[PulseMind] panel listener failed', err)
      }
    }
    return false
  })
}

/** A worker push is one of ours only when its type is in the panel/ namespace;
 *  anything else on the channel belongs to another consumer. */
function isPanelNotification(msg: unknown): msg is PanelNotification {
  if (!msg || typeof msg !== 'object') return false
  const type = (msg as { type?: unknown }).type
  return typeof type === 'string' && type.startsWith(PANEL_NOTIFICATION_PREFIX)
}

/** Open the extension's options page (used by the "not connected" hint). */
export function openOptions(): void {
  try {
    chrome.runtime.openOptionsPage()
  } catch {
    /* no options page context (should not happen) */
  }
}
