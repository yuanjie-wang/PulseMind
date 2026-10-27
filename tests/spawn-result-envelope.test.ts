import { describe, expect, it } from 'vitest'

const { execSpawnAgent } = await import('../src/renderer/src/agent/executors/spawn-tool')
import type { ToolExecContext } from '../src/renderer/src/agent/executors/context'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

/**
 * 结果信封的收尾指令（方案二，2026-09-16）：spawn_agent 的 tool_result 读起来
 * 像中间产物，弱模型收到后不汇报、反而再次委派——实测 mimo 连续 5 次重新派发
 * 已完成的翻译任务（「猪的位置查询」会话）。修复 = 信封的**最后几个字节**就是
 * 模型决策下一步的依据，所以结尾必须是「汇报，不要重跑」。这里驱动真实的
 * execSpawnAgent（假 context + 假子代理句柄），钉住三件事：completed / 失败两
 * 种信封都有收尾行、收尾行在信封最末、与 plan 结算行共存时排在结算行之后。
 */

const subMessages = (text: string) => [
  { id: 'a1', role: 'assistant', contentBlocks: [{ type: 'text', text }], createdAt: '2026-09-16T12:00:00.000Z' },
]

function makeContext(result: { status: string; messages: unknown[]; error?: string }): {
  ex: ToolExecContext
  /** Getter, not a destructured copy: the executor assigns the closure
   *  variable, and a plain destructure would snapshot `null` forever. */
  getCaptured: () => { content: string; isError: boolean } | null
} {
  let captured: { content: string; isError: boolean } | null = null
  const ex = {
    opts: { conversationId: `conv_envelope_${Math.random().toString(36).slice(2, 8)}`, maxTokens: 1024 },
    notify: () => {},
    addToolResult: (_id: string, content: string, isError: boolean) => { captured = { content, isError } },
    spawnSubAgent: () => ({
      id: 'h1',
      subConvId: 'sub_envelope_test',
      messages: [],
      agentStatus: { status: 'completed' },
      abort: () => {},
      waitForCompletion: async () => result,
    }),
    formatExecResult: () => '',
  } as unknown as ToolExecContext
  return { ex, getCaptured: () => captured }
}

const tool = (input: Record<string, unknown>): ToolUseBlock =>
  // autoDispatch: the planNode scenarios here simulate the SCHEDULER's own
  // dispatch settling (that is whose delivery the settle-line envelope serves),
  // which is the call shape the scheduler-ownership gate exempts.
  ({ id: 't1', type: 'tool_use', name: 'spawn_agent', input: input.planNode !== undefined ? { ...input, autoDispatch: true } : input, status: 'pending' }) as ToolUseBlock

describe('spawn result envelope: the last line tells the model what to do next', () => {
  it('completed result ends with report-donot-redeliver, after the summary', async () => {
    const { ex, getCaptured } = makeContext({
      status: 'completed',
      messages: subMessages('译文：猪在哪里？'),
    })
    await execSpawnAgent(ex, tool({ task: '翻译：Where is the pig？' }))

    expect(getCaptured()).not.toBeNull()
    const content = getCaptured()!.content
    expect(content).toContain('## Sub-Agent Result (completed)')
    expect(content).toContain('译文：猪在哪里？')
    expect(content).toContain('**This result is the deliverable.**')
    expect(content).toContain('do NOT re-dispatch')
    // The close-out is the LAST thing the model reads.
    expect(content.trimEnd().endsWith('near-identical task.')).toBe(true)
  })

  it('failed result ends with report-the-outcome, and marks the result as an error', async () => {
    const { ex, getCaptured } = makeContext({
      status: 'error',
      messages: subMessages('部分输出'),
    })
    await execSpawnAgent(ex, tool({ task: '会失败的任务' }))

    expect(getCaptured()).not.toBeNull()
    const content = getCaptured()!.content
    expect(content).toContain('did not complete successfully')
    expect(content).toContain('**Report this outcome to the user.**')
    expect(content).toContain('Do NOT silently re-dispatch')
    expect(content.trimEnd().endsWith('or ask the user.')).toBe(true)
    expect(getCaptured()!.isError).toBe(true)
  })

  it('delegated plan: the settle line says the scheduler settles it — no ritual advance_plan', async () => {
    const plan = {
      objective: 'demo',
      nodes: [{ id: 'n1', description: '翻译节点', status: 'pending', dependsOn: [] }],
    }
    const { ex, getCaptured } = makeContext({
      status: 'completed',
      messages: subMessages('译文：猪在哪里？'),
    })
    ;(ex as { getPlan?: () => unknown }).getPlan = () => plan

    await execSpawnAgent(ex, tool({ task: '翻译', planNode: 'n1' }))

    const content = getCaptured()!.content
    expect(content).toContain('**Plan node n1** ("翻译节点")')
    // PLAN-plan-scheduler: a delegated delivery hands off (handoff recorded),
    // the scheduler settles — telling the model to advance_plan here is the
    // ritual round the scheduler exists to remove.
    expect(content).toContain('the scheduler settles it automatically')
    expect(content).not.toContain('advance_plan action="complete"')
    // The close-out still comes last: report, don't re-dispatch.
    expect(content).toContain('**This result is the deliverable.**')
    expect(content.indexOf('the scheduler settles it automatically')).toBeLessThan(content.indexOf('**This result is the deliverable.**'))
    expect(content.trimEnd().endsWith('near-identical task.')).toBe(true)
  })

  it('direct plan keeps the settle-now instruction (that mode never auto-settles)', async () => {
    const plan = {
      objective: 'demo',
      mode: 'direct',
      nodes: [{ id: 'n1', description: '翻译节点', status: 'pending', dependsOn: [] }],
    }
    const { ex, getCaptured } = makeContext({
      status: 'completed',
      messages: subMessages('译文：猪在哪里？'),
    })
    ;(ex as { getPlan?: () => unknown }).getPlan = () => plan

    await execSpawnAgent(ex, tool({ task: '翻译', planNode: 'n1' }))

    const content = getCaptured()!.content
    expect(content).toContain('advance_plan action="complete" node=1')
    expect(content).not.toContain('the scheduler settles it automatically')
    expect(content.indexOf('advance_plan action="complete"')).toBeLessThan(content.indexOf('**This result is the deliverable.**'))
  })
})

