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
    for (const gated of ['git_status', 'office_edit']) {
      expect(names).not.toContain(gated)
    }
  })

  it('pick_tool activation (selectedBuiltinTools) surfaces them — appended AFTER the base toolset', async () => {
    const tm = fullToolManager()
    const names = (await collectEnabledTools(
      deps({ selectedBuiltinTools: ['git_status', 'office_edit'] }),
      tm,
    )).map((t) => t.name)
    expect(names).toContain('git_status')
    expect(names).toContain('office_edit')
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
    expect(names).not.toContain('office_edit') // 别的类别不沾光
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
    const docx = BUILT_IN_TOOLS.find((t) => t.name === 'office_edit')
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

describe('recall 读 + memory_save 写是 ALWAYS base 工具（PLAN-recall-unification：检索一元化后读写仍随主干）', () => {
  const ALWAYS_MEMORY_TOOLS = ['recall', 'memory_save']

  it('defined always + memory；triggers 必须保留——关键词门靠它们当 memory 类目的中文门', () => {
    for (const name of ALWAYS_MEMORY_TOOLS) {
      const def = BUILT_IN_TOOLS.find((t) => t.name === name)
      expect(def, name).toBeDefined()
      expect(def?.availability, name).toBe('always')
      expect(def?.category, name).toBe('memory')
      expect(def?.triggers?.length ?? 0, name).toBeGreaterThan(0)
    }
    expect(BUILT_IN_TOOLS.find((t) => t.name === 'recall')?.triggers).toContain('记忆')
    // 三旧检索工具确已退役（回归守卫）
    for (const retired of ['memory_search', 'conversation_search', 'knowledge_search']) {
      expect(BUILT_IN_TOOLS.find((t) => t.name === retired), retired).toBeUndefined()
    }
  })

  it('ships in the dormant base toolset and their manuals ride Tool Protocols（检索+写入的教学随主干走）', async () => {
    const names = (await collectEnabledTools(deps(), fullToolManager())).map((t) => t.name)
    for (const name of ALWAYS_MEMORY_TOOLS) expect(names, name).toContain(name)
    const protocols = buildToolProtocols(await collectEnabledTools(deps(), fullToolManager()))
    expect(protocols).toContain('## recall')
    // 「only view」教学迁去了 schema description（2026-10-25 瘦身，schema 同请求
    // 在场）；手册侧钉 query 实操教学仍在主干。
    expect(protocols).toContain('2-4 char terms work')
    expect(protocols).toContain('## memory_save')
  })

  it('the manual is byte-stable across activation states (it sits in the shared trunk)', async () => {
    const activated = await collectEnabledTools(deps({ selectedBuiltinTools: GATED_NAMES }), fullToolManager())
    const dormant = await collectEnabledTools(deps(), fullToolManager())
    expect(buildToolProtocols(activated)).toBe(buildToolProtocols(dormant))
  })
})

describe('context_compact is an ALWAYS base tool (PLAN-context-compact-tool, user ruling 2026-10-01)', () => {
  it('defined always + session — 压缩是会话元操作（2026-11-08 分类裁定；「不是记忆」的旧裁定保持：user 2026-10-10）', () => {
    const def = BUILT_IN_TOOLS.find((t) => t.name === 'context_compact')
    expect(def).toBeDefined()
    expect(def?.availability).toBe('always')
    expect(def?.category).toBe('session')
    // An always tool needs no triggers — the keyword door is inert for it.
    expect(def?.triggers).toBeUndefined()
  })

  it('类目成员（2026-11-08 重划）：session 收编压缩，tool_result_search 并入 memory；memory 类目无 gated 残留', () => {
    const cat = (n: string): string | undefined => BUILT_IN_TOOLS.find((t) => t.name === n)?.category
    expect(cat('context_compact')).toBe('session')
    expect(cat('tool_result_search')).toBe('memory')
    // memory 类目全 always——关键词门对该类目自然失效，没有半激活的中间态
    const memoryGated = BUILT_IN_TOOLS.filter((t) => t.category === 'memory' && t.availability === 'gated')
    expect(memoryGated).toHaveLength(0)
  })

  it('ships in the dormant base toolset with no activation, and its manual rides Tool Protocols', async () => {
    const names = (await collectEnabledTools(deps(), fullToolManager())).map((t) => t.name)
    expect(names).toContain('context_compact')
    const protocols = buildToolProtocols(await collectEnabledTools(deps(), fullToolManager()))
    expect(protocols).toContain('## context_compact')
  })

  it('the manual is byte-stable across activation states (it sits in the shared trunk)', async () => {
    const activated = await collectEnabledTools(deps({ selectedBuiltinTools: GATED_NAMES }), fullToolManager())
    const dormant = await collectEnabledTools(deps(), fullToolManager())
    expect(buildToolProtocols(activated)).toBe(buildToolProtocols(dormant))
  })

  it('the new member did not move the gated tail shape: activated gated schemas still ride last', async () => {
    const names = (await collectEnabledTools(
      deps({ selectedBuiltinTools: ['git_status'] }),
      fullToolManager(),
    )).map((t) => t.name)
    const lastBase = Math.max(...names.map((n, i) => (BUILT_IN_TOOLS.some((d) => d.name === n && d.availability !== 'gated') ? i : -1)))
    expect(names.indexOf('git_status')).toBeGreaterThan(lastBase)
  })
})
