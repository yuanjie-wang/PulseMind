import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// ── cached_tokens 落库（2026-10-24）─────────────────────────────────────────
// The DB layer itself cannot run under plain Node (better-sqlite3 is
// Electron-ABI — the known coverage gap), so this pins the WIRING by source
// scan, the same discipline as packed-node-modules' wiring cases: the provider
// reports the cache hit count, the engine carries it on the assistant message,
// and everything between that message and the cached_tokens column must pass
// it along. The motivation was the 410-request translation task of
// 2026-10-24: 83% real cache hit, ZERO of it reconstructable afterwards
// because the dumps prune at 60 files and the DB dropped the dimension —
// the audit had to be rebuilt by hand from the surviving tail.

const ROOT = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

describe('cached_tokens persistence wiring', () => {
  it('schema: both tables carry the column, with a migration for existing databases', () => {
    const src = read('src/main/storage/database.ts')
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS messages \([\s\S]*?cached_tokens\s+INTEGER/)
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS token_usage \([\s\S]*?cached_tokens\s+INTEGER NOT NULL DEFAULT 0/)
    expect(src).toContain("ALTER TABLE messages ADD COLUMN cached_tokens INTEGER")
    expect(src).toContain("ALTER TABLE token_usage ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0")
  })

  it('conversation.db: both write paths upsert the column and token_usage records it', () => {
    const src = read('src/main/storage/conversation.db.ts')
    const upserts = src.match(/INSERT INTO messages[^;]+/g) ?? []
    // Two full-message write paths (saveConversation + appendConversationMessages).
    // The third INSERT (auto-summary injection) writes no tokens by design.
    const tokenUpserts = upserts.filter(s => s.includes('cached_tokens'))
    expect(tokenUpserts).toHaveLength(2)
    for (const upsert of tokenUpserts) {
      expect(upsert).toMatch(/\(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)/)
      expect(upsert).toContain('cached_tokens = excluded.cached_tokens')
    }
    const tokenUsage = src.match(/INSERT OR REPLACE INTO token_usage[^']+/g) ?? []
    expect(tokenUsage).toHaveLength(2)
    for (const insert of tokenUsage) {
      expect(insert).toContain('cached_tokens')
    }
    // And every write feeds the column from the same message field: two
    // upsertMsg.run sites + two insertTokenUsage.run sites.
    expect(src.match(/msg\.promptCacheHitTokens/g)?.length).toBe(4)
  })

  it('conversation.db: the load path reads the column back into promptCacheHitTokens', () => {
    const src = read('src/main/storage/conversation.db.ts')
    expect(src).toMatch(/SELECT id, role, content, content_blocks[\s\S]*?cached_tokens/)
    expect(src).toContain('promptCacheHitTokens: m.cached_tokens ?? undefined')
  })

  it('stats: the aggregate queries SUM the column so in-app audit needs no dump files', () => {
    const src = read('src/main/storage/stats.db.ts')
    expect(src.match(/SUM\(cached_tokens\)/g)?.length).toBe(3)
    expect(src).toContain('cachedTokens: number')
  })

  it('conversion: the field survives AgentMessage ↔ persisted Message in both directions', () => {
    const src = read('src/renderer/src/utils/message-utils.ts')
    expect(src).toContain('promptCacheHitTokens: m.promptCacheHitTokens')
    // appears once in each converter (agent→persisted, persisted→agent)
    expect(src.match(/promptCacheHitTokens: m\.promptCacheHitTokens/g)?.length).toBe(2)
  })

  it('adapter: the OpenAI parser reads BOTH cache-hit wire forms (zen nests, DeepSeek is top-level)', () => {
    const src = read('src/renderer/src/llm/OpenAIAdapter.ts')
    expect(src).toContain('prompt_cache_hit_tokens')
    expect(src).toMatch(/prompt_tokens_details/)

    const dumpSrc = read('src/main/llm/request-dump.ts')
    // The dump log line must not silently omit cached= on nested-form gateways.
    expect(dumpSrc).toMatch(/prompt_tokens_details/)
    expect(dumpSrc).toMatch(/merged\.cached_tokens/)
  })
})
