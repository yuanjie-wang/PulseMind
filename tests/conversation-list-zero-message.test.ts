// ── 零消息会话不进侧栏（2026-11-04 用户裁定「走克制版」）──
//
// The user reported seeing a browser task container in the LEFT history list
// after a restart. The container itself writes nothing (no engine ⇒ nothing to
// snapshot), but ANY binding write — workspace mint at real session creation,
// 授权 / 模型 pick, project / expert bind — stub-inserts a minimal row
// (`stubInsertConversation`: title '新对话', type 'normal', zero messages), and
// `listConversations` had no message predicate, so those stubs survived restart
// as 新对话 entries. The restrained fix is the rule the other two surfaces
// already used: `listConversationsByOrigin` and the welcome slices' history
// cards both demand `messageCount > 0`. 搜索中心's keyword search reads the same
// table and therefore takes the same predicate — a stub whose title matched a
// query would otherwise come back as a hit that opens onto nothing.
//
// The DB layer is better-sqlite3 (Electron ABI — not loadable under `npm test`),
// so the predicate is pinned by scan; `scripts/probe-conversation-project-stub.mjs`
// and `scripts/probe-conversation-profile.mjs` drive the behaviour against a
// real database (stub invisible → first message → visible with its binding).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const CONV_DB = readFileSync(join(REPO, 'src', 'main', 'storage', 'conversation.db.ts'), 'utf-8')
const PERSISTENCE = readFileSync(join(REPO, 'src', 'renderer', 'src', 'hooks', 'useConversationPersistence.ts'), 'utf-8')

describe('listConversations drops zero-message rows', () => {
  it('carries the EXISTS(messages) predicate between the origin filter and the ordering', () => {
    // Non-vacuous: dropping the EXISTS line fails the match (the only other
    // occurrences sit EARLIER in the file, and the pattern anchors on
    // `WHERE c.type = 'normal'` first, so a lazy span cannot reach back to
    // them); dropping the hosted-origin filter fails the first anchor.
    expect(CONV_DB).toMatch(
      /WHERE c\.type = 'normal'\s*\n\s*AND \(c\.origin IS NULL OR c\.origin NOT IN \(\$\{originPlaceholders\}\)\)[\s\S]*?AND EXISTS \(SELECT 1 FROM messages m WHERE m\.conversation_id = c\.id\)\s*\n\s*ORDER BY c\.pinned DESC, c\.created_at DESC/,
    )
  })

  it('is the same rule the extension panel list already applied (one rule, two surfaces)', () => {
    // Not a re-derivation: if these ever diverge, a session shows up in one
    // list and not the other, which is exactly the class of bug the whole
    // 历史会话 predicate was introduced to stop.
    const pin = /AND EXISTS \(SELECT 1 FROM messages m WHERE m\.conversation_id = c\.id\)/
    expect(CONV_DB.match(new RegExp(pin, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(CONV_DB).toMatch(/WHERE c\.origin = \?\s*\n\s*AND EXISTS \(SELECT 1 FROM messages m WHERE m\.conversation_id = c\.id\)/)
  })

  it('leaves the stub writers alone — the filter hides the row, it does not prevent it', () => {
    // The stub row is the ONLY carrier of a pre-materialization binding
    // (project / expert / approval / profile / workspace chosen before the first
    // message). Filtering it out of the list must not become "stop writing it",
    // or the first ask loses its 授权 / 模型 / 项目.
    expect(CONV_DB).toContain('function stubInsertConversation(')
    expect(CONV_DB).toContain('stubInsertConversation(id, { profile_id: profileId })')
    expect(CONV_DB).toContain('stubInsertConversation(id, { approval_mode: mode })')
  })

  it('the search center applies the same predicate (a stub must not return through search)', () => {
    // The sidebar is not the only reader: 搜索中心's conversation keyword search
    // had no message predicate either, so a 新对话 stub whose title matched the
    // query came back as a hit with nothing behind it. The condition must sit in
    // that search's `conditions` array (the outer table there is unaliased
    // `conversations`), otherwise the list fix is a one-door fix.
    expect(CONV_DB).toMatch(
      /const conditions: string\[\] = \[`type = 'normal' AND \(\$\{terms\.join\(' OR '\)\}\)`, hostedOriginExclusion\(\),[\s\S]{0,600}?'EXISTS \(SELECT 1 FROM messages m WHERE m\.conversation_id = conversations\.id\)'\]/,
    )
  })

  it('the sidebar seeds from that list, so the filter is the only gate', () => {
    // The optimistic in-memory entry (new conversation / browser container) is
    // a different surface and stays: it is what makes the freshly opened
    // container reachable before anything is persisted. What must not exist is
    // a second, DB-shaped path that reintroduces zero-message rows after a
    // restart — the sidebar takes exactly what the list returns.
    expect(PERSISTENCE).toContain('window.electronAPI.listConversations()')
    expect(PERSISTENCE).toMatch(/setConversations\(\s*sortConversations\(/)
  })
})
