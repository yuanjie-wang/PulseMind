// ── Sidebar project-list sorting ──
// Drives the real comparators from project-sort.ts (pure, node-importable —
// the component itself pulls antd + i18n, so the logic lives next to it in its
// own file). Covers the three modes, the empty-project fallback that keeps an
// idle group from pretending to be active, input immutability, and stable ties.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sortProjectGroups } from '../src/renderer/src/components/layout/project-sort'
import type { ProjectGroup } from '../src/renderer/src/components/layout/project-sort'
import type { Project } from '../src/shared/types/project'
import type { ConversationListItem } from '../src/renderer/src/types/conversation'

function project(id: string, name: string, createdAt: string, updatedAt = createdAt, sortOrder?: number): Project {
  return { id, name, workspaceDir: `/tmp/${id}`, createdAt, updatedAt, sortOrder }
}

function conv(key: string, projectId: string, updatedAt: string): ConversationListItem {
  return { key, label: key, projectId, updatedAt }
}

function group(p: Project, convs: ConversationListItem[]): ProjectGroup {
  return { project: p, conversations: convs }
}

const A = project('p_a', 'Alpha 项目', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')
const B = project('p_b', 'Beta 项目', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z')
const C = project('p_c', 'Charlie 项目', '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z')

const FIXTURE: ProjectGroup[] = [
  group(A, [conv('c1', 'p_a', '2026-09-01T12:00:00Z')]),
  group(B, []), // empty: no conversation has ever happened here
  group(C, [conv('c2', 'p_c', '2026-09-15T08:00:00Z'), conv('c3', 'p_c', '2026-09-12T08:00:00Z')])
]

describe('sortProjectGroups', () => {
  it('created: newest project first, regardless of conversations', () => {
    expect(sortProjectGroups(FIXTURE, 'created').map((g) => g.project.id)).toEqual(['p_b', 'p_c', 'p_a'])
  })

  it('name: zh-aware ascending (pinyin for Chinese, alphabetical for Latin)', () => {
    expect(sortProjectGroups(FIXTURE, 'name').map((g) => g.project.id)).toEqual(['p_a', 'p_b', 'p_c'])
    const latin = [
      group(project('x', 'zebra', '2026-01-01T00:00:00Z'), []),
      group(project('y', 'apple', '2026-01-01T00:00:00Z'), [])
    ]
    expect(sortProjectGroups(latin, 'name').map((g) => g.project.name)).toEqual(['apple', 'zebra'])
  })

  it('activity: the group with the newest conversation first; an empty group reads as its own updatedAt', () => {
    // C has a conversation from 09-15; A from 09-01; B (empty) falls back to
    // the project's own updatedAt (09-10).
    expect(sortProjectGroups(FIXTURE, 'activity').map((g) => g.project.id)).toEqual(['p_c', 'p_b', 'p_a'])
  })

  it('activity: a project whose updatedAt predates every conversation still sinks below them', () => {
    // A's project row is old (09-01) but its conversation is new (09-20).
    const fresh = group(project('p_x', 'X', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), [
      conv('c9', 'p_x', '2026-09-20T00:00:00Z')
    ])
    const sorted = sortProjectGroups([FIXTURE[0], fresh], 'activity')
    expect(sorted.map((g) => g.project.id)).toEqual(['p_x', 'p_a'])
  })

  it('does not mutate the input array', () => {
    const input = [...FIXTURE]
    sortProjectGroups(input, 'name')
    expect(input.map((g) => g.project.id)).toEqual(['p_a', 'p_b', 'p_c'])
  })

  it('keeps equal keys in their original order (stable sort)', () => {
    const tied = [project('x1', '同', '2026-01-01T00:00:00Z'), project('x2', '同', '2026-01-01T00:00:00Z')]
    const sorted = sortProjectGroups([group(tied[0], []), group(tied[1], [])], 'name')
    expect(sorted.map((g) => g.project.id)).toEqual(['x1', 'x2'])
  })

  it('empty input sorts to empty', () => {
    expect(sortProjectGroups([], 'activity')).toEqual([])
  })
})

describe('sortProjectGroups · manual (drag order)', () => {
  // M was dragged to the front (sort_order 0), Z never dragged. B and A carry
  // orders 1 and 2 from the same drag session.
  const dragged = [
    group(project('p_m', 'M', '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z', 0), []),
    group(project('p_z', 'Z (created later)', '2026-09-20T00:00:00Z'), []),
    group(project('p_b', 'B', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', 1), []),
    group(project('p_a', 'A', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', 2), [])
  ]

  it('orders by sort_order; a project created after the last drag stays on top', () => {
    // Z has no sort_order: it rides the unordered block, newest-first, AHEAD
    // of the dragged block — "new stuff on top" survives a drag session.
    expect(sortProjectGroups(dragged, 'manual').map((g) => g.project.id)).toEqual(['p_z', 'p_m', 'p_b', 'p_a'])
  })

  it('two unordered rows keep the created-desc order between themselves', () => {
    const unordered = [
      group(project('old', 'old', '2026-01-01T00:00:00Z'), []),
      group(project('new', 'new', '2026-06-01T00:00:00Z'), [])
    ]
    expect(sortProjectGroups(unordered, 'manual').map((g) => g.project.id)).toEqual(['new', 'old'])
  })

  it('input immutability holds for manual too', () => {
    const input = [...dragged]
    sortProjectGroups(input, 'manual')
    expect(input.map((g) => g.project.id)).toEqual(['p_m', 'p_z', 'p_b', 'p_a'])
  })
})

// Static scans for the wiring vitest cannot mount (node-env, no jsdom): the
// reorder IPC chain and the sort_order migration. Every scan names what
// deleting it would silently break.
describe('manual reorder wiring', () => {
  const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf-8')
  const CHANNELS = read('src', 'shared', 'ipc-channels.ts')
  const HANDLER = read('src', 'main', 'ipc', 'project.handler.ts')
  const PRELOAD = read('src', 'preload', 'index.ts')
  const BRIDGE = read('src', 'shared', 'types', 'electron-bridge.ts')
  const STORE = read('src', 'main', 'storage', 'project-store.ts')
  const DB = read('src', 'main', 'storage', 'database.ts')

  it('the channel exists and every hop names it', () => {
    expect(CHANNELS).toContain("PROJECT_REORDER: 'project:reorder'")
    expect(HANDLER).toContain('IPC_CHANNELS.PROJECT_REORDER')
    expect(PRELOAD).toContain('IPC_CHANNELS.PROJECT_REORDER')
  })

  it('the bridge declares projectReorder for the renderer', () => {
    expect(BRIDGE).toContain('projectReorder: (orderedIds: string[]) => Promise<void>')
  })

  it('reorder binds named @-parameters, never positional ones', () => {
    // The positional-bind swap that poisoned conversation project bindings is
    // exactly the shape this statement must not reintroduce.
    expect(STORE).toContain('SET sort_order = @order WHERE id = @id')
    expect(STORE).toMatch(/update\.run\(\{ id, order \}\)/)
  })

  it('rows outside the submitted list lose their stale position', () => {
    expect(STORE).toContain('SET sort_order = NULL')
  })

  it('the sort_order column exists for fresh schemas and old ones alike', () => {
    // The block scan (not a span regex): sort_order must sit INSIDE the
    // projects CREATE TABLE, and the guarded ALTER covers databases that
    // predate the column.
    const create = DB.match(/CREATE TABLE IF NOT EXISTS projects \(([\s\S]*?)\);/)
    expect(create && create[1].includes('sort_order')).toBe(true)
    expect(DB).toContain('ALTER TABLE projects ADD COLUMN sort_order INTEGER')
  })

  it('the list row mapper carries sortOrder off the row', () => {
    expect(STORE).toContain('sortOrder: r.sort_order ?? undefined')
  })
})
