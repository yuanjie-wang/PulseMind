import { describe, expect, it, afterEach } from 'vitest'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import {
  buildSystemPrompt,
  MAX_PROJECT_AGENTS_CHARS,
  projectAgentsPath,
  rootAgentsPath,
  resetProjectInstructionsRootCache,
} from '../src/renderer/src/agent/system-prompt-builder'
import { execSpawnAgent } from '../src/renderer/src/agent/executors/spawn-tool'
import type { ToolExecContext } from '../src/renderer/src/agent/executors/context'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'
import type { SpawnSubAgentConfig } from '../src/renderer/src/agent/agent-utils'

// ── Why this suite exists ──────────────────────────────────────────────────
// .pulsemind/AGENTS.md is the per-project standing-instructions file (the
// PulseMind answer to Claude Code's CLAUDE.md). The disk file only becomes
// "project law" through two injection points, and this suite pins both:
//
//   1. the MAIN agent's state block — `## Project Instructions`, read from
//      disk on EVERY loop iteration (like git context), so an edit lands on
//      the next request with no restart; the empty state teaches the write
//      path, but ONLY where a conventions file can meaningfully exist (a
//      project-bound conversation — a plain chat's minted scratch workspace
//      gets nothing);
//   2. the SUB-AGENT spawn prompt — content pass-through only (the parent
//      cannot be trusted to transcribe project law into every task), with no
//      empty-state pointer and no write invitation: ephemeral workers don't
//      author the law.
//
// Cache contract under all of it: the section rides the per-turn tail ONLY.
// The frozen core must never learn the file exists.

const WS = '/tmp/pm-agents-md-ws'

interface FsSpec {
  [path: string]: string | Error
}

/** Host stub whose readFile answers from `files`; unlisted paths ENOENT.
 *  `stats` names the paths getFileStat reports as existing (the `.git` walk's
 *  repo markers); anything else stats as null. */
function installHost(files: FsSpec = {}, stats: string[] = []) {
  const reads: string[] = []
  setHost({
    // git + commands injection both default OFF — zero noise in the block.
    getSettings: async () => ({}),
    readFile: async (path: string) => {
      reads.push(path)
      const hit = files[path]
      if (hit instanceof Error) throw hit
      if (hit === undefined) throw new Error(`ENOENT: ${path}`)
      return hit
    },
    getFileStat: async (path: string) =>
      stats.includes(path) ? { size: 1, birthtime: '', mtime: '', isDirectory: true } : null,
  } as unknown as PulseHost)
  return reads
}

/** The real public entry point the engine calls — not an internal helper. */
const prompt = (opts: Record<string, unknown>) =>
  buildSystemPrompt({ opts: opts as never, messages: [], plan: null })

const agentsPath = () => projectAgentsPath(WS)

afterEach(() => {
  setHost(null as unknown as PulseHost)
  resetProjectInstructionsRootCache()
})