/**
 * 失败要带原因（2026-09-29）：SubAgentResult 此前没有 error 字段，运行期失败
 * （循环上限 / 请求失败 / 流失败）的错误文本死在子引擎内存里，父级信封只有
 * `Status: error` 一个词；且工具卡渲染的 t.output 在失败分支也被覆写成
 * 「子代理已完成」——用户只能靠红叉知道出错了，看不到为什么。钉住两件事：
 * 信封带 **Reason:** 行、卡片输出承认失败并写明原因。
 */
describe('spawn failure carries its reason (envelope + tool card output)', () => {
  it('error result: the envelope names the Reason and the card stops claiming 已完成', async () => {
    const { ex, getCaptured } = makeContext({
      status: 'error',
      error: 'Sub-agent reached its loop limit (40 rounds) without completing the task.',
      messages: subMessages('做到一半的输出'),
    })
    const t = tool({ task: '会失败的任务' })
    await execSpawnAgent(ex, t)

    // The envelope (model-facing) carries the reason before the partial output.
    const content = getCaptured()!.content
    expect(content).toContain('### Sub-agent Status: error')
    expect(content).toContain(`**Reason:** Sub-agent reached its loop limit (40 rounds) without completing the task.`)
    expect(content).toContain('**Partial Output:**')
    expect(content).toContain('**Report this outcome to the user.**')

    // The card (user-facing, renders t.output) names the failure, not 已完成.
    expect(t.output).toContain('子代理失败：Sub-agent reached its loop limit (40 rounds) without completing the task.')
    expect(t.output).not.toContain('子代理已完成')
    expect(t.exitCode).toBe(1)
  })

  it('error without an error field degrades to a bare 子代理失败 (no crash, no Reason line)', async () => {
    const { ex, getCaptured } = makeContext({
      status: 'error',
      messages: subMessages('部分输出'),
    })
    const t = tool({ task: '会失败的任务' })
    await execSpawnAgent(ex, t)

    expect(getCaptured()!.content).not.toContain('**Reason:**')
    expect(t.output).toContain('子代理失败')
    expect(t.output).not.toContain('子代理已完成')
  })

  it('aborted result: the card says 已被停止, no Reason line, not an error result', async () => {
    const { ex, getCaptured } = makeContext({
      status: 'aborted',
      messages: subMessages('停止前的输出'),
    })
    const t = tool({ task: '被停止的任务' })
    await execSpawnAgent(ex, t)

    expect(getCaptured()!.content).toContain('### Sub-agent Status: aborted')
    expect(getCaptured()!.content).not.toContain('**Reason:**')
    expect(getCaptured()!.isError).toBe(false)
    expect(t.output).toContain('子代理已被停止')
    expect(t.output).not.toContain('子代理已完成')
    expect(t.exitCode).toBe(1)
  })
})
