// The load-freeze half of the 0.4.1 report ("加载对话会卡死"). The mechanism:
// tool_result full text lives ONLY in the tool_results table (sanitizeToolResults
// blanks the inline copy on save), so a child conversation full of whole-file
// `read` results was re-read in full by every capped hydrate — the 2000-char
// cap was applied in JS after SQLite had already materialised every body.
// The cap now rides INTO the SQL, and the conversation-open path reads the
// rows once instead of twice. Node-env vitest cannot open the real DB
// (better-sqlite3 is Electron-ABI), so the wiring is source-scanned — with
// marker strings specific enough that reverting either half fails here.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

describe('hydrateConversation applies the cap in SQL', () => {
  it('the capped branch selects substr(content, …), the full branch stays verbatim', () => {
    const db = src('src/main/storage/conversation.db.ts')
    expect(db).toContain("'SELECT ref_id, substr(content, 1, ?) AS content, is_error FROM tool_results WHERE conversation_id = ?'")
    expect(db).toContain("'SELECT ref_id, content, is_error FROM tool_results WHERE conversation_id = ?'")
  })

  it('the uncapped call path (continuing a conversation) is unchanged', () => {
    const db = src('src/main/storage/conversation.db.ts')
    expect(db).toContain('export function hydrateConversation(id: string, maxContentLength?: number)')
  })
})

describe('opening a conversation reads the rows once', () => {
  it('the renderer goes straight to hydrateConversation — no getConversation pre-pass', () => {
    const persistence = src('src/renderer/src/hooks/useConversationPersistence.ts')
    expect(persistence).toContain('window.electronAPI.hydrateConversation(key).then')
    expect(persistence).not.toContain('window.electronAPI.getConversation(key).then')
  })
})

describe('the context ring reads the shared estimator', () => {
  it('estimateContextUsed anchors on input_tokens and prices the tail post-nano', () => {
    // The ring shows what the model sees: the last real request's priced size
    // (persisted input_tokens) plus the tail since — priced through the nano
    // rules (estimateAfterNanoTokens), because that is how the next request
    // carries it (2026-10-24; raw-tail pricing over-read by exactly the
    // compressible share, 79–96% shown against a ~60% wire). The max-guarded
    // contextTokensOf stays the COMPACTOR's trigger input — taking it here
    // pinned the ring at whole-transcript pressure forever (775.2K shown
    // against an 88K wire request, conv_20260927170026, 2026-09-28).
    const ring = src('src/renderer/src/components/chat/ContextRing.tsx')
    expect(ring).toContain('messages[i].inputTokens')
    // The window and the anchor ride along: the merged fit gate judges the
    // whole copy, so a tail slice must be priced against `t` (W1).
    expect(ring).toContain('estimateAfterNanoTokens(messages.slice(i + 1), contextLength, t)')
    expect(ring).not.toContain('contextTokensOf(')
    expect(ring).not.toContain('text.length / 2')
    expect(ring).not.toContain('inputTokens != null')
  })

  it('the CJK-blind chars/3.5 estimator is gone from the compactor', () => {
    const compactor = src('src/renderer/src/agent/engine/context-compactor.ts')
    expect(compactor).not.toContain('total / 3.5')
    expect(compactor).toContain('estimateMessagesTokens')
  })
})
