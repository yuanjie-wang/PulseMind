// @vitest-environment jsdom
// PLAN-deliverables M2: the sub-conversation aggregation hook. The facts under
// test are async timing facts (when hydrate fires, what cancels it, what the
// cache spares) — invisible to the source and to node-env, so this mounts the
// real hook behind a stubbed electronAPI, exactly the chat-favorite pattern.
//
// The child cache is MODULE-level (it must survive remounts — that is the
// point of one test below), so every test here namespaces its conversation ids
// to stay independent of the tests that ran before it.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDeliverables } from '../src/renderer/src/hooks/useDeliverables'
import type { AgentMessage, AgentStatus } from '../src/renderer/src/types/agent'
import type { Conversation } from '../src/shared/types/conversation'

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const AT = '2026-09-18T10:00:00.000Z'

const spawnUse = (id: string, subConvId: string) =>
  ({ type: 'tool_use', id, name: 'spawn_agent', input: {}, subConvId })

const writeMsg = (id: string, path: string): AgentMessage[] => [
  { id: `${id}-a`, role: 'assistant', createdAt: AT, contentBlocks: [{ type: 'tool_use', id: `${id}-u`, name: 'write', input: { file_path: path } }] },
  { id: `${id}-r`, role: 'user', createdAt: AT, contentBlocks: [{ type: 'tool_result', tool_use_id: `${id}-u`, content: 'ok' }] }
]

/** A stored-shape conversation: hydrate returns DB rows (no tool_use.status). */
const conv = (id: string, title: string, messages: AgentMessage[]): Conversation => ({
  id,
  title,
  createdAt: AT,
  updatedAt: AT,
  messages: messages.map(m => ({ ...m, content: '' })) as Conversation['messages']
})

let hydrateCalls: string[] = []

function stubHydrate(db: Map<string, Conversation>, gate?: (id: string) => Promise<void>): void {
  hydrateCalls = []
  vi.stubGlobal('electronAPI', {
    hydrateConversation: vi.fn(async (id: string) => {
      hydrateCalls.push(id)
      await gate?.(id)
      return db.get(id) ?? null
    })
  })
}

/** Mounts the real hook and renders its result as probeable JSON. The hook
 *  returns the per-child map only (the workbench aggregate that consumed a
 *  merge is gone), so `rows`/`sources` here are the parts flattened — every
 *  assertion below is over distinct children, for which flatten == merge. */
function HookProbe(props: { conversationId: string; messages: AgentMessage[]; agentStatus?: AgentStatus }): React.ReactElement {
  const childParts = useDeliverables(props.conversationId, props.messages, props.agentStatus)
  const parts = Array.from(childParts, ([convId, part]) => ({ convId, rows: part.rows, sources: part.sources }))
  const rows = parts.flatMap((p) => p.rows)
  const sources = parts.flatMap((p) => p.sources)
  return React.createElement('div', { 'data-probe': JSON.stringify({ childParts: parts, rows, sources }) })
}

interface ChildPart {
  convId: string
  rows: Array<{ path: string }>
  sources: Array<{ convId: string; title?: string }>
}

interface Mount {
  probe: () => {
    childParts: ChildPart[]
    rows: Array<{ path: string; fromConvIds: string[] }>
    sources: Array<{ convId: string; title?: string }>
  }
  rerender: (props: { conversationId?: string; messages?: AgentMessage[]; agentStatus?: AgentStatus }) => Promise<void>
  unmount: () => Promise<void>
}

