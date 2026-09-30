// The composer's character cap (user ruling 2026-09-30: 「给输入框一个4k的上限」).
// The input used to be unbounded — a huge paste rode the whole conversation
// forever (lightCompact never drops pure-text user messages; only hardTruncate
// past the 0.9× window line cuts one). Enforced at two depths:
//   1. Composer's onChange wrapper — feedback via the near-limit counter. NOT
//      an antd maxLength prop: @ant-design/x's Sender does not declare
//      maxLength and its imperative insert() (the @-mention path) writes the
//      DOM value directly, but that insert still reports through the context
//      onChange, which lands on this prop — so the wrapper sees every mutation
//      (typing, paste, mention insert, history recall).
//   2. prepareTurn clips after the beforeSession hook — the protocol backstop
//      for clients without the UI clamp (staged rows from old drafts,
//      extension panel, hosted sessions).
// The constant lives in engine-constants (MAX_USER_INPUT_CHARS) because
// AgentEngine is de-facto shared code and must not import a component module.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMPOSER_MAX_CHARS, COMPOSER_COUNT_VISIBLE_AT, clampComposerInput } from '../src/renderer/src/components/chat/Composer'
import { MAX_USER_INPUT_CHARS } from '../src/renderer/src/agent/engine/engine-constants'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

describe('MAX_USER_INPUT_CHARS — one cap, two enforcement depths', () => {
  it('is 4000, and Composer aliases it (never re-declares its own number)', () => {
    expect(MAX_USER_INPUT_CHARS).toBe(4_000)
    expect(COMPOSER_MAX_CHARS).toBe(MAX_USER_INPUT_CHARS)
    expect(COMPOSER_COUNT_VISIBLE_AT).toBe(3_200)
    expect(COMPOSER_COUNT_VISIBLE_AT).toBeLessThan(COMPOSER_MAX_CHARS)
  })

  it('short input passes through untouched', () => {
    expect(clampComposerInput('你好')).toBe('你好')
    expect(clampComposerInput('')).toBe('')
  })

  it('exactly at the cap passes; one over is cut', () => {
    const at = 'a'.repeat(4_000)
    expect(clampComposerInput(at)).toBe(at)
    const over = `${at}b`
    expect(clampComposerInput(over)).toBe(at)
    expect(clampComposerInput(over).length).toBe(4_000)
  })

  it('a huge paste is clipped to the cap, keeping the head', () => {
    const paste = `${'汉'.repeat(50_000)}tail-marker`
    const clamped = clampComposerInput(paste)
    expect(clamped.length).toBe(4_000)
    expect(clamped.endsWith('tail-marker')).toBe(false)
    expect(paste.startsWith(clamped.slice(0, 3_999))).toBe(true)
  })
})

describe('wiring — the clamp rides the one funnel, the backstop rides prepareTurn', () => {
  it('non-vacuity: the scans read real sources', () => {
    expect(read('src/renderer/src/components/chat/Composer.tsx')).toContain('MAX_USER_INPUT_CHARS')
  })

  it('Composer wraps the Sender onChange with the clamp', () => {
    const composer = read('src/renderer/src/components/chat/Composer.tsx')
    expect(composer).toContain('onChange(clampComposerInput(')
    // and the antd maxLength prop is NOT the mechanism (Sender does not declare
    // it; its insert() bypasses it) — the scan fails if someone re-adds it
    // believing it enforces anything
    expect(composer).not.toMatch(/<Sender[^>]*maxLength/s)
  })

  it('the near-limit counter renders in the footer', () => {
    const composer = read('src/renderer/src/components/chat/Composer.tsx')
    expect(composer).toContain('pm-composer-count')
    expect(composer).toContain('nearLimit &&')
  })

  it('prepareTurn clips after the beforeSession hook (the non-desktop backstop)', () => {
    const engine = read('src/renderer/src/agent/AgentEngine.ts')
    expect(engine).toContain('MAX_USER_INPUT_CHARS')
    // the clip must sit AFTER the hook rewrite (a hook-injected big text is
    // clamped too), pinned by the two lines it must follow
    const clampIdx = engine.indexOf('userMessage.length > MAX_USER_INPUT_CHARS')
    const hookIdx = engine.indexOf('userMessage = beforeSessionCtx.userMessage')
    expect(clampIdx).toBeGreaterThan(-1)
    expect(hookIdx).toBeGreaterThan(-1)
    expect(clampIdx).toBeGreaterThan(hookIdx)
  })
})
