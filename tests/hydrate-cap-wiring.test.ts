// PLAN-long-task-perf M3-T3 — the deliverables hydrate's content cap.
// hydrateConversation runs on better-sqlite3 (Electron-ABI), so the behaviour
// itself is probed by the ELECTRON_RUN_AS_NODE probes; what node-env vitest
// CAN pin is the wiring: the cap is an optional parameter whose default keeps
// the continuation path byte-identical, and the deliverables BFS passes one.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

describe('hydrate content cap wiring (M3-T3)', () => {
  const db = read('src/main/storage/conversation.db.ts')
  const preload = read('src/preload/index.ts')
  const hook = read('src/renderer/src/hooks/useDeliverables.ts')

  it('the cap is optional and the default path is untouched', () => {
    expect(db).toMatch(/hydrateConversation\(id: string, maxContentLength\?: number\)/)
    // the truncation must be guarded — undefined cap ⇒ original content
    expect(db).toMatch(/maxContentLength != null && data\.content\.length > maxContentLength/)
  })

  it('preload forwards the optional argument', () => {
    expect(preload).toMatch(/hydrateConversation: \(id: string, maxContentLength\?: number\)/)
    expect(preload).toMatch(/CONVERSATION_HYDRATE, id, maxContentLength\)/)
  })

  it('the deliverables BFS passes a finite cap; continuation callers stay uncapped', () => {
    expect(hook).toMatch(/hydrateConversation\(id, \d+\)/)
    // the OTHER hydrate call sites keep the one-argument shape — continuation
    // (AgentEngine's next turn) and the sub-agent session view need full bodies
    for (const file of [
      'src/renderer/src/hooks/useConversationPersistence.ts',
      'src/renderer/src/hooks/useHostedAgentSession.ts',
      'src/renderer/src/components/subagent/SubAgentSessionView.tsx',
    ]) {
      const src = read(file)
      // single-argument call (any identifier arg) = the uncapped continuation shape
      const calls = src.match(/hydrateConversation\([a-zA-Z]\w*\)/g) ?? []
      expect(calls.length).toBeGreaterThan(0)
    }
  })
})
