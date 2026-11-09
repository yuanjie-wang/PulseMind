// ── UI-surface gates ──
// For features that stay shipped and functional but are withheld from the
// interface: the backend machinery (endpoints, stored settings, existing
// data) keeps working — only the editing surface is hidden. Flip a gate to
// true to re-expose its surface.
//
// ROUTINE_WEBHOOK_UI hides BOTH webhook surfaces of the routine feature
// (user 2026-10-07): the form's 「Webhook 触发」 switch (loopback trigger
// inbound, RoutineForm TriggersSection) and 高级设置's 「例行任务结算
// Webhook」 url/secret fields (settlement outbound, DataRuntimeSettings).
// Routines that already carry a webhook trigger keep firing and settlement
// posts keep going out; this gate is presentation-only.
export const ROUTINE_WEBHOOK_UI = false

// WORKFLOW_TASKS_UI lives in shared/ because the share-import gate runs in the
// main process too (a blocked preview and a committed record must not disagree).
export { WORKFLOW_TASKS_UI } from '../../shared/feature-flags'
