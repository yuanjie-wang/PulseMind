/**
 * The deliverables summary (PLAN-deliverables): what files a turn actually
 * delivered, derived as a PURE function of the mirror's messages. Same
 * position in the codebase as `tool-summary.ts` — no React, no IPC — so the
 * card, the hook that aggregates sub-conversations, and the tests all read the
 * one derivation.
 *
 * The completion criterion is the load-bearing part: a write/edit counts as
 * delivered only when a `tool_result` block pairs with the `tool_use` id AND
 * that result is not an error. NEVER `block.status` — the sanitizer strips
 * status before persistence (`utils/message-utils.ts`), so a derivation keyed
 * on status works live and dies after a restart. Pairing is the one truth both
 * the live mirror and the hydrated DB rows share.
 */

import type { AgentMessage, ToolResultBlock, ToolUseBlock } from '../../types/agent'
import type { Segment } from './message-segments'

/** Tools whose success writes/edits a file at an input path we can name.
 *  Deliberately NOT `exec` — shell redirections and scripts leave no
 *  recoverable target path, and a summary that guesses lies. When
 *  PLAN-office-export's export_document lands, it joins here (one line). */
export const FILE_WRITER_TOOLS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'docx_edit',
  'xlsx_edit',
  'pptx_edit',
  'export_document',
])

/** One completed operation on a file. `ok` is true by construction — failed
 *  ops never enter the list (is_error exclusion) — kept so the shape states
 *  the contract the collection enforces. */
export interface DeliverableOp {
  tool: string
  at: string
  ok: boolean
}

export interface DeliverableRow {
  /** The path exactly as the model wrote it in `input.file_path` — no
   *  normalization, no guessing (v1: two spellings are two rows). */
  path: string
  ops: DeliverableOp[]
  lastAt: string
  /** Conversations whose calls landed on this path, main session first.
   *  Empty = this session wrote it (no attribution shown). */
  fromConvIds: string[]
}

export interface Deliverable {
  rows: DeliverableRow[]
  /** Child conversations that produced rows (main session is implicit and
   *  never listed). Titles are attached by the aggregating hook. */
  sources: Array<{ convId: string; title?: string }>
}

function extractFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const filePath = (input as Record<string, unknown>).file_path
  return typeof filePath === 'string' && filePath.trim() !== '' ? filePath : null
}

/** export_document's REAL output path rides the tool result text
 *  (`Exported <path> (N KB)` — the executor's summary). file_path is optional
 *  for the tool (a default name is minted), and a collision silently gains a
 *  `-2` suffix — in both cases the input string names a file that does not
 *  exist, so the result, not the input, is what a clickable row must carry
 *  (M18). */
function extractExportedPath(result: ToolResultBlock): string | null {
  const content = Array.isArray(result.content)
    ? result.content.map((c) => (typeof c === 'string' ? c : '')).join('\n')
    : typeof result.content === 'string'
      ? result.content
      : ''
  const m = /Exported (.+) \(\d+ KB\)/m.exec(content)
  return m ? m[1] : null
}

/** Walk the messages once, pairing every writer tool_use with its tool_result
 *  regardless of which message carries the result (the engine folds a whole
 *  round's results into ONE later user message, and hydration replays the
 *  same shape). The op's time is the RESULT message's — the moment the write
 *  actually completed, not when the call was minted. */
export function collectDeliverables(
  messages: AgentMessage[],
  opts?: { convId?: string }
): Deliverable {
  const resultMap = new Map<string, { result: ToolResultBlock; at: string }>()
  for (const message of messages) {
    for (const block of message.contentBlocks ?? []) {
      if (block.type === 'tool_result') resultMap.set(block.tool_use_id, { result: block, at: message.createdAt })
    }
  }

  const byPath = new Map<string, DeliverableRow>()
  for (const message of messages) {
    for (const block of message.contentBlocks ?? []) {
      if (block.type !== 'tool_use') continue
      const use = block as ToolUseBlock
      if (!FILE_WRITER_TOOLS.has(use.name)) continue
      let path = extractFilePath(use.input)
      const paired = resultMap.get(use.id)
      if (!paired || paired.result.is_error) continue
      // export_document: the result names where the bytes actually are —
      // the default name when file_path was omitted, and the suffixed name
      // after a D6 collision (M18).
      if (use.name === 'export_document') {
        path = extractExportedPath(paired.result) ?? path
      }
      if (!path) continue
      const op: DeliverableOp = { tool: use.name, at: paired.at, ok: true }
      const existing = byPath.get(path)
      if (existing) {
        existing.ops.push(op)
        existing.ops.sort((a, b) => a.at.localeCompare(b.at))
        existing.lastAt = existing.ops[existing.ops.length - 1].at
      } else {
        byPath.set(path, {
          path,
          ops: [op],
          lastAt: op.at,
          fromConvIds: opts?.convId ? [opts.convId] : []
        })
      }
    }
  }

  const rows = [...byPath.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt))
  const sources = opts?.convId ? [{ convId: opts.convId }] : []
  return { rows, sources }
}

