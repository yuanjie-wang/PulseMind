// 丢弃区读取重注（PLAN-context-zcode-benchmarks P0，2026-09-29）。
// 病灶：conv_20260927170026 —— light 丢掉的工具循环里成功 read 过的文件，
// 摘要只留 400 字符转述、replays 只保用户的话，模型隔 100 分钟对同一批
// 对象原样重探。修复：丢弃区里「结果已不在保留尾段」的 read 以指针提醒
// 回注（路径 + tool_result_id），取回走既有 tool_result_search + 全量持久化
// 的 tool_results 表——ZCode 的 inline 重注（5 文件/50K token）在 PulseMind
// 不需要，窗口留给工作区。
import { describe, expect, it, vi } from 'vitest'
import {
  buildDroppedReadReminder,
  ContextCompactor,
} from '../src/renderer/src/agent/engine/context-compactor'
import type { AgentMessage, ContentBlock, ToolResultBlock, ToolUseBlock } from '../src/renderer/src/types/agent'

const AT = '2026-09-29T00:00:00.000Z'
let seq = 0

const text = (t: string): ContentBlock => ({ type: 'text', text: t })

function readCycle(i: number, opts: {
  resultContent: string
  isError?: boolean
  noResultId?: boolean
  toolName?: string
}): AgentMessage[] {
  const tu: ToolUseBlock = {
    type: 'tool_use', id: `tu${i}`, name: opts.toolName ?? 'read',
    input: { file_path: `f-${i}.txt` },
  }
  const tr: ToolResultBlock = {
    type: 'tool_result', tool_use_id: `tu${i}`, content: opts.resultContent,
    ...(opts.isError ? { is_error: true } : {}),
    ...(opts.noResultId ? {} : { tool_result_id: `rid-${i}` }),
  }
  return [
    { id: `a${++seq}`, role: 'assistant', createdAt: AT, contentBlocks: [tu] },
    { id: `u${++seq}`, role: 'user', createdAt: AT, contentBlocks: [tr] },
  ]
}

describe('buildDroppedReadReminder: pure function', () => {
  it('lists dropped successful reads newest-first with their tool_result_id', () => {
    const dropped = [
      ...readCycle(0, { resultContent: 'a'.repeat(100) }),
      ...readCycle(1, { resultContent: 'b'.repeat(100) }),
    ]
    const reminder = buildDroppedReadReminder(dropped, [])
    expect(reminder).not.toBeNull()
    expect(reminder).toContain('tool_result_search')
    const ids = (reminder as string).match(/rid-\d/g)
    expect(ids).toEqual(['rid-1', 'rid-0']) // newest first
    expect(reminder).toContain('f-0.txt')
    expect(reminder).toContain('f-1.txt')
  })

  it('skips error results, placeholder contents, and results without a persisted id', () => {
    const dropped = [
      ...readCycle(0, { resultContent: 'boom', isError: true }),
      ...readCycle(1, { resultContent: '[tool_result_id: rid-old] — nano already pointed here' }),
      ...readCycle(2, { resultContent: 'no id minted', noResultId: true }),
      ...readCycle(3, { resultContent: 'good content' }),
    ]
    const reminder = buildDroppedReadReminder(dropped, [])
    expect(reminder).not.toBeNull()
    expect(reminder).toContain('rid-3')
    expect(reminder).not.toContain('rid-0')
    expect(reminder).not.toContain('rid-1')
    expect(reminder).not.toContain('rid-2')
  })

  it('skips reads whose result is still visible in the kept tail — full or nano-placeholder form', () => {
    const dropped = [
      ...readCycle(0, { resultContent: 'kept whole in the tail' }),
      ...readCycle(1, { resultContent: 'x'.repeat(100) }),
      ...readCycle(2, { resultContent: 'kept as a placeholder in the tail' }),
    ]
    const tu2: ToolUseBlock = { type: 'tool_use', id: 'tu9', name: 'read', input: { file_path: 'other.txt' } }
    const truncated: AgentMessage[] = [
      { id: `k0${seq}`, role: 'user', createdAt: AT, contentBlocks: [
        { type: 'tool_result', tool_use_id: 'tu0', content: 'kept whole in the tail', tool_result_id: 'rid-0' },
        { type: 'tool_result', tool_use_id: 'tu2', content: '[tool_result_id: rid-2] (nano placeholder)', tool_result_id: 'rid-2' },
      ] as ContentBlock[] },
      { id: `k1${seq}`, role: 'assistant', createdAt: AT, contentBlocks: [tu2] },
    ]
    const reminder = buildDroppedReadReminder(dropped, truncated)
    expect(reminder).not.toBeNull()
    expect(reminder).toContain('rid-1')
    expect(reminder).not.toContain('rid-0') // full content visible → no reminder needed
    expect(reminder).not.toContain('rid-2') // the placeholder IS its own pointer
  })

  it('dedupes by file path keeping the newest read, and caps at 10 with an overflow note', () => {
    const dropped: AgentMessage[] = []
    for (let i = 0; i < 13; i++) {
      // same path f-dup.txt read three times (i = 2, 7, 12) — newest wins
      dropped.push(...readCycle(i, { resultContent: 'c'.repeat(50) }))
      if (i === 2 || i === 7 || i === 12) {
        dropped.pop()
        dropped.pop()
        dropped.push(
          { id: `da${++seq}`, role: 'assistant', createdAt: AT, contentBlocks: [{ type: 'tool_use', id: `tu${i}`, name: 'read', input: { file_path: 'f-dup.txt' } } as ContentBlock] },
          { id: `du${++seq}`, role: 'user', createdAt: AT, contentBlocks: [{ type: 'tool_result', tool_use_id: `tu${i}`, content: `dup-${i}`, tool_result_id: `rid-${i}` } as ContentBlock] },
        )
      }
    }
    // Unique paths: the replaced reads (i=2,7,12) removed f-2/f-7/f-12, so
    // f-0,f-1,f-3..f-6,f-8..f-11 (10) + f-dup (1) = 11; the 10-line cap leaves 1 over.
    const reminder = buildDroppedReadReminder(dropped, []) as string
    const pathLines = reminder.split('\n').filter((l) => l.startsWith('- '))
    expect(pathLines).toHaveLength(10) // the cap
    const dupMatches = reminder.match(/f-dup\.txt（tool_result_id: rid-\d+）/g)
    expect(dupMatches).toHaveLength(1)
    expect(dupMatches![0]).toContain('rid-12') // the newest dup read wins
    expect(reminder).toContain('另有 1 个更早的已归档读取未列出')
  })

  it('returns null when nothing qualifies', () => {
    expect(buildDroppedReadReminder([], [])).toBeNull()
    const nonRead = readCycle(0, { resultContent: 'ok', toolName: 'exec' })
    expect(buildDroppedReadReminder(nonRead, [])).toBeNull()
  })
})

