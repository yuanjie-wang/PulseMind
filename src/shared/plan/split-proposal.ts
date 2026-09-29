/**
 * The sub-agent split-proposal wire protocol (PLAN-plan-split P1). A spawned
 * node sub-agent that judges its task beyond one sub-agent's capacity ends its
 * final output with a `### Split Proposal` section instead of doing the work;
 * the spawn choke point parses it and merges the proposed sub-DAG into the
 * live plan (shared/plan/graph.ts mergeSplitProposal). Deliberately a TEXT
 * protocol, not a tool: no schema changes, no Tool Protocols section churn —
 * the prompt-cache contract holds and a spawn prompt is per-session anyway.
 *
 * DOM-free and host-free: imported by the engine's spawn executor (main
 * process) and by tests. Pure functions only.
 */

/** Hard child-count window for one proposal (P1). Below 2 it is not a split;
 *  above 5 the wave would flood the slot budget from one node. */
export const SPLIT_MIN_CHILDREN = 2
export const SPLIT_MAX_CHILDREN = 5

/** One child description cap — a proposal is a tasking line, not an essay. */
const SPLIT_DESCRIPTION_MAX = 500

export interface SplitChildSpec {
  description: string
  /** 1-based indexes into the proposal's own list, FORWARD only — the
   *  sub-DAG is a DAG by construction (mergeSplitProposal still re-runs
   *  assertAcyclic as defense). */
  dependsOn?: number[]
}

export interface SplitProposal {
  reason?: string
  children: SplitChildSpec[]
}

/** Three-state on purpose (P2): the spawn choke point branches on it. `none`
 *  → the sub-agent did the work, take the delivered chain; `invalid` → it
 *  TRIED to split but the proposal is malformed, so no work happened — settle
 *  failed and consult; `valid` → attempt the merge. A plain null-returning
 *  parser could not tell "did the work" from "tried and botched", which is
 *  exactly the difference between settle-as-delivered and settle-as-failed. */
export type SplitProposalParse =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'valid'; proposal: SplitProposal }

const SECTION_HEADER = '### Split Proposal'
const REASON_PREFIX = 'Reason:'
const DEPS_SUFFIX = /\s*\[deps:\s*([0-9,\s]+)\]\s*$/

/** Parse a sub-agent's final text into a proposal. Tolerant by design; all
 *  rejections are total — there is no salvage of a half-valid list, because
 *  the merge is whole-unit (P3) and a silently repaired DAG is how a model's
 *  typo becomes someone's mis-scoped task. When the section appears more than
 *  once (draft + final), the LAST occurrence wins. */
export function parseSplitProposal(text: string): SplitProposalParse {
  const start = text.lastIndexOf(SECTION_HEADER)
  if (start < 0) return { kind: 'none' }

  // The section runs to the end of the output or to the next markdown header,
  // whichever comes first — a model that appends `## Summary` after the block
  // is not extending the proposal.
  const afterHeader = text.slice(start + SECTION_HEADER.length)
  const nextHeader = afterHeader.search(/^#{1,6} /m)
  const body = (nextHeader >= 0 ? afterHeader.slice(0, nextHeader) : afterHeader).trim()

  let reason: string | undefined
  const children: SplitChildSpec[] = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (reason === undefined && line.startsWith(REASON_PREFIX)) {
      const value = line.slice(REASON_PREFIX.length).trim()
      if (value) reason = value
      continue
    }
    const item = /^(\d+)[.、)]\s*(.+)$/.exec(line)
    if (!item) continue
    const deps = parseDeps(item[2])
    const description = (deps ? item[2].replace(DEPS_SUFFIX, '') : item[2]).trim()
    children.push({ description, ...(deps ? { dependsOn: deps } : {}) })
  }

  if (children.length < SPLIT_MIN_CHILDREN) {
    return { kind: 'invalid', reason: `a split needs ${SPLIT_MIN_CHILDREN}–${SPLIT_MAX_CHILDREN} sub-tasks, got ${children.length}` }
  }
  if (children.length > SPLIT_MAX_CHILDREN) {
    return { kind: 'invalid', reason: `a split needs ${SPLIT_MIN_CHILDREN}–${SPLIT_MAX_CHILDREN} sub-tasks, got ${children.length}` }
  }
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (!child.description || child.description.length > SPLIT_DESCRIPTION_MAX) {
      return { kind: 'invalid', reason: `sub-task ${i + 1}: description must be 1–${SPLIT_DESCRIPTION_MAX} characters` }
    }
    for (const d of child.dependsOn ?? []) {
      if (d === i + 1) return { kind: 'invalid', reason: `sub-task ${i + 1} depends on itself` }
      if (d < 1 || d > children.length) return { kind: 'invalid', reason: `sub-task ${i + 1}: dependency ${d} is out of range (1..${children.length})` }
      if (d > i + 1) return { kind: 'invalid', reason: `sub-task ${i + 1}: dependency ${d} must reference an EARLIER sub-task (forward references only)` }
    }
  }
  return { kind: 'valid', proposal: { ...(reason ? { reason } : {}), children } }
}

function parseDeps(description: string): number[] | undefined {
  const match = DEPS_SUFFIX.exec(description)
  if (!match) return undefined
  const deps = [...new Set(match[1].split(/[,\s]+/).filter(Boolean).map(Number))].filter(Number.isFinite)
  return deps.length > 0 ? deps : undefined
}
