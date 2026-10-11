import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const { selectEvictionCandidates, MAX_CACHED_CONVERSATIONS } = await import('../src/renderer/src/hooks/useConversationEngine')

/**
 * 12h-run memory hardening (2026-10-11): every conversation the desktop chat
 * ever opened kept a full SessionState mirror in statesRef — and its
 * main-hosted engine the same transcript — with no eviction path, so a long
 * session that visits many conversations grew both processes monotonically.
 * The policy is pure (this file drives it directly); the persistence sweep
 * owns the gate (verified-save ledger) and the engine hook the mechanism.
 */

const LIVE_STATUSES = ['streaming', 'executing', 'retrying', 'awaiting_approval', 'awaiting_user_input', 'awaiting_continue', 'awaiting_extension'] as const

describe('mirror eviction policy (selectEvictionCandidates)', () => {
  it('the cap is a real bound, not a token value', () => {
    expect(Number.isInteger(MAX_CACHED_CONVERSATIONS)).toBe(true)
    expect(MAX_CACHED_CONVERSATIONS).toBeGreaterThanOrEqual(2)
  })

  it('the active conversation is never a candidate', () => {
    const entries = [
      { id: 'a', status: 'idle' as const, touchedAt: 1 },
      { id: 'b', status: 'idle' as const, touchedAt: 2 },
    ]
    expect(selectEvictionCandidates(entries, 'a')).toEqual(['b'])
    expect(selectEvictionCandidates(entries, 'b')).toEqual(['a'])
  })

  it('live statuses are never candidates — their events must keep flowing', () => {
    const entries = LIVE_STATUSES.map((status, i) => ({ id: `live${i}`, status, touchedAt: i }))
    expect(selectEvictionCandidates(entries, '')).toEqual([])
  })

  it('terminal statuses are candidates, oldest-touch first', () => {
    const entries = [
      { id: 'old', status: 'idle' as const, touchedAt: 100 },
      { id: 'live', status: 'streaming' as const, touchedAt: 50 },
      { id: 'newer', status: 'completed' as const, touchedAt: 200 },
      { id: 'newest', status: 'error' as const, touchedAt: 300 },
    ]
    expect(selectEvictionCandidates(entries, '')).toEqual(['old', 'newer', 'newest'])
  })

  it('a conversation never touched by an event sorts first (touchedAt 0)', () => {
    const entries = [
      { id: 'touched', status: 'idle' as const, touchedAt: 500 },
      { id: 'untouched', status: 'completed' as const, touchedAt: 0 },
    ]
    expect(selectEvictionCandidates(entries, '')).toEqual(['untouched', 'touched'])
  })
})

describe('wiring: the caps are actually applied at the accumulation sites', () => {
  const read = (p: string) => readFileSync(p, 'utf8')

  it('MAX_LIVE_OUTPUT_CHARS gates BOTH exec output buffers (shell path + exec tool)', () => {
    const flow = read('src/renderer/src/agent/engine/execution-flow.ts')
    const domain = read('src/renderer/src/agent/executors/domain-tools.ts')
    // The shell path must slice, not just import.
    expect(flow).toContain('MAX_LIVE_OUTPUT_CHARS')
    expect(flow).toMatch(/outputBuffer\.length > MAX_LIVE_OUTPUT_CHARS\)\s+outputBuffer = outputBuffer\.slice/)
    expect(domain).toContain('MAX_LIVE_OUTPUT_CHARS')
    expect(domain).toMatch(/buf\.length > MAX_LIVE_OUTPUT_CHARS \? buf\.slice/)
  })

  it('the persistence sweep consumes the eviction policy (gate + forget ordering)', () => {
    const persistence = read('src/renderer/src/hooks/useConversationPersistence.ts')
    expect(persistence).toContain('MAX_CACHED_CONVERSATIONS')
    expect(persistence).toContain('listEvictionCandidates()')
    // The baseline must be dropped WITH the mirror (its fingerprints ≈ the
    // messages' own JSON — keeping it would keep half the memory).
    expect(persistence).toMatch(/forget\(id\)[\s\S]{0,80}evictEngine\(id\)/)
    const controller = read('src/renderer/src/hooks/useChatController.ts')
    expect(controller).toContain('listEvictionCandidates: engine.listEvictionCandidates')
    expect(controller).toContain('evictEngine: engine.evictEngine')
  })

  it('the engine hook disposes the main-hosted engine on eviction', () => {
    const hook = read('src/renderer/src/hooks/useConversationEngine.ts')
    expect(hook).toMatch(/evictEngine[\s\S]{0,400}\.dispose\(\)/)
    expect(hook).toContain('statesRef.current.delete(convId)')
  })
})
