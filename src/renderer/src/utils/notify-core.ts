// ── notify sink plumbing (pure, no antd) ──
// The router behind utils/notify.tsx: one mutable sink slot that <NotifyBridge>
// fills with the App-scoped antd message instance and every caller drains from.
// The failure helpers live here too — they are console + sink only, so vitest
// can drive them without pulling antd into the test process.

export type NotifyKind = 'success' | 'error' | 'warning' | 'info'

export interface NotifySink {
  success(message: string): void
  error(message: string): void
  warning(message: string): void
  info(message: string): void
}

let sink: NotifySink | null = null

/** Bind the app-scoped sink. Passing null unbinds (component unmounted) and
 *  callers fall back to the static sink. */
export function setNotifySink(next: NotifySink | null): void {
  sink = next
}

/** The App-scoped sink when one is bound, else null (caller falls back). */
export function resolveNotifySink(): NotifySink | null {
  return sink
}

/** User-initiated action failed: toast AND a tagged console trace. The toast
 *  is the user's surface, the console line is the trail. */
export function notifyFailure(scope: string, err: unknown, userMessage?: string): void {
  const text = userMessage ?? (err instanceof Error ? err.message : String(err))
  resolveNotifySink()?.error(text)
  console.error(`[notify][${scope}]`, err)
}

/** Background/best-effort work failed: NO toast (by design), but the failure
 *  leaves the same tagged trace instead of `catch(() => {})` erasing it. */
export function reportSilentFailure(scope: string, err: unknown): void {
  console.error(`[silent-failure][${scope}]`, err)
}
