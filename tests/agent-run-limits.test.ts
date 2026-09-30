import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// AgentEngine's import chain touches real stores (MEMORY.md on first touch),
// so point HOME at a temp dir BEFORE importing — never the user's live
// ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-run-limits-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { getLoopIterationLimit, setLoopIterationLimit } = await import('../src/renderer/src/agent/agent-utils')
const { setHost } = await import('../src/renderer/src/agent/host')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')

import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'

/** Construction-time cache warming pokes the host; nothing here needs it. */
setHost(new Proxy({}, { get: () => () => Promise.resolve([] as unknown[]) }) as never)

/** 设置 → 助手设置的两项运行上限（循环次数 / 并行专家）。并行上限的生效值在
 *  subagent-limiter.test.ts 里已有引擎无关的用例；本文件钉的是 loop 上限的
 *  引擎侧接线：maxLoopCount 的铸造（构造）、重置（新回合 / 加载历史）和续期
 *  （「继续」按钮）读的都是配置后的生效值，不是写死的 50。生效值是模块级
 *  状态，每个用例自己负责还原。 */

function makeEngine(): InstanceType<typeof AgentEngine> {
  return new AgentEngine({
    apiKey: 'test-key', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 1024,
    myName: 'tester', soul: '', yourName: 'user',
    adapter: {} as never,
    toolManager: new ToolManager() as never, skillManager: new SkillManager() as never,
    conversationId: 'conv_run_limits',
  } as unknown as AgentEngineOptions)
}

/** 打桩掉一轮 loop 的请求/流式：这里要验证的只是轮数记账与上限判断。 */
function stubLoopRounds(engine: InstanceType<typeof AgentEngine>): void {
  (engine as unknown as Record<string, unknown>).prepareLoopRequest = async () => ({})
  ;(engine as unknown as Record<string, unknown>).runLlmStream = async () => {}
}

beforeEach(() => {
  setLoopIterationLimit(null)
})

describe('settings-configured loop limit (设置 → 助手设置 · 单次任务循环次数上限)', () => {
  it('seeds a fresh engine from the configured value and parks past it', async () => {
    setLoopIterationLimit(2)
    const engine = makeEngine()
    stubLoopRounds(engine)
    expect(engine.maxLoopCount).toBe(2)

    await engine.continueLoop()
    await engine.continueLoop()
    expect(engine.agentStatus.status).not.toBe('awaiting_extension')

    // 第 3 轮越界：主代理停在整个回合上等用户裁决（子代理才会直接报错结算）。
    await engine.continueLoop()
    expect(engine.agentStatus).toMatchObject({ status: 'awaiting_extension', currentCount: 2, limit: 2 })
  })

  it('extends by the configured base, not a hardcoded 50', async () => {
    setLoopIterationLimit(2)
    const engine = makeEngine()
    stubLoopRounds(engine)

    await engine.continueLoop()
    await engine.continueLoop()
    await engine.continueLoop()
    expect(engine.agentStatus.status).toBe('awaiting_extension')

    engine.extendLoop() // 「继续」：新配额 = 配置的 base
    expect(engine.maxLoopCount).toBe(4)
    await engine.continueLoop()
    expect(engine.agentStatus.status).not.toBe('awaiting_extension')
  })

  it('reset paths (load history / new turn) re-read the live setting', () => {
    setLoopIterationLimit(2)
    const engine = makeEngine()
    expect(engine.maxLoopCount).toBe(2)

    // 设置在引擎活着的时候改了：下一个回合（startLoop / loadConversation /
    // reset 的重置点）拿到新值，不打断正在跑的回合。
    setLoopIterationLimit(7)
    engine.loadConversation([])
    expect(engine.maxLoopCount).toBe(7)
  })

  it('falls back to the pinned default when nothing is configured', () => {
    expect(getLoopIterationLimit()).toBe(200)
    const engine = makeEngine()
    expect(engine.maxLoopCount).toBe(200)
  })
})
