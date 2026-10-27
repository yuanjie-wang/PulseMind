import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSystemPrompt } from '../src/renderer/src/agent/system-prompt-builder'
import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'

// ── Test doubles ──────────────────────────────────────────────────────
//
// The contract under test is byte-level: DeepSeek matches a prompt prefix from
// token 0 and renders `system → tools → messages`, so the system prompt sits in
// front of the tool schemas AND the whole conversation. One volatile byte in it
// re-bills everything behind it, which is what these tests pin down.

const opts = (patch: Partial<AgentEngineOptions> = {}): AgentEngineOptions =>
  ({
    apiKey: null,
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    maxTokens: 4096,
    myName: 'Yuanjie',
    soul: 'terse, technical',
    yourName: 'Pulse',
    locale: 'zh',
    adapter: {} as AgentEngineOptions['adapter'],
    toolManager: undefined as unknown as AgentEngineOptions['toolManager'],
    skillManager: undefined as unknown as AgentEngineOptions['skillManager'],
    ...patch,
  }) as AgentEngineOptions

const userMsg = (text: string) => ({
  id: 'u1',
  role: 'user' as const,
  contentBlocks: [{ type: 'text' as const, text }],
  createdAt: '2026-09-15T00:00:00.000Z',
})

const memoryStub = (context: string) =>
  ({ getManualMemoryContext: async () => context }) as unknown as AgentEngineOptions['memoryManager']

const experienceStub = (matched: { name: string; description: string }[]) =>
  ({
    buildNameIndex: async () => null,
    matchByTriggers: async () => matched,
  }) as unknown as NonNullable<AgentEngineOptions['experienceManager']>

/** Minimal Plan shape — only the fields the v2 plan section reads (PLAN-plan-dag). */
const plan = (mode: string, stepDone: boolean) =>
  ({
    objective: 'ship the cache work',
    mode,
    completed: false,
    version: 2,
    nodes: [
      { id: 'n1', description: 'measure', status: 'completed', dependsOn: [] },
      { id: 'n2', description: 'refactor', status: stepDone ? 'completed' : 'pending', dependsOn: ['n1'] },
    ],
  }) as never

afterEach(() => vi.useRealTimers())

// ── The invariant core ────────────────────────────────────────────────

describe('invariant core', () => {
  it('is byte-identical when the clock, plan, page and workspace all move (one shared memory snapshot)', async () => {
    // The memory context now rides the core — byte-stable via the manager's
    // double 3h TTL — so the invariance claim is: one SHARED snapshot does not
    // move when per-turn / per-conversation state does.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-15T06:00:00.000Z'))
    const sharedMemory = memoryStub('# Memory Context\n- a fact')
    const first = await buildSystemPrompt({
      opts: opts({ workspaceDir: '/tmp/ws-a', memoryManager: sharedMemory }),
      messages: [userMsg('hello')],
      plan: plan('auto', false),
    })

    vi.setSystemTime(new Date('2026-09-15T09:31:00.000Z'))
    const second = await buildSystemPrompt({
      opts: opts({
        workspaceDir: '/tmp/ws-b',
        memoryManager: sharedMemory,
        pageContext: { url: 'https://example.test/a', title: 'Example' },
      }),
      messages: [userMsg('hello')],
      plan: plan('delegated', true),
    })

    // The whole point: nothing above may differ, or the tools + history behind
    // this prompt are re-billed on every turn.
    expect(second.systemPrompt).toBe(first.systemPrompt)
  })

  it('carries no clock and no workspace; the memory context rides the snapshot', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-15T06:00:00.000Z'))
    const { systemPrompt } = await buildSystemPrompt({
      opts: opts({ workspaceDir: '/tmp/ws-a', memoryManager: memoryStub('# Memory Context\n- SECRET_FACT') }),
      messages: [userMsg('hello')],
      plan: null,
    })

    expect(systemPrompt).not.toMatch(/\d{4}-\d{2}-\d{2}/) // no date anywhere
    expect(systemPrompt).not.toContain('/tmp/ws-a')
    // 2026-09-26 contract flip: the memory context IS in the core now (3h
    // snapshot) — this assertion pins the new shape against a silent revert.
    expect(systemPrompt).toContain('SECRET_FACT')
  })

  it('stays identical across conversations that differ only in per-conversation state', async () => {
    // Different projects/dirs must share one warm prefix — this is what makes
    // the cache reusable across conversations and restarts.
    const a = await buildSystemPrompt({
      opts: opts({ workspaceDir: '/Users/x/project-one' }),
      messages: [userMsg('do A')],
      plan: null,
    })
    const b = await buildSystemPrompt({
      opts: opts({ workspaceDir: '/Users/x/project-two' }),
      messages: [userMsg('do B')],
      plan: null,
    })
    expect(b.systemPrompt).toBe(a.systemPrompt)
  })

  it('keeps the tool-call contract and explains where session state lives', () => {
    return buildSystemPrompt({ opts: opts(), messages: [userMsg('hi')], plan: null }).then(({ systemPrompt }) => {
      expect(systemPrompt).toContain('## Tool Call Format')
      expect(systemPrompt).toContain('## Compressed Tool Results')
      expect(systemPrompt).toContain('## Local Knowledge & Memory')
      expect(systemPrompt).toContain('<session-state>')
    })
  })
})

