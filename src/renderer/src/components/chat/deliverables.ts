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
