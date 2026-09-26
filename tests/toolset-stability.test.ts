import { readFileSync } from 'node:fs'
import { describe, expect, it, beforeEach } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { ToolManager } from '../src/renderer/src/tools/ToolManager'
import { BUILT_IN_TOOLS } from '../src/renderer/src/tools/built-in-tools'
import type { ToolManager as ToolManagerType } from '../src/renderer/src/tools/ToolManager'
import { collectEnabledTools, buildToolProtocols } from '../src/renderer/src/agent/engine/tool-collection'
import type { ToolCollectionDeps } from '../src/renderer/src/agent/engine/tool-collection'
import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'
import type { AgentMessage } from '../src/renderer/src/types/agent'

/**
 * 门控与主干（2026-09-26，两轮裁定后的最终形状）。
 *
 * gated 内建工具按需激活：关键词命中类别触发词、或 pick_tool 激活，未激活
 * 不得出现在上下文中。但「跨会话保住暖启动」同样成立，靠的是两个形状约束：
 *   1. 激活的 gated schema 追加在工具数组的【末尾】——system + 基础 schema
 *      对所有会话逐字节相同，激活状态不同的会话共享整段主干；
 *   2. gated 手册不进 Tool Protocols（改由 pick_tool 激活结果携带）——否则
 *      system 在手册处分叉，主干断得更早。
 * 两轮的历史：第一轮把门整个拆掉保缓存（错，丢产品语义），这一轮恢复门、
 * 用形状保缓存。本文件把两边都钉死。
 */

const GATED_NAMES = BUILT_IN_TOOLS.filter((t) => t.availability === 'gated').map((t) => t.name)

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

function fullToolManager(): ToolManagerType {
  // 生产里 tool_preferences 表的缺省 = 全部内建（DEFAULT_ENABLED_TOOLS）。
  const tm = new ToolManager() as ToolManagerType
  tm.applyPreferences({ enabledTools: BUILT_IN_TOOLS.map((t) => t.name) })
  return tm
}

function userMsg(text: string): AgentMessage {
  return {
    id: `u_${text.slice(0, 8)}`,
    role: 'user',
    contentBlocks: [{ type: 'text', text }],
    createdAt: '2026-09-26T00:00:00.000Z',
  } as AgentMessage
}

function deps(patch: Partial<ToolCollectionDeps> = {}): ToolCollectionDeps {
  return {
    mcpToolOwner: new Map(),
    selectedBuiltinTools: [],
    selectedMcpTools: [],
    messages: [],
    opts: { toolManager: fullToolManager(), skillManager: undefined } as unknown as AgentEngineOptions,
    ...patch,
  }
}

describe('the gate: gated built-ins are hidden until activated', () => {
  it('no activation → no gated tools in the toolset', async () => {
    const names = (await collectEnabledTools(deps(), fullToolManager())).map((t) => t.name)
    expect(names).toContain('read')
    for (const gated of ['git_status', 'docx_edit', 'memory_save', 'experience_save']) {
      expect(names).not.toContain(gated)
    }
  })

  it('pick_tool activation (selectedBuiltinTools) surfaces them — appended AFTER the base toolset', async () => {
    const tm = fullToolManager()
    const names = (await collectEnabledTools(
      deps({ selectedBuiltinTools: ['git_status', 'docx_edit'] }),
      tm,
    )).map((t) => t.name)
    expect(names).toContain('git_status')
    expect(names).toContain('docx_edit')
    // 尾部追加：gated 的位置必须晚于所有非 gated —— 主干不被切断
    const lastBase = Math.max(...names.map((n, i) => (BUILT_IN_TOOLS.some((d) => d.name === n && d.availability !== 'gated') ? i : -1)))
    const firstGated = names.indexOf('git_status')
    expect(firstGated).toBeGreaterThan(lastBase)
  })

  it('the keyword door still activates whole categories', async () => {
    const names = (await collectEnabledTools(
      deps({ messages: [userMsg('帮我看一下 git 状态，顺便整理分支')] }),
      fullToolManager(),
    )).map((t) => t.name)
    expect(names).toContain('git_status')
    expect(names).not.toContain('docx_edit') // 别的类别不沾光
  })
})

describe('the trunk: activation must not move the shared prefix', () => {
  it('Tool Protocols are byte-identical with and without activation (gated manuals excluded)', async () => {
    const activated = await collectEnabledTools(
      deps({ selectedBuiltinTools: GATED_NAMES }),
      fullToolManager(),
    )
    const dormant = await collectEnabledTools(deps(), fullToolManager())

    // 若 gated 手册进了 protocols，这两个串会在手册处不同 —— 主干就此断裂
    expect(buildToolProtocols(activated)).toBe(buildToolProtocols(dormant))
    expect(buildToolProtocols(activated).length).toBeGreaterThan(0) // 基础手册仍在
  })

  it('the exclusion is load-bearing: gated definitions really do carry manuals', () => {
    const docx = BUILT_IN_TOOLS.find((t) => t.name === 'docx_edit')
    expect(docx?.instructions?.trim().length ?? 0).toBeGreaterThan(100)
  })

  it('two back-to-back dormant collections are deep-equal', async () => {
    const first = (await collectEnabledTools(deps(), fullToolManager())).map((t) => t.name)
    const second = (await collectEnabledTools(deps(), fullToolManager())).map((t) => t.name)
    expect(second).toEqual(first)
  })

  it('a spawned-agent whitelist still filters built-ins', async () => {
    const names = (await collectEnabledTools(
      deps({ allowedToolsSet: new Set(['read', 'exec']) }),
      fullToolManager(),
    )).map((t) => t.name)
    expect(names).toContain('read')
    expect(names).not.toContain('git_status')
    expect(names).not.toContain('write')
  })
})

describe('source shape', () => {
  it('the keyword/activation mechanism is present in the collection layer', () => {
    const src = readFileSync('src/renderer/src/agent/engine/tool-collection.ts', 'utf-8')
    expect(src).toContain('.triggers')
    expect(src).toContain("availability !== 'gated'")
    expect(src).toContain('selectedBuiltinTools: string[]')
  })
})
