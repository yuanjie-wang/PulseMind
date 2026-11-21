// ── Turn-level stats aggregate (2026-11-21 user ruling) ─────────────────
// 「把耗时去掉，改为最终完成输出的时间，和输入消息的时间对应；期望要回合级的
// 聚合」。耗时档位退役的理由在 message-stats.ts 头部（scopes 混装：同一行里
// token 是单请求的、耗时却是整轮的）；替代形态 = 完成时间戳（与用户气泡的
// 发送时间同形，成对可读）+ 回合 Σtoken。本文件钉两层：
//   1. collectTurnMessageStats 的聚合语义（shared/agent-session 纯函数——
//      桌面 ChatView 与扩展面板共用同一份，漂移无路可走）；
//   2. 两个客户端的接线（回合最后一段拿聚合、中间段撤行、无回合宿主回落）。

import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectTurnMessageStats } from '../src/shared/agent-session/message-stats'
import { stripMessageIdSuffix } from '../src/renderer/src/components/chat/message-segments'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const REPO = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(REPO, p), 'utf-8')

const text = (t: string): ContentBlock => ({ type: 'text', text: t })
const toolResult = (id: string): ContentBlock => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })

let seq = 0
const user = (at = '2026-11-21T10:00:00.000Z', withResult = false): AgentMessage => ({
  id: `u${++seq}`,
  role: 'user',
  contentBlocks: withResult ? [toolResult(`t${seq}`)] : [text('跑一下这个任务')],
  createdAt: at
})
const assistant = (opts: { input?: number; output?: number; hit?: number; at?: string; withTool?: boolean; autoSummary?: boolean } = {}): AgentMessage => ({
  id: `a${++seq}`,
  role: 'assistant',
  contentBlocks: opts.withTool
    ? [{ type: 'tool_use', id: `t${seq + 1000}`, name: 'read', input: {} } as ContentBlock]
    : [text('答案')],
  createdAt: opts.at ?? '2026-11-21T10:01:00.000Z',
  inputTokens: opts.input,
  outputTokens: opts.output,
  promptCacheHitTokens: opts.hit,
  ...(opts.autoSummary ? { autoSummary: true as const } : {})
})

describe('collectTurnMessageStats: the turn aggregate', () => {
  // id 由模块级 seq 铸造——每个用例归零，键名才与用例注释里的 u1/a2 对得上。
  beforeEach(() => { seq = 0 })

  it('sums every request of the turn; the key and timestamp are the FINAL assistant message', () => {
    // 三请求回合：↑=100+200+400（每次请求的完整 prompt 都计费，求和才是回合
    // 真实搬入量）、↓=10+20+30、命中=80+160+240。
    const msgs = [
      user(),
      assistant({ input: 100, output: 10, hit: 80, withTool: true }),
      assistant({ input: 200, output: 20, hit: 160, withTool: true }),
      assistant({ input: 400, output: 30, hit: 240, at: '2026-11-21T10:03:00.000Z' })
    ]
    const stats = collectTurnMessageStats(msgs)
    expect(stats.size).toBe(1)
    const entry = stats.get('a4') // 键 = 回合最后一条 assistant 消息（seq 计数：u1,a2,a3,a4）
    expect(entry).toEqual({
      completedAt: '2026-11-21T10:03:00.000Z', // 末次请求完成 = 输出完成时刻
      inputTokens: 700,
      outputTokens: 60,
      promptCacheHitTokens: 480
    })
  })

  it('tool_result carriers do not open a turn; a plain user message does', () => {
    const msgs = [
      user('2026-11-21T10:00:00.000Z'),
      assistant({ input: 100, output: 10, withTool: true }),
      user('2026-11-21T10:00:30.000Z', true), // tool_result 载体——同回合
      assistant({ input: 200, output: 20, withTool: true }),
      user('2026-11-21T10:05:00.000Z'), // 新回合
      assistant({ input: 400, output: 40 })
    ]
    const stats = collectTurnMessageStats(msgs)
    expect(stats.size).toBe(2)
    expect(stats.get('a4')).toMatchObject({ inputTokens: 300, outputTokens: 30 }) // u1,a2,u3,a4：tool_result 载体不分回合
    expect(stats.get('a6')).toMatchObject({ inputTokens: 400, outputTokens: 40 })
  })

  it('a turn whose requests reported no usage still carries its completion timestamp', () => {
    // 时间是逐消息事实，不是用量报告：网关不报 usage 的回合也有完成时刻。
    const stats = collectTurnMessageStats([user(), assistant({ at: '2026-11-21T10:02:00.000Z' })])
    expect(stats.get('a2')).toEqual({
      completedAt: '2026-11-21T10:02:00.000Z',
      inputTokens: undefined,
      outputTokens: undefined,
      promptCacheHitTokens: undefined
    })
  })

  it('skips autoSummary sidecar rows and turns without any assistant message', () => {
    const msgs = [user(), assistant({ autoSummary: true, input: 9, output: 9 })]
    const stats = collectTurnMessageStats(msgs)
    expect(stats.size).toBe(0)
    expect(collectTurnMessageStats([user(), user()]).size).toBe(0)
  })

  it('the desktop lookup strips the segment suffix off the segment message id', () => {
    // 桌面段的 msg.id 带 __text/__ask 等后缀；聚合键是裸消息 id。
    expect(stripMessageIdSuffix('a3__text')).toBe('a3')
    expect(stripMessageIdSuffix('a3__ask')).toBe('a3')
    expect(stripMessageIdSuffix('a3')).toBe('a3')
  })
})

