// ── Sandbox policy model (PLAN-0.4.0 M3.3) ──
// The single adjudication input for everything an agent session touches: file
// writes, shell commands, network reach. Stored per project as JSON
// (`projects.sandbox_json`), normalized on read so older/partial rows load
// with defaults instead of failing.
//
// Approval is deliberately NOT part of a project policy: how much an agent may
// do unattended is a per-conversation choice (`conversations.approval_mode`),
// carried here because the engine's ladder and that column share one vocabulary.

export type SandboxFsMode = 'read-only' | 'workspace-write' | 'full-access'
export type SandboxNetworkMode = 'allow' | 'deny'
export type SandboxApprovalMode = 'auto' | 'outside-ask' | 'always-ask'

export interface ProjectSandboxPolicy {
  fs: SandboxFsMode
  network: SandboxNetworkMode
  /** OS-level command isolation (sandbox-exec / bwrap). Off by default (D2). */
  hardIsolation: boolean
  /** Additional writable roots alongside the workspace. */
  extraRoots: string[]
}

/** D2: workspace-write, hard isolation opt-in. */
export const DEFAULT_SANDBOX_POLICY: ProjectSandboxPolicy = {
  fs: 'workspace-write',
  network: 'allow',
  hardIsolation: false,
  extraRoots: [],
}

const FS_MODES: SandboxFsMode[] = ['read-only', 'workspace-write', 'full-access']
const NETWORK_MODES: SandboxNetworkMode[] = ['allow', 'deny']
const APPROVAL_MODES: SandboxApprovalMode[] = ['auto', 'outside-ask', 'always-ask']

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback
}

/** Coerce an unknown value to an approval mode, or undefined when it isn't one.
 *  Callers layer their own fallback on top (session payloads, the DB column). */
export function toSandboxApprovalMode(raw: unknown): SandboxApprovalMode | undefined {
  return typeof raw === 'string' && (APPROVAL_MODES as string[]).includes(raw) ? (raw as SandboxApprovalMode) : undefined
}

/** The first candidate that is actually set, most specific first — an explicit
 *  session override beats the conversation's stored choice, which beats a bare
 *  'auto'. One place so every resolver agrees on the precedence. */
export function pickApprovalMode(...candidates: Array<SandboxApprovalMode | undefined | null>): SandboxApprovalMode {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) return candidate
  }
  return 'auto'
}

/** What an approval mode holds back. 'read' covers everything that only looks
 *  (reads, memory/knowledge/system tools) — never gated at any level. */
export type SandboxToolTier = 'read' | 'write' | 'exec'

/** The approval ladder, as one decision the engine consults per tool:
 *  'auto' runs everything; 'outside-ask' holds calls that leave the workspace
 *  (shell, ungrouped tools, MCP tools declaring requireApproval); 'always-ask'
 *  also holds file writes and edits. */
export function requiresApproval(mode: SandboxApprovalMode, tier: SandboxToolTier): boolean {
  switch (mode) {
    case 'auto': return false
    case 'outside-ask': return tier === 'exec'
    case 'always-ask': return tier !== 'read'
  }
}

/** Tolerantly parse a policy from unknown JSON. Invalid fields fall back to
 *  defaults; unknown fields are dropped. */
export function normalizeSandboxPolicy(raw: unknown): ProjectSandboxPolicy {
  if (raw == null || typeof raw !== 'object') return { ...DEFAULT_SANDBOX_POLICY, extraRoots: [] }
  const raw_ = raw as Record<string, unknown>
  return {
    fs: oneOf(raw_.fs, FS_MODES, DEFAULT_SANDBOX_POLICY.fs),
    network: oneOf(raw_.network, NETWORK_MODES, DEFAULT_SANDBOX_POLICY.network),
    hardIsolation: raw_.hardIsolation === true,
    extraRoots: Array.isArray(raw_.extraRoots)
      ? raw_.extraRoots.filter((r): r is string => typeof r === 'string' && r.length > 0)
      : [],
  }
}