describe('## Project Instructions — the state-block injection point', () => {
  it('injects the file body, verbatim and trimmed, naming its path', async () => {
    installHost({ [agentsPath()]: '# 约定\n\n- 用 pnpm，不用 npm\n\n\n' })
    const { stateBlock, systemPrompt } = await prompt({ workspaceDir: WS, projectName: 'Demo' })

    const block = stateBlock ?? ''
    expect(block).toContain('## Project Instructions')
    expect(block).toContain('- 用 pnpm，不用 npm')
    expect(block).toContain(agentsPath())
    // Never leaks into the frozen core — the cache contract.
    expect(systemPrompt).not.toContain('## Project Instructions')
  })

  it('injects for ANY workspace that has the file, project-bound or not', async () => {
    installHost({ [agentsPath()]: '- 数据口径以 sources/ 为准' })
    const { stateBlock } = await prompt({ workspaceDir: WS })
    expect(stateBlock).toContain('- 数据口径以 sources/ 为准')
    // Present file → full section, never the empty-state pointer.
    expect(stateBlock).not.toContain('no .pulsemind/AGENTS.md yet')
  })

  it('sits in the low-volatility band: after ## Project, before ## Workspace', async () => {
    installHost({ [agentsPath()]: '- rule' })
    const { stateBlock } = await prompt({ workspaceDir: WS, projectName: 'Demo' })
    const block = stateBlock ?? ''
    const project = block.indexOf('## Project\n')
    const instructions = block.indexOf('## Project Instructions')
    const workspace = block.indexOf('## Workspace')
    expect(project).toBeGreaterThanOrEqual(0)
    expect(instructions).toBeGreaterThan(project)
    expect(workspace).toBeGreaterThan(instructions)
  })

  it('caps a pathological file at MAX_PROJECT_AGENTS_CHARS and points back at the path', async () => {
    const big = 'A'.repeat(MAX_PROJECT_AGENTS_CHARS) + 'TAIL-SENTINEL-BEYOND-CAP'
    installHost({ [agentsPath()]: big })
    const { stateBlock } = await prompt({ workspaceDir: WS })
    const block = stateBlock ?? ''
    expect(block).toContain('The file exceeds')
    expect(block).toContain('`read` ' + agentsPath())
    expect(block).not.toContain('TAIL-SENTINEL-BEYOND-CAP')
  })

  it('a file at exactly the cap is NOT truncated — the boundary is inclusive', async () => {
    installHost({ [agentsPath()]: 'B'.repeat(MAX_PROJECT_AGENTS_CHARS) })
    const { stateBlock } = await prompt({ workspaceDir: WS })
    expect(stateBlock).not.toContain('The file exceeds')
  })

  it('absent file + project-bound conversation → the one-line write-path pointer', async () => {
    installHost({})
    const { stateBlock } = await prompt({ workspaceDir: WS, projectName: 'Demo' })
    const block = stateBlock ?? ''
    expect(block).toContain('## Project Instructions')
    expect(block).toContain('no .pulsemind/AGENTS.md yet')
    expect(block).toContain('confirm before the first write')
    expect(block).toContain(agentsPath())
  })

  it('absent file + plain minted workspace → nothing at all (scratch has no conventions)', async () => {
    installHost({})
    const { stateBlock } = await prompt({ workspaceDir: WS })
    expect(stateBlock).not.toContain('## Project Instructions')
  })

  it('a whitespace-only file counts as absent → pointer, not an empty law section', async () => {
    installHost({ [agentsPath()]: '   \n\t\n' })
    const { stateBlock } = await prompt({ workspaceDir: WS, projectName: 'Demo' })
    expect(stateBlock).toContain('no .pulsemind/AGENTS.md yet')
  })

  it('an unreadable file (or a host without readFile) never takes the prompt down', async () => {
    installHost({ [agentsPath()]: new Error('EACCES') })
    const { stateBlock } = await prompt({ workspaceDir: WS, projectName: 'Demo' })
    expect(stateBlock).toContain('no .pulsemind/AGENTS.md yet')
  })

  it('no workspaceDir → no section and no read at all', async () => {
    const reads = installHost({})
    const { stateBlock } = await prompt({ projectName: 'Demo' })
    expect(stateBlock).not.toContain('## Project Instructions')
    expect(reads).toHaveLength(0)
  })
})

// ── the root AGENTS.md fallback (2026-10-28) ──────────────────────────────
//
// The shared cross-tool AGENTS.md is READ as a fallback when PulseMind's own
// file is absent — workspace root first, then the git root for a workspace
// nested inside a repo — but never written (the state block teaches
// 「read-only context」 and points PulseMind-specific conventions at
// projectAgentsPath). .pulsemind/AGENTS.md always wins when present.

