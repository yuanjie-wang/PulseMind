import { describe, expect, it, beforeEach } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { AgentEngine } from '../src/renderer/src/agent/AgentEngine'
import { ToolManager } from '../src/renderer/src/tools/ToolManager'
import { SkillManager } from '../src/renderer/src/skills/SkillManager'
import type { ToolManager as ToolManagerType } from '../src/renderer/src/tools/ToolManager'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

/**
 * PLAN-parallel-experts T12（P5 后半）：已停/已暂停的循环不得被迟到的工具结果复活。
 *
 * 复活链：`addToolResult` 在 pendingToolIds 清空时回调 `continueLoop`，而
 * `continueLoop` 原本没有 isCancelled 守卫——停止之后一条迟到的 MCP/shell 结果
 * 就能重新发起 LLM 请求（本测试里落到空 apiKey 分支变成 error，可直接观测）。
 * 守卫 = continueLoop 入口的 isCancelled 检查；resumeExecution / retryLastTurn
 * 这类显式恢复本来就会先把它置回 false，不会被误挡。
 */

const tick = () => new Promise((r) => setTimeout(r, 10))

function makeMockHost(): PulseHost {
  const noop = () => Promise.resolve([] as unknown[])
  return {
    onApiStreamChunk: () => () => {},
    onApiStreamError: () => () => {},
    onApiStreamDone: () => () => {},
    onApiStreamRetry: () => () => {},
    onTerminalOutput: () => () => {},
    onTerminalExit: () => () => {},
    onTerminalError: () => () => {},
    onMcpServersChanged: () => () => {},
    onSkillsChanged: () => () => {},
    mcpListServers: noop,
    expertList: noop,
    getSkillPreferences: () => Promise.resolve({}),
    getSettings: () => Promise.resolve({ locale: 'zh' }),
  } as unknown as PulseHost
}

function makeEngine(conversationId: string): AgentEngine {
  return new AgentEngine({
    apiKey: '', // 复活的观测点：没有守卫时 continueLoop 落在 no-key 分支 → status error
    baseURL: 'https://example.invalid',
    model: 'test-model',
    maxTokens: 512,
    myName: '',
    soul: '',
    yourName: '',
    adapter: {} as never,
    toolManager: new ToolManager() as ToolManagerType,
    skillManager: new SkillManager(),
    conversationId,
  })
}

function plantPendingTool(engine: AgentEngine, id: string): void {
  const block = { type: 'tool_use', id, name: 'webfetch', input: { url: 'https://example.invalid' }, status: 'running' } as unknown as ToolUseBlock
  engine.messages = [...engine.messages, {
    id: `m_${id}`,
    role: 'assistant',
    contentBlocks: [block],
    createdAt: new Date().toISOString(),
  }]
  engine.pendingToolIds = new Set([id])
}

beforeEach(() => {
  setHost(makeMockHost())
})

describe('cancelled engines are not revived by late tool results (T12)', () => {
  it('after stopExecution a late result is recorded but the engine stays idle', async () => {
    const engine = makeEngine('conv_revival_stop')
    plantPendingTool(engine, 't1')

    engine.stopExecution()
    expect(engine.agentStatus.status).toBe('idle')

    engine.addToolResult('t1', 'late MCP output', false)
    await tick()

    // 迟到的结果本身仍要记录（addToolResult 侧不动）……
    const results = engine.messages.flatMap(m => m.contentBlocks)
      .filter(b => b.type === 'tool_result' && (b as { tool_use_id?: string }).tool_use_id === 't1')
    expect(results).toHaveLength(1)
    // ……但循环不复活：状态仍是 idle，且没有新的 assistant 轮次。
    expect(engine.agentStatus.status).toBe('idle')
    expect(engine.messages[engine.messages.length - 1].role).toBe('user')
  })

  it('after pauseExecution a late result does not revive; resumeExecution does continue', async () => {
    const engine = makeEngine('conv_revival_pause')
    plantPendingTool(engine, 't1')

    engine.pauseExecution()
    engine.addToolResult('t1', 'late MCP output', false)
    await tick()
    expect(engine.agentStatus.status).toBe('idle') // 暂停中不复活

    engine.resumeExecution()
    await tick()
    // 显式恢复把 isCancelled 置回 false，循环照常走——空 apiKey 分支是它
    // 「确实在跑」的可观测形态。
    expect(engine.agentStatus).toEqual({ status: 'error', error: 'API key not configured' })
  })
})