async function mount(initial: { conversationId: string; messages: AgentMessage[]; agentStatus?: AgentStatus }): Promise<Mount> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let current = initial
  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(React.createElement(HookProbe, current))
      await flush()
    })
  }
  await render()
  return {
    probe: () => JSON.parse(container.querySelector('[data-probe]')!.getAttribute('data-probe')!),
    rerender: async (next) => {
      current = { ...current, ...next }
      await render()
    },
    unmount: async () => {
      await act(async () => { root.unmount(); await flush() })
      container.remove()
    }
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({ matches: false,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('useDeliverables — sub-conversation aggregation', () => {
  it('does NOT hydrate while the turn is executing, hydrates once terminal', async () => {
    const db = new Map<string, Conversation>()
    db.set('d1_sub', conv('d1_sub', '调研专家', writeMsg('d1_k', '/ws/kid.md')))
    stubHydrate(db)
    const mainMessages: AgentMessage[] = [
      { id: 'd1_a', role: 'assistant', createdAt: AT, contentBlocks: [spawnUse('d1_u', 'd1_sub')] }
    ]
    const mounted = await mount({ conversationId: 'd1_conv', messages: mainMessages, agentStatus: { status: 'executing', toolUseId: 'd1_u' } })
    try {
      expect(hydrateCalls).toEqual([])
      expect(mounted.probe().rows).toEqual([])
      await mounted.rerender({ agentStatus: { status: 'completed' } })
      expect(hydrateCalls).toEqual(['d1_sub'])
      const probe = mounted.probe()
      expect(probe.rows.map(r => r.path)).toEqual(['/ws/kid.md'])
      expect(probe.rows[0].fromConvIds).toEqual(['d1_sub'])
      expect(probe.sources).toEqual([{ convId: 'd1_sub', title: '调研专家' }])
      // The per-turn attribution view rides the same scan: one settled child
      // part, keyed by subConvId, carrying the same rows.
      expect(probe.childParts).toEqual([
        {
          convId: 'd1_sub',
          rows: [{ path: '/ws/kid.md', ops: [{ tool: 'write', at: AT, ok: true }], lastAt: AT, fromConvIds: ['d1_sub'] }],
          sources: [{ convId: 'd1_sub', title: '调研专家' }]
        }
      ])
    } finally {
      await mounted.unmount()
    }
  })

  it('caps the spawn chain at depth 3 (the 4th level never hydrates)', async () => {
    const db = new Map<string, Conversation>()
    for (const [id, next] of [['d2_c1', 'd2_c2'], ['d2_c2', 'd2_c3'], ['d2_c3', 'd2_c4']] as const) {
      const msgs = writeMsg(id, `/ws/${id}.md`)
      msgs[0].contentBlocks.push(spawnUse(`${id}-u`, next))
      db.set(id, conv(id, `专家 ${id}`, msgs))
    }
    db.set('d2_c4', conv('d2_c4', 'L4', writeMsg('d2_c4', '/ws/d2_c4.md')))
    stubHydrate(db)
    const mainMessages: AgentMessage[] = [
      { id: 'd2_a', role: 'assistant', createdAt: AT, contentBlocks: [spawnUse('d2_u', 'd2_c1')] }
    ]
    const mounted = await mount({ conversationId: 'd2_conv', messages: mainMessages, agentStatus: { status: 'completed' } })
    try {
      expect(hydrateCalls).toEqual(['d2_c1', 'd2_c2', 'd2_c3'])
      expect(hydrateCalls).not.toContain('d2_c4')
      const paths = mounted.probe().rows.map(r => r.path)
      expect(paths).toContain('/ws/d2_c1.md')
      expect(paths).toContain('/ws/d2_c3.md')
      expect(paths).not.toContain('/ws/d2_c4.md')
    } finally {
      await mounted.unmount()
    }
  })

  it('hydrates at most 20 children per scan', async () => {
    const db = new Map<string, Conversation>()
    for (let i = 0; i < 25; i++) db.set(`d3_s${i}`, conv(`d3_s${i}`, `E${i}`, writeMsg(`d3_s${i}`, `/ws/d3_s${i}.md`)))
    stubHydrate(db)
    const mainMessages: AgentMessage[] = [
      {
        id: 'd3_a', role: 'assistant', createdAt: AT,
        contentBlocks: Array.from({ length: 25 }, (_, i) => spawnUse(`d3_u${i}`, `d3_s${i}`))
      }
    ]
    const mounted = await mount({ conversationId: 'd3_conv', messages: mainMessages, agentStatus: { status: 'completed' } })
    try {
      expect(hydrateCalls).toHaveLength(20)
      expect(mounted.probe().rows).toHaveLength(20)
    } finally {
      await mounted.unmount()
    }
  })

  it('a settled cache hit is never hydrated again — and its grandchild rows survive the re-scan', async () => {
    const db = new Map<string, Conversation>()
    // A chain: the child carries its own spawn to a grandchild. The FIRST scan
    // hydrates both; the SECOND (fresh mount, still terminal) hits the cache
    // for both — and must still traverse child → grandchild, or the
    // grandchild's cached rows silently drop out of the merge (caught first by
    // probe-chat-deliverables.mjs).
    const childMsgs = writeMsg('d4_k', '/ws/kid.md')
    childMsgs[0].contentBlocks.push(spawnUse('d4_ks', 'd4_grand'))
    db.set('d4_sub', conv('d4_sub', '调研专家', childMsgs))
    db.set('d4_grand', conv('d4_grand', '汇总专家', writeMsg('d4_g', '/ws/grand.md')))
    stubHydrate(db)
    const mainMessages: AgentMessage[] = [
      { id: 'd4_a', role: 'assistant', createdAt: AT, contentBlocks: [spawnUse('d4_u', 'd4_sub')] }
    ]
    const first = await mount({ conversationId: 'd4_conv', messages: mainMessages, agentStatus: { status: 'completed' } })
    expect(hydrateCalls).toEqual(['d4_sub', 'd4_grand'])
    await first.unmount()
    // Fresh mount (≈ reopen the conversation): the module cache still holds
    // both settled children; zero hydrates, both rows present.
    const second = await mount({ conversationId: 'd4_conv', messages: mainMessages, agentStatus: { status: 'completed' } })
    try {
      expect(hydrateCalls).toEqual(['d4_sub', 'd4_grand'])
      expect(second.probe().rows.map(r => r.path).sort()).toEqual(['/ws/grand.md', '/ws/kid.md'])
      expect(second.probe().sources).toEqual([
        { convId: 'd4_sub', title: '调研专家' },
        { convId: 'd4_grand', title: '汇总专家' }
      ])
    } finally {
      await second.unmount()
    }
  })

  it('a failed hydrate is not cached — the next terminal scan retries', async () => {
    const db = new Map<string, Conversation>()
    db.set('d5_sub', conv('d5_sub', '调研专家', writeMsg('d5_k', '/ws/kid.md')))
    let fail = true
    vi.stubGlobal('electronAPI', {
      hydrateConversation: vi.fn(async (id: string) => {
        hydrateCalls.push(id)
        if (fail) throw new Error('transient')
        return db.get(id) ?? null
      })
    })
    hydrateCalls = []
    const mainMessages: AgentMessage[] = [
      { id: 'd5_a', role: 'assistant', createdAt: AT, contentBlocks: [spawnUse('d5_u', 'd5_sub')] }
    ]
    const mounted = await mount({ conversationId: 'd5_conv', messages: mainMessages, agentStatus: { status: 'completed' } })
    try {
      expect(hydrateCalls).toEqual(['d5_sub'])
      expect(mounted.probe().rows).toEqual([])
      fail = false
      await mounted.rerender({ messages: [...mainMessages] })
      expect(hydrateCalls).toEqual(['d5_sub', 'd5_sub'])
      expect(mounted.probe().rows.map(r => r.path)).toEqual(['/ws/kid.md'])
    } finally {
      await mounted.unmount()
    }
  })

  it('switching conversations cancels the in-flight scan — no grandchild, no late rows', async () => {
    const db = new Map<string, Conversation>()
    db.set('d6_a_child', conv('d6_a_child', 'A 专家', [...writeMsg('d6_ka', '/ws/a.md'), { id: 'd6_as', role: 'assistant', createdAt: AT, contentBlocks: [spawnUse('d6_au', 'd6_a_grand')] }]))
    db.set('d6_a_grand', conv('d6_a_grand', 'A 孙', writeMsg('d6_kg', '/ws/g.md')))
    db.set('d6_b_child', conv('d6_b_child', 'B 专家', writeMsg('d6_kb', '/ws/b.md')))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    stubHydrate(db, async (id) => { if (id === 'd6_a_child') await gate })
    const messagesA: AgentMessage[] = [
      { id: 'd6_a1', role: 'assistant', createdAt: AT, contentBlocks: [spawnUse('d6_u1', 'd6_a_child')] }
    ]
    const messagesB: AgentMessage[] = [
      { id: 'd6_b1', role: 'assistant', createdAt: AT, contentBlocks: [spawnUse('d6_u2', 'd6_b_child')] }
    ]
    const mounted = await mount({ conversationId: 'd6_convA', messages: messagesA, agentStatus: { status: 'completed' } })
    try {
      expect(hydrateCalls).toEqual(['d6_a_child']) // in flight, gated
      // Switch to B: B's own aggregation hydrates its child — and A's cancelled
      // scan must neither proceed to its grandchild nor write A's rows here.
      await mounted.rerender({ conversationId: 'd6_convB', messages: messagesB })
      expect(hydrateCalls).toEqual(['d6_a_child', 'd6_b_child'])
      release()
      await flush()
      expect(hydrateCalls).toEqual(['d6_a_child', 'd6_b_child'])
      expect(hydrateCalls).not.toContain('d6_a_grand')
      const probe = mounted.probe()
      expect(probe.rows.map(r => r.path)).toEqual(['/ws/b.md'])
      expect(probe.rows[0].fromConvIds).toEqual(['d6_b_child'])
      expect(probe.sources).toEqual([{ convId: 'd6_b_child', title: 'B 专家' }])
    } finally {
      await mounted.unmount()
    }
  })

  it('merges the grandchild chain into one deliverable with per-source attribution', async () => {
    const db = new Map<string, Conversation>()
    const withSpawn = (id: string, title: string, next?: string): Conversation => {
      const msgs = writeMsg(id, `/ws/${id}.md`)
      if (next) msgs[0].contentBlocks.push(spawnUse(`${id}-u`, next))
      return conv(id, title, msgs)
    }
    db.set('d7_c1', withSpawn('d7_c1', 'L1', 'd7_g1'))
    db.set('d7_g1', withSpawn('d7_g1', 'L2'))
    stubHydrate(db)
    const mainMessages: AgentMessage[] = [
      { id: 'd7_a', role: 'assistant', createdAt: AT, contentBlocks: [spawnUse('d7_u', 'd7_c1')] }
    ]
    const mounted = await mount({ conversationId: 'd7_conv', messages: mainMessages, agentStatus: { status: 'completed' } })
    try {
      expect(hydrateCalls).toEqual(['d7_c1', 'd7_g1'])
      const probe = mounted.probe()
      expect(probe.rows.map(r => r.path).sort()).toEqual(['/ws/d7_c1.md', '/ws/d7_g1.md'])
      expect(probe.sources).toEqual([
        { convId: 'd7_c1', title: 'L1' },
        { convId: 'd7_g1', title: 'L2' }
      ])
    } finally {
      await mounted.unmount()
    }
  })

  it('scans a statusless host on first non-empty messages (history reopen)', async () => {
    const db = new Map<string, Conversation>()
    db.set('d8_sub', conv('d8_sub', '调研专家', writeMsg('d8_k', '/ws/kid.md')))
    stubHydrate(db)
    const mainMessages: AgentMessage[] = [
      { id: 'd8_a', role: 'assistant', createdAt: AT, contentBlocks: [spawnUse('d8_u', 'd8_sub')] }
    ]
    const mounted = await mount({ conversationId: 'd8_conv', messages: mainMessages })
    try {
      expect(hydrateCalls).toEqual(['d8_sub'])
      expect(mounted.probe().rows.map(r => r.path)).toEqual(['/ws/kid.md'])
    } finally {
      await mounted.unmount()
    }
  })
})
