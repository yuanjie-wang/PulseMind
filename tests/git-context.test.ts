import { describe, expect, it, afterEach } from 'vitest'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { buildSystemPrompt } from '../src/renderer/src/agent/system-prompt-builder'
import type { GitStatusInfo } from '../src/shared/types/git'

// ── Why this suite exists ──────────────────────────────────────────────────
// `buildGitContext` runs on EVERY tool-loop iteration of a turn, not once per
// turn: AgentEngine.prepareLoopRequest → buildSystemPrompt → buildStateBlock.
// So each git subprocess it spawns is multiplied by the iteration count, and a
// single unnecessary probe call costs ~10ms × iterations (measured on a 775-file
// repo; see scripts/probe-loop-iteration-perf.mjs section D).
//
// It used to run TWO: a `rev-parse --is-inside-work-tree` precheck guarding the
// `status` call. The precheck was pure waste — `status` already reports
// `isRepo`, and the main-process `gitStatus` returns `{ isRepo: false }` (not an
// error) for a non-repo cwd. These tests pin the call COUNT, because the
// redundancy is invisible in the output bytes: reverting it silently doubles the
// cost of the hottest fixed path in a long task.
//
// They also pin the behaviour that made the removal safe — every non-repo and
// failure path still yields "no git section, no throw" — so nobody can satisfy
// the call-count pin by deleting the feature instead of the probe.

const WS = '/tmp/pm-git-context-ws'

const REPO: GitStatusInfo = {
  isRepo: true,
  branch: 'main',
  ahead: 1,
  behind: 2,
  staged: ['src/a.ts'],
  unstaged: ['src/b.ts'],
  untracked: ['notes.md'],
  conflict: [],
}

type GitResult = { ok: boolean; data?: unknown; error?: { code: number; message: string } }

/** Installs a host that records every gitInvoke action it is asked to run. */
function installHost(result: GitResult | (() => never), settings: unknown = { git: { contextInjection: true } }) {
  const calls: Array<{ action: string; cwd: string }> = []
  setHost({
    getSettings: async () => settings,
    gitInvoke: async (action: { action: string; cwd: string }) => {
      calls.push(action)
      if (typeof result === 'function') return result()
      return result
    },
  } as unknown as PulseHost)
  return calls
}

/** The real public entry point the engine calls — not an internal helper. */
const prompt = (workspaceDir: string = WS) =>
  buildSystemPrompt({ opts: { workspaceDir } as never, messages: [], plan: null })

afterEach(() => setHost(null as unknown as PulseHost))

describe('buildGitContext — one git call per loop iteration, not two', () => {
  it('issues exactly ONE gitInvoke, and it is the status call', async () => {
    const calls = installHost({ ok: true, data: REPO })
    await prompt()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ action: 'status', cwd: WS })
    // The probe call must not come back. If this assertion fires, the
    // per-iteration cost of every long task just doubled.
    expect(calls.some((c) => c.action === 'is_repo')).toBe(false)
  })

  it('still renders the full git section — the call-count pin is not satisfied by dropping the feature', async () => {
    installHost({ ok: true, data: REPO })
    const { stateBlock, systemPrompt } = await prompt()
    const block = stateBlock ?? ''
    expect(block).toContain('--- Git Context ---')
    expect(block).toContain('--- End Git Context ---')
    expect(block).toContain(`Repo: ${WS} (branch: main)`)
    expect(block).toContain('Ahead: 1 | Behind: 2')
    expect(block).toContain('Staged (1):')
    expect(block).toContain('Unstaged (1):')
    expect(block).toContain('Untracked (1):')
    expect(block).toContain('  notes.md')
    // The cache contract: volatile git state rides the per-turn tail only, never
    // the frozen core (which must stay byte-identical across turns).
    expect(systemPrompt).not.toContain('--- Git Context ---')
  })

  it('a non-repo cwd yields no section and no throw — the path the removed precheck used to take', async () => {
    const calls = installHost({ ok: true, data: { ...REPO, isRepo: false, branch: null } })
    const { stateBlock } = await prompt()
    expect(stateBlock).not.toContain('--- Git Context ---')
    // One call, not zero: `status` is what answers "is this a repo" now.
    expect(calls).toHaveLength(1)
  })

  it('a failed git call yields no section and never takes the prompt down', async () => {
    installHost({ ok: false, error: { code: 128, message: 'fatal: not a git repository' } })
    const { stateBlock } = await prompt()
    expect(stateBlock).not.toContain('--- Git Context ---')
  })

  it('a throwing host is swallowed rather than propagated', async () => {
    installHost(() => {
      throw new Error('git binary missing')
    })
    const { stateBlock } = await prompt()
    expect(stateBlock).not.toContain('--- Git Context ---')
  })

  it('the settings gate sits upstream: injection off means zero git calls', async () => {
    const calls = installHost({ ok: true, data: REPO }, { git: { contextInjection: false } })
    const { stateBlock } = await prompt()
    expect(calls).toHaveLength(0)
    expect(stateBlock).not.toContain('--- Git Context ---')
  })

  it('the default is OFF: no git group in settings means zero git calls', async () => {
    const calls = installHost({ ok: true, data: REPO }, {})
    const { stateBlock } = await prompt()
    expect(calls).toHaveLength(0)
    expect(stateBlock).not.toContain('--- Git Context ---')
  })

  it('no workspace means no git call at all', async () => {
    const calls = installHost({ ok: true, data: REPO })
    await buildSystemPrompt({ opts: {} as never, messages: [], plan: null })
    expect(calls).toHaveLength(0)
  })

  it('a spawn session carries no state block, hence never pays for git', async () => {
    const calls = installHost({ ok: true, data: REPO })
    const result = await buildSystemPrompt({
      opts: { workspaceDir: WS } as never,
      spawnSystemPrompt: 'SPAWN CORE',
      messages: [],
      plan: null,
    })
    expect(result.stateBlock).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
