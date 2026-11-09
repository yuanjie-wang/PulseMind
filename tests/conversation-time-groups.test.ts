import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// The rows component is default-exported (only the pure helpers are named) —
// a `{ ConversationRows }` named import here is silently undefined.
import ConversationRows, { groupConversationsByDate, type ConversationListItem } from '../src/renderer/src/components/layout/ConversationRows'

// The header labels the rows render under — the component reads them through
// useTranslation, so the mock doubles as the wiring check: a GROUP_LABEL_KEY
// that points at a renamed key would fall through to the raw path and fail
// the header assertions below. The 显示更多 label interpolates {{count}}, so
// the mock does too — otherwise the remaining-count assertions would read the
// raw placeholder.
const LABELS: Record<string, string> = {
  'conversationSidebar.groupPinned': '置顶',
  'conversationSidebar.groupToday': '今天',
  'conversationSidebar.groupYesterday': '昨天',
  'conversationSidebar.groupEarlier': '更早',
  'conversationSidebar.showMore': '显示更多（还有 {{count}} 条）'
}
vi.mock('../src/renderer/src/i18n/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const raw = LABELS[key] ?? key
      return values
        ? Object.entries(values).reduce((s, [k, v]) => s.replace(`{{${k}}}`, String(v)), raw)
        : raw
    }
  })
}))

const DAY_NOW = new Date(2026, 8, 16, 12, 0).getTime() // Wed 2026-09-16, local noon
const localIso = (y: number, m: number, d: number, hh = 12, mm = 0): string =>
  new Date(y, m - 1, d, hh, mm, 0).toISOString()

const conv = (key: string, over: Partial<ConversationListItem> = {}): ConversationListItem => ({
  key,
  label: `会话 ${key}`,
  updatedAt: localIso(2026, 9, 16, 10),
  ...over
})

describe('groupConversationsByDate', () => {
  it('buckets the unpinned into 今天/昨天/更早, in recency order within a group', () => {
    const groups = groupConversationsByDate([
      conv('a', { updatedAt: localIso(2026, 9, 16, 11) }),
      conv('b', { updatedAt: localIso(2026, 9, 16, 9) }),
      conv('c', { updatedAt: localIso(2026, 9, 15, 8) }),
      conv('d', { updatedAt: localIso(2026, 9, 1, 8) }),
    ], DAY_NOW)
    expect(groups.map((g) => g.bucket)).toEqual(['today', 'yesterday', 'earlier'])
    expect(groups[0].items.map((c) => c.key)).toEqual(['a', 'b'])
    expect(groups[1].items.map((c) => c.key)).toEqual(['c'])
    expect(groups[2].items.map((c) => c.key)).toEqual(['d'])
  })

  it('floats pinned conversations into a leading 置顶 group, out of their day bucket', () => {
    const groups = groupConversationsByDate([
      conv('old', { pinned: true, updatedAt: localIso(2026, 9, 10, 8) }),
      conv('fresh', { updatedAt: localIso(2026, 9, 16, 11) }),
      conv('pinned2', { pinned: true, updatedAt: localIso(2026, 9, 15, 8) }),
    ], DAY_NOW)
    expect(groups.map((g) => g.bucket)).toEqual(['pinned', 'today'])
    // Within the pin pool: most recently touched first.
    expect(groups[0].items.map((c) => c.key)).toEqual(['pinned2', 'old'])
  })

  it('omits empty buckets, so a quiet yesterday paints no header', () => {
    const groups = groupConversationsByDate([
      conv('a', { updatedAt: localIso(2026, 9, 16, 11) }),
      conv('d', { updatedAt: localIso(2026, 9, 1, 8) }),
    ], DAY_NOW)
    expect(groups.map((g) => g.bucket)).toEqual(['today', 'earlier'])
  })

  it('sends a missing updatedAt to 更早 and re-buckets when the caller clock moves', () => {
    expect(groupConversationsByDate([conv('x', { updatedAt: undefined })], DAY_NOW)[0].bucket).toBe('earlier')
    const morning = conv('m', { updatedAt: localIso(2026, 9, 16, 9) })
    expect(groupConversationsByDate([morning], DAY_NOW)[0].bucket).toBe('today')
    expect(groupConversationsByDate([morning], new Date(2026, 8, 17, 12, 0).getTime())[0].bucket).toBe('yesterday')
  })
})

