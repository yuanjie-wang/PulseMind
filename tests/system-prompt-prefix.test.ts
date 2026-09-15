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
  ({ buildMemoryContext: async () => context }) as unknown as AgentEngineOptions['memoryManager']

const experienceStub = (matched: { name: string; description: string }[]) =>
  ({
    buildNameIndex: async () => null,
    matchByTriggers: async () => matched,
  }) as unknown as NonNullable<AgentEngineOptions['experienceManager']>

/** Minimal Plan shape — only the fields buildPlanSection reads. */
const plan = (mode: string, stepDone: boolean) =>
  ({
    objective: 'ship the cache work',
    mode,
    completed: false,
    steps: [
      { description: 'measure', status: 'completed' },
      { description: 'refactor', status: stepDone ? 'completed' : 'pending' },
    ],
  }) as never

afterEach(() => vi.useRealTimers())

// ── The invariant core ────────────────────────────────────────────────

describe('invariant core', () => {
  it('is byte-identical when the clock, plan, page, workspace and memory all move', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-15T06:00:00.000Z'))
    const first = await buildSystemPrompt({
      opts: opts({ workspaceDir: '/tmp/ws-a', memoryManager: memoryStub('# Memory Context\n- old fact') }),
      messages: [userMsg('hello')],
      plan: plan('auto', false),
    })

    vi.setSystemTime(new Date('2026-09-15T09:31:00.000Z'))
    const second = await buildSystemPrompt({
      opts: opts({
        workspaceDir: '/tmp/ws-b',
        memoryManager: memoryStub('# Memory Context\n- a fact saved mid-session'),
        pageContext: { url: 'https://example.test/a', title: 'Example' },
      }),
      messages: [userMsg('hello')],
      plan: plan('delegated', true),
    })

    // The whole point: nothing above may differ, or the tools + history behind
    // this prompt are re-billed on every turn.
    expect(second.systemPrompt).toBe(first.systemPrompt)
  })

  it('carries no clock, no workspace and no memory', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-15T06:00:00.000Z'))
    const { systemPrompt } = await buildSystemPrompt({
      opts: opts({ workspaceDir: '/tmp/ws-a', memoryManager: memoryStub('# Memory Context\n- SECRET_FACT') }),
      messages: [userMsg('hello')],
      plan: null,
    })

    expect(systemPrompt).not.toMatch(/\d{4}-\d{2}-\d{2}/) // no date anywhere
    expect(systemPrompt).not.toContain('/tmp/ws-a')
    expect(systemPrompt).not.toContain('SECRET_FACT')
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
      expect(systemPrompt).toContain('## Knowledge Base')
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
    expect(stateBlock).toContain('SECRET_FACT')
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
    for (const section of ['# Memory Context', '## Workspace', '## Current Plan', '## Current Page', 'https://example.test/a']) {
      expect(block.indexOf(section)).toBeGreaterThan(-1)
      expect(block.indexOf(section)).toBeLessThan(clockAt)
    }
    // Nothing but the closing tag may follow the clock.
    expect(block.slice(clockAt)).toMatch(/^## Current Date[\s\S]*<\/session-state>$/)
  })

  it('carries the per-turn capability hints without touching the user message', async () => {
    const hint = () => opts({ experienceManager: experienceStub([{ name: 'perf-tuning', description: 'tuning notes' }]) })
    const msgs = [userMsg('tune the perf of this')]
    const { stateBlock, systemPrompt } = await buildSystemPrompt({ opts: hint(), messages: msgs, plan: null })

    expect(stateBlock).toContain('<experience><name>perf-tuning</name>')
    expect(stateBlock).toContain('Possible experiences')
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