describe('root AGENTS.md fallback', () => {
  it('absent .pulsemind + present workspace-root AGENTS.md → root body with the read-only teaching line', async () => {
    installHost({ [rootAgentsPath(WS)]: '- 全仓用 pnpm' })
    const { stateBlock } = await prompt({ workspaceDir: WS, projectName: 'Demo' })
    expect(stateBlock).toContain('## Project Instructions')
    expect(stateBlock).toContain('- 全仓用 pnpm')
    expect(stateBlock).toContain(`${WS}/AGENTS.md`)
    expect(stateBlock).toContain('read-only context')
    // PulseMind-specific conventions still learn their own write path.
    expect(stateBlock).toContain(agentsPath())
    expect(stateBlock).not.toContain('no .pulsemind/AGENTS.md yet')
  })

  it('.pulsemind/AGENTS.md wins when both exist — root never injected alongside', async () => {
    installHost({ [agentsPath()]: '- PulseMind 约定', [rootAgentsPath(WS)]: '- 共享约定' })
    const { stateBlock } = await prompt({ workspaceDir: WS })
    expect(stateBlock).toContain('- PulseMind 约定')
    expect(stateBlock).toContain('user-authored')
    expect(stateBlock).not.toContain('- 共享约定')
    expect(stateBlock).not.toContain(rootAgentsPath(WS))
  })

  it('a workspace nested inside a repo reads the repo-root AGENTS.md (the .git walk)', async () => {
    const SUB = '/tmp/pm-agents-md-repo/sub'
    installHost({ ['/tmp/pm-agents-md-repo/AGENTS.md']: '- monorepo 根约定' }, ['/tmp/pm-agents-md-repo/.git'])
    const { stateBlock } = await prompt({ workspaceDir: SUB, projectName: 'Demo' })
    expect(stateBlock).toContain('- monorepo 根约定')
    expect(stateBlock).toContain('/tmp/pm-agents-md-repo/AGENTS.md')
  })

  it('the direct workspace-root file beats the git-root one (nearest law first)', async () => {
    const SUB = '/tmp/pm-agents-md-repo2/sub'
    installHost(
      { [`${SUB}/AGENTS.md`]: '- 子目录约定', ['/tmp/pm-agents-md-repo2/AGENTS.md']: '- 根约定' },
      ['/tmp/pm-agents-md-repo2/.git'],
    )
    const { stateBlock } = await prompt({ workspaceDir: SUB })
    expect(stateBlock).toContain('- 子目录约定')
    expect(stateBlock).not.toContain('- 根约定')
  })

  it('the git-root walk is TTL-cached (one walk per window) and resettable', async () => {
    const SUB = '/tmp/pm-agents-md-repo3/sub'
    const stats = ['/tmp/pm-agents-md-repo3/.git']
    let statCalls = 0
    const reads: string[] = []
    setHost({
      getSettings: async () => ({}),
      readFile: async (path: string) => {
        reads.push(path)
        if (path === '/tmp/pm-agents-md-repo3/AGENTS.md') return '- 根约定'
        throw new Error(`ENOENT: ${path}`)
      },
      getFileStat: async (path: string) => {
        if (stats.includes(path)) { statCalls++; return { size: 1, birthtime: '', mtime: '', isDirectory: true } }
        return null
      },
    } as unknown as PulseHost)
    await prompt({ workspaceDir: SUB })
    const afterFirst = statCalls
    expect(afterFirst).toBeGreaterThan(0)
    await prompt({ workspaceDir: SUB })
    expect(statCalls).toBe(afterFirst) // cache hit — no re-walk
    resetProjectInstructionsRootCache()
    await prompt({ workspaceDir: SUB })
    expect(statCalls).toBe(afterFirst * 2) // reset → re-walk
  })

  it('a root file over the cap is truncated with a pointer at the ROOT path', async () => {
    installHost({ [rootAgentsPath(WS)]: 'A'.repeat(MAX_PROJECT_AGENTS_CHARS) + 'TAIL' })
    const { stateBlock } = await prompt({ workspaceDir: WS })
    expect(stateBlock).toContain('The file exceeds')
    expect(stateBlock).toContain('`read` ' + rootAgentsPath(WS))
    expect(stateBlock).not.toContain('TAIL')
  })

  it('no candidates anywhere → the plain empty-state (or nothing) exactly as before', async () => {
    installHost({})
    const bound = await prompt({ workspaceDir: WS, projectName: 'Demo' })
    expect(bound.stateBlock).toContain('no .pulsemind/AGENTS.md yet')
    const plain = await prompt({ workspaceDir: WS })
    expect(plain.stateBlock).not.toContain('## Project Instructions')
  })

  it('the spawn pass-through carries the root body too (content only)', async () => {
    installHost({ [`${WS}/AGENTS.md`]: '- 共享约定，子代理也要守' })
    const { ex, getConfig } = makeContext({ workspaceDir: WS })
    await execSpawnAgent(ex, tool({ task: '写周报' }))
    const sp = getConfig()!.systemPrompt
    expect(sp).toContain('# Project Instructions')
    expect(sp).toContain('- 共享约定，子代理也要守')
    expect(sp).not.toContain('read-only context') // no teaching — content only
  })
})

