// ── Settings dirty-leave guard ──
// A settings section holding unsaved edits registers an async gate here;
// SettingsPage's tab switch runs it before navigating. The gate resolves
// `true` when leaving is allowed (clean state, or the user confirmed the
// discard). One registrant at a time — the mounted section owns the slot.

let guard: (() => Promise<boolean>) | null = null

export function registerSettingsLeaveGuard(fn: (() => Promise<boolean>) | null): void {
  guard = fn
}

export async function runSettingsLeaveGuard(): Promise<boolean> {
  return guard ? guard() : true
}
