import { describe, it, expect } from 'vitest'
import {
  FILE_WRITER_TOOLS,
  collectDeliverables,
  collectTurnDeliverables,
  mergeDeliverables,
  segmentTurnPlacement,
  verbCounts
} from '../src/renderer/src/components/chat/deliverables'
import { groupMessages } from '../src/renderer/src/components/chat/message-segments'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const T0 = '2026-09-18T10:00:00.000Z'
const T1 = '2026-09-18T10:01:00.000Z'
const T2 = '2026-09-18T10:02:00.000Z'

// Synthetic workspace path (the repo's /Users/u convention, same as
// external-url.test.ts): these assertions are pure string joins and nothing here
// touches the filesystem, so a real home path in a fixture only leaks the dev
// machine's user name.
const WORKSPACE_DIR = '/Users/u/.pulsemind/workspace/20260925211304'
const DELIVERABLE = `${WORKSPACE_DIR}/成都旅游攻略-3天2晚.docx`

const use = (id: string, name: string, input: Record<string, unknown>): ContentBlock =>
  ({ type: 'tool_use', id, name, input })

const result = (toolUseId: string, isError = false): ContentBlock =>
  ({ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', ...(isError ? { is_error: true } : {}) })

const text = (s: string): ContentBlock => ({ type: 'text', text: s })

const msg = (id: string, role: 'user' | 'assistant', createdAt: string, blocks: ContentBlock[]): AgentMessage =>
  ({ id, role, contentBlocks: blocks, createdAt })

describe('FILE_WRITER_TOOLS', () => {
  // Pins the set: the deliverables card's honesty boundary is "the tools whose
  // target path we can name" — exec is deliberately absent, and a future
  // export_document joins here as one line (PLAN-office-export §五).
  it('is exactly the path-naming writer tools, exec excluded', () => {
    // export_document joined when PLAN-office-export landed (its tool result
    // names the path it wrote, just like write/edit do); office_edit joined
    // as the three retired edit tools merged (2026-10-04) — the old names
    // STAY, persisted transcripts carry them forever and hydration counts on.
    expect([...FILE_WRITER_TOOLS].sort()).toEqual(['docx_edit', 'edit', 'export_document', 'office_edit', 'office_export', 'pptx_edit', 'write', 'xlsx_edit'])
    expect(FILE_WRITER_TOOLS.has('exec')).toBe(false)
    expect(FILE_WRITER_TOOLS.has('read')).toBe(false)
    expect(FILE_WRITER_TOOLS.has('office_read')).toBe(false) // a read is not a deliverable
  })
})

describe('verbCounts', () => {
  // The badge counts 新增/编辑 only (user ruling 2026-09-26): export ops ride
  // the row but are never counted, and every other writer tool owns a bucket.
  it('counts export_document ops as NOTHING — the conv_20260925211304 badge shape', () => {
    const ops = [
      ...Array.from({ length: 2 }, (_, i) => ({ tool: 'office_export', at: `t${i}`, ok: true })),
      ...Array.from({ length: 7 }, (_, i) => ({ tool: 'docx_edit', at: `e${i}`, ok: true }))
    ]
    expect(verbCounts(ops)).toEqual([{ verb: 'edit', count: 7 }])
  })

  it('buckets write as 新增 and the edit family as 编辑, in that order, zeros dropped', () => {
    expect(verbCounts([{ tool: 'write', at: 't', ok: true }])).toEqual([{ verb: 'create', count: 1 }])
    expect(
      verbCounts([
        { tool: 'edit', at: 't', ok: true },
        { tool: 'docx_edit', at: 't', ok: true },
        { tool: 'xlsx_edit', at: 't', ok: true },
        { tool: 'pptx_edit', at: 't', ok: true },
        { tool: 'office_edit', at: 't', ok: true }
      ])
    ).toEqual([{ verb: 'edit', count: 5 }])
    expect(verbCounts([{ tool: 'write', at: 't', ok: true }, { tool: 'edit', at: 't', ok: true }])).toEqual([
      { verb: 'create', count: 1 },
      { verb: 'edit', count: 1 }
    ])
    // export-only row: the badge shows nothing at all
    expect(verbCounts([{ tool: 'office_export', at: 't', ok: true }])).toEqual([])
  })

  it('covers every FILE_WRITER_TOOLS member — a new writer must pick a bucket', () => {
    for (const tool of FILE_WRITER_TOOLS) {
      const counts = verbCounts([{ tool, at: 't', ok: true }])
      if (tool === 'office_export' || tool === 'export_document') expect(counts).toEqual([])
      else expect(counts).toHaveLength(1)
    }
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

  it('ONE row for a file the turn exported (absolute result path) AND edited (relative input)', () => {
    // conv_20260925211304 regression: export_document keyed its row on the
    // result's ABSOLUTE path while docx_edit keyed on the RELATIVE input —
    // two rows, both displaying the same name. Relative inputs resolve
    // against the workspace (the same resolution the click-preview uses),
    // so the spellings collapse and the ops count in one row.
    const exported = (path: string): ContentBlock =>
      ({ type: 'tool_result', tool_use_id: 'u1', content: `Exported ${path} (12 KB)` })
    const messages = [
      msg('a1', 'assistant', T0, [
        use('u1', 'office_export', { source: { format: 'docx' }, file_path: '成都旅游攻略-3天2晚.docx' }),
        use('u2', 'docx_edit', { file_path: '成都旅游攻略-3天2晚.docx', ops: [] })
      ]),
      msg('u1', 'user', T1, [
        exported(DELIVERABLE),
        result('u2')
      ])
    ]
    const d = collectDeliverables(messages, {
      workspaceDir: WORKSPACE_DIR
    })
    expect(d.rows).toHaveLength(1)
    expect(d.rows[0].path).toBe(DELIVERABLE)
    expect(d.rows[0].ops.map((o) => o.tool)).toEqual(['office_export', 'docx_edit'])
  })

  it('resolves relative inputs against workspaceDir; without it they pass through raw', () => {
    const messages = [
      msg('a1', 'assistant', T0, [use('u1', 'write', { file_path: 'notes/a.md' })]),
      msg('u1', 'user', T1, [result('u1')])
    ]
    const resolved = collectDeliverables(messages, { workspaceDir: '/home/u/.pulsemind/workspace/c1' })
    expect(resolved.rows[0].path).toBe('/home/u/.pulsemind/workspace/c1/notes/a.md')
    // Callers without a workspace (child hydration) keep the raw string.
    expect(collectDeliverables(messages).rows[0].path).toBe('notes/a.md')
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

describe('collectTurnDeliverables', () => {
  it('slices turns at user messages WITHOUT tool_result; result-carrier user messages stay in-turn', () => {
    // The engine folds a whole round's results into one user message — that
    // message must never read as a turn boundary, or the slice would split a
    // tool_use/tool_result pair and the per-turn pairing would lose the row.
    const messages = [
      msg('u0', 'user', T0, [text('第一轮')]),
      msg('a1', 'assistant', T0, [use('u1', 'write', { file_path: '/ws/a.md' })]),
      msg('r1', 'user', T1, [result('u1')]),
      msg('u1b', 'user', T1, [text('第二轮')]),
      msg('a2', 'assistant', T2, [use('u2', 'write', { file_path: '/ws/b.md' })]),
      msg('r2', 'user', T2, [result('u2')])
    ]
    const turns = collectTurnDeliverables(messages)
    expect(turns).toHaveLength(2)
    expect(turns[0].rows.map((r) => r.path)).toEqual(['/ws/a.md'])
    expect(turns[1].rows.map((r) => r.path)).toEqual(['/ws/b.md'])
  })

  it('leading messages before the first user message form turn 0', () => {
    const messages = [
      msg('g', 'assistant', T0, [text('你好')]),
      msg('u0', 'user', T1, [text('写文件')]),
      msg('a1', 'assistant', T1, [use('u1', 'write', { file_path: '/ws/a.md' })]),
      msg('r1', 'user', T2, [result('u1')])
    ]
    const turns = collectTurnDeliverables(messages)
    expect(turns).toHaveLength(2)
    expect(turns[0].rows).toEqual([])
    expect(turns[1].rows.map((r) => r.path)).toEqual(['/ws/a.md'])
  })

  it('merges the settled child parts of THAT turn\'s spawns — grandchildren stay aggregate-only', () => {
    // The turn spawns sub_1; childParts carries sub_1 AND a grandchild the
    // MAIN messages never spawned. Only the looked-up id joins the turn card;
    // the grandchild's rows ride the workbench aggregate alone.
    const messages = [
      msg('u0', 'user', T0, [text('调研')]),
      msg('a1', 'assistant', T0, [
        use('u1', 'write', { file_path: '/ws/main.md' }),
        { type: 'tool_use', id: 's1', name: 'spawn_agent', input: {}, subConvId: 'sub_1' }
      ]),
      msg('r1', 'user', T1, [result('u1'), result('s1')])
    ]
    const childParts = new Map([
      ['sub_1', {
        rows: [{ path: '/ws/kid.md', ops: [{ tool: 'write', at: T1, ok: true }], lastAt: T1, fromConvIds: ['sub_1'] }],
        sources: [{ convId: 'sub_1', title: '调研专家' }]
      }],
      ['sub_grand', {
        rows: [{ path: '/ws/grand.md', ops: [{ tool: 'write', at: T1, ok: true }], lastAt: T1, fromConvIds: ['sub_grand'] }],
        sources: [{ convId: 'sub_grand', title: '汇总专家' }]
      }]
    ])
    const turns = collectTurnDeliverables(messages, childParts)
    expect(turns[0].rows.map((r) => r.path).sort()).toEqual(['/ws/kid.md', '/ws/main.md'])
    expect(turns[0].rows.find((r) => r.path === '/ws/kid.md')!.fromConvIds).toEqual(['sub_1'])
    expect(turns[0].sources).toEqual([{ convId: 'sub_1', title: '调研专家' }])
    expect(turns[0].rows.some((r) => r.path === '/ws/grand.md')).toBe(false)
  })

  it('a turn with only failed / pending writes has no rows', () => {
    const messages = [
      msg('u0', 'user', T0, [text('写')]),
      msg('a1', 'assistant', T0, [
        use('u1', 'write', { file_path: '/ws/failed.md' }),
        { type: 'tool_use', id: 'u2', name: 'write', input: { file_path: '/ws/pending.md' }, status: 'running' }
      ]),
      msg('r1', 'user', T1, [result('u1', true)])
    ]
    expect(collectTurnDeliverables(messages)[0].rows).toEqual([])
  })

  it('the same path written in two turns is two per-turn rows (the aggregate merges them)', () => {
    const messages = [
      msg('u0', 'user', T0, [text('一')]),
      msg('a1', 'assistant', T0, [use('u1', 'write', { file_path: '/ws/x.md' })]),
      msg('r1', 'user', T1, [result('u1')]),
      msg('u1b', 'user', T1, [text('二')]),
      msg('a2', 'assistant', T2, [use('u2', 'edit', { file_path: '/ws/x.md' })]),
      msg('r2', 'user', T2, [result('u2')])
    ]
    const turns = collectTurnDeliverables(messages)
    expect(turns[0].rows.map((r) => r.path)).toEqual(['/ws/x.md'])
    expect(turns[1].rows.map((r) => r.path)).toEqual(['/ws/x.md'])
    // …while the whole-conversation derivation (the workbench panel's feed)
    // keeps them as ONE row with both ops.
    const all = collectDeliverables(messages)
    expect(all.rows).toHaveLength(1)
    expect(all.rows[0].ops.map((o) => o.tool)).toEqual(['write', 'edit'])
  })
})

describe('segmentTurnPlacement', () => {
  it('numbering agrees with collectTurnDeliverables; each card renders after its turn\'s last segment', () => {
    const messages = [
      msg('u0', 'user', T0, [text('第一轮')]),
      msg('a1', 'assistant', T0, [use('u1', 'write', { file_path: '/ws/a.md' })]),
      msg('r1', 'user', T1, [result('u1')]),
      msg('a2', 'assistant', T1, [text('第一轮完成')]),
      msg('u1b', 'user', T2, [text('第二轮')]),
      msg('a3', 'assistant', T2, [use('u2', 'write', { file_path: '/ws/b.md' })]),
      msg('r2', 'user', T2, [result('u2')])
    ]
    const segments = groupMessages(messages)
    const placement = segmentTurnPlacement(segments)
    const turns = collectTurnDeliverables(messages)
    // One turn index per segment, and the turn count matches the message-side
    // derivation — the boundary rule is the same, so the two can never drift.
    expect(placement.turnOf).toHaveLength(segments.length)
    expect(new Set(placement.turnOf).size).toBe(turns.length)
    expect(turns).toHaveLength(2)
    // Turn 0 = [u0 single, exec(a1+r1), a2 text single] → card after index 2.
    expect(placement.lastSegmentOfTurn[0]).toBe(2)
    // Turn 1 ends at the list's last segment (the exec holding a3+r2).
    expect(placement.lastSegmentOfTurn[1]).toBe(segments.length - 1)
    expect(placement.turnOf[0]).toBe(0)
    expect(placement.turnOf[3]).toBe(1)
  })

  it('empty input yields empty placement', () => {
    expect(segmentTurnPlacement([])).toEqual({ turnOf: [], lastSegmentOfTurn: [] })
  })
})
