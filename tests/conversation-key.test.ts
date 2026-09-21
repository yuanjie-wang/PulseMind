// ── "No conversation is open" is the empty string, not undefined ──
// `useXConversations` builds its store as
// `new ConversationStore(list, config?.defaultActiveConversationKey || '')`, so a
// fresh window (and every "new chat" that clears the key) reports
// `activeConversationKey === ''`. A `typeof key === 'string'` test therefore reads
// the empty string as an open conversation, and the composer's 授权 click went
// down the write path for an id that does not exist:
//
//   UPDATE conversations SET approval_mode = ? WHERE id = ''   → 0 rows
//   INSERT INTO conversations (id, …) VALUES ('', '新对话', …)  → the junk row
//
// Nothing then moved, because no list item carries the key `''` — the optimistic
// update matched nothing — which is the user-visible report "权限选择无法切换 /
// 还是切不动". Found in the real database: one such row, 0 messages, id `''`.
//
// Two layers again: the helper's behaviour runs for real here, and the absence of
// the bug's signature (a bare type test on the key) is asserted as source, because
// the renderer's hooks cannot be mounted in this vitest environment.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { conversationKeyOf } from '../src/shared/conversation-key'

describe('conversationKeyOf', () => {
  it('treats the empty string as "nothing is open"', () => {
    expect(conversationKeyOf('')).toBeUndefined()
  })

  it('treats a whitespace-only key the same way', () => {
    expect(conversationKeyOf('   ')).toBeUndefined()
  })

  it('passes a real key through, trimmed', () => {
    expect(conversationKeyOf('conv_20260915140227')).toBe('conv_20260915140227')
    expect(conversationKeyOf(' conv_1 ')).toBe('conv_1')
  })

  it('accepts an sdk key that arrives as a number', () => {
    expect(conversationKeyOf(7)).toBe('7')
  })

  it('rejects everything that cannot name a conversation', () => {
    for (const value of [undefined, null, NaN, Infinity, {}, [], true]) {
      expect(conversationKeyOf(value)).toBeUndefined()
    }
  })
})

const REPO = process.cwd()
const RENDERER = join(REPO, 'src', 'renderer', 'src')
const APP = join(RENDERER, 'App.tsx')
const LAYOUT = join(RENDERER, 'components', 'layout', 'AppLayout.tsx')
const PERSISTENCE = join(RENDERER, 'hooks', 'useConversationPersistence.ts')
const CONV_DB = join(REPO, 'src', 'main', 'storage', 'conversation.db.ts')

/** Every renderer source file, so the "no bare type test" rule is scanned rather
 *  than trusted to a list someone has to remember to update. */
function rendererSources(dir: string = RENDERER): Array<{ path: string; src: string }> {
  const out: Array<{ path: string; src: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...rendererSources(path))
    else if (/\.tsx?$/.test(entry.name)) out.push({ path, src: readFileSync(path, 'utf-8') })
  }
  return out
}

describe('the empty key cannot be read as a conversation', () => {
  const sources = rendererSources()

  it('scans the renderer (non-vacuity)', () => {
    expect(sources.length).toBeGreaterThan(100)
    expect(sources.some((f) => f.path === APP)).toBe(true)
  })

  it('no renderer file tests the key with typeof', () => {
    // The signature of the bug. `typeof x === 'string'` is true for '' — ask
    // conversationKeyOf instead.
    const offenders = sources
      .filter((f) => /typeof\s+activeConversationKey/.test(f.src))
      .map((f) => f.path.replace(REPO + '/', ''))
    expect(offenders).toEqual([])
  })

  it('App and AppLayout resolve the key through the helper', () => {
    for (const file of [APP, LAYOUT]) {
      const src = readFileSync(file, 'utf-8')
      // Relative path differs by depth — assert the module, not the spelling.
      expect(src).toMatch(/import \{ conversationKeyOf \} from '(\.\.\/)+shared\/conversation-key'/)
      expect(src).toContain('conversationKeyOf(activeConversationKey)')
    }
  })

  it('both 授权 branches stay reachable through the resolved key', () => {
    const src = readFileSync(APP, 'utf-8')
    expect(src).toContain('if (activeConvKey) updateConversationApproval(activeConvKey, mode)')
    expect(src).toContain('usePendingApprovalStore.getState().setMode(mode)')
    expect(src).toContain('pendingApprovalMode ?? DEFAULT_APPROVAL_MODE')
  })

  it('the renderer refuses to write an approval for a conversation that is not open', () => {
    const src = readFileSync(PERSISTENCE, 'utf-8')
    const from = src.indexOf('const updateConversationApproval = useCallback')
    expect(from).toBeGreaterThan(-1)
    const rest = src.slice(from)
    const nextDecl = rest.slice(1).search(/\n {2}const [A-Za-z]/)
    const body = nextDecl === -1 ? rest : rest.slice(0, nextDecl + 1)

    expect(body).toContain('const id = conversationKeyOf(convId)')
    expect(body).toContain('if (!id) {')
  })

  it('every DB setter that can stub-insert a conversation row checks the id', () => {
    const src = readFileSync(CONV_DB, 'utf-8')
    // project / expert / approval / workspace / origin / profile — the six
    // writers that INSERT a conversation row when the UPDATE matched nothing.
    const guarded = [...src.matchAll(/if \(!isRealConversationId\(id\)\) return/g)].length
    expect(guarded).toBe(6)
    // Non-vacuity: the helper really is the shared predicate, not a local copy.
    expect(src).toContain("import { conversationKeyOf } from '../../shared/conversation-key'")
    expect(src).toContain('if (conversationKeyOf(id)) return true')
  })
})
