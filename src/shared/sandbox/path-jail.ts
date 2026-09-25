// ── Path jail (PLAN-0.4.0 M3.4) ──
// Pure decision function for every file path an agent session touches.
// No IO, no Electron — the caller (main-process services) resolves symlinks
// and supplies the deny-root list; this module only decides.
//
// MAIN-PROCESS ONLY despite living in shared/: it imports `node:path` and
// reads `process.platform`, neither of which exists in the sandboxed
// renderer. If renderer-side reuse is ever needed, this file must be
// rewritten self-contained (pure string path logic) — and re-tested, since
// these are security decisions. Renderer path filtering goes through
// main's file-ops instead.
//
// Semantics:
//   read   — allowed everywhere except DENY_ROOTS (agent may look around, not
//            into secrets or PulseMind's own data)
//   write  — additionally jailed to workspaceDir
//   baseline (no workspaceDir) — deny-roots only; user-initiated renderer
//            utilities (knowledge import) run this way and must keep
//            writing into ~/.pulsemind, so the baseline list excludes it

import { isAbsolute, resolve, sep } from 'node:path'

export type PathOperation = 'read' | 'write'

export type PathDecision = {
  ok: true
  resolved: string
} | {
  ok: false
  /** English, agent-facing — this lands in a tool result verbatim. */
  reason: string
  resolved: string
}

export interface GuardPathInput {
  target: string
  operation: PathOperation
  denyRoots: string[]
  /** Present only for agent sessions. Absent = baseline (deny-roots only). */
  workspaceDir?: string
  /** Canonical spelling of `workspaceDir` when the caller resolved it.
   *  `realTarget` is always canonical, so judging it against a lexical
   *  workspace root would deny EVERY op inside a workspace whose ancestors
   *  include a symlink (`/tmp` → `/private/tmp`, a symlinked home). Each
   *  comparison runs in its own coordinate system: lexical against lexical,
   *  real against real. */
  workspaceReal?: string | null
  /** Realpath-resolved target when the caller could resolve it (symlinks,
   *  `/tmp` → `/private/tmp`). Checked in addition to the lexical resolution. */
  realTarget?: string | null
}

export function buildDenyRoots(home: string, platform: string): string[] {
  const roots = [
    `${home}/.ssh`,
    `${home}/.aws`,
    `${home}/.gnupg`,
    `${home}/.pulsemind`,
  ]
  if (platform === 'darwin') roots.push(`${home}/Library/Keychains`)
  return roots
}

/** Deny roots for callers WITHOUT a session (user-initiated utilities).
 *  Everything the app itself must write into stays writable. */
export function buildBaselineDenyRoots(home: string, platform: string): string[] {
  const roots = [
    `${home}/.ssh`,
    `${home}/.aws`,
    `${home}/.gnupg`,
  ]
  if (platform === 'darwin') roots.push(`${home}/Library/Keychains`)
  return roots
}

function normalize(p: string): string {
  const r = resolve(p)
  // macOS/Windows are case-insensitive filesystems.
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r
}

/** True when `target` is `root` itself or lives underneath it (case-folded on
 *  darwin/win32). Shared by the guard and by the terminal's cwd materialization. */
export function isSubpath(root: string, target: string): boolean {
  const r = normalize(root)
  const t = normalize(target)
  if (r === t) return true
  const prefixed = r.endsWith(sep) ? r : r + sep
  return t.startsWith(prefixed)
}

/** Resolve `target` the way the agent means it: relative paths hang off the
 *  workspace. Without a workspace, absolute targets stand alone. */
export function resolveTarget(workspaceDir: string | undefined, target: string): string {
  if (isAbsolute(target)) return resolve(target)
  if (workspaceDir) return resolve(workspaceDir, target)
  return resolve(target)
}

function hitsDenyRoots(decision: { denyRoots: string[]; resolved: string; realTarget?: string | null }): boolean {
  return decision.denyRoots.some((root) =>
    isSubpath(root, decision.resolved) ||
    (decision.realTarget ? isSubpath(root, decision.realTarget) : false)
  )
}

export function guardPath(input: GuardPathInput): PathDecision {
  const resolved = resolveTarget(input.workspaceDir, input.target)
  const extra: { realTarget?: string | null } = input.realTarget != null ? { realTarget: input.realTarget } : {}

  // The session's own workspace is exempt from deny roots: the default workspace
  // lives under the protected ~/.pulsemind root, so a blanket deny would lock the
  // agent out of its own working directory (PLAN-0.4.0 M8.1). Writes stay jailed
  // to the workspace below. The exemption needs BOTH the lexical target and the
  // realpath (when known) inside the workspace — a symlink that leads out does
  // not count, keeping deny roots effective for link escapes.
  const lexicalInside = !!input.workspaceDir && isSubpath(input.workspaceDir, resolved)
  const realInside = input.workspaceDir && input.realTarget != null
    ? isSubpath(input.workspaceReal ?? input.workspaceDir, input.realTarget)
    : null
  const inWorkspace = lexicalInside && realInside !== false

  if (!inWorkspace && hitsDenyRoots({ denyRoots: input.denyRoots, resolved, ...extra })) {
    return { ok: false, resolved, reason: `Path is protected: ${resolved}` }
  }

  if (!input.workspaceDir) {
    // Baseline: user-initiated, no agent jail beyond deny roots.
    return { ok: true, resolved }
  }

  if (input.operation === 'read') return { ok: true, resolved }

  // Writes are jailed to the workspace. Both spellings of the root are
  // writable: `realTarget` judges against the canonical root (the default —
  // a link inside the workspace pointing outside must not pass), while a
  // caller with no `realTarget` resolves lexically and judges lexically.
  const writableRoots: string[] = [input.workspaceDir]
  if (input.workspaceReal) writableRoots.push(input.workspaceReal)
  const judgeTarget = input.realTarget ?? resolved
  const inside = writableRoots.some((root) => isSubpath(root, judgeTarget))
  if (!inside) {
    return {
      ok: false,
      resolved,
      reason: `Write blocked by sandbox: ${resolved} is outside the workspace (${input.workspaceDir})`,
    }
  }
  return { ok: true, resolved }
}
