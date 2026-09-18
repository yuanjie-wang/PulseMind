import { describe, it, expect } from 'vitest'
import {
  FILE_WRITER_TOOLS,
  collectDeliverables,
  mergeDeliverables
} from '../src/renderer/src/components/chat/deliverables'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const T0 = '2026-09-18T10:00:00.000Z'
const T1 = '2026-09-18T10:01:00.000Z'
const T2 = '2026-09-18T10:02:00.000Z'

const use = (id: string, name: string, input: Record<string, unknown>): ContentBlock =>
  ({ type: 'tool_use', id, name, input })

const result = (toolUseId: string, isError = false): ContentBlock =>
  ({ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', ...(isError ? { is_error: true } : {}) })

const msg = (id: string, role: 'user' | 'assistant', createdAt: string, blocks: ContentBlock[]): AgentMessage =>
  ({ id, role, contentBlocks: blocks, createdAt })

describe('FILE_WRITER_TOOLS', () => {
  // Pins the set: the deliverables card's honesty boundary is "the tools whose
  // target path we can name" — exec is deliberately absent, and a future
  // export_document joins here as one line (PLAN-office-export §五).
  it('is exactly the path-naming writer tools, exec excluded', () => {
    // export_document joined when PLAN-office-export landed (its tool result
    // names the path it wrote, just like write/edit do).
    expect([...FILE_WRITER_TOOLS].sort()).toEqual(['docx_edit', 'edit', 'export_document', 'write', 'xlsx_edit'])
    expect(FILE_WRITER_TOOLS.has('exec')).toBe(false)
    expect(FILE_WRITER_TOOLS.has('read')).toBe(false)
  })
})

describe('collectDeliverables', () => {
  it('collects a successful write into one row with its op', () => {
    const messages = [
      msg('a1', 'assistant', T0, [use('u1', 'write', { file_path: '/ws/report.md', content: 'x' })]),
      msg('u1', 'user', T1, [result('u1')])
    ]
    const d = collectDeliverables(messages)
    expect(d.rows).toHaveLength(1)
    expect(d.rows[0].path).toBe('/ws/report.md')
    // op time = when the paired tool_result landed (the write completed), not
    // when the call was minted
    expect(d.rows[0].ops).toEqual([{ tool: 'write', at: T1, ok: true }])
    expect(d.rows[0].lastAt).toBe(T1)
    expect(d.rows[0].fromConvIds).toEqual([])
    expect(d.sources).toEqual([])
  })

  it('dedupes by exact path — chunked writes of one file are ONE row', () => {
    // write >10KB auto-chunks into several calls on the same path (§2.1);
    // the path is the dedup key, so the card shows one row, ops counted.
    const messages = [
      msg('a1', 'assistant', T0, [
        use('u1', 'write', { file_path: '/ws/big.md', content: 'chunk1' }),
        use('u2', 'write', { file_path: '/ws/big.md', content: 'chunk2' })
      ]),
      msg('u1', 'user', T1, [result('u1'), result('u2')])
    ]
    const d = collectDeliverables(messages)
    expect(d.rows).toHaveLength(1)
    expect(d.rows[0].ops).toHaveLength(2)
    expect(d.rows[0].ops.every((op) => op.tool === 'write')).toBe(true)
  })

  it('summarizes mixed verbs per file — 写入 ×2 · 编辑 ×1 shape', () => {
    const messages = [
      msg('a1', 'assistant', T0, [
        use('u1', 'write', { file_path: '/ws/a.md' }),
        use('u2', 'write', { file_path: '/ws/a.md' }),
        use('u3', 'edit', { file_path: '/ws/a.md' }),
        use('u4', 'docx_edit', { file_path: '/ws/report.docx', ops: [] })
      ]),
      msg('u1', 'user', T1, [result('u1'), result('u2'), result('u3'), result('u4')])
    ]
    const d = collectDeliverables(messages)
    expect(d.rows).toHaveLength(2)
    const a = d.rows.find((r) => r.path === '/ws/a.md')!
    const counts = a.ops.reduce<Record<string, number>>((acc, op) => {
      acc[op.tool] = (acc[op.tool] || 0) + 1
      return acc
    }, {})
    expect(counts).toEqual({ write: 2, edit: 1 })
  })

  it('sorts rows by lastAt descending and ops within a row ascending', () => {
    const T3 = '2026-09-18T10:03:00.000Z'
    const messages = [
      msg('a1', 'assistant', T0, [use('u1', 'write', { file_path: '/ws/old.md' })]),
      msg('u1', 'user', T1, [result('u1')]),
      msg('a2', 'assistant', T2, [use('u2', 'write', { file_path: '/ws/new.md' })]),
      msg('u2', 'user', T3, [result('u2')]),
      // an edit on the older file, its result landing between the two writes
      msg('a3', 'assistant', T1, [use('u3', 'edit', { file_path: '/ws/old.md' })]),
      msg('u3', 'user', T2, [result('u3')])
    ]
    const d = collectDeliverables(messages)
    expect(d.rows.map((r) => r.path)).toEqual(['/ws/new.md', '/ws/old.md'])
    const old = d.rows.find((r) => r.path === '/ws/old.md')!
    expect(old.ops.map((op) => op.tool)).toEqual(['write', 'edit'])
    expect(old.lastAt).toBe(T2)
  })

  it('excludes failed ops (is_error) — a rejected write is not a deliverable', () => {
    const messages = [
      msg('a1', 'assistant', T0, [
        use('u1', 'write', { file_path: '/ws/failed.md' }),
        use('u2', 'write', { file_path: '/ws/ok.md' })
      ]),
      msg('u1', 'user', T1, [result('u1', true), result('u2')])
    ]
    const d = collectDeliverables(messages)
    expect(d.rows.map((r) => r.path)).toEqual(['/ws/ok.md'])
  })

  it('excludes calls with no paired tool_result yet (pending / rejected / mid-stream)', () => {
    const messages = [
      msg('a1', 'assistant', T0, [
        { type: 'tool_use', id: 'u1', name: 'write', input: { file_path: '/ws/pending.md' }, status: 'running' },
        use('u2', 'edit', { file_path: '/ws/done.md' })
      ]),
      msg('u1', 'user', T1, [result('u2')])
    ]
    const d = collectDeliverables(messages)
    expect(d.rows.map((r) => r.path)).toEqual(['/ws/done.md'])
  })

  it('derives the SAME result from sanitized storage shape — no status on blocks', () => {
    // The archive contract (§2.1): sanitizeContentBlocks strips ONLY
    // tool_use.status; input/subConvId survive. A derivation keyed on status
    // would blank the card after a restart — this fixture is the sanitized
    // shape and must yield the identical rows.
    const live = [
      msg('a1', 'assistant', T0, [
        { type: 'tool_use', id: 'u1', name: 'write', input: { file_path: '/ws/r.md' }, status: 'completed' },
        use('u2', 'edit', { file_path: '/ws/r.md' })
      ]),
      msg('u1', 'user', T1, [result('u1'), result('u2')])
    ]
    const stored = JSON.parse(JSON.stringify(live)) as AgentMessage[]
    for (const m of stored) {
      for (const b of m.contentBlocks) {
        if (b.type === 'tool_use') delete (b as { status?: string }).status
      }
    }
    expect(JSON.stringify(collectDeliverables(stored))).toEqual(JSON.stringify(collectDeliverables(live)))
  })

  it('skips malformed inputs — missing / non-string / empty file_path', () => {
    const messages = [
      msg('a1', 'assistant', T0, [
        use('u1', 'write', {}),
        use('u2', 'write', { file_path: 42 }),
        use('u3', 'edit', { file_path: '   ' }),
        use('u4', 'xlsx_edit', { file_path: '/ws/real.xlsx', ops: [] })
      ]),
      msg('u1', 'user', T1, [result('u1'), result('u2'), result('u3'), result('u4')])
    ]
    const d = collectDeliverables(messages)
    expect(d.rows.map((r) => r.path)).toEqual(['/ws/real.xlsx'])
  })

  it('ignores non-writer tools and survives messages without contentBlocks', () => {
    const messages = [
      msg('a1', 'assistant', T0, [
        use('u1', 'exec', { command: 'echo hi > /ws/leak.md' }),
        use('u2', 'read', { file_path: '/ws/read-only.md' })
      ]),
      msg('u1', 'user', T1, [result('u1'), result('u2')]),
      { id: 'm3', role: 'user', contentBlocks: [], createdAt: T2 } as unknown as AgentMessage
    ]
    const d = collectDeliverables(messages)
    expect(d.rows).toHaveLength(0)
  })

  it('attributes rows to the given convId (child aggregation)', () => {
    const messages = [
      msg('a1', 'assistant', T0, [use('u1', 'write', { file_path: '/ws/kid.md' })]),
      msg('u1', 'user', T1, [result('u1')])
    ]
    const d = collectDeliverables(messages, { convId: 'sub_1' })
    expect(d.rows[0].fromConvIds).toEqual(['sub_1'])
    expect(d.sources).toEqual([{ convId: 'sub_1' }])
  })
})

describe('mergeDeliverables', () => {
  it('merges child rows into main rows by path and unions attribution', () => {
    const main = collectDeliverables([
      msg('a1', 'assistant', T0, [use('u1', 'write', { file_path: '/ws/shared.md' })]),
      msg('u1', 'user', T1, [result('u1')])
    ])
    const child = collectDeliverables(
      [
        msg('a2', 'assistant', T2, [
          use('u3', 'write', { file_path: '/ws/shared.md' }),
          use('u4', 'write', { file_path: '/ws/kid-only.md' })
        ]),
        msg('u2', 'user', T2, [result('u3'), result('u4')])
      ],
      { convId: 'sub_1' }
    )
    const merged = mergeDeliverables([main, child])
    expect(merged.rows).toHaveLength(2)
    const shared = merged.rows.find((r) => r.path === '/ws/shared.md')!
    expect(shared.ops).toHaveLength(2)
    expect(shared.lastAt).toBe(T2)
    expect(shared.fromConvIds).toEqual(['sub_1'])
    expect(merged.sources).toEqual([{ convId: 'sub_1' }])
  })

  it('keeps main-session rows un-attributed and dedupes sources', () => {
    const mk = (convId: string | undefined, path: string) =>
      collectDeliverables(
        [msg('a1', 'assistant', T0, [use('u1', 'write', { file_path: path })]), msg('u1', 'user', T1, [result('u1')])],
        convId ? { convId } : undefined
      )
    const merged = mergeDeliverables([mk(undefined, '/ws/a.md'), mk('sub_1', '/ws/b.md'), mk('sub_1', '/ws/c.md')])
    expect(merged.sources).toEqual([{ convId: 'sub_1' }])
    expect(merged.rows.find((r) => r.path === '/ws/a.md')!.fromConvIds).toEqual([])
    expect(merged.rows.find((r) => r.path === '/ws/b.md')!.fromConvIds).toEqual(['sub_1'])
  })
})
