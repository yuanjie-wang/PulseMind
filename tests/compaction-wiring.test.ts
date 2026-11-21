import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// vitest here is node-env: the hooks and views cannot be mounted, so the
// wiring is pinned the way tests/pending-approval.test.ts does it — source
// scans over the exact lines that carry each hop, with a non-vacuity guard.

const root = join(__dirname, '..')
const src = (p: string): string => readFileSync(join(root, p), 'utf8')

/** Every scan below must match at least once; a broken regex cannot pass by
 *  finding nothing (the same discipline pending-approval.test.ts uses). The
 *  count comes from a global scan — a non-global match() caps at 1 and would
 *  let "this appears exactly twice" assertions pass vacuously. */
function expectLines(source: string, pattern: RegExp, file: string, min = 1): RegExpMatchArray {
  const matches = source.match(new RegExp(pattern.source, 'g'))
  expect(matches, `${file} should contain ${pattern} (found ${matches?.length ?? 0})`).not.toBeNull()
  expect(matches!.length, `${file}: ${pattern}`).toBeGreaterThanOrEqual(min)
  return matches!
}

/** Slice a handler body out by brace pairing from `from`. A character window
 *  ({0,400} / at + 500) is hostage to comment length — the 2026-11-17 try/catch
 *  and its explanation pushed onCompaction past every such budget and broke the
 *  very assertion that guarded it. Pairing is immune to comments and nesting, so
 *  it keeps pinning "same handler" without a brittle span. `${…}` and
 *  `{ type: … }` inside strings are balanced, so the depth stays net-zero here. */
function handlerBody(source: string, from: number): string {
  const open = source.indexOf('{', from)
  expect(open, 'handler must have a body').toBeGreaterThan(-1)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  throw new Error('unbalanced handler body')
}

