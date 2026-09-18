import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

// The sweep test imports the real session-manager, whose module chain touches
// real stores — point HOME at a temp dir BEFORE importing (same recipe as
// tests/turn-duration.test.ts).
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-project-overview-'))

// refreshProjectSessions filters live sessions by their conversation's project
// binding — a question the real store answers from SQLite. The whole module is
// replaced (no DB touch; the other exports are unused by this suite).
vi.mock('../src/main/storage/conversation.db', () => ({
  updateConversationOrigin: () => {},
  setConversationProject: () => {},
  getConversationProjectId: (id: string) => (id === 'conv_bound_a' || id === 'conv_bound_b' ? 'proj_overview' : 'default'),
  getConversationExpertId: () => null,
  getConversationApprovalMode: () => undefined,
  setConversationApprovalMode: () => {},
  deriveConvType: () => 'normal',
}))

const { normalizeProjectOverview, PROJECT_OVERVIEW_MAX_LENGTH } = await import('../src/shared/types/project')
const { buildSystemPrompt } = await import('../src/renderer/src/agent/system-prompt-builder')
const { ProjectOverviewAgent } = await import('../src/renderer/src/agent/one-shot-agent/ProjectOverviewAgent')
const { AgentSessionManagerImpl } = await import('../src/main/agent/session-manager')

// ── the shared 50-char rule ────────────────────────────────────────────────

describe('normalizeProjectOverview — one rule for every overview writer', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeProjectOverview('  给设计师用的组件库  ')).toBe('给设计师用的组件库')
  })

  it('caps at 50 chars', () => {
    const long = '这是一个远超五十字限制的概述'.repeat(6) // 84 chars
    expect(long.length).toBe(84) // the fixture is what it claims
    expect(normalizeProjectOverview(long)).toHaveLength(PROJECT_OVERVIEW_MAX_LENGTH)
  })

  it('collapses empty and whitespace-only input to undefined', () => {
    expect(normalizeProjectOverview('')).toBeUndefined()
    expect(normalizeProjectOverview('   ')).toBeUndefined()
    expect(normalizeProjectOverview(null)).toBeUndefined()
    expect(normalizeProjectOverview(undefined)).toBeUndefined()
  })
})

// ── the `## Project` state-block section ───────────────────────────────────

describe('## Project prompt section — per-turn state, never the invariant core', () => {
  it('carries name and overview in the state block', async () => {
    const result = await buildSystemPrompt({
      opts: { projectName: '设计系统', projectOverview: '给设计师用的组件库' } as never,
      messages: [],
      plan: null,
    })
    expect(result.stateBlock).toContain('## Project')
    expect(result.stateBlock).toContain('- Name: 设计系统')
    expect(result.stateBlock).toContain('- Overview: 给设计师用的组件库')
  })

  it('sits in the project → workspace order and never leaks into the frozen core', async () => {
    const result = await buildSystemPrompt({
      opts: { projectName: '设计系统', projectOverview: '给设计师用的组件库', workspaceDir: '/tmp/ws' } as never,
      messages: [],
      plan: null,
    })
    const block = result.stateBlock ?? ''
    const project = block.indexOf('## Project')
    const workspace = block.indexOf('## Workspace')
    expect(project).toBeGreaterThanOrEqual(0)
    expect(workspace).toBeGreaterThan(project)
    // The cache contract: the overview rides the per-turn tail only.
    expect(result.systemPrompt).not.toContain('给设计师用的组件库')
  })

  it('is omitted entirely when the project has neither (若无则忽略)', async () => {
    const result = await buildSystemPrompt({ opts: {} as never, messages: [], plan: null })
    expect(result.stateBlock).not.toContain('## Project')
  })

  it('renders whichever of the two exists', async () => {
    const nameOnly = await buildSystemPrompt({ opts: { projectName: 'X' } as never, messages: [], plan: null })
    expect(nameOnly.stateBlock).toContain('- Name: X')
    expect(nameOnly.stateBlock).not.toContain('- Overview:')
    const overviewOnly = await buildSystemPrompt({ opts: { projectOverview: 'Y' } as never, messages: [], plan: null })
    expect(overviewOnly.stateBlock).toContain('- Overview: Y')
    expect(overviewOnly.stateBlock).not.toContain('- Name:')
  })
})

