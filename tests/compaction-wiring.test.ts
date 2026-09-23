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
    expectLines(sessionManager, /onCompaction: \(event: CompactionEvent\) => this\.emit\(sessionId, \{ type: 'compaction', event \}\)/, 'session-manager.ts')
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
    expectLines(ring, /export function projectContextUsed\(messages: AgentMessage\[\], compaction: CompactionEvent \| null \| undefined\): number/, 'ContextRing.tsx')
    expectLines(chatView, /projectContextUsed\(messages, lastCompaction\)/, 'ChatView.tsx')
    expectLines(app, /lastCompaction=\{lastCompaction\}/, 'App.tsx')
    expectLines(chatView, /lastCompaction=\{lastCompaction\}/, 'ChatView.tsx', 2) // welcome + main composers
    expectLines(inputArea, /lastCompaction\?: CompactionEvent \| null/, 'InputArea.tsx')
    expectLines(inputArea, /t\('chatView\.compaction\.chip'/, 'InputArea.tsx')
    expectLines(inputArea, /t\('chatView\.compaction\.chipPending'/, 'InputArea.tsx')
  })

  it('the engine emits the request-time event and the post-turn hook fires at turn end', () => {
    expectLines(executionFlow, /this\.engine\.schedulePostTurnCompaction\(\)/, 'execution-flow.ts')
    expectLines(engine, /schedulePostTurnCompaction = \(\): void =>/, 'AgentEngine.ts')
    expectLines(engine, /this\.callbacks\.onCompaction\?\.\(event\)/, 'AgentEngine.ts', 2) // request path + compactNow
    expectLines(engine, /onCompaction\?: \(event: CompactionEvent\) => void/, 'AgentEngine.ts')
    // The compactor owns the two P0 mechanisms themselves.
    expectLines(compactor, /export function collectUserReplays/, 'context-compactor.ts')
    expectLines(compactor, /USER_REPLAY_BUDGET_TOKENS = 10_000/, 'context-compactor.ts')
    expectLines(compactor, /POST_TURN_COMPACT_USED_RATIO = 0\.75/, 'context-compactor.ts')
    expectLines(compactor, /async prewarm\(options: \{/, 'context-compactor.ts')
    expectLines(summaryAgent, /\[摘要额外要求\]/, 'HistorySummaryAgent.ts')
  })

  it('both locales carry the chip and feedback strings', () => {
    for (const locale of ['zh', 'en']) {
      const table = src(`src/renderer/src/i18n/locales/${locale}.ts`)
      expectLines(table, /chip: '/, `${locale}.ts`)
      expectLines(table, /chipPending: '/, `${locale}.ts`)
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
