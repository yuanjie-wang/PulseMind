// ── Preview-frame measurement (main-process frame channel) ── The HTML
// preview's zoom needs the page's natural size, and the preview iframe is a
// sandboxed opaque-origin frame: its DOM is unreadable from the renderer (and
// the renderer-side webFrame tree doesn't see the frame at all — probed). The
// main process has no such restriction: WebFrameMain.executeJavaScript crosses
// process boundaries, opaque origins and page CSP alike. Nothing is injected
// into the served file — the view copy stays byte-verbatim.
import type { WebContents, WebFrameMain } from 'electron'

export interface FrameMetrics {
  width: number
  height: number
}

/** The minimal surface of `event.sender` this module needs — `WebContents`
 *  minus everything that keeps it out of a unit test. */
export type FrameHost = Pick<WebContents, 'mainFrame'>

/** Runs inside the target frame: report the document's scroll size, and —
 *  when `centerX` — park the frame's own horizontal scroll at the middle of
 *  its overflow. The frame's scroll is unreachable from the parent for the
 *  same reason its size is; this script is the only lever. */
function measureScript(centerX: boolean): string {
  const park = centerX ? 'if (over > 0) el.scrollLeft = over / 2' : ''
  return `(() => {
  const el = document.documentElement
  const over = el.scrollWidth - el.clientWidth
  ${park}
  return JSON.stringify({ w: el.scrollWidth, h: el.scrollHeight })
})()`
}

/** Find the frame named `frameName` under the sender's page and read its
 *  document size; `centerX` also re-centers it. Null = no such frame, the
 *  execution failed (frame destroyed mid-flight) or the page answered
 *  garbage — callers treat null as "no data" and fall back. */
export async function measurePreviewFrame(
  host: FrameHost,
  frameName: string,
  centerX = false,
): Promise<FrameMetrics | null> {
  const find = (frame: WebFrameMain): WebFrameMain | undefined => {
    if (frame.name === frameName) return frame
    for (const child of frame.frames) {
      const hit = find(child)
      if (hit) return hit
    }
    return undefined
  }
  let target: WebFrameMain | undefined
  try {
    target = find(host.mainFrame)
  } catch {
    return null
  }
  if (!target) return null
  try {
    const raw = await target.executeJavaScript(measureScript(centerX), false)
    if (typeof raw !== 'string') return null
    const parsed = JSON.parse(raw) as { w?: unknown; h?: unknown }
    const width = Number(parsed.w)
    const height = Number(parsed.h)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
    return { width, height }
  } catch {
    return null
  }
}
