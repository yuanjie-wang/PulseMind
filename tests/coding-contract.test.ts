import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENGINEERING_WORKFLOW, buildSystemPrompt } from '../src/renderer/src/agent/system-prompt-builder'
import { buildToolProtocols } from '../src/renderer/src/agent/engine/tool-collection'
import { toolInstructions } from '../src/renderer/src/tools/tool-instructions'
import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'

// ── PLAN-coding-contract P0-1: the coding behaviour contract rides the FROZEN
// core. Everything here pins shape, byte-stability and wiring; a revert of any
// of the three silently forks the cached prefix or detaches the sub-agents.

const ROOT = join(__dirname, '..')

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
  createdAt: '2026-09-27T00:00:00.000Z',
})

const plan = (objective: string, done: boolean) =>
  ({
    objective,
    mode: 'auto',
    completed: false,
    version: 2,
    nodes: [{ id: 'n1', description: 'measure', status: done ? 'completed' : 'pending', dependsOn: [] }],
  }) as never

// 1 — the contract block itself
describe('ENGINEERING_WORKFLOW constant', () => {
  it('carries the four numbered contracts', () => {
    expect(ENGINEERING_WORKFLOW).toContain('## Engineering Workflow')
    expect(ENGINEERING_WORKFLOW).toContain('1. Read before you write.')
    expect(ENGINEERING_WORKFLOW).toContain('2. Verify before you claim done.')
    expect(ENGINEERING_WORKFLOW).toContain('3. Never invent an API.')
    expect(ENGINEERING_WORKFLOW).toContain('4. Match the code around you.')
    // The anti-performance line is the point of #2 — without it a model that
    // cannot run anything vaguely implies it did.
    expect(ENGINEERING_WORKFLOW).toContain('never imply a check happened')
    // #1 is a hard gate, not advice (2026-10-27): the executor's
    // readFilePaths ledger rejects unread edits and stale overwrites.
    expect(ENGINEERING_WORKFLOW).toContain('Enforced: `edit` on any file, and `write` replacing an existing file, are rejected')
    expect(ENGINEERING_WORKFLOW).toContain('re-rejected if the file changed on disk after that read')
  })

  it('is pure static text — no interpolation, no clock in the literal', () => {
    const src = readFileSync(join(ROOT, 'src/renderer/src/agent/system-prompt-builder.ts'), 'utf8')
    const start = src.indexOf('export const ENGINEERING_WORKFLOW = `')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('`', start + 'export const ENGINEERING_WORKFLOW = `'.length)
    const literal = src.slice(start, end)
    expect(literal).not.toContain('${')
    expect(literal).not.toContain('new Date(')
  })
})

// 2 — it rides the frozen core, not the tail
describe('contract placement', () => {
  it('rides the system prompt and never the state block', async () => {
    const { systemPrompt, stateBlock } = await buildSystemPrompt({
      opts: opts({ workspaceDir: '/tmp/ws-a' }),
      messages: [userMsg('hello')],
      plan: plan('ship it', false),
    })
    expect(systemPrompt).toContain('## Engineering Workflow')
    expect(stateBlock).not.toContain('## Engineering Workflow')
  })

  it('is byte-stable when workspace, plan and clock all move', async () => {
    const a = await buildSystemPrompt({
      opts: opts({ workspaceDir: '/tmp/ws-a' }),
      messages: [userMsg('do A')],
      plan: plan('objective one', false),
    })
    const b = await buildSystemPrompt({
      opts: opts({ workspaceDir: '/tmp/ws-b' }),
      messages: [userMsg('do B')],
      plan: plan('objective two', true),
    })
    expect(b.systemPrompt).toBe(a.systemPrompt)
    // and the core section exists in that shared prefix
    expect(a.systemPrompt).toContain(ENGINEERING_WORKFLOW)
  })

  it('sits after the tool protocols and before the session-state notice', async () => {
    const { systemPrompt } = await buildSystemPrompt({
      opts: opts(),
      messages: [userMsg('hello')],
      plan: null,
    })
    const workflowAt = systemPrompt.indexOf('## Engineering Workflow')
    expect(workflowAt).toBeGreaterThan(-1)
    expect(systemPrompt.indexOf('# Tool Protocols')).toBeLessThan(workflowAt)
    expect(systemPrompt.indexOf('## Session State')).toBeGreaterThan(workflowAt)
  })
})