// ── The per-turn state block ──────────────────────────────────────────

describe('session state block', () => {
  it('carries the volatile values instead', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-15T06:00:00.000Z'))
    const { stateBlock } = await buildSystemPrompt({
      opts: opts({
        workspaceDir: '/tmp/ws-a',
        memoryManager: memoryStub('# Memory Context\n## Extracted Memories\n- SECRET_FACT'),
        pageContext: { url: 'https://example.test/a', title: 'Example Page' },
      }),
      messages: [userMsg('hello')],
      plan: plan('auto', false),
    })

    expect(stateBlock).toBeTruthy()
    expect(stateBlock).toContain('<session-state>')
    // Memory left the block for the frozen core (2026-09-26) — the volatile
    // tail carries only the genuinely per-turn / per-conversation values.
    expect(stateBlock).not.toContain('SECRET_FACT')
    expect(stateBlock).toContain('/tmp/ws-a')
    expect(stateBlock).toContain('https://example.test/a')
    expect(stateBlock).toContain('Objective: "ship the cache work"')
    expect(stateBlock).toContain('2026-09-15')
  })

  it('ends with the clock, so a tool loop reuses everything above it', async () => {
    // Within one turn the block is re-sent on every iteration; the cache can only
    // reuse it up to the first differing byte, so the always-changing clock has to
    // be the last thing in it.
    const { stateBlock } = await buildSystemPrompt({
      opts: opts({
        workspaceDir: '/tmp/ws-a',
        memoryManager: memoryStub('# Memory Context\n- stable-ish'),
        pageContext: { url: 'https://example.test/a', title: 'Example Page' },
        experienceManager: experienceStub([{ name: 'perf-tuning', description: 'tuning notes' }]),
      }),
      messages: [userMsg('tune the perf of this')],
      plan: plan('auto', false),
    })

    const block = stateBlock as string
    const clockAt = block.indexOf('## Current Date')
    expect(clockAt).toBeGreaterThan(-1)
    for (const section of ['## Workspace', '## Current Plan', '## Current Page', 'https://example.test/a']) {
      expect(block.indexOf(section)).toBeGreaterThan(-1)
      expect(block.indexOf(section)).toBeLessThan(clockAt)
    }
    // Nothing but the closing tag may follow the clock.
    expect(block.slice(clockAt)).toMatch(/^## Current Date[\s\S]*<\/session-state>$/)
  })

  it('carries the per-turn capability hints without touching the user message; 经验 hint 已退役（M4）', async () => {
    const hint = () => opts({ experienceManager: experienceStub([{ name: 'perf-tuning', description: 'tuning notes' }]) })
    const msgs = [userMsg('tune the perf of this')]
    const { stateBlock, systemPrompt } = await buildSystemPrompt({ opts: hint(), messages: msgs, plan: null })

    // 经验=记忆页：trigger hint 不再注入（经验检索走 memory_search 的静态协议节）
    expect(stateBlock).not.toContain('<experience>')
    expect(stateBlock).not.toContain('Possible experiences')
    expect(systemPrompt).not.toContain('perf-tuning')
    // The hint used to be appended to the last user message in the API copy, which
    // mutated history and vanished once a tool result added a text-less user
    // message. It now rides the state block, so the message itself stays pristine.
    expect((msgs[0].contentBlocks[0] as { text: string }).text).toBe('tune the perf of this')
  })

  it('is omitted entirely for spawned sub-agents, which bring their own prompt', async () => {
    const { systemPrompt, stateBlock } = await buildSystemPrompt({
      opts: opts({ workspaceDir: '/tmp/ws-a', memoryManager: memoryStub('- SECRET_FACT') }),
      spawnSystemPrompt: 'You are a focused worker.',
      spawnSystemPromptAppendix: 'Skills: none.',
      messages: [userMsg('sub-task')],
      plan: plan('auto', false),
    })

    expect(stateBlock).toBeNull()
    expect(systemPrompt).toBe('You are a focused worker.\n\nSkills: none.')
  })
})

