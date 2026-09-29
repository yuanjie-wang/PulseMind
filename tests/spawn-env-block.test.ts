import { describe, expect, it } from 'vitest'

const { execSpawnAgent } = await import('../src/renderer/src/agent/executors/spawn-tool')
import type { ToolExecContext } from '../src/renderer/src/agent/executors/context'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'
import type { SpawnSubAgentConfig } from '../src/renderer/src/agent/agent-utils'

/**
 * 子代理的环境段（2026-09-29）：spawnSystemPrompt 分支返回 stateBlock null，
 * `## Workspace` / `## System Info` 从未到达子代理——运行时继承是通的
 * （opts.workspaceDir 随 opts 展开进入子引擎，相对路径解析、ALS 沙箱都落在父
 * 工作目录），但模型看不到路径：报不出绝对路径、说不出文件写在了哪、猜 `~/`
 * 还会撞 deny root。修复 = execSpawnAgent 组装 systemPrompt 时补 `# Running
 * Environment` 段（workspace + 输出上限）。这里驱动真实的 execSpawnAgent（假
 * context + 假子代理句柄），钉住：有 workspaceDir 时路径原样出现且排在
 * ENGINEERING_WORKFLOW 之前；没有时该行整体缺席而输出上限仍在；任务消息形状
 * 不变（2026-09-25 裁定：任务骑首条用户消息）。
 */

function makeContext(opts: Record<string, unknown>): {
  ex: ToolExecContext
  getConfig: () => SpawnSubAgentConfig | null
} {
  let config: SpawnSubAgentConfig | null = null
  const ex = {
    opts: { conversationId: `conv_env_${Math.random().toString(36).slice(2, 8)}`, maxTokens: 8192, ...opts },
    notify: () => {},
    addToolResult: () => {},
    spawnSubAgent: (cfg: SpawnSubAgentConfig) => {
      config = cfg
      return {
        id: 'h1',
        subConvId: 'sub_env_test',
        messages: [],
        agentStatus: { status: 'completed' },
        abort: () => {},
        waitForCompletion: async () => ({
          status: 'completed',
          messages: [{ id: 'a1', role: 'assistant', contentBlocks: [{ type: 'text', text: '完成' }], createdAt: '2026-09-29T12:00:00.000Z' }],
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

describe('spawn env block: the workspace reaches the sub-agent prompt', () => {
  it('workspaceDir lands verbatim in # Running Environment, before ENGINEERING_WORKFLOW', async () => {
    const ws = `/tmp/pm-ws-${Math.random().toString(36).slice(2, 8)}`
    const { ex, getConfig } = makeContext({ workspaceDir: ws })
    await execSpawnAgent(ex, tool({ task: '把结果写到 summary.md' }))

    expect(getConfig()).not.toBeNull()
    const sp = getConfig()!.systemPrompt
    expect(sp).toContain('# Running Environment')
    expect(sp).toContain(`- Workspace: ${ws}`)
    // The contract must still close the prompt — env is mechanics, not the
    // last word the model reads.
    expect(sp.indexOf('# Running Environment')).toBeLessThan(sp.indexOf('## Engineering Workflow'))
  })

  it('output limit line carries the inherited maxTokens', async () => {
    const { ex, getConfig } = makeContext({ workspaceDir: '/tmp/pm-ws' })
    await execSpawnAgent(ex, tool({ task: 'task' }))

    const sp = getConfig()!.systemPrompt
    expect(sp).toContain('- Your maximum output limit: 8192 tokens per response')
  })

  it('without a workspaceDir the Workspace line stays out, the limit line remains', async () => {
    const { ex, getConfig } = makeContext({ workspaceDir: undefined })
    await execSpawnAgent(ex, tool({ task: 'task' }))

    const sp = getConfig()!.systemPrompt
    expect(sp).not.toContain('- Workspace:')
    expect(sp).toContain('- Your maximum output limit: 8192 tokens per response')
  })

  it('the task message keeps its 2026-09-25 shape — env rides the system prompt, not the task', async () => {
    const { ex, getConfig } = makeContext({ workspaceDir: '/tmp/pm-ws' })
    await execSpawnAgent(ex, tool({ task: '翻译：Where is the pig？' }))

    const cfg = getConfig()!
    expect(cfg.initialMessages[0]?.role).toBe('user')
    const first = (cfg.initialMessages[0]?.contentBlocks as Array<{ type: string; text?: string }>)[0]
    expect(first?.text?.startsWith('## 你的任务')).toBe(true)
    expect(first?.text).not.toContain('Workspace')
  })
})
