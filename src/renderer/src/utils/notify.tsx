// ── notify: the one toast outlet ──
// Before this module there were three toast systems in flight at once —
// `App.useApp()` message in some components, `message.useMessage()` holders in
// the five settings components, and a hand-rolled toastFailure in HtmlPreview
// (plus a fourth static-fallback hybrid in MessageGroup). Consequences: toasts
// with different theming, holders mounted/unmounted with their component, and
// no single place to reason about "did the user see this failure".
//
// Rule now: components call `notify.*` and never own a message holder. The
// App-scoped instance is bound once by <NotifyBridge /> inside <AntdApp> (so
// toasts keep the app's theme); before any binding lands (or outside the
// provider, e.g. early startup) the antd static sink covers it.
//
// The sink plumbing lives in notify-core.ts (pure, vitest-tested); this file
// is the antd-flavored shell plus the failure helpers:
//   notifyFailure(scope, err, userMessage?) — user-initiated action failed:
//     toast AND console.error. The toast is the user's surface, the tagged
//     console line is the trace.
//   reportSilentFailure(scope, err) — background/best-effort work failed:
//     NO toast (by design), but the failure leaves the same tagged console
//     trace instead of `catch(() => {})` erasing it.
import { useEffect } from 'react'
import { App as AntdApp, message as antdStaticMessage } from 'antd'
import { setNotifySink, resolveNotifySink, type NotifyKind, type NotifySink } from './notify-core'

// The failure helpers and their contracts are documented in notify-core.ts
// (kept there so vitest can drive them without antd); re-exported here —
// components import everything toast-shaped from this one module.
export { notifyFailure, reportSilentFailure } from './notify-core'

let staticSink: NotifySink | null = null

function currentSink(): NotifySink {
  const bound = resolveNotifySink()
  if (bound) return bound
  if (!staticSink) {
    staticSink = {
      success: (m) => {
        antdStaticMessage.success(m)
      },
      error: (m) => {
        antdStaticMessage.error(m)
      },
      warning: (m) => {
        antdStaticMessage.warning(m)
      },
      info: (m) => {
        antdStaticMessage.info(m)
      },
    }
  }
  return staticSink
}

export const notify: Record<NotifyKind, (message: string) => void> = {
  success: (m) => currentSink().success(m),
  error: (m) => currentSink().error(m),
  warning: (m) => currentSink().warning(m),
  info: (m) => currentSink().info(m),
}

/** Bind the App-scoped message instance. Renders nothing; mount once inside
 *  <AntdApp> (App.tsx). */
export function NotifyBridge(): null {
  const { message } = AntdApp.useApp()
  useEffect(() => {
    setNotifySink(message as unknown as NotifySink)
    return () => setNotifySink(null)
  }, [message])
  return null
}