/** Fold per-conversation derivations (main + hydrated children) into one.
 *  Rows merge by exact path — the same file written by the parent and a child
 *  is one row with combined ops; attribution unions, main first. */
export function mergeDeliverables(parts: Deliverable[]): Deliverable {
  const byPath = new Map<string, DeliverableRow>()
  const sources: Deliverable['sources'] = []
  const seenSources = new Set<string>()

  for (const part of parts) {
    for (const source of part.sources) {
      if (!seenSources.has(source.convId)) {
        seenSources.add(source.convId)
        sources.push(source)
      }
    }
    for (const row of part.rows) {
      const existing = byPath.get(row.path)
      if (!existing) {
        byPath.set(row.path, {
          path: row.path,
          ops: [...row.ops],
          lastAt: row.lastAt,
          fromConvIds: [...row.fromConvIds]
        })
        continue
      }
      existing.ops = [...existing.ops, ...row.ops].sort((a, b) => a.at.localeCompare(b.at))
      existing.lastAt = existing.ops[existing.ops.length - 1].at
      for (const convId of row.fromConvIds) {
        if (!existing.fromConvIds.includes(convId)) existing.fromConvIds.push(convId)
      }
    }
  }

  return {
    rows: [...byPath.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    sources
  }
}

// ── Turn scoping (每轮产物, 2026-09-19) ──
// The chat shows a per-turn sub-summary after each turn's last segment, while
// the whole-conversation aggregate moved to the workbench's 产物 tab. A turn
// starts at a user message that carries NO tool_result — the engine folds a
// whole round's results into user messages that DO carry them, and those stay
// in-turn, so a slice boundary can never split a tool_use/tool_result pair and
// the per-turn pairing derivation stays exact. The same rule over the SEGMENT
// list places the card: groupMessages always promotes such a message to a
// 'single' segment, so the boundary sequences — and therefore the turn
// indices — agree between the two derivations even though groupMessages skips
// messages that render as nothing (the per-turn derivation slices the RAW
// messages, which is also why it loses nothing to those skips).

/** Every spawn block's subConvId in one message list. Shared by the hook's BFS
 *  (whole spawn tree) and the per-turn attribution (which turns launched
 *  which children) — one definition so the two cannot drift. */
export function spawnTargets(messages: AgentMessage[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    for (const block of message.contentBlocks ?? []) {
      if (block.type !== 'tool_use') continue
      if (block.name !== 'spawn_agent') continue
      const subConvId = (block as { subConvId?: unknown }).subConvId
      if (typeof subConvId === 'string' && subConvId.trim() !== '') ids.push(subConvId)
    }
  }
  return ids
}

const isTurnStart = (message: AgentMessage): boolean =>
  message.role === 'user' && !(message.contentBlocks ?? []).some((b) => b.type === 'tool_result')

/** Rows per turn, indexed by turn number (turn 0 = everything before the first
 *  user message). Each turn's rows are its own main-session writes MERGED with
 *  the settled child conversations its spawns launched — the caller supplies
 *  those as `childParts` (the hydration hook's per-child map). Only ids this
 *  turn actually spawned are looked up, so a grandchild's rows land in the
 *  workbench aggregate only, never on a user-facing turn card.
 *
 *  Runs on every message append — keyed on `messages` identity, NOT the
 *  streaming segment list, so it is not re-paid per streamed token. */
export function collectTurnDeliverables(
  messages: AgentMessage[],
  childParts?: ReadonlyMap<string, Deliverable>
): Deliverable[] {
  const slices: AgentMessage[][] = []
  for (const message of messages) {
    if (slices.length === 0 || isTurnStart(message)) slices.push([message])
    else slices[slices.length - 1].push(message)
  }
  return slices.map((slice) => {
    const parts: Deliverable[] = [collectDeliverables(slice)]
    const seen = new Set<string>()
    for (const subConvId of spawnTargets(slice)) {
      if (seen.has(subConvId)) continue
      seen.add(subConvId)
      const part = childParts?.get(subConvId)
      if (part) parts.push(part)
    }
    return mergeDeliverables(parts)
  })
}

/** Segment-index placement for the turn cards: which turn each segment belongs
 *  to, and the absolute segment index each turn's card renders after. Cheap —
 *  no deliverable work, safe to re-run per streamed token. Turn numbering
 *  matches `collectTurnDeliverables` by construction (same boundary rule). */
export function segmentTurnPlacement(segments: Segment[]): {
  turnOf: number[]
  lastSegmentOfTurn: number[]
} {
  const turnOf: number[] = []
  const lastSegmentOfTurn: number[] = []
  let current = -1
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const boundary = seg.type === 'single' && isTurnStart(seg.msg)
    if (current < 0) current = 0
    else if (boundary) current++
    turnOf[i] = current
    lastSegmentOfTurn[current] = i
  }
  return { turnOf, lastSegmentOfTurn }
}
