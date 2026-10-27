import { describe, expect, it, beforeEach, vi } from 'vitest'
import { ToolExecutor } from '../src/renderer/src/agent/tool-executors'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

/**
 * tool_result_search 的执行器（conv_20261026154702 A4/B4 改源）：压缩管线的
 * 取回半边此前从未接线——工具在系统提示词与压缩通知里被点名，调用却落进
 * shell 兜底路径，`echo "Unrecognized tool: …"` 以 Exit Code 0 假成功收场。
 * 这里钉四层：命中取回全文、miss 的逐 id 纠正（编造 id 不再是哑失败）、
 * 空 ids 拒绝、以及 execOtherTool 分发链的接线本身（走 execOtherTool 而非
 * 直接调执行器，门没接等于没修）。
 */

interface Row { ref_id: string; content: string; is_error: number }

function makeHarness(rows: Row[]) {
  const results: Array<{ id: string; content: string; isError: boolean }> = []
  const getToolResult = vi.fn(async (ids: string[]) =>
    rows.filter((r) => ids.includes(r.ref_id))
      .map((r) => ({ ref_id: r.ref_id, conversation_id: 'c1', message_id: 'm1', block_index: 0, tool_use_id: `tu_${r.ref_id}`, content: r.content, is_error: r.is_error })),
  )
  setHost({ getToolResult } as unknown as PulseHost)
  const executor = new ToolExecutor(
    { apiKey: 'k', baseURL: 'https://x', model: 'm', maxTokens: 10, adapter: {} as never, conversationId: 'c1' } as never,
    new Map(),
    {} as never,
    {} as never,
    (id: string, content: string, isError: boolean) => { results.push({ id, content, isError }) },
    () => {},
  )
  const call = (input: Record<string, unknown>) =>
    ({ type: 'tool_use', id: 't1', name: 'tool_result_search', input, status: 'pending' }) as unknown as ToolUseBlock
  return { executor, getToolResult, results, call }
}

beforeEach(() => { setHost({} as unknown as PulseHost) })

describe('tool_result_search: the read half of the compaction pipeline', () => {
  it('resolves archived ids to the full original content (execOtherTool wiring, not a direct call)', async () => {
    const { executor, results, call, getToolResult } = makeHarness([
      { ref_id: 'uuid-1', content: 'full original body of the archived result', is_error: 0 },
    ])
    await executor.execOtherTool(call({ ids: ['uuid-1'] }))

    expect(getToolResult).toHaveBeenCalledWith(['uuid-1'])
    expect(results).toHaveLength(1)
    expect(results[0].isError).toBe(false)
    expect(results[0].content).toContain('[archived tool result · uuid-1]')
    expect(results[0].content).toContain('full original body of the archived result')
  })

  it('an error result is archived with its error identity, not silently as a success', async () => {
    const { executor, results, call } = makeHarness([
      { ref_id: 'uuid-err', content: 'Error: the original failure text', is_error: 1 },
    ])
    await executor.execOtherTool(call({ ids: ['uuid-err'] }))
    expect(results[0].content).toContain('[archived error result · uuid-err]')
    expect(results[0].content).toContain('the original failure text')
    expect(results[0].isError).toBe(false) // the LOOKUP succeeded; the archive records the old failure
  })

  it('a hallucinated id is a per-id correction with the verbatim-copy teaching (B4)', async () => {
    const { executor, results, call } = makeHarness([])
    await executor.execOtherTool(call({ ids: ['bd19c465-b38b-4fd9-bcde-fc53f4938c8e'] }))

    expect(results[0].isError).toBe(true)
    expect(results[0].content).toContain('bd19c465-b38b-4fd9-bcde-fc53f4938c8e')
    expect(results[0].content).toContain('⟨archived: <uuid>⟩')
    expect(results[0].content).toContain('VERBATIM')
  })

  it('mixed found/missed: what resolved is delivered AND the misses are named (no whole-call error burying hits)', async () => {
    const { executor, results, call } = makeHarness([
      { ref_id: 'good-1', content: 'the hit body', is_error: 0 },
    ])
    await executor.execOtherTool(call({ ids: ['good-1', 'fabricated-9'] }))

    expect(results[0].isError).toBe(false)
    expect(results[0].content).toContain('the hit body')
    expect(results[0].content).toContain('fabricated-9')
    expect(results[0].content).toContain('1 of 2')
  })

  it('empty ids refuse with the placeholder pointer', async () => {
    const { executor, results, call } = makeHarness([])
    await executor.execOtherTool(call({ ids: [] }))
    expect(results[0].isError).toBe(true)
    expect(results[0].content).toContain('⟨archived: …⟩')
  })

  it('duplicate ids collapse to one lookup (and the executor claims the name before the skill-command fallthrough)', async () => {
    const { executor, results, call, getToolResult } = makeHarness([
      { ref_id: 'u1', content: 'body', is_error: 0 },
    ])
    await executor.execOtherTool(call({ ids: ['u1', 'u1'] }))
    expect(getToolResult).toHaveBeenCalledWith(['u1'])
    expect(results[0].isError).toBe(false)
  })
})
