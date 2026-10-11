// ── Popup motion guard ────────────────────────────────────────────────────
// A mid-session flip into `prefers-reduced-motion: reduce` (Windows
// 辅助功能 → 视觉效果 → 动画效果 toggled off, an RDP connect — both silent to
// the user) breaks every antd popup in the app: Blink starts clamping
// animation/transition durations to 0.01ms, and the popup choreography
// rc-motion/rc-trigger established at mount computes garbage offsets on the
// next open — every dropdown/Select/tooltip then mounts and is parked
// off-screen at `left:-1000vw` (@rc-component/trigger useOffsetStyle),
// rendered at opacity 1 and permanently invisible. The context ring's numbers
// live only in its tooltip, so they vanish with it. Pinned end-to-end by
// scripts/probe-popup-motion.mjs: flip → parked, flip back → recovered.
//
// No renderer-side rescue works — remounting the tree, antd's own motion
// switch (token.motion), forced re-aligns (they oscillate between two
// off-screen spots) and antd 6.6.5 / @rc-component/trigger 3.10.1 all fail
// the probe — so the guard removes the trigger at the source: the renderer
// NEVER sees `reduce`. CDP Emulation.setEmulatedMedia pins the media feature
// to no-preference for the target's lifetime, which shadows the OS value and
// every later OS flip. Cost: while the guard holds, this window's CSS stops
// matching `(prefers-reduced-motion: reduce)` — the chat's and plan graph's
// own reduce rules included. That is the deliberate trade: honoring the
// preference here means a window whose popups cannot be opened at all.
//
// `webContents.debugger` allows a single CDP client, and DevTools is one —
// opening DevTools detaches us (the 'detach' event), closing it hands the
// target back via 'devtools-closed' and we re-attach + re-apply. A renderer
// navigation/reload keeps the emulation (per-target state).
import { BrowserWindow, WebContents } from 'electron'

const FEATURE = 'prefers-reduced-motion'
const FORCED = 'no-preference'

/** Idempotent per webContents: attach (unless DevTools owns the target) and
 *  pin the media feature. Failures are warns — a lost guard degrades to the
 *  pre-guard behaviour, never to a crashed window. */
async function apply(webContents: WebContents): Promise<void> {
  try {
    if (webContents.isDevToolsOpened()) return
    if (!webContents.debugger.isAttached()) webContents.debugger.attach('1.3')
    await webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: FEATURE, value: FORCED }],
    })
  } catch (err) {
    console.warn('[motion-guard] failed to pin prefers-reduced-motion:', err instanceof Error ? err.message : err)
  }
}

/** Wire the guard onto a window's webContents (the main window — popups exist
 *  only there; the hook login window is a plain browser surface). */
export function installPopupMotionGuard(win: BrowserWindow): void {
  const webContents = win.webContents
  webContents.on('devtools-opened', () => {
    // DevTools needs the single CDP client slot — hand the target over.
    try {
      if (webContents.debugger.isAttached()) webContents.debugger.detach()
    } catch { /* already gone */ }
  })
  webContents.on('devtools-closed', () => { void apply(webContents) })
  // Re-assert after a renderer replacement (crash recovery reloads) — cheap,
  // and the per-target emulation should survive it anyway.
  webContents.on('render-process-gone', () => { void apply(webContents) })
  void apply(webContents)
}
