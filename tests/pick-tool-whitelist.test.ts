import { describe, expect, it, vi } from 'vitest'
import { execPickTool } from '../src/renderer/src/agent/executors/pick-tool'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

/**
 * pick_tool 的连接器白名单（audit 2026-10-10 #8）：names 模式一直走
 * fetchCandidateTools 的过滤，serverName/intent 模式曾直接列全量服务器——
 * 受限专家按信封激活了白名单外的武器，引擎侧 mcpToolOwner 却永远不会装它，
 * 调用必败。白名单没被真正突破（这是信封诚实性修复），但源头要顶回去：
 * 白名单外的服务器连候选都不进，错误信息也只列白名单内的。
 */

function t(id: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id, name: 'pick_tool', input, status: 'pending' } as unknown as ToolUseBlock
}

const SERVERS = [
  { id: 'srv_free', name: 'free', status: 'connected', tools: [{ name: 't_free', description: 'free tool', inputSchema: { type: 'object' } }] },
  { id: 'srv_gated', name: 'gated', status: 'connected', tools: [{ name: 't_gated', description: 'gated tool', inputSchema: { type: 'object' } }] },
]

function makeEx(allowedMcpServers?: string[]) {
  const results: Array<{ id: string, content: string, isError: boolean }> = []
  setHost({
    mcpListServers: vi.fn(async () => SERVERS),
    onMcpServersChanged: () => () => {},
  } as unknown as PulseHost)
  const selected: string[] = []
  const ex = {
    opts: {
      allowedMcpServers,
      toolManager: { getEnabledTools: () => [] as Array<{ definition: { name: string } }> },
      adapter: {}, apiKey: 'k', baseURL: 'https://x', model: 'm', maxTokens: 10,
    },
    addToolResult: (id: string, content: string, isError: boolean) => { results.push({ id, content, isError }) },
    notify: () => {},
  } as never as Parameters<typeof execPickTool>[0]
  return { ex, results, selected, setSelected: (names: string[]) => selected.push(...names) }
}