// ── the sub-agent pass-through ─────────────────────────────────────────────

function makeContext(opts: Record<string, unknown>): {
  ex: ToolExecContext
  getConfig: () => SpawnSubAgentConfig | null
} {
  let config: SpawnSubAgentConfig | null = null
  const ex = {
    opts: { conversationId: `conv_law_${Math.random().toString(36).slice(2, 8)}`, maxTokens: 8192, ...opts },
    notify: () => {},
    addToolResult: () => {},
    spawnSubAgent: (cfg: SpawnSubAgentConfig) => {
      config = cfg
      return {
        id: 'h1',
        subConvId: 'sub_law_test',
        messages: [],
        agentStatus: { status: 'completed' },
        abort: () => {},
        waitForCompletion: async () => ({
          status: 'completed',
          messages: [{ id: 'a1', role: 'assistant', contentBlocks: [{ type: 'text', text: '完成' }], createdAt: '2026-10-07T12:00:00.000Z' }],
          outputTokens: 0,
        }),
      }
    },
    formatExecResult: () => '',
  } as unknown as ToolExecContext
  return { ex, getConfig: () => config }
}

const tool = (input: Record<string, unknown>): ToolUseBlock =>
  ({ id: 't1', type: 'tool_use', name: 'spawn_agent', input, status: 'pending' }) as ToolUseBlock

describe('# Project Instructions — the spawn pass-through', () => {
  it('the file rides the spawn prompt: after the env block, before the workflow', async () => {
    installHost({ [agentsPath()]: '- 报告用中文，正式语气' })
    const { ex, getConfig } = makeContext({ workspaceDir: WS })
    await execSpawnAgent(ex, tool({ task: '写周报' }))

    const sp = getConfig()!.systemPrompt
    expect(sp).toContain('# Project Instructions')
    expect(sp).toContain('- 报告用中文，正式语气')
    expect(sp.indexOf('# Running Environment')).toBeLessThan(sp.indexOf('# Project Instructions'))
    expect(sp.indexOf('# Project Instructions')).toBeLessThan(sp.indexOf('## Engineering Workflow'))
    // Content only — ephemeral workers get no write path.
    expect(sp).not.toContain('confirm before the first write')
    expect(sp).not.toContain('no .pulsemind/AGENTS.md yet')
  })

  it('absent file → no section, no pointer, env block intact, no throw', async () => {
    installHost({})
    const { ex, getConfig } = makeContext({ workspaceDir: WS })
    await execSpawnAgent(ex, tool({ task: 'task' }))

    const sp = getConfig()!.systemPrompt
    expect(sp).not.toContain('# Project Instructions')
    expect(sp).toContain(`- Workspace: ${WS}`)
  })

  it('no workspaceDir → nothing to pass through', async () => {
    installHost({})
    const { ex, getConfig } = makeContext({ workspaceDir: undefined })
    await execSpawnAgent(ex, tool({ task: 'task' }))

    expect(getConfig()!.systemPrompt).not.toContain('# Project Instructions')
  })
})