// ── K9: the knowledge-count line (PLAN-knowledge-groups R3) ───────────
//
// The knowledge section's acceptance had no test: the section lived in
// buildStateBlock with nothing pinning WHERE it lives. The cache contract makes
// that load-bearing — the count line moves per turn-cycle but rarely per turn,
// so it rides the state block (re-sent, unpersisted); if it ever migrates into
// the frozen core, EVERY conversation's prefix is re-billed and, worse, stale
// counts are baked into the cached identity.

const knowledgeStatsStub = (stats: { total: number; compiled: number; wikiFileCount: number } | null) =>
  ({ getStats: async () => stats }) as unknown as AgentEngineOptions['knowledgeManager']

describe('knowledge count line (K9, state block only)', () => {
  it('rides the state block when the base is non-empty, before the clock', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-15T06:00:00.000Z'))
    const { stateBlock } = await buildSystemPrompt({
      opts: opts({ knowledgeManager: knowledgeStatsStub({ total: 3, compiled: 2, wikiFileCount: 13 }) }),
      messages: [userMsg('hello')],
      plan: plan('auto', false),
    })

    const block = stateBlock as string
    expect(block).toContain('知识库：3 个源（2 已编译），wiki 13 页')
    expect(block).toContain('## Knowledge Base')  // state block 的统计节（标题未随 core 协议节更名）
    // Cache reuse inside a tool loop runs up to the first differing byte, so the
    // always-changing clock must stay AFTER the (rarely-moving) knowledge line.
    expect(block.indexOf('## Knowledge Base')).toBeLessThan(block.indexOf('## Current Date'))
  })

  it('never leaks into the invariant core (moving it there must fail this test)', async () => {
    const { systemPrompt, stateBlock } = await buildSystemPrompt({
      opts: opts({ knowledgeManager: knowledgeStatsStub({ total: 3, compiled: 2, wikiFileCount: 13 }) }),
      messages: [userMsg('hello')],
      plan: plan('auto', false),
    })

    expect(systemPrompt).not.toContain('知识库：')
    // The core DOES carry the static hint (a different '## Knowledge Base'
    // heading, present since before K9) — only the count line is forbidden.
    expect(systemPrompt).toContain('## Local Knowledge & Memory')
    expect(stateBlock).toContain('知识库：')
  })

  it('is omitted entirely when the base is empty', async () => {
    const { stateBlock } = await buildSystemPrompt({
      opts: opts({ knowledgeManager: knowledgeStatsStub({ total: 0, compiled: 0, wikiFileCount: 0 }) }),
      messages: [userMsg('hello')],
      plan: plan('auto', false),
    })

    expect(stateBlock).not.toContain('知识库：')
    expect(stateBlock).not.toContain('## Local Knowledge & Memory')  // core 协议节名不得泄漏进 state block
  })
})

describe('scoped knowledge count line (G6)', () => {
  it('an @知识库 turn counts (and names) only its scope', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-15T06:00:00.000Z'))
    const scopedStub = {
      getStats: async (baseId?: string | null) =>
        baseId === 'kb_x'
          ? { total: 2, compiled: 2, wikiFileCount: 3 }
          : { total: 9, compiled: 5, wikiFileCount: 13 },
    } as unknown as AgentEngineOptions['knowledgeManager']
    const { stateBlock } = await buildSystemPrompt({
      opts: opts({ knowledgeBaseScope: { id: 'kb_x', name: '项目X' }, knowledgeManager: scopedStub }),
      messages: [userMsg('hello')],
      plan: plan('auto', false),
    })

    const block = stateBlock as string
    expect(block).toContain('知识库：@项目X · 2 个源（2 已编译），wiki 3 页')
    expect(block).not.toContain('9 个源')
  })

  it('an unscoped turn keeps the plain count line (no @)', async () => {
    const { stateBlock } = await buildSystemPrompt({
      opts: opts({ knowledgeManager: knowledgeStatsStub({ total: 3, compiled: 2, wikiFileCount: 13 }) }),
      messages: [userMsg('hello')],
      plan: plan('auto', false),
    })
    expect(stateBlock).toContain('知识库：3 个源')
    expect(stateBlock).not.toContain('@')
  })
})
