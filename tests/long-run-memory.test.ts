import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { AgentStatus } from '../src/renderer/src/types/agent'

const { selectEvictionCandidates, MAX_CACHED_CONVERSATIONS } = await import('../src/renderer/src/hooks/useConversationEngine')
const { evictMirrorCandidates } = await import('../src/renderer/src/hooks/useConversationPersistence')

/**
 * 12h-run memory hardening (2026-10-11): every conversation the desktop chat
 * ever opened kept a full SessionState mirror in statesRef — and its
 * main-hosted engine the same transcript — with no eviction path, so a long
 * session that visits many conversations grew both processes monotonically.
 * The policy is pure (this file drives it directly); the persistence sweep
 * owns the gate (verified-save ledger) and the engine hook the mechanism.
 * The sweep LOOP itself is also driven here (review 2026-10-12 中1/低3): the
 * candidate table is snapshotted before `forget` awaits an in-flight write,
 * so an activation or a live turn landing inside that window is only caught
 * by the post-forget re-verify — a shape no source-string scan can pin.
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

describe('eviction sweep loop (evictMirrorCandidates — the real post-forget re-verify)', () => {
  /** A controllable sweep world: `count` engines in the map and an active id;
   *  tests that need the world to move mid-window replace `forget`/`statusOf`
   *  on the returned io. */
  function makeIo(opts: { count: number; cap?: number; activeId?: string; evictable?: (id: string) => boolean }) {
    const log: string[] = []
    const evicted: string[] = []
    let remaining = opts.count
    let activeId = opts.activeId ?? ''
    return {
      log,
      evicted,
      io: {
        overCap: () => remaining > (opts.cap ?? 0),
        isEvictable: opts.evictable ?? (() => true),
        forget: async (id: string) => {
          log.push(`forget:${id}`)
        },
        isActive: (id: string) => id === activeId,
        statusOf: (): AgentStatus['status'] => 'idle',
        evict: (id: string) => {
          log.push(`evict:${id}`)
          evicted.push(id)
          remaining -= 1
        },
      },
      /** Tests flip this mid-sweep to simulate an activation landing inside
       *  a later forget window. */
      setActive: (id: string) => {
        activeId = id
      },
    }
  }

  it('evicts oldest-first only while over the cap, forget preceding every evict', async () => {
    const h = makeIo({ count: 4, cap: 2 })
    await evictMirrorCandidates(['a', 'b', 'c', 'd'], h.io)
    // a and b bring the map to the cap; c finds overCap false and the loop
    // breaks — c and d are never forgotten (no wasted baseline drops).
    expect(h.evicted).toEqual(['a', 'b'])
    expect(h.log).toEqual(['forget:a', 'evict:a', 'forget:b', 'evict:b'])
  })

  it('a candidate the gate refuses never reaches forget', async () => {
    const h = makeIo({ count: 3, cap: 0, evictable: (id) => id !== 'stuck' })
    await evictMirrorCandidates(['stuck', 'ok'], h.io)
    expect(h.log).toEqual(['forget:ok', 'evict:ok'])
    expect(h.evicted).toEqual(['ok'])
  })

  it('the user opening a candidate inside the forget window keeps its engine', async () => {
    const h = makeIo({ count: 2, cap: 0 })
    // The user opens `a` while its forget await is in flight — and stays
    // there. `b`'s own window sees no activation, so only `a` is spared.
    h.io.forget = async (id: string) => {
      h.log.push(`forget:${id}`)
      if (id === 'a') h.setActive('a')
    }
    await evictMirrorCandidates(['a', 'b'], h.io)
    expect(h.evicted).toEqual(['b'])
    expect(h.log).toEqual(['forget:a', 'forget:b', 'evict:b'])
  })

  it.each(LIVE_STATUSES)('a status flipping live (%s) inside the forget window keeps the engine', async (live) => {
    const statusRef: { value: AgentStatus['status'] | 'GONE' } = { value: 'idle' }
    const evicted: string[] = []
    await evictMirrorCandidates(['a'], {
      overCap: () => true,
      isEvictable: () => true,
      forget: async () => {
        statusRef.value = live
      }, // extension panel drives the same session mid-window
      isActive: () => false,
      statusOf: () => (statusRef.value === 'GONE' ? undefined : statusRef.value),
      evict: (id) => {
        evicted.push(id)
      },
    })
    expect(evicted).toEqual([])
  })

  it('the engine leaving the map inside the forget window skips the evict', async () => {
    const statusRef: { value: AgentStatus['status'] | 'GONE' } = { value: 'idle' }
    const evicted: string[] = []
    await evictMirrorCandidates(['a'], {
      overCap: () => true,
      isEvictable: () => true,
      forget: async () => {
        statusRef.value = 'GONE'
      }, // disposed elsewhere mid-window
      isActive: () => false,
      statusOf: () => (statusRef.value === 'GONE' ? undefined : statusRef.value),
      evict: (id) => {
        evicted.push(id)
      },
    })
    expect(evicted).toEqual([])
  })

  it('a mid-window mutation (gate refuses after the await) keeps the engine', async () => {
    let dirty = false
    const evicted: string[] = []
    await evictMirrorCandidates(['a'], {
      overCap: () => true,
      isEvictable: () => !dirty,
      forget: async () => {
        dirty = true
      }, // a tool result landed mid-window
      isActive: () => false,
      statusOf: () => 'idle',
      evict: (id) => {
        evicted.push(id)
      },
    })
    expect(evicted).toEqual([])
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

  it('the persistence sweep consumes the extracted eviction loop (engine wiring unchanged)', () => {
    const persistence = read('src/renderer/src/hooks/useConversationPersistence.ts')
    expect(persistence).toContain('MAX_CACHED_CONVERSATIONS')
    expect(persistence).toContain('listEvictionCandidates()')
    // The loop body is behavior-tested above; this only pins that the hook
    // still routes its sweep through it, carrying the live active-id and
    // status sources the post-forget re-verify reads.
    expect(persistence).toMatch(/await evictMirrorCandidates\(listEvictionCandidates\(\)/)
    expect(persistence).toMatch(/isActive: id => activeEngineIdRef\.current === id/)
    expect(persistence).toMatch(/statusOf: id => enginesRef\.current\.get\(id\)\?\.agentStatus\.status/)
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