describe('turn stats wiring: both clients hang the aggregate on the turn-final row', () => {
  const group = read('src/renderer/src/components/chat/MessageGroup.tsx')
  const segmentView = read('src/renderer/src/components/chat/SegmentView.tsx')
  const chatView = read('src/renderer/src/components/layout/ChatView.tsx')
  const panelTranscript = read('src/extension/ui/Transcript.tsx')
  const panelBlocks = read('src/extension/ui/MessageBlocks.tsx')
  const zh = read('src/renderer/src/i18n/locales/zh.ts')
  const en = read('src/renderer/src/i18n/locales/en.ts')

  it('MessageGroup renders the completion stamp and the turn Σ, no duration anywhere', () => {
    // 统计源 = turnStats ?? msg（无回合宿主回落逐消息）；完成时间走
    // describeSentAtText——与用户气泡发送时间同一格式化通道。completedAt 只在
    // TurnMessageStats 上（AgentMessage 无此字段），取值必须走 turnStats?.
    // 的可选链回落 msg.createdAt——union 上的直接访问过不了 tsc。
    expect(group).toContain('const stats = turnStats ?? msg')
    expect(group).toContain('describeSentAtText(turnStats?.completedAt ?? msg.createdAt, t)')
    expect(group).toContain('describeSentAtTitle(turnStats?.completedAt ?? msg.createdAt, t)')
    expect(group).toContain('if (hideStats) return null')
    // 耗时不残留：formatDuration 与 processingMs 都不再上屏。
    expect(group).not.toMatch(/formatDuration\b/)
    expect(group).not.toContain('msg.processingMs')
    expect(group).toContain('cacheHitRate(stats.promptCacheHitTokens, stats.inputTokens)')
  })

  it('SegmentView threads both props; hosts without them keep the fallback', () => {
    expect(segmentView).toContain('turnStats?: TurnMessageStats')
    expect(segmentView).toContain('hideStats?: boolean')
    expect(segmentView).toContain('turnStats={turnStats}')
    expect(segmentView).toContain('hideStats={hideStats}')
  })

  it('ChatView hands the aggregate to the settled turn-final segment only', () => {
    // 聚合按 messages 身份推导（不逐 token 重建）；liveTurn 先于 renderSegment
    // （useCallback 依赖它——运行中没有「完成时间」可言）。
    expect(chatView).toContain('collectTurnMessageStats(messages)')
    expect(chatView.match(/const liveTurn = !routineEntryAllowed/g)?.length).toBe(1)
    const renderAt = chatView.indexOf('const renderSegment = useCallback')
    const liveAt = chatView.indexOf('const liveTurn = !routineEntryAllowed')
    expect(liveAt).toBeGreaterThan(-1)
    expect(liveAt).toBeLessThan(renderAt)
    // 落点：回合最后一段（lastSegmentOfTurn）且回合已落定（!== liveTurn），
    // 键 = 剥后缀的段消息 id；中间段 hideStats。
    expect(chatView).toContain('turnStatsById.get(stripMessageIdSuffix(seg.msg.id))')
    expect(chatView).toContain('turnPlacement.lastSegmentOfTurn[segTurn] === index')
    expect(chatView).toContain('hideStats={isAssistantSingle && !(isTurnFinal && turnSettled) ? true : undefined}')
    expect(chatView).toContain('turnStats={turnStats}')
  })

  it('the extension panel reads the same aggregate and formats the same stamp', () => {
    expect(panelTranscript).toContain('collectTurnMessageStats(session.messages)')
    expect(panelTranscript).toContain('turnStats={statsById.get(message.id)}')
    // ActionRow 的行消息就是聚合键（actionRowIds 的判定与聚合同落点）。
    expect(panelBlocks).toContain('const stats = turnStats ?? msg')
    expect(panelBlocks).toContain('describeSentAt(turnStats?.completedAt ?? msg.createdAt)')
    expect(panelBlocks).not.toMatch(/formatDuration\b/)
    expect(panelBlocks).not.toContain('msg.processingMs')
  })

  it('the processingTime i18n key is retired from both locales', () => {
    expect(zh).not.toContain('processingTime')
    expect(en).not.toContain('processingTime')
  })
})