// ── The grouped render ──
// Static markup keeps the DOM order the user reads: each header must sit above
// its own rows and below the previous group's, which a pure-function test
// cannot see (the render loop is where a group could lose its rows).

/** Render fixtures relative to the REAL clock — the component ticks with
 *  Date.now() internally. midnight-anchored stamps cannot flip with the time
 *  of day the suite runs at: today-1min is always 今天 (barring a midnight
 *  crossing mid-test), midnight-1h is always 昨天, midnight-3d is always 更早. */
const relativeStamps = () => {
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  return {
    // `now - 1min` crosses midnight when the suite runs in the first minute of
    // the day (实锤：00:00:04 那一跑 today 桶空、整条断言崩) — clamp to just
    // after local midnight so the 今天 bucket always has a member.
    today: new Date(Math.max(midnight.getTime() + 1000, Date.now() - 60_000)).toISOString(),
    yesterday: new Date(midnight.getTime() - 3_600_000).toISOString(),
    earlier: new Date(midnight.getTime() - 3 * 86_400_000).toISOString(),
  }
}

const renderRows = (conversations: ConversationListItem[], groupByDate: boolean): string =>
  renderToStaticMarkup(React.createElement(ConversationRows, {
    conversations,
    activeKey: undefined,
    groupByDate,
    onSelect: () => {}, onDelete: () => {}, onRename: () => {}, onTogglePin: () => {},
  }))

describe('ConversationRows groupByDate render', () => {
  it('renders the section headers in order, each above its own rows', () => {
    const s = relativeStamps()
    const html = renderRows([
      conv('earlier1', { updatedAt: s.earlier }),
      conv('yest1', { updatedAt: s.yesterday }),
      conv('pin1', { pinned: true, updatedAt: s.earlier }),
      conv('today1', { updatedAt: s.today }),
    ], true)

    const pos = (marker: string): number => html.indexOf(marker)
    expect(pos('data-conv-group="pinned"')).toBeGreaterThan(-1)
    expect(pos('置顶')).toBeGreaterThan(-1)
    // Header order as the user reads it.
    expect(pos('data-conv-group="pinned"')).toBeLessThan(pos('data-conv-group="today"'))
    expect(pos('data-conv-group="today"')).toBeLessThan(pos('data-conv-group="yesterday"'))
    expect(pos('data-conv-group="yesterday"')).toBeLessThan(pos('data-conv-group="earlier"'))
    // Every row sits inside its own group's span: after its header, before the next one.
    expect(pos('data-conv-row="pin1"')).toBeGreaterThan(pos('data-conv-group="pinned"'))
    expect(pos('data-conv-row="pin1"')).toBeLessThan(pos('data-conv-group="today"'))
    expect(pos('data-conv-row="today1"')).toBeGreaterThan(pos('data-conv-group="today"'))
    expect(pos('data-conv-row="today1"')).toBeLessThan(pos('data-conv-group="yesterday"'))
    expect(pos('data-conv-row="yest1"')).toBeGreaterThan(pos('data-conv-group="yesterday"'))
    expect(pos('data-conv-row="yest1"')).toBeLessThan(pos('data-conv-group="earlier"'))
    expect(pos('data-conv-row="earlier1"')).toBeGreaterThan(pos('data-conv-group="earlier"'))
  })

  it('keeps the flat pinned-first list without the flag — the project tab reads the same component', () => {
    const s = relativeStamps()
    const html = renderRows([
      conv('old', { updatedAt: s.earlier }),
      conv('pin', { pinned: true, updatedAt: s.yesterday }),
    ], false)
    expect(html).not.toContain('data-conv-group')
    expect(html).not.toContain('置顶')
    expect(html.indexOf('data-conv-row="pin"')).toBeGreaterThan(-1)
    expect(html.indexOf('data-conv-row="pin"')).toBeLessThan(html.indexOf('data-conv-row="old"'))
  })
})

// ── Pagination: each block starts at 10, 置顶 aside ──
// Static markup sees the SLICE — which rows made it, which block the button
// belongs to, how many remain. The CLICK lives in
// scripts/probe-sidebar-time-groups.mjs, which drives a real mouse.

/** One block's segment: from its group header to the next header (or EOF). */
const segmentOf = (html: string, bucket: string): string => {
  const start = html.indexOf(`data-conv-group="${bucket}"`)
  expect(start).toBeGreaterThan(-1)
  const next = html.indexOf('data-conv-group=', start + 1)
  return html.slice(start, next < 0 ? html.length : next)
}
const rowsIn = (segment: string): string[] =>
  [...segment.matchAll(/data-conv-row="([^"]+)"/g)].map((m) => m[1])
