// ── Approval vocabulary (PLAN-0.4.0) ──
// How much an agent may do unattended is a per-conversation choice
// (`conversations.approval_mode`); the engine's ladder and that column share
// this one vocabulary. The former project sandbox policy (fs/network/hard
// isolation) is gone: file writes are always jailed to the conversation's
// workspace (see shared/sandbox/path-jail.ts).

export type SandboxApprovalMode = 'auto' | 'outside-ask' | 'always-ask'

const APPROVAL_MODES: SandboxApprovalMode[] = ['auto', 'outside-ask', 'always-ask']

/** Coerce an unknown value to an approval mode, or undefined when it isn't one.
 *  Callers layer their own fallback on top (session payloads, the DB column). */
export function toSandboxApprovalMode(raw: unknown): SandboxApprovalMode | undefined {
  return typeof raw === 'string' && (APPROVAL_MODES as string[]).includes(raw) ? (raw as SandboxApprovalMode) : undefined
}

/** The level a conversation that never chose one runs at — 按需确认: reads and
 *  workspace writes run unattended, everything that leaves the workspace (shell,
 *  page_execute_js, gated MCP tools) waits for a click. `webfetch`/`browser`
 *  do NOT wait — they ride the trusted system group past the ladder (see the
 *  requiresApproval note below), so network egress runs unattended here too.
 *
 *  Deliberately not 'auto': the unrestricted level is a widening the user asks
 *  for (the UI tints it orange for exactly that reason), so it must never be
 *  what a conversation silently starts at. Every resolver falls back here, so
 *  the desktop's 授权 button, the extension panel's same-named dropdown and the
 *  engine's own ladder cannot disagree about what a fresh conversation does. */
export const DEFAULT_APPROVAL_MODE: SandboxApprovalMode = 'outside-ask'

/** The first candidate that is actually set, most specific first — an explicit
 *  session override beats the conversation's stored choice, which beats
 *  DEFAULT_APPROVAL_MODE. One place so every resolver agrees on the precedence. */
export function pickApprovalMode(...candidates: Array<SandboxApprovalMode | undefined | null>): SandboxApprovalMode {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) return candidate
  }
  return DEFAULT_APPROVAL_MODE
}

/** What an approval mode holds back. 'read' covers everything that only looks
 *  (reads, memory/knowledge/system tools) — never gated at any level. */
export type SandboxToolTier = 'read' | 'write' | 'exec'

/** The approval ladder, as one decision the engine consults per tool:
 *  'auto' runs everything; 'outside-ask' holds calls that leave the workspace
 *  (shell/exec, ungrouped tools, install(mcp), MCP tools declaring
 *  requireApproval); 'always-ask' also holds file writes and edits.
 *
 *  DOCUMENTED EXEMPTION — do not "fix" the inconsistency silently (2026-10-10
 *  audit #2): `webfetch` and `browser` answer 'exec' here yet are NEVER held,
 *  because the engine dispatches them as trusted system groups
 *  (execution-flow's isSystemTool), not through this ladder — a pre-existing
 *  exemption, see tool-tiers.ts' header for the other half of the note.
 *  Network egress therefore runs unattended at every level including
 *  'always-ask'. Tightening that is a product decision, not a drive-by edit.
 *
 *  `allowlisted` short-circuits the ladder (PLAN-coding-contract #5): the
 *  command's stable prefix is in the session's 「本会话总是允许」 set, which the
 *  USER narrowed it with — the session-scoped exception beats the mode, never
 *  the other way around. The session set lives in the main process (not the DB,
 *  so a new session starts clean) and is matched by
 *  shared/sandbox/command-allowlist.ts. */
export function requiresApproval(mode: SandboxApprovalMode, tier: SandboxToolTier, allowlisted?: boolean): boolean {
  if (allowlisted) return false
  switch (mode) {
    case 'auto': return false
    case 'outside-ask': return tier === 'exec'
    case 'always-ask': return tier !== 'read'
  }
}