describe('injectHistorySummaryInto: the reminder rides the compensation region', () => {
  function makeCompactor(messages: AgentMessage[]) {
    const runHistorySummary = vi.fn(async () => '摘要内容')
    const compactor = new ContextCompactor({ runHistorySummary, getMessages: () => messages })
    return { compactor, runHistorySummary }
  }

  it('places the reminder after the summary and before the kept tail', async () => {
    const dropped = [
      ...readCycle(0, { resultContent: 'a'.repeat(300) }),
      ...readCycle(1, { resultContent: 'b'.repeat(300) }),
    ]
    const tail: AgentMessage[] = [
      { id: 'tail-user', role: 'user', createdAt: AT, contentBlocks: [text('当前指令')] },
    ]
    const original = [...dropped, ...tail]
    const { compactor } = makeCompactor(original)

    const final = await compactor.injectHistorySummary(original, [...dropped], tail)
    const kinds = final.map((m) => {
      const b0 = m.contentBlocks[0]
      const t = b0 && 'text' in b0 ? (b0 as { text: string }).text : ''
      if (t.includes('【历史对话摘要】')) return 'summary'
      if (t.includes('【已归档读取提醒】')) return 'reminder'
      if (t.includes('当前指令')) return 'tail'
      return 'replay-or-other'
    })
    expect(kinds).toEqual(['summary', 'reminder', 'tail'])
    expect(compactor.lastReminderCount).toBe(1)
  })

  it('emits no reminder message when nothing qualifies — the copy shape is unchanged', async () => {
    const dropped: AgentMessage[] = [
      { id: `x${++seq}`, role: 'user', createdAt: AT, contentBlocks: [text('用户指令 MARKER')] },
    ]
    const tail: AgentMessage[] = [
      { id: 'tail-user', role: 'user', createdAt: AT, contentBlocks: [text('当前指令')] },
    ]
    const original = [...dropped, ...tail]
    const { compactor } = makeCompactor(original)

    const final = await compactor.injectHistorySummary(original, [...dropped], tail)
    expect(final.some((m) => (m.contentBlocks[0] as { text?: string }).text?.includes('【已归档读取提醒】'))).toBe(false)
    expect(compactor.lastReminderCount).toBe(0)
  })

  it('the request path tags read_reminder into strategies, excluding the reminder message from the summary flag', async () => {
    // Wire-level shape check: the engine's strategy derivation is
    //   summary iff final.length > truncated.length + (reminder ? 1 : 0).
    // Replayed user messages also add length, so build a case with BOTH:
    // one replayed user message + one reminder.
    const dropped = [
      { id: `rp${++seq}`, role: 'user', createdAt: AT, contentBlocks: [text('被丢的用户意图')] },
      ...readCycle(0, { resultContent: 'c'.repeat(200) }),
    ]
    const tail: AgentMessage[] = [{ id: 'tail-user', role: 'user', createdAt: AT, contentBlocks: [text('当前指令')] }]
    const original = [...dropped, ...tail]
    const { compactor } = makeCompactor(original)

    const final = await compactor.injectHistorySummary(original, [...dropped], tail)
    const replays = compactor.lastInjectReplayCount // 1
    const reminders = compactor.lastReminderCount // 1
    expect(replays).toBe(1)
    expect(replays + reminders).toBe(2)
    expect(final.length).toBe(tail.length + replays + reminders + 1) // +1 = the summary message
    // The reminder line carries the retrieval pointer contract.
    const reminder = final.find((m) => (m.contentBlocks[0] as { text?: string }).text?.includes('【已归档读取提醒】'))
    expect((reminder!.contentBlocks[0] as { text: string }).text).toContain('rid-0')
  })
})