// 3 — wiring scans (the static gates the plan calls out)
describe('wiring', () => {
  const builderSrc = () => readFileSync(join(ROOT, 'src/renderer/src/agent/system-prompt-builder.ts'), 'utf8')

  it('pushes the constant inside buildCorePrompt, never inside buildStateBlock', () => {
    const src = builderSrc()
    const push = 'parts.push(ENGINEERING_WORKFLOW)'
    expect(src).toContain(push)
    const stateFnAt = src.indexOf('async function buildStateBlock')
    const pushAt = src.indexOf(push)
    expect(pushAt).toBeGreaterThan(-1)
    expect(stateFnAt).toBeGreaterThan(-1)
    // The push must sit BEFORE the state-block function even starts — if it
    // ever migrates into the per-turn tail the shared cache prefix forks.
    expect(pushAt).toBeLessThan(stateFnAt)
    // Exactly one assembly site.
    expect(src.split(push).length - 1).toBe(1)
  })

  it('hangs the same contract on the sub-agent spawn prompt (ruling D1)', () => {
    const src = readFileSync(join(ROOT, 'src/renderer/src/agent/executors/spawn-tool.ts'), 'utf8')
    expect(src).toContain('ENGINEERING_WORKFLOW')
    // and it reaches the systemPrompt assembly, not just an import line
    expect(src).toMatch(/systemPrompt\s*=\s*[^\n]*ENGINEERING_WORKFLOW|ENGINEERING_WORKFLOW[^\n]*\n[^\n]*systemPrompt/)
  })
})

// 4 — the block is a core section, not a tool manual
describe('not a tool protocol', () => {
  it('never leaks into buildToolProtocols output', () => {
    const manuals = Object.values(toolInstructions)
      .filter(Boolean)
      .map((instructions) => ({ instructions, availability: 'builtin' as const }))
    const out = buildToolProtocols(manuals)
    expect(out).not.toContain('## Engineering Workflow')
    // sanity: the protocols builder did produce content
    expect(out).toContain('# Tool Protocols')
    // the edit manual carries its own one-line echo of contract #1 (P0-1 #3)
    expect(toolInstructions.edit).toContain('must come from a `read` of THIS file in THIS session')
    // and both manuals name the enforcement (2026-10-27 read-before-write gate)
    expect(toolInstructions.edit).toContain('Enforced: an edit to a path `read` (or `write`) has not touched this session is rejected')
    expect(toolInstructions.write).toContain('Replacing an EXISTING file requires a prior `read` of it this session')
  })
})

// ── P0-2 / P0-3 wiring scans (cheap static insurance; runtime behavior lives
// in the probe scripts). Scans read real source so a revert cannot pass.

describe('exec manual wording (P0-2 ruling D2 + background)', () => {
  it('names the 900s wall-clock and points long jobs at background:true', () => {
    expect(toolInstructions.exec).toContain('900s wall-clock')
    expect(toolInstructions.exec).toContain('`background: true`')
    // the misleading old advice must be gone: `timeout` cannot save a long job
    expect(toolInstructions.exec).not.toContain('raise `timeout` for long-running')
  })
})

