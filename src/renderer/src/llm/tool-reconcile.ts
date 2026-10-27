// ── Reconcile placeholders (2026-10-25 plan-tool evaluation) ──────────
// The provider contract demands every tool_use be answered before the next
// request; when one is still unanswered the adapters fabricate a tool_result.
// The fabrication is STATUS-AWARE: a call whose executor still holds it
// (queued/approved/running) must not read as "interrupted or cancelled" —
// that text once made a live spawn_agent read as a failed node whose work
// never landed (the report was on disk, the plan had auto-settled), inviting
// a re-dispatch of completed work. Dead calls (never started / session died /
// user stop) keep the honest interrupted verdict.
//
// Both shapes carry `_synthetic` on the block (set by the callers): when the
// real result arrives later, addToolResult REPLACES a _synthetic placeholder
// in place instead of swallowing it as a duplicate.

import type { ToolUseBlock } from '../types/agent'

export interface ReconcilePlaceholder {
  content: string
  isError: boolean
}

const LIVE_TOOL_STATUSES = new Set(['queued', 'approved', 'running'])

export function isLiveToolUse(toolUse: Pick<ToolUseBlock, 'status'>): boolean {
  return toolUse.status !== undefined && LIVE_TOOL_STATUSES.has(toolUse.status)
}

export function reconcilePlaceholderFor(toolUse: Pick<ToolUseBlock, 'status'>): ReconcilePlaceholder {
  return isLiveToolUse(toolUse)
    ? {
        content: 'Tool execution is still in progress — its real result will replace this line when the call settles. Do NOT re-dispatch the same task; if nothing else remains, say so briefly and wait.',
        isError: false,
      }
    : { content: 'Tool execution was interrupted or cancelled.', isError: true }
}
