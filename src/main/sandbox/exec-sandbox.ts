// ── exec hard isolation (PLAN-0.4.0 M3.9) ──
// OS-level command sandboxing, opt-in per project (`hardIsolation`).
//   macOS: sandbox-exec with a generated Seatbelt profile — probe-verified on
//   darwin 24 (deny file-write* + targeted subpath allows). IMPORTANT: Seatbelt
//   matches REAL paths, so the workspace is realpath-resolved before being
//   written into the profile (`/tmp` → `/private/tmp`).
//   Linux: bubblewrap when present.
// When support is missing the caller degrades to approval + audit (R1/R2) and
// says so in the UI — never silently claims hard isolation.

import { existsSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import type { ProjectSandboxPolicy } from '../../shared/sandbox/policy'

let cachedSupport: boolean | null = null

export function detectSandboxSupport(): boolean {
  if (cachedSupport != null) return cachedSupport
  try {
    if (platform() === 'darwin') {
      cachedSupport = existsSync('/usr/bin/sandbox-exec')
    } else if (platform() === 'linux') {
      execFileSync('bwrap', ['--version'], { timeout: 3000 })
      cachedSupport = true
    } else {
      cachedSupport = false
    }
  } catch {
    cachedSupport = false
  }
  return cachedSupport
}

function toRealPath(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/** Generate the Seatbelt profile text. `allow default` keeps reads/other ops
 *  working; all writes are denied then re-allowed for the workspace, app tmp
 *  and /private/tmp (build tools need scratch space). */
function seatbeltProfile(policy: ProjectSandboxPolicy, realWorkspace: string, realTmp: string): string {
  const writable = [realWorkspace, realTmp, '/private/tmp', '/dev/null']
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    ...writable.map((p) => `(allow file-write* (subpath "${p}"))`),
  ]
  if (policy.network === 'deny') lines.push('(deny network*)')
  return lines.join('\n')
}

/** Linux bubblewrap argv: read-only root, writable workspace + /tmp + /dev. */
function bwrapArgv(policy: ProjectSandboxPolicy, realWorkspace: string): string[] {
  const argv = ['bwrap', '--ro-bind', '/', '/', '--bind', realWorkspace, realWorkspace, '--bind', '/tmp', '/tmp', '--dev', '/dev', '--proc', '/proc']
  if (policy.network === 'deny') argv.push('--unshare-net')
  return argv
}

export interface SandboxSpawnPlan {
  /** Prefix argv — spawn argv becomes [...prefix, shell, ...shellArgs]. */
  prefix: string[]
  /** Short human label for audit entries. */
  kind: 'sandbox-exec' | 'bwrap'
}

/**
 * Build the spawn prefix for an isolated command, or null when the platform
 * cannot hard-isolate (caller falls back to approval + audit).
 * `dataTmp` is PulseMind's own tmp dir — app machinery keeps working inside
 * the sandbox.
 */
export function planSandboxSpawn(policy: ProjectSandboxPolicy, workspaceDir: string, dataTmp: string): SandboxSpawnPlan | null {
  if (!policy.hardIsolation) return null
  const realWorkspace = toRealPath(workspaceDir)
  const realTmp = toRealPath(dataTmp)
  if (platform() === 'darwin') {
    if (!detectSandboxSupport()) return null
    const dir = join(homedir(), '.pulsemind', 'tmp')
    mkdirSync(dir, { recursive: true })
    const profilePath = join(dir, `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sb`)
    writeFileSync(profilePath, seatbeltProfile(policy, realWorkspace, realTmp))
    return { prefix: ['/usr/bin/sandbox-exec', '-f', profilePath], kind: 'sandbox-exec' }
  }
  if (platform() === 'linux') {
    if (!detectSandboxSupport()) return null
    return { prefix: bwrapArgv(policy, realWorkspace), kind: 'bwrap' }
  }
  return null
}