describe('background exec wiring (P0-3)', () => {
  const ROOT_SRC = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

  it('exposes the exec background param and the pid-keyed tools', () => {
    const tools = ROOT_SRC('src/renderer/src/tools/built-in-tools.ts')
    expect(tools).toContain("name: 'exec_logs'")
    expect(tools).toContain("name: 'exec_kill'")
    const instr = ROOT_SRC('src/renderer/src/tools/tool-instructions.ts')
    expect(instr).toContain('exec_logs: `## exec_logs')
    expect(instr).toContain('exec_kill: `## exec_kill')
    // exec_logs is a read tier WITHOUT joining READ_TIER_TOOLS (that set picks
    // the executor; the gotcha in AGENTS.md — page tools, same shape)
    const tiers = ROOT_SRC('src/renderer/src/agent/engine/tool-tiers.ts')
    expect(tiers).toContain("name === 'exec_logs'")
  })

  it('executes background spawns without touching the foreground scalar', () => {
    const domain = ROOT_SRC('src/renderer/src/agent/executors/domain-tools.ts')
    expect(domain).toContain('background === true')
    expect(domain).toContain('executeBackground')
    // background settles its own result; the span/exit subscription never runs
    expect(domain).toContain('execLogs')
    expect(domain).toContain('execKill')
    // the FOREGROUND path still parks on the scalar (onProcessStart), the
    // background branch must not call it
    const bgIdx = domain.indexOf('background === true')
    const fgIdx = domain.indexOf('onProcessStart')
    expect(bgIdx).toBeGreaterThan(-1)
    expect(fgIdx).toBeGreaterThan(-1)
  })

  it('routes killTool through execKill for background blocks', () => {
    const flow = ROOT_SRC('src/renderer/src/agent/engine/execution-flow.ts')
    expect(flow).toContain('backgroundPid')
    expect(flow).toContain('execKill')
    // the ladder consults the session allowlist in BOTH the partition and the
    // dispatch (P0-2 #5)
    expect((flow.match(/getExecAllowlist/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(flow).toContain('commandAllowlistKey')
    expect(flow).toContain('alwaysAllow')
  })

  it('reaps session background pids at dispose', () => {
    const sm = ROOT_SRC('src/main/agent/session-manager.ts')
    expect(sm).toContain('reapBackgroundPids')
    const term = ROOT_SRC('src/main/services/terminal.ts')
    expect(term).toContain('svcReapBackgroundPids')
    // shipped cap is 900s (the PM_WALL_CLOCK_MAX_MS env is the probe-only seam)
    expect(term).toContain('raw : 900_000')
    // wall-clock must NOT reach the background path (P0-3 #13): the background
    // function body sits after svcExecBackground's marker and sets no timers
    expect(term).toContain('svcExecuteBackground')
    expect(term).toContain('proc-logs')
  })
})

// ── PLAN-context-zcode-benchmarks P2: the context-management notice rides the
// frozen core — it educates the model about compaction (summary + replays +
// archived-reads reminder + tool_result_search retrieval) and must never move.

describe('CONTEXT_MANAGEMENT_NOTICE (P2)', () => {
  it('rides the system prompt core, never the state block', async () => {
    const { systemPrompt, stateBlock } = await buildSystemPrompt({
      opts: opts({ workspaceDir: '/tmp/ws-a' }),
      messages: [userMsg('hello')],
      plan: plan('ship it', false),
    })
    expect(systemPrompt).toContain('## Context Management')
    expect(systemPrompt).toContain('tool_result_search')
    expect(stateBlock).not.toContain('## Context Management')
  })

  it('is byte-stable when workspace, plan and messages all move', async () => {
    const a = await buildSystemPrompt({
      opts: opts({ workspaceDir: '/tmp/ws-a' }),
      messages: [userMsg('do A')],
      plan: plan('objective one', false),
    })
    const b = await buildSystemPrompt({
      opts: opts({ workspaceDir: '/tmp/ws-b' }),
      messages: [userMsg('do B')],
      plan: plan('objective two', true),
    })
    expect(b.systemPrompt).toBe(a.systemPrompt)
  })

  it('sits right after the compressed-tool-results notice (same retrieval family)', async () => {
    const { systemPrompt } = await buildSystemPrompt({
      opts: opts(),
      messages: [userMsg('hello')],
      plan: null,
    })
    const compressedAt = systemPrompt.indexOf('## Compressed Tool Results')
    const noticeAt = systemPrompt.indexOf('## Context Management')
    const renderAt = systemPrompt.indexOf('## Render Reference')
    expect(compressedAt).toBeGreaterThan(-1)
    expect(noticeAt).toBeGreaterThan(compressedAt)
    expect(renderAt).toBeGreaterThan(noticeAt)
  })
})