// ── decision 3: sub-agents do not inherit ──────────────────────────────────

describe('spawn sessions carry no state block, hence no project overview', () => {
  it('a spawnSystemPrompt engine gets stateBlock: null even with project fields set', async () => {
    // spawnSystemPrompt is a buildSystemPrompt PARAM (the engine passes its
    // spawn core there), not an opts field — project fields stay on opts to
    // prove they cannot leak into a spawn prompt.
    const result = await buildSystemPrompt({
      opts: { projectName: '设计系统', projectOverview: '给设计师用的组件库' } as never,
      spawnSystemPrompt: 'SPAWN CORE',
      messages: [],
      plan: null,
    })
    expect(result.stateBlock).toBeNull()
    expect(result.systemPrompt).toContain('SPAWN CORE')
  })
})

// ── the auto-summarize agent ───────────────────────────────────────────────

describe('ProjectOverviewAgent', () => {
  const agent = new ProjectOverviewAgent()
  // The OneShotAgent hooks are protected; the suite drives them directly.
  const call = <T>(fn: (agent: ProjectOverviewAgent) => T): T => fn(agent)

  it('builds a zh system prompt carrying the 50-char rule', () => {
    const sys = call((a) => (a as unknown as { buildSystemPrompt(i: never): string }).buildSystemPrompt({ name: 'x' } as never))
    expect(sys).toContain('50')
    expect(sys).toContain('只输出概述本身')
  })

  it('builds an en system prompt when the locale asks for one', () => {
    const sys = call((a) => (a as unknown as { buildSystemPrompt(i: never): string }).buildSystemPrompt({ name: 'x', locale: 'en' } as never))
    expect(sys).toContain('At most 50 characters')
  })

  it('assembles the user message from name, workspace entries and conversation briefs', () => {
    const msgs = call((a) =>
      (a as unknown as { buildUserMessages(i: never): Array<{ content: string }> }).buildUserMessages({
        name: '我的项目',
        conversationBriefs: ['「调研」最近提到：看看竞品'],
        workspaceEntries: ['README.md', 'packages'],
      } as never),
    )
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toContain('项目名称：我的项目')
    expect(msgs[0].content).toContain('README.md')
    expect(msgs[0].content).toContain('「调研」最近提到：看看竞品')
  })

  it('parses plain output, stripping fences, lead-ins and wrapping quotes', () => {
    const parse = (raw: string) =>
      call((a) => (a as unknown as { parseResponse(r: string, i: never): string | null }).parseResponse(raw, { name: 'x' } as never))
    expect(parse('这是一个测试项目')).toBe('这是一个测试项目')
    expect(parse('概述：一个测试项目')).toBe('一个测试项目')
    expect(parse('“一个测试项目”')).toBe('一个测试项目')
    expect(parse('```\n一个测试项目\n```')).toBe('一个测试项目')
    expect(parse('第一行概述\n第二行噪声')).toBe('第一行概述')
    // Nothing usable → null, the OneShotAgent contract's "no output".
    expect(parse('   ')).toBeNull()
  })

  it('caps its output at the shared limit', () => {
    const parse = (raw: string) =>
      call((a) => (a as unknown as { parseResponse(r: string, i: never): string | undefined }).parseResponse(raw, { name: 'x' } as never))
    expect(parse('好。' + 'x'.repeat(60))).toHaveLength(PROJECT_OVERVIEW_MAX_LENGTH)
  })

  it('never invents a fallback — the user keeps what they typed', () => {
    const fallback = call((a) => (a as unknown as { getDefaultOutput(i: never): string | null }).getDefaultOutput({} as never))
    expect(fallback).toBeNull()
  })
})

