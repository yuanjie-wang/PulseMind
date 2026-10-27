import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { elideTodoWritePairs } from '../src/renderer/src/llm/elide-todo-pairs'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

// ── todo_write pair elision（出站管线，2026-10-25 用户提议）─────────────────
// The todo list's authoritative state rides the <session-state> block, so an
// old todo_write tool_use + tool_result pair in history is a pure echo. The
// transform drops every elidable pair from the API copy and keeps only the
// MOST RECENT call — its result carries the delta/cautions exactly once, and
// the model keeps one format anchor of its own last call. Wire-only: store,
// mirrors and DB transcripts keep everything.

let seq = 0
const assistant = (blocks: ContentBlock[]): AgentMessage =>
  ({ id: `a_${++seq}`, role: 'assistant', contentBlocks: blocks, createdAt: '2026-01-01T00:00:00Z' })
const user = (blocks: ContentBlock[]): AgentMessage =>
  ({ id: `u_${++seq}`, role: 'user', contentBlocks: blocks, createdAt: '2026-01-01T00:00:00Z' })
const use = (id: string, name = 'todo_write'): ContentBlock =>
  ({ type: 'tool_use', id, name, input: {} }) as ContentBlock
const result = (id: string, content = 'snapshot'): ContentBlock =>
  ({ type: 'tool_result', tool_use_id: id, content }) as ContentBlock
const text = (t: string): ContentBlock => ({ type: 'text', text: t })
const thinking = (t = 'hmm'): ContentBlock => ({ type: 'thinking', thinking: t })

const useIds = (msgs: AgentMessage[]): string[] =>
  msgs.flatMap(m => m.contentBlocks).filter(b => b.type === 'tool_use').map(b => (b as { id: string }).id)
const resultIds = (msgs: AgentMessage[]): string[] =>
  msgs.flatMap(m => m.contentBlocks).filter(b => b.type === 'tool_result').map(b => (b as { tool_use_id: string }).tool_use_id)

describe('elideTodoWritePairs', () => {
  it('histories with at most one todo_write call come back as the SAME array', () => {
    const one = [user([text('hi')]), assistant([use('t1')]), user([result('t1')])]
    expect(elideTodoWritePairs(one)).toBe(one)
    const none = [user([text('hi')])]
    expect(elideTodoWritePairs(none)).toBe(none)
  })

  it('keeps the most recent pair, elides older ones, other tools untouched', () => {
    const read1 = assistant([use('r1', 'read')])
    const todo1 = assistant([use('t1')])
    const res1 = user([result('t1'), result('r1')])
    const read2 = assistant([use('r2', 'read')])
    const todo2 = assistant([use('t2')])
    const res2 = user([result('r2'), result('t2')])
    const out = elideTodoWritePairs([user([text('go')]), read1, todo1, res1, read2, todo2, res2])
    // todo1 dropped whole → read2's use now precedes todo2's on the wire
    expect(useIds(out)).toEqual(['r1', 'r2', 't2'])
    expect(resultIds(out)).toEqual(['r1', 'r2', 't2'])
    // store purity: untouched messages keep their references
    expect(out).toContain(read1)
    expect(out).toContain(read2)
    expect(out).toContain(res2)
    // todo1 held nothing but the elided call → dropped whole
    expect(out).not.toContain(todo1)
    // res1 rebuilt down to the surviving read result — a new object
    const rebuilt = out.find(m => m.contentBlocks.some(b => b.type === 'tool_result' && (b as { tool_use_id: string }).tool_use_id === 'r1'))!
    expect(rebuilt).not.toBe(res1)
    expect(rebuilt.contentBlocks).toHaveLength(1)
  })

  it('an unpaired older todo_write survives — interrupted calls belong to the adapters', () => {
    const out = elideTodoWritePairs([
      assistant([use('t1')]),
      user([text('interrupted')]),
      assistant([use('t2')]),
      user([result('t2')]),
    ])
    expect(useIds(out)).toEqual(['t1', 't2'])
  })

  it('a paired older call elides even when the most recent one is unpaired', () => {
    const out = elideTodoWritePairs([
      assistant([use('t1')]),
      user([result('t1')]),
      assistant([use('t2')]), // interrupted: no result yet
    ])
    expect(useIds(out)).toEqual(['t2'])
  })

  it('an assistant message reduced to bare thinking is dropped; thinking alongside text survives', () => {
    const t1 = assistant([thinking(), use('t1')])
    const t2 = assistant([thinking(), use('t2'), text('note')])
    const out = elideTodoWritePairs([
      t1, user([result('t1')]),
      t2, user([result('t2')]),
      assistant([use('t3')]), user([result('t3')]),
    ])
    expect(out).not.toContain(t1)
    const keptT2 = out.find(m => m.id === t2.id)!
    expect(keptT2.contentBlocks.map(b => b.type)).toEqual(['thinking', 'text'])
    expect(useIds(out)).toEqual(['t3'])
  })

  it('two todo_write calls inside ONE assistant message: the older elides, the newer stays', () => {
    const both = assistant([use('t1'), use('t2')])
    const out = elideTodoWritePairs([
      both, user([result('t1'), result('t2')]),
    ])
    const kept = out.find(m => m.id === both.id)!
    expect(kept.contentBlocks.map(b => (b as { id: string }).id)).toEqual(['t2'])
    expect(resultIds(out)).toEqual(['t2'])
  })

  it('pure: the input array and its objects are never mutated', () => {
    const todo1 = assistant([use('t1')])
    const input = [user([text('go')]), todo1, user([result('t1')]), assistant([use('t2')]), user([result('t2')])]
    const snapshot = JSON.stringify(input)
    const out = elideTodoWritePairs(input)
    expect(JSON.stringify(input)).toBe(snapshot)
    expect(out).not.toBe(input)
    expect(out).not.toContain(todo1)
  })

  it('long tasks stay bounded: five rounds leave exactly one todo pair on the wire', () => {
    const msgs: AgentMessage[] = [user([text('go')])]
    for (let i = 1; i <= 5; i++) {
      msgs.push(assistant([use(`t${i}`), use(`r${i}`, 'read')]))
      msgs.push(user([result(`t${i}`), result(`r${i}`)]))
    }
    const out = elideTodoWritePairs(msgs)
    expect(useIds(out).filter(id => id.startsWith('t'))).toEqual(['t5'])
    expect(resultIds(out).filter(id => id.startsWith('t'))).toEqual(['t5'])
    // every read call survives — elision is todo-scoped
    expect(useIds(out).filter(id => id.startsWith('r'))).toEqual(['r1', 'r2', 'r3', 'r4', 'r5'])
  })

  it('wired into the prepareLoopRequest transform chain, before regroup', () => {
    const src = readFileSync(join(__dirname, '../src/renderer/src/agent/AgentEngine.ts'), 'utf8')
    expect(src).toMatch(/regroupToolResults\(elideTodoWritePairs\(/)
  })
})
