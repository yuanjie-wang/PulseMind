// ── Sandbox guard glue (PLAN-0.4.0 M3.5) ──
// Bridges the pure path-jail decision to the main-process services: resolves
// the current session context (AsyncLocalStorage), picks the right deny-root
// list, realpath-resolves the target and audits the outcome.

import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { guardPath, buildDenyRoots, buildBaselineDenyRoots, resolveTarget } from '../../shared/sandbox/path-jail'
import { normalizePathInput } from '../../shared/path-input'
import { resolveRealTarget } from './real-path'
import { currentSessionSandbox } from './session-context'
import { auditStore } from '../storage/audit-store'

export type GuardOperation = 'read' | 'write'

/** The ONE spelling rule applied before the jail judges a path (see
 *  guardFsTarget): strip a `file:` / `local-file:` URI, then expand `~` to
 *  home. `file-ops.resolvePath` re-exports this same function, so judgment and
 *  landing spot cannot drift.
 *
 *  Why the URI half is here and not only in the pure resolver: a `file:` URI
 *  reaching the gate used to resolve as a literal relative segment — inside
 *  the workspace, past every deny root — while fs would then look at
 *  `<workspace>/file:/home/x.png`. Judgment said "fine", the operation said
 *  ENOENT, and the api path resolver (both renderer and main) produced that
 *  spelling independently (2026-11-10 UOS attachment failure). Stripping makes
 *  both halves see the real target — the URI form names an ABSOLUTE path, so
 *  no jail decision changes except toward the truthful one.
 *
 *  Why the `~` half is here: without it `~/.ssh/x` resolves as a literal `~`
 *  segment — inside the workspace, past every deny root — while the service
 *  layer's own path expansion then lands the bytes in the real home: judgment
 *  and landing spot disagree, and the disagreeable side wins. */
export function normalizeUserPath(target: string): string {
  const filePath = normalizePathInput(target)
  return filePath.startsWith('~') ? join(homedir(), filePath.slice(1)) : filePath
}

export interface GuardResult {
  ok: boolean
  /** English reason when blocked — lands in a tool result verbatim. */
  reason?: string
  resolved: string
}

/**
 * Adjudicate one file path for the caller's context.
 * - Inside an agent session: deny roots + workspace write jail.
 * - Outside (renderer utilities): baseline deny roots only.
 * Throws when blocked — write services catch and surface the reason as the
 * tool error; callers that must not throw should use `checkFsTarget`.
 */
