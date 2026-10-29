/**
 * 已完成子代理的续聊原语（2026-10-28）：spawn 完成不再等于丢弃——引擎保留进
 * 父会话的 LRU 注册表，spawn_agent { agentId } 唤醒同一个引擎带全部上下文继续。
 * 与既有机制的三条边界在这里钉死：
 *  - 再派发门只拦「重派已完成的活」，不拦对同一代理的追问（agentId 在门之前路由）；
 *  - 注册表未命中（LRU 淘汰/重启）回落「全新派发」的恢复话术，且明确不是门；
 *  - follow-up 的完成走自己的信封，末尾再教一次续聊通道（链可继续）。
 *
 * 续聊的子侧用真 AgentEngine 驱动（followUpRun 是真循环重启）；父侧注册表
 * 经真 SpawnManager（retainCompleted 的 LRU 白盒访问走 cast，与其它套件
 * 访问私有管理器的先例一致）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-followup-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')
const { execSpawnAgent, spawnTaskSignature } = await import(
  '../src/renderer/src/agent/executors/spawn-tool'
)
const { SUB_AGENT_FOLLOWUP_KEEP } = await import('../src/renderer/src/agent/engine/spawn-manager')
const { setHost } = await import('../src/renderer/src/agent/host')
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

const noop = () => Promise.resolve([] as unknown[])

function makeMockHost(): PulseHost {
  return {
    onApiStreamChunk: noop, onApiStreamError: noop, onApiStreamDone: noop, onApiStreamRetry: noop,
    onTerminalOutput: noop, onTerminalExit: noop, onTerminalError: noop,
    onMcpServersChanged: noop, onSkillsChanged: noop,
    mcpListServers: noop, expertList: noop, getSkillPreferences: noop,
    getSettings: () => Promise.resolve({ locale: 'zh' }),
    // '' NOT []: readProjectInstructionsBody reads `.trim()` off this — an
    // array would TypeError the whole spawn path (parallel-spawn's harness
    // never hits it: its engines carry no workspaceDir).
    readFile: () => Promise.resolve(''),
    ...Object.fromEntries([
      'apiAbortStream', 'apiFetch', 'apiFetchStream', 'execCommandSync', 'executeCommand',
      'killCommand', 'writeFile', 'editFile', 'patchFile', 'getFileStat',
      'convertFileToMarkdown', 'gitInvoke', 'mcpCallTool',
      'setSkillPreferences', 'readSkillRaw', 'installSkill', 'saveMemory',
      'searchConversationsByKeyword', 'getToolResult', 'getConversation',
      'saveConversation', 'appendConversationMessages', 'persistToolResults',
      'getConversationPlan', 'saveConversationPlan',
    ].map(k => [k, noop])),
  } as unknown as PulseHost
}

function makeEngine(conversationId: string): AgentEngine {
  return new AgentEngine({
    apiKey: '',
    baseURL: 'https://example.invalid',
    model: 'test-model',
    maxTokens: 512,
    myName: '', soul: '', yourName: '',
    adapter: {} as never,
    toolManager: new ToolManager(),
    skillManager: new SkillManager(),
    conversationId,
  })
}

// ── 子侧：followUpRun + 注册表生命周期（真引擎） ─────────────────────────────

describe('SpawnManager follow-up lifecycle (real engines)', () => {
  it('a follow-up appends the question to the SAME engine and restarts its loop', () => {
    setHost(makeMockHost())
    const parent = makeEngine('conv_fu_parent')
    const child = makeEngine('sub_conv_child')
    const before = child.messages.length
    parent.completedSubAgents.set('sub_conv_child', { engine: child, title: 'Scout' })

    const handle = parent.followUpSubAgent('sub_conv_child', 'Follow up: what did you find about auth?')

    expect(handle).not.toBeNull()
    expect(handle!.subConvId).toBe('sub_conv_child')
    expect(child.messages.length).toBe(before + 1)
    const last = child.messages[child.messages.length - 1]
    expect(last.role).toBe('user')
    expect(last.contentBlocks[0]).toMatchObject({ type: 'text', text: 'Follow up: what did you find about auth?' })
    expect(child.isCancelled).toBe(false)
    // The child is re-bound to the parent's cancel surface while it runs.
    expect([...parent.activeSubAgents.values()]).toContain(child)
  })

  it('settling a follow-up re-retains the engine and cleans activeSubAgents', async () => {
    setHost(makeMockHost())
    const parent = makeEngine('conv_fu_settle')
    const child = makeEngine('sub_conv_settle')
    parent.completedSubAgents.set('sub_conv_settle', { engine: child, title: 'Scout' })
    const handle = parent.followUpSubAgent('sub_conv_settle', 'one more question')
    expect(handle).not.toBeNull()

    child.resolveCompletionIfSpawned('completed')
    await handle!.waitForCompletion()

    // Re-retained for the NEXT follow-up; activeSubAgents cleaned.
    expect(parent.completedSubAgents.get('sub_conv_settle')?.engine).toBe(child)
    expect([...parent.activeSubAgents.values()]).not.toContain(child)
  })

  it('the registry is an LRU capped at SUB_AGENT_FOLLOWUP_KEEP', () => {
    setHost(makeMockHost())
    const parent = makeEngine('conv_fu_lru')
    const mgr = (parent as unknown as { spawnManager: { retainCompleted: (id: string, e: AgentEngine, t?: string) => void } }).spawnManager
    const engines = Array.from({ length: SUB_AGENT_FOLLOWUP_KEEP + 1 }, (_, i) => makeEngine(`sub_lru_${i}`))
    engines.forEach((e, i) => mgr.retainCompleted(`sub_lru_${i}`, e))
    expect(parent.completedSubAgents.size).toBe(SUB_AGENT_FOLLOWUP_KEEP)
    expect(parent.completedSubAgents.has('sub_lru_0')).toBe(false) // oldest evicted
    expect(parent.completedSubAgents.has(`sub_lru_${SUB_AGENT_FOLLOWUP_KEEP}`)).toBe(true)
    // Re-retaining the same id must not grow the registry.
    mgr.retainCompleted('sub_lru_1', engines[1])
    expect(parent.completedSubAgents.size).toBe(SUB_AGENT_FOLLOWUP_KEEP)
  })

  it('an in-flight engine stays addressable — the defense check precedes the registry delete (review_20261028 中3)', () => {
    setHost(makeMockHost())
    const parent = makeEngine('conv_fu_inflight')
    const child = makeEngine('sub_conv_inflight')
    parent.completedSubAgents.set('sub_conv_inflight', { engine: child, title: 'Scout' })
    // The race: a settled engine that still carries a live request. Under the
    // old delete-before-check order this call returned null AND evicted the
    // engine — the follow-up context was gone for good.
    child.pendingToolIds.add('toolu_still_draining')
    expect(parent.followUpSubAgent('sub_conv_inflight', 'too early')).toBeNull()
    expect(parent.completedSubAgents.get('sub_conv_inflight')?.engine).toBe(child)
    // In-flight over: the SAME registry entry answers the next call.
    child.pendingToolIds.clear()
    const handle = parent.followUpSubAgent('sub_conv_inflight', 'now')
    expect(handle).not.toBeNull()
    expect(handle!.subConvId).toBe('sub_conv_inflight')
    expect([...parent.activeSubAgents.values()]).toContain(child)
  })
})

// ── 父侧：execSpawnAgent 的 agentId 路由（假上下文，redispatch-gate 风格） ──

type ToolExecContext = Parameters<typeof execSpawnAgent>[0]

interface FuHarness {
  ex: ToolExecContext
  state: { captured: { content: string; isError: boolean } | null }
  followUp: { asked: Array<{ id: string; task: string }> }
}

function makeContext(opts: {
  results?: Map<string, 'completed' | 'failed' | 'aborted'>
  handle?: Parameters<NonNullable<ToolExecContext['followUpSubAgent']>>[0] extends never ? never : {
    subConvId: string
    status: 'completed' | 'error' | 'aborted'
    text?: string
    error?: string
  } | null
} = {}): FuHarness {
  const state: { captured: { content: string; isError: boolean } | null } = { captured: null }
  const followUp: { asked: Array<{ id: string; task: string }> } = { asked: [] }
  const ex = {
    opts: { spawnedToolset: false, workspaceDir: '/ws', maxTokens: 1000, earlyStopGuard: false },
    notify: () => {},
    addToolResult: (_id: string, content: string, isError: boolean) => { state.captured = { content, isError } },
    spawnTaskResults: opts.results ?? new Map(),
    followUpSubAgent: opts.handle === undefined ? undefined : (id: string, task: string) => {
      followUp.asked.push({ id, task })
      if (!opts.handle) return null
      return {
        id: 'h1',
        subConvId: id,
        waitForCompletion: async () => ({
          messages: [{
            id: 'm1', role: 'assistant', createdAt: new Date().toISOString(),
            contentBlocks: [{ type: 'text', text: opts.handle!.text ?? 'follow-up answer' }],
          }],
          status: opts.handle!.status,
          outputTokens: 5,
          error: opts.handle!.error,
        }),
      }
    },
  } as unknown as ToolExecContext
  return { ex, state, followUp }
}

const block = (input: Record<string, unknown>): ToolUseBlock =>
  ({ type: 'tool_use', id: 't_fu', name: 'spawn_agent', input, status: 'queued' }) as ToolUseBlock

describe('execSpawnAgent follow-up routing', () => {
  it('an agentId follow-up bypasses the re-dispatch gate even for a completed signature', async () => {
    setHost(makeMockHost())
    const results = new Map([[spawnTaskSignature('同一份任务'), 'completed' as const]])
    const h = makeContext({ results, handle: { subConvId: 'sub_warm', status: 'completed' } })
    await execSpawnAgent(h.ex, block({ task: '同一份任务', agentId: 'sub_warm' }))
    // NOT the redispatch rejection — the follow-up channel answered.
    expect(h.state.captured?.content).toContain('Sub-Agent Result (follow-up, completed)')
    expect(h.state.captured?.content).not.toContain('already delegated and COMPLETED')
    expect(h.followUp.asked).toEqual([{ id: 'sub_warm', task: '同一份任务' }])
  })

  it('a completed follow-up settles exit 0, records its ledger, and re-teaches the channel', async () => {
    setHost(makeMockHost())
    const h = makeContext({ handle: { subConvId: 'sub_warm', status: 'completed' } })
    const t = block({ task: '追问', agentId: 'sub_warm' })
    await execSpawnAgent(h.ex, t)
    expect(t.exitCode).toBe(0)
    expect(t.subConvId).toBe('sub_warm')
    expect(h.state.captured?.content).toContain('agentId: "sub_warm"')
    expect(h.ex.spawnTaskResults?.get(spawnTaskSignature('追问'))).toBe('completed')
  })

  it('an unknown agentId falls back to the fresh-spawn escape, explicitly NOT the gate', async () => {
    setHost(makeMockHost())
    const h = makeContext({ handle: null }) // registry miss
    const t = block({ task: '追问', agentId: 'sub_gone' })
    await execSpawnAgent(h.ex, t)
    expect(t.exitCode).toBe(-1)
    expect(h.state.captured?.content).toContain('no longer warm')
    expect(h.state.captured?.content).toContain('not the re-dispatch gate')
  })

  it('a failed follow-up settles as a failure but keeps the agent addressable', async () => {
    setHost(makeMockHost())
    const h = makeContext({ handle: { subConvId: 'sub_warm', status: 'error', error: 'boom' } })
    const t = block({ task: '追问', agentId: 'sub_warm' })
    await execSpawnAgent(h.ex, t)
    expect(t.exitCode).toBe(1)
    expect(h.state.captured?.isError).toBe(true)
    expect(h.state.captured?.content).toContain('stays warm')
  })

  it('conflicts with dispatch-time injections are rejected synchronously', async () => {
    setHost(makeMockHost())
    for (const [input, fragment] of [
      [{ task: 'x', agentId: 'sub_a', subAgentId: 'expert_1' }, 'subAgentId'],
      [{ task: 'x', agentId: 'sub_a', preset: 'explore' }, 'preset'],
      [{ task: 'x', agentId: 'sub_a', planNode: '1' }, 'planNode'],
    ] as const) {
      const h = makeContext()
      await execSpawnAgent(h.ex, block({ ...input }))
      expect(h.state.captured?.content, JSON.stringify(input)).toContain('cannot be combined')
      expect(h.state.captured?.content, JSON.stringify(input)).toContain(fragment)
    }
  })

  it('a NORMAL completed spawn envelope teaches the follow-up channel with its agentId', async () => {
    setHost(makeMockHost())
    const h = makeContext()
    ;(h.ex as { spawnSubAgent?: unknown }).spawnSubAgent = () => ({
      id: 'h2',
      subConvId: 'sub_conv_fresh',
      waitForCompletion: async () => ({
        messages: [{ id: 'm1', role: 'assistant', createdAt: new Date().toISOString(), contentBlocks: [{ type: 'text', text: 'done' }] }],
        status: 'completed',
        outputTokens: 3,
      }),
    })
    await execSpawnAgent(h.ex, block({ task: '探索任务' }))
    expect(h.state.captured?.content).toContain('Follow-up channel')
    expect(h.state.captured?.content).toContain('agentId: "sub_conv_fresh"')
  })
})