const moreIn = (segment: string): { block: string; text: string } | null => {
  const m = segment.match(/data-conv-more="([^"]+)"[^>]*>([^<]*)</)
  return m ? { block: m[1], text: m[2] } : null
}

/** N 今天 conversations, keys in recency order (t0 newest) — stamped inside
 *  today's own calendar day from midnight, so the bucket holds whenever the
 *  suite runs. */
const manyToday = (n: number): ConversationListItem[] => {
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  return Array.from({ length: n }, (_, i) =>
    conv(`t${i}`, { updatedAt: new Date(midnight.getTime() + (n - i) * 60_000).toISOString() }))
}

describe('ConversationRows block pagination', () => {
  it('a day block renders its first 10 rows and a 显示更多 naming the rest', () => {
    const s = relativeStamps()
    const html = renderRows([
      ...manyToday(13),
      conv('y0', { updatedAt: s.yesterday }),
      conv('y1', { updatedAt: s.yesterday }),
    ], true)

    const today = segmentOf(html, 'today')
    expect(rowsIn(today)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'])
    expect(today).not.toContain('data-conv-row="t10"')
    expect(moreIn(today)).toEqual({ block: 'today', text: '显示更多（还有 3 条）' })

    // Pagination is per block: yesterday fits on one page and grows no button.
    const yesterday = segmentOf(html, 'yesterday')
    expect(rowsIn(yesterday)).toEqual(['y0', 'y1'])
    expect(moreIn(yesterday)).toBeNull()
  })

  it('a block that fits the first page renders no button', () => {
    const html = renderRows(manyToday(10), true)
    expect(rowsIn(segmentOf(html, 'today'))).toHaveLength(10)
    expect(html).not.toContain('data-conv-more')
  })

  it('the 置顶 block is exempt — all 12 pins render, no button hides any', () => {
    const html = renderRows(
      Array.from({ length: 12 }, (_, i) => conv(`p${i}`, { pinned: true })),
      true
    )
    const pinned = segmentOf(html, 'pinned')
    expect(rowsIn(pinned)).toHaveLength(12)
    expect(moreIn(pinned)).toBeNull()
  })

  it('the project tab pages its flat list, pins included whole', () => {
    const pinned = ['p0', 'p1', 'p2'].map((key) => conv(key, { pinned: true }))
    const html = renderRows([...pinned, ...manyToday(14)], false)

    expect(html).not.toContain('data-conv-group')
    expect(html.match(/data-conv-row="/g)).toHaveLength(13) // 3 pins + 10
    expect(html).not.toContain('data-conv-row="t10"')
    expect(moreIn(html)).toEqual({ block: 'flat', text: '显示更多（还有 4 条）' })
  })
})

// ── The wiring ──
// vitest here is node-env: the sidebar cannot be mounted, so the two props
// that decide which tab groups are asserted against the sources themselves.
const layoutDir = join(__dirname, '../src/renderer/src/components/layout')
const sourceOf = (file: string): string => readFileSync(join(layoutDir, file), 'utf8')

describe('sidebar grouping wiring', () => {
  // The open JSX tag, sliced to its closing `/>` — arrow-function props carry
  // `>` inside the tag, so a `[^>]*` regex cannot span it.
  const tagOf = (src: string, tag: string): string => {
    const start = src.indexOf(`<${tag}`)
    expect(start).toBeGreaterThan(-1)
    return src.slice(start, src.indexOf('/>', start))
  }

  it('the 对话 tab turns grouping on; the project tab does not', () => {
    const sidebar = sourceOf('ConversationSidebar.tsx')
    expect(tagOf(sidebar, 'ConversationRows')).toContain('groupByDate')
    const projectList = sourceOf('ProjectSidebarList.tsx')
    expect(tagOf(projectList, 'ConversationRows')).not.toContain('groupByDate')
  })

  it('the grouped list is fed the non-project slice, and only that', () => {
    const appLayout = sourceOf('AppLayout.tsx')
    expect(appLayout).toContain('looseConversations = conversations.filter((c) => !c.projectId)')
    expect(tagOf(appLayout, 'ConversationSidebar')).toContain('conversations={looseConversations}')
  })
})
