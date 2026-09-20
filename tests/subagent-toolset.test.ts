import { describe, expect, it, beforeEach } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { AgentEngine } from '../src/renderer/src/agent/AgentEngine'
import { ToolManager } from '../src/renderer/src/tools/ToolManager'
import { SkillManager } from '../src/renderer/src/skills/SkillManager'
import type { ToolManager as ToolManagerType } from '../src/renderer/src/tools/ToolManager'
import { collectEnabledTools } from '../src/renderer/src/agent/engine/tool-collection'

/**
 * PLAN-parallel-experts T9（第二轮裁定 ④：专家不给 page_* 工具）。
 * 专家继承父会话的 hostedAvailable=true，但 page 工具的注册表只绑定被 ws 客户端
 * ask 过的会话——专家的 sub_… 会话没人绑定，每次调用都必然报
 * 「当前会话没有连接的浏览器客户端」。v1 的定案是把入口关掉，而不是留着必然
 * 失败的出口。这里证明派发链路的另一端：父引擎（hostedAvailable: true）派生的
 * 专家，工具集里没有 page_*，父引擎仍有。
 *
 * 2026-09-20 起 page_* 不在 ToolManager 注册表里（插件专用），父会话的
 * page 工具来自 collectEnabledTools 按 hostedAvailable 的合并，enabledTools
 * 只负责普通内建工具。
 */

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
    saveConversation: noop,
    appendConversationMessages: noop,
  } as unknown as PulseHost
}

beforeEach(() => {
  setHost(makeMockHost())
})

describe('sub-agent toolset excludes page_* (T9)', () => {
  it('a spawned engine of a hosted parent carries hostedAvailable=false and no page_* tools; the parent keeps them', async () => {
    // 全新 ToolManager 默认全禁（生产里从 tool_preferences 表载入）——这里显式
    // 启用一个普通工具作底座；page 家族由 hostedAvailable 的合并提供，不走注册表。
    const toolManager = new ToolManager() as ToolManagerType
    toolManager.applyPreferences({ enabledTools: ['read'] })
    const parent = new AgentEngine({
      apiKey: 'test-key', // 子引擎继承：空 key 会撞 no-key 守卫，而那条路径不结算 completion
      baseURL: 'https://example.invalid',
      model: 'test-model',
      maxTokens: 512,
      myName: '',
      soul: '',
      yourName: '',
      adapter: {} as never,
      toolManager,
      skillManager: new SkillManager(),
      conversationId: 'conv_page_parent',
      hostedAvailable: true, // 扩展在线的会话形态
    })

    const handle = parent.spawnSubAgent({
      systemPrompt: 'do a thing',
      initialMessages: [],
      title: '子代理: page',
      maxTokens: 128,
      maxLoopIterations: 0, // 第一轮就越线 → T8 分支立刻收摊，不发起任何 LLM 请求
    })
    const sub = parent.activeSubAgents.get(handle.id)!
    await handle.waitForCompletion() // 收摊，避免悬挂

    // 派发时显式关闭（spawn-manager 的 subOpts），不再继承父会话的 true。
    expect(parent.opts.hostedAvailable).toBe(true)
    expect(sub.opts.hostedAvailable).toBe(false)

    const parentNames = (await collectEnabledTools({
      mcpToolOwner: parent.mcpToolOwner,
      selectedBuiltinTools: [],
      selectedMcpTools: [],
      messages: [],
      opts: parent.opts,
    }, toolManager)).map(t => t.name)
    const subNames = (await collectEnabledTools({
      mcpToolOwner: sub.mcpToolOwner,
      selectedBuiltinTools: [],
      selectedMcpTools: [],
      messages: sub.messages,
      spawnSystemPrompt: sub.spawnSystemPrompt,
      opts: sub.opts,
    }, toolManager)).map(t => t.name)

    expect(parentNames).toContain('page_get_content')
    expect(parentNames).toContain('page_click')
    expect(subNames.filter(n => n.startsWith('page_'))).toEqual([])
    expect(subNames).toContain('read') // 专家的其余工具不受影响
  })
})