describe('compaction P0 wiring: engine → protocol → mirror → UI', () => {
  const payloads = src('src/shared/agent-protocol/payloads.ts')
  const mirror = src('src/shared/agent-session/mirror.ts')
  const sessionManager = src('src/main/agent/session-manager.ts')
  const engineHook = src('src/renderer/src/hooks/useConversationEngine.ts')
  const controller = src('src/renderer/src/hooks/useChatController.ts')
  const app = src('src/renderer/src/App.tsx')
  const chatView = src('src/renderer/src/components/layout/ChatView.tsx')
  const inputArea = src('src/renderer/src/components/chat/InputArea.tsx')
  const ring = src('src/renderer/src/components/chat/ContextRing.tsx')
  const executionFlow = src('src/renderer/src/agent/engine/execution-flow.ts')
  const engine = src('src/renderer/src/agent/AgentEngine.ts')
  const compactor = src('src/renderer/src/agent/engine/context-compactor.ts')
  const summaryAgent = src('src/renderer/src/agent/one-shot-agent/HistorySummaryAgent.ts')

  it('protocol carries the compaction event and the mirror folds it', () => {
    expectLines(payloads, /export interface CompactionEvent/, 'payloads.ts')
    expectLines(payloads, /\| \{ type: 'compaction'; event: CompactionEvent \}/, 'payloads.ts')
    expectLines(payloads, /replayedUserMessages: number/, 'payloads.ts')
    // The fold keeps the chip state AND refreshes the persisted summary —
    // the post-turn prewarm appends no message, so the event is the only
    // carrier the save queue would ever see it through.
    expectLines(mirror, /case 'compaction': \{[\s\S]*?state\.lastCompaction = data\.event[\s\S]*?state\.historySummary = data\.event\.summary/, 'mirror.ts')
  })

  it('session-manager forwards onCompaction and whitelists compactNow', () => {
    // P1-B (2026-11-17) made this handler two steps — persist, then emit — so the
    // single-line form is gone by design. The scan is anchored by brace pairing
    // rather than a character span: the later try/catch and its comments pushed
    // onCompaction past every {0,400} budget and broke this very assertion.
    // compaction-persist.test.ts owns the strict order ("write before emit, emit
    // outside the guarded block"); this one only pins that both hops still live
    // in the same handler, with expectLines' non-vacuity guard on each.
    const at = sessionManager.indexOf('onCompaction:')
    expect(at, 'session-manager must forward onCompaction').toBeGreaterThan(-1)
    const body = handlerBody(sessionManager, at)
    expectLines(body, /setLastCompaction\(sessionId, event\)/, 'session-manager.ts onCompaction')
    expectLines(body, /this\.emit\(sessionId, \{ type: 'compaction', event \}\)/, 'session-manager.ts onCompaction')
    expectLines(sessionManager, /case 'compactNow': return engine\.compactNow\(args\[0\] as string \| undefined\)/, 'session-manager.ts')
  })

  it('the renderer handle forwards compactNow and mirrors the event into React state', () => {
    expectLines(engineHook, /agentSessionEngineCall\(convId, 'compactNow', \[instruction \?\? null\]\)/, 'useConversationEngine.ts')
    expectLines(engineHook, /if \(data\.type === 'compaction'\) setLastCompaction\(data\.event\)/, 'useConversationEngine.ts')
    // Switching conversations must swap the chip too — a stale one would
    // describe a compaction the user is no longer looking at.
    expectLines(engineHook, /setLastCompaction\(st\.lastCompaction\)/, 'useConversationEngine.ts')
    expectLines(engineHook, /setLastCompaction\(null\)/, 'useConversationEngine.ts')
  })

  it('handleRequest intercepts /compact before materialization and reports back', () => {
    expectLines(controller, /trimmedContent === '\/compact' \|\| trimmedContent\.startsWith\('\/compact '\)/, 'useChatController.ts')
    expectLines(controller, /\.compactNow\(instruction\)/, 'useChatController.ts')
    expectLines(controller, /conversationKeyOf\(convId\)/, 'useChatController.ts')
    expectLines(controller, /lastCompaction: engine\.lastCompaction/, 'useChatController.ts')
  })

  it('the chat surface projects the ring after compaction and renders the chip', () => {
    expectLines(ring, /export function projectContextUsed\(/, 'ContextRing.tsx')
    // The window reaches the projection (PLAN-nano-light-trigger-merge W1):
    // without it the merged fit gate never opens and the ring prices archived
    // results whole.
    expectLines(ring, /export function estimateContextUsed\(messages: AgentMessage\[\], contextLength\?: number\)/, 'ContextRing.tsx')
    // 不带尾逗号：钉的是「投影第三参拿到窗口」这个语义，不是行形态 ——
    // prettier（printWidth 160）会把 projectContextUsed 的多行签名折成单行，
    // 两种形态都必须放行（2026-11-21 折行实锤过一次）。
    expectLines(ring, /contextLength\?: number/, 'ContextRing.tsx')
    expectLines(chatView, /projectContextUsed\(messages, lastCompaction, contextLength\)/, 'ChatView.tsx')
    expectLines(app, /lastCompaction=\{lastCompaction\}/, 'App.tsx')
    expectLines(chatView, /lastCompaction=\{lastCompaction\}/, 'ChatView.tsx', 2) // welcome + main composers
    expectLines(inputArea, /lastCompaction\?: CompactionEvent \| null/, 'InputArea.tsx')
    // 外层已压缩 chip 已退役（user 2026-11-21：压缩信息只在 ContextRing 浮窗
    // 里展示）—— lastCompaction 仍由 InputArea 持有并透传给环，但外层 chip
    // 渲染与它的两句文案不许长回来。
    expectLines(inputArea, /<ContextRing[^>]*lastCompaction=\{lastCompaction\}/, 'InputArea.tsx')
    expect(inputArea).not.toContain('pm-collapse-chip')
    expect(inputArea).not.toContain('compactionLabel')
  })

  it('the engine emits the request-time event and the post-turn hook fires at turn end', () => {
    expectLines(executionFlow, /this\.engine\.schedulePostTurnCompaction\(\)/, 'execution-flow.ts')
    expectLines(engine, /schedulePostTurnCompaction = \(\): void =>/, 'AgentEngine.ts')
    // 2026-10-31 起五个发射点统一走 emitCompaction 漏斗（回调 + lastCompaction
    // 留存一体，扩展面板冷附着快照的载体）——直呼恰好一处（漏斗体内），
    // 旧钉「request + compactNow 两处直呼」随漏斗化作废。
    expectLines(engine, /this\.callbacks\.onCompaction\?\.\(event\)/, 'AgentEngine.ts', 1)
    expectLines(engine, /private emitCompaction\(event: CompactionEvent\): void/, 'AgentEngine.ts')
    expectLines(engine, /this\.lastCompaction = event/, 'AgentEngine.ts')
    expectLines(engine, /onCompaction\?: \(event: CompactionEvent\) => void/, 'AgentEngine.ts')
    // The compactor owns the two P0 mechanisms themselves.
    expectLines(compactor, /export function collectUserReplays/, 'context-compactor.ts')
    expectLines(compactor, /USER_REPLAY_BUDGET_TOKENS = 10_000/, 'context-compactor.ts')
    // 2026-11-21 epoch 重写：固定比例 0.75 退役 —— post-turn prewarm 不再读
    // 「用到几成」这个猜测，而是直接预测下一次切割的落点（`epochLines` 的
    // target）；手动压缩是唯一例外（0.60 常量，用户要求「压到位」）。
    expect(compactor).not.toContain('POST_TURN_COMPACT_USED_RATIO')
    expectLines(compactor, /const lines = this\.epochLines\(contextLength\)/, 'context-compactor.ts')
    expectLines(compactor, /EPOCH_MANUAL_TARGET_RATIO = 0\.60/, 'context-compactor.ts')
    // prewarm 只在后台，两处纪律：tool 触发是恢复路径不给 hard；一律不记账
    // （账本是请求路径的，prewarm 不写它 —— 见 compaction-wire-gate 的钉子）。
    expectLines(compactor, /allowHard: source !== 'tool'/, 'context-compactor.ts')
    expectLines(compactor, /async prewarm\(options: \{/, 'context-compactor.ts')
    expectLines(summaryAgent, /\[摘要额外要求\]/, 'HistorySummaryAgent.ts')
  })

  it('both locales carry the feedback strings (chip 文案已随 chip 退役)', () => {
    for (const locale of ['zh', 'en']) {
      const table = src(`src/renderer/src/i18n/locales/${locale}.ts`)
      // chip/chipPending/tooltip/tooltipZeroReplays 四键随外层 chip 退役删除
      // （user 2026-11-21）；留着死键就是邀请 run-on 句回来。反馈类键保留
      // （手动压缩的 toast 还在读）。
      expect(table).not.toContain('chip: ')
      expect(table).not.toContain('chipPending: ')
      expect(table).not.toContain('tooltipZeroReplays: ')
      expectLines(table, /noConversation: '/, `${locale}.ts`)
      expectLines(table, /busy: '/, `${locale}.ts`)
      expectLines(table, /done: '/, `${locale}.ts`)
      expectLines(table, /nothing: '/, `${locale}.ts`)
    }
  })

  it('non-vacuity: the scans read real files, not empty strings', () => {
    expect(payloads.length).toBeGreaterThan(1000)
    expect(sessionManager.length).toBeGreaterThan(10_000)
    expect(compactor.length).toBeGreaterThan(5_000)
  })
})