export async function guardFsTarget(target: string, operation: GuardOperation): Promise<GuardResult> {
  const ctx = currentSessionSandbox()
  const denyRoots = ctx ? buildDenyRoots(homedir(), platform()) : buildBaselineDenyRoots(homedir(), platform())
  // Normalize ONCE at the gate: every derivation below (realpath, guardPath's
  // own resolveTarget, the audit target) must see the same spelling.
  target = normalizeUserPath(target)
  const resolved = resolveTarget(ctx?.workspaceDir, target)

  // Resolve to the REAL location; a target that exists but cannot be resolved
  // (dangling/loop symlink) fails CLOSED — a write would follow the link
  // wherever it points, so there is no judgment to make. Nonexistent targets
  // still get an anchored real path (nearest existing ancestor), so a write
  // through a symlinked parent dir is judged by where it lands, not spelled.
  const real = await resolveRealTarget(resolved)
  if (real.status === 'unresolvable') {
    const resolvedPath = resolved
    auditStore.record({
      scope: 'project',
      actor: ctx?.sessionId,
      action: `fs.${operation}`,
      target: resolvedPath,
      decision: 'denied',
    })
    return { ok: false, reason: 'path cannot be resolved (symlink loop or dangling link)', resolved: resolvedPath }
  }

  // Both spellings of the workspace: realTarget below is canonical, so the
  // canonical workspace root must be available for the same-coordinate
  // comparison (a symlinked ancestor — /tmp → /private/tmp, a symlinked home —
  // would otherwise deny every op inside the workspace).
  let workspaceReal: string | null = null
  if (ctx) {
    const ws = await resolveRealTarget(ctx.workspaceDir)
    workspaceReal = ws.status === 'resolved' ? ws.path : null
  }

  // The skills directory is the agent's sanctioned edit surface (2026-09-27):
  // skill files are content the model is supposed to revise (create_skill's
  // whole premise), and `install` already lets it CREATE arbitrary skill text
  // — denying `edit` on the same files only broke the revision loop.
  //
  // The truncation offload (~/.pulsemind/tmp/trunc, added 2026-10-10) is the
  // second sanctioned root: oversized tool results are head+tail truncated and
  // the full text offloaded there, with the marker telling the model to `read`
  // it back. Before this root the write was denied (~/.pulsemind is a deny
  // root, trunc is neither workspace nor skills) and the .catch swallowed it —
  // the advertised read-back was a dead link and the omitted middle was
  // unrecoverable from anywhere (tool_results persists the TRUNCATED copy).
  // Reads and writes alike are exempt, so `read` reaches the file.
  //
  // The read cache (~/.pulsemind/tmp/read-cache, 2026-10-12) is the third
  // sanctioned root: `read` converts a binary document (pdf/docx/xlsx/…) once
  // via markitdown, caches the markdown there, and the result's Note advertises
  // that path so the model can `search` headings/keywords in it and only then
  // page `read` to the hits. Before this root the advertised path was a dead
  // link under a workspace session (~/.pulsemind is a deny root) — the
  // convert-once-query-many strategy for large documents was unreachable.
  // Reads and writes alike, same discipline as skills/trunc: the tree is
  // app-owned cache, ttl-swept by tmp-cleanup.
  // Everything else under ~/.pulsemind (settings, db, memory, logs, mcp,
  // experiences) stays denied. Both spellings resolve like the workspace's, so
  // a symlinked ancestor or a link escaping the tree still fails the judgment.
  const skillsRoot = join(homedir(), '.pulsemind', 'skills')
  const knowledgeRoot = join(homedir(), '.pulsemind', 'knowledge')
  const knowledgeReal = await resolveRealTarget(knowledgeRoot).then((r) => (r.status === 'resolved' ? r.path : null)).catch(() => null)
  const skillsResolved = await resolveRealTarget(skillsRoot)
  const skillsReal = skillsResolved.status === 'resolved' ? skillsResolved.path : null
  const truncRoot = join(homedir(), '.pulsemind', 'tmp', 'trunc')
  const truncResolved = await resolveRealTarget(truncRoot)
  const truncReal = truncResolved.status === 'resolved' ? truncResolved.path : null
  const readCacheRoot = join(homedir(), '.pulsemind', 'tmp', 'read-cache')
  const readCacheResolved = await resolveRealTarget(readCacheRoot)
  const readCacheReal = readCacheResolved.status === 'resolved' ? readCacheResolved.path : null

  const decision = guardPath({
    target,
    operation,
    denyRoots,
    workspaceDir: ctx?.workspaceDir,
    workspaceReal,
    realTarget: real.path,
    extraWritableRoots: [
      { dir: skillsRoot, real: skillsReal },
      { dir: truncRoot, real: truncReal },
      { dir: readCacheRoot, real: readCacheReal },
    ],
    // knowledge/ read-exempt (E8): the agent reads imported docs/wiki pages via
    // `read` on absolute paths from recall results; writes stay denied (import
    // products, not agent-writable). Session side only — baseline callers (no
    // session: knowledge import UI) already pass via buildBaselineDenyRoots.
    extraReadableRoots: [
      { dir: knowledgeRoot, real: knowledgeReal },
    ],
  })

  // Audit denials always; writes always (allowed writes are the interesting
  // history). Reads that pass stay silent — they would flood the log.
  if (!decision.ok || operation === 'write') {
    auditStore.record({
      scope: 'project',
      actor: ctx?.sessionId,
      action: `fs.${operation}`,
      target: decision.resolved,
      decision: decision.ok ? 'allowed' : 'denied',
    })
  }

  return decision.ok ? { ok: true, resolved: decision.resolved } : { ok: false, reason: decision.reason, resolved: decision.resolved }
}

/** Non-throwing variant for read paths where a rejection degrades to "null". */
export async function checkFsTarget(target: string, operation: GuardOperation): Promise<GuardResult> {
  return guardFsTarget(target, operation)
}