describe('execPickTool — serverName/intent 模式的连接器白名单', () => {
  it('serverName 命中白名单外服务器 → 拒绝，且错误只列白名单内的', async () => {
    const { ex, results, selected } = makeEx(['srv_free'])
    await execPickTool(ex, t('t1', { serverName: 'srv_gated' }), () => {})
    expect(results[0].isError).toBe(true)
    expect(results[0].content).toContain('not found')
    // 可用清单只列白名单内的（请求名的回显不在此列）
    expect(results[0].content).toContain('Available servers: srv_free')
    expect(results[0].content).not.toContain('Available servers: srv_gated')
    expect(selected).toEqual([])
  })

  it('serverName 命中白名单内服务器 → 正常激活', async () => {
    const { ex, results, selected } = makeEx(['srv_free'])
    await execPickTool(ex, t('t1', { serverName: 'srv_free' }), (names) => selected.push(...names))
    expect(results[0].isError).toBe(false)
    expect(results[0].content).toContain('t_free')
    expect(selected).toEqual(['t_free'])
  })

  it('无白名单（主会话）→ serverName 全量可达（负控：过滤不误伤）', async () => {
    const { ex, results, selected } = makeEx(undefined)
    await execPickTool(ex, t('t1', { serverName: 'srv_gated' }), (names) => selected.push(...names))
    expect(results[0].isError).toBe(false)
    expect(selected).toEqual(['t_gated'])
  })

  it('intent 模式：选择代理看到的服务器清单同样过滤（不产出必败的候选）', async () => {
    const { ex, results, selected } = makeEx(['srv_free'])
    // ServerSelectionAgent 是 executor 内部 new 的——用 spy 让它指名白名单外
    // 的 srv_gated，验证清单过滤的下游效果：fetchCandidateTools 里没有它的
    // 工具 → 「No tools found」而非激活。
    const { ServerSelectionAgent } = await import('../src/renderer/src/agent/one-shot-agent')
    const spy = vi.spyOn(ServerSelectionAgent.prototype, 'execute').mockResolvedValue(['srv_gated'])
    try {
      await execPickTool(ex, t('t1', { intent: 'gated stuff' }), (names) => selected.push(...names))
      expect(results[0].isError).toBe(false)
      expect(results[0].content).toContain('No tools found for servers: srv_gated')
      expect(selected).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})

// ── PLAN-tool-issues #5（2026-10-28）：无参自检 + 拒绝侧教学 ──
// 模型点名一个未激活工具只得到拒绝，且没有任何「问一句现在能拿什么」的口子
// （原库 8 次）。无参 pick_tool 现在列出可拿全集（沿用白名单过滤的候选源，
// * 标已激活），两处拒绝文案点名这个自检。
describe('execPickTool — Mode 0: the no-argument self-check', () => {
  const GATED = [
    { definition: { name: 'git_status', availability: 'gated', category: 'git', description: 'git status', input_schema: { type: 'object' }, instructions: 'manual' } },
    { definition: { name: 'recall', availability: 'gated', category: 'memory', description: 'recall', input_schema: { type: 'object' }, instructions: '' } },
  ]

  function makeListEx(allowedMcpServers?: string[], activated: string[] = []) {
    const results: Array<{ id: string, content: string, isError: boolean }> = []
    setHost({
      mcpListServers: vi.fn(async () => SERVERS),
      onMcpServersChanged: () => () => {},
    } as unknown as PulseHost)
    const ex = {
      opts: {
        allowedMcpServers,
        toolManager: { getEnabledTools: () => GATED as never },
        adapter: {}, apiKey: 'k', baseURL: 'https://x', model: 'm', maxTokens: 10,
      },
      addToolResult: (_id: string, content: string, isError: boolean) => { results.push({ id: _id, content, isError }) },
      notify: () => {},
    } as never as Parameters<typeof execPickTool>[0]
    return { ex, results, getActivated: () => activated }
  }

  it('no arguments lists gated categories and MCP servers, *-marking the active ones', async () => {
    const { ex, results, getActivated } = makeListEx(undefined, ['git_status'])
    await execPickTool(ex, t('t0', {}), () => {}, getActivated)
    const text = results[0]!.content
    expect(results[0]!.isError).toBe(false)
    expect(text).toContain('## Pick-able Tools')
    expect(text).toContain('- **git**: git_status*')
    expect(text).toContain('- **memory**: recall')
    expect(text).toContain('srv_free')
    expect(text).toContain('srv_gated')
    expect(text).toContain('pick_tool({ names: [...] })')
    // Always-on tools are not repeated.
    expect(text).not.toContain('webfetch')
  })

  it('the whitelist filters the listing too — a restricted expert cannot even see the others', async () => {
    const { ex, results, getActivated } = makeListEx(['srv_free'])
    await execPickTool(ex, t('t0', {}), () => {}, getActivated)
    expect(results[0]!.content).toContain('srv_free')
    expect(results[0]!.content).not.toContain('srv_gated')
  })

  it('nothing pick-able says so honestly instead of erroring', async () => {
    // Whitelist [] kills every server; a defs override kills the gated rows.
    const saved = GATED.splice(0, GATED.length)
    try {
      const { ex, results } = makeListEx([])
      await execPickTool(ex, t('t0', {}), () => {}, () => [])
      expect(results[0]!.isError).toBe(false)
      expect(results[0]!.content).toContain('Nothing is pick-able right now')
    } finally {
      GATED.push(...saved)
    }
  })

  it('without the getter wired the listing still works, just without * marks', async () => {
    const { ex, results } = makeListEx(undefined, ['git_status'])
    await execPickTool(ex, t('t0', {}), () => {})
    expect(results[0]!.content).toContain('- **git**: git_status')
    expect(results[0]!.content).toContain('- **memory**: recall')
    expect(results[0]!.content).not.toContain('git_status*')
  })

  it('both rejections name the self-check (failure-time teaching)', async () => {
    const { ex, results, getActivated } = makeListEx()
    await execPickTool(ex, t('t1', { names: ['no_such_tool'] }), () => {}, getActivated)
    expect(results[0]!.content).toContain('No MCP or built-in tools found matching names: no_such_tool')
    expect(results[0]!.content).toContain('Call pick_tool with no arguments')

    const h2 = makeListEx()
    await execPickTool(h2.ex, t('t2', { serverName: 'nope' }), () => {}, h2.getActivated)
    expect(h2.results[0]!.content).toContain('Call pick_tool with no arguments')
  })
})

describe('pick_tool self-check wiring (PLAN-tool-issues #5)', () => {
  it('schema: oneOf is gone and the description advertises the no-arg mode', async () => {
    const { BUILT_IN_TOOLS } = await import('../src/renderer/src/tools/built-in-tools')
    const def = BUILT_IN_TOOLS.find((d) => d.name === 'pick_tool')!
    expect((def.input_schema as Record<string, unknown>).oneOf).toBeUndefined()
    expect(def.description).toContain('NO arguments')
    expect(def.description).toContain('already active')
  })

  it('manual: the self-check sentence rides the protocol', async () => {
    const { toolInstructions } = await import('../src/renderer/src/tools/tool-instructions')
    expect(toolInstructions.pick_tool).toContain('NO arguments')
    expect(toolInstructions.pick_tool).toContain('instead of guessing whether a tool exists')
  })

  it('execution-flow passes the activated-set getter; tool-executors forwards the 4th param', async () => {
    const { readFileSync } = await import('node:fs')
    const read = (p: string) => readFileSync(process.cwd() + '/src/' + p, 'utf8')
    const flow = read('renderer/src/agent/engine/execution-flow.ts')
    expect(flow).toContain('() => [...this.engine.selectedBuiltinTools, ...this.engine.selectedMcpTools]')
    const te = read('renderer/src/agent/tool-executors.ts')
    expect(te).toContain('getActivatedTools?: () => string[]')
    expect(te).toContain('pickToolImpl(this, t, setSelectedTools, getActivatedTools)')
  })
})
