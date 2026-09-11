// ── Sandbox policy model (PLAN-0.4.0 M3.3) ──
// The single adjudication input for everything an agent session touches: file
// writes, shell commands, network reach. Stored per project as JSON
// (`projects.sandbox_json`), normalized on read so older/partial rows load
// with defaults instead of failing.

export type SandboxFsMode = 'read-only' | 'workspace-write' | 'full-access'
export type SandboxNetworkMode = 'allow' | 'deny'
export type SandboxApprovalMode = 'auto' | 'outside-ask' | 'always-ask'

export interface ProjectSandboxPolicy {
  fs: SandboxFsMode
  network: SandboxNetworkMode
  approval: SandboxApprovalMode
  /** OS-level command isolation (sandbox-exec / bwrap). Off by default (D2). */
  hardIsolation: boolean
  /** Additional writable roots alongside the workspace. */
  extraRoots: string[]
}

/** D2: workspace-write + outside-ask, hard isolation opt-in. */
export const DEFAULT_SANDBOX_POLICY: ProjectSandboxPolicy = {
  fs: 'workspace-write',
  network: 'allow',
  approval: 'outside-ask',
  hardIsolation: false,
  extraRoots: [],
}

const FS_MODES: SandboxFsMode[] = ['read-only', 'workspace-write', 'full-access']
const NETWORK_MODES: SandboxNetworkMode[] = ['allow', 'deny']
const APPROVAL_MODES: SandboxApprovalMode[] = ['auto', 'outside-ask', 'always-ask']

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback
}

/** Tolerantly parse a policy from unknown JSON. Invalid fields fall back to
 *  defaults; unknown fields are dropped. */
export function normalizeSandboxPolicy(raw: unknown): ProjectSandboxPolicy {
  if (raw == null || typeof raw !== 'object') return { ...DEFAULT_SANDBOX_POLICY, extraRoots: [] }
  const raw_ = raw as Record<string, unknown>
  return {
    fs: oneOf(raw_.fs, FS_MODES, DEFAULT_SANDBOX_POLICY.fs),
    network: oneOf(raw_.network, NETWORK_MODES, DEFAULT_SANDBOX_POLICY.network),
    approval: oneOf(raw_.approval, APPROVAL_MODES, DEFAULT_SANDBOX_POLICY.approval),
    hardIsolation: raw_.hardIsolation === true,
    extraRoots: Array.isArray(raw_.extraRoots)
      ? raw_.extraRoots.filter((r): r is string => typeof r === 'string' && r.length > 0)
      : [],
  }
}