// ── the live-session sweep (立即生效, 2026-09-18) ──────────────────────────

describe('refreshProjectSessions — a project edit reaches its bound live sessions', () => {
  it('refreshes only the sessions bound to the edited project', async () => {
    const manager = new AgentSessionManagerImpl() as unknown as {
      sessions: Map<string, unknown>
      refreshOptions: (id: string) => Promise<void>
      refreshProjectSessions: (projectId: string) => Promise<void>
    }
    const refreshed: string[] = []
    // The heavy settings/manager rebuild is stubbed — the filter under test
    // lives in refreshProjectSessions; that refreshOptions itself ships the
    // project fields is pinned by the wiring scan below.
    manager.refreshOptions = async (id: string) => {
      refreshed.push(id)
    }
    const entry = (id: string) => ({
      engine: {
        updateOptions: () => {
          throw new Error(`${id} must not be touched`)
        },
      },
    })
    manager.sessions = new Map([
      ['conv_bound_a', entry('a')],
      ['conv_unbound', entry('u')],
      ['conv_bound_b', entry('b')],
    ])

    await manager.refreshProjectSessions('proj_overview')
    expect(refreshed.sort()).toEqual(['conv_bound_a', 'conv_bound_b'])
  })

  it('refreshes nothing when no session is bound to the project', async () => {
    const manager = new AgentSessionManagerImpl() as unknown as {
      sessions: Map<string, unknown>
      refreshOptions: (id: string) => Promise<void>
      refreshProjectSessions: (projectId: string) => Promise<void>
    }
    const refreshed: string[] = []
    manager.refreshOptions = async (id: string) => {
      refreshed.push(id)
    }
    manager.sessions = new Map([['conv_unbound', { engine: {} }]])
    await manager.refreshProjectSessions('proj_nothing_binds_here')
    expect(refreshed).toEqual([])
  })
})

// ── wiring the DB-boundary tests cannot drive ──────────────────────────────
// (source scans — vitest here is node-env; the DB probe drives the real store,
// and the UI probes mount the real components)

describe('wiring: every surface writes the same field', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8')

  it('refreshOptions re-reads the project and ships it in the wholesale-replaced bag', () => {
    const src = read('src/main/agent/session-manager.ts')
    // refreshOptions's own lookup (doCreateSession's copy shares the shape —
    // two occurrences of the pair prove the bag carries both fields).
    expect(src).toMatch(/refreshOptions/)
    const bagOccurrences = src.match(/projectName,\s*\n\s*projectOverview,/g)?.length ?? 0
    expect(bagOccurrences).toBeGreaterThanOrEqual(2)
  })

  it('PROJECT_UPDATE sweeps the bound sessions, default project excluded', () => {
    const src = read('src/main/ipc/project.handler.ts')
    expect(src).toContain('refreshProjectSessions(id)')
    expect(src).toMatch(/id !== DEFAULT_PROJECT_ID/)
  })

  it('the modal edit save always rides overview so clearing reaches the store', () => {
    const src = read('src/renderer/src/components/project/ProjectModal.tsx')
    expect(src).toMatch(/overview:\s*overview\.trim\(\)/)
  })

  it('the sidebar and welcome edit entries are wired to a modal in edit mode', () => {
    const sidebar = read('src/renderer/src/components/layout/ProjectSidebarList.tsx')
    expect(sidebar).toContain('onEditProject')
    const appLayout = read('src/renderer/src/components/layout/AppLayout.tsx')
    expect(appLayout).toMatch(/editing=\{projectEditTarget\}/)
    const cards = read('src/renderer/src/components/welcome/ProjectCards.tsx')
    expect(cards).toMatch(/editing=\{editTarget\}/)
  })
})
