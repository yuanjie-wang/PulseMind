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
