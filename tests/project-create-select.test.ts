// ── Creating a project selects it on the welcome picker ──
// User 2026-11-09: 「在左侧边栏新建项目后，进入项目模式的welcome页面，需要自动
// 选中刚刚新建的项目」. Both ProjectModal hosts (AppLayout for the sidebar's
// 新增 / the 新建项目 accelerator, ProjectCards for the welcome picker's own
// dashed card) already selected the new project on save — and lost it at
// once: the reload was fire-and-forget, the selection was applied before the
// list landed, and ProjectCards' stale-selection guard (陈旧选择自愈:
// `loaded && projectId && !projects.some(...)` → setProjectId(null)) read the
// still-loaded OLD list, found no such project and cleared the pick.
//
// Two layers, because neither covers the other:
//   - the store property the fix rests on runs for real: reload() resolves
//     only AFTER the fresh list is committed, and never rejects — so
//     `reload().then(select)` always runs, and always against a list that
//     contains the project;
//   - the ordering itself lives in two inline JSX callbacks no node-env unit
//     test can mount, so it is asserted as source.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useProjectStore } from '../src/renderer/src/stores/projectStore'
import type { Project } from '../src/shared/types/project'

const read = (...parts: string[]): string => readFileSync(join(__dirname, '..', ...parts), 'utf-8')

function project(id: string, name: string): Project {
  return { id, name, workspaceDir: `/tmp/${id}`, createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z' }
}

/** The ProjectModal element's onSaved handler: from its opening arrow to the
 *  element's self-closing tag. */
function onSavedSlice(src: string): string {
  const start = src.indexOf('onSaved={(project) => {')
  expect(start, 'ProjectModal onSaved handler not found').toBeGreaterThanOrEqual(0)
  const end = src.indexOf('/>', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('projectStore.reload — the property `reload().then(select)` rests on', () => {
  const g = globalThis as { window?: unknown }
  let savedWindow: unknown

  beforeEach(() => {
    savedWindow = g.window
    // The pre-create snapshot: already loaded, without the project-to-be —
    // exactly the state the stale-selection guard misread.
    useProjectStore.setState({ projects: [project('default', '默认项目')], loaded: true })
  })
  afterEach(() => {
    g.window = savedWindow
  })

  it('resolves only after the fresh list is committed to the store', async () => {
    const fresh = [project('default', '默认项目'), project('proj_new', '新项目')]
    g.window = { electronAPI: { projectList: async () => fresh } }
    const pending = useProjectStore.getState().reload()
    // Still the old snapshot while the IPC is in flight: selecting now is
    // what the guard used to clear.
    expect(useProjectStore.getState().projects.some((p) => p.id === 'proj_new')).toBe(false)
    await pending
    expect(useProjectStore.getState().projects.some((p) => p.id === 'proj_new')).toBe(true)
    expect(useProjectStore.getState().loaded).toBe(true)
  })

  it('never rejects, so the chained selection always runs', async () => {
    g.window = {
      electronAPI: {
        projectList: async () => {
          throw new Error('ipc down')
        },
      },
    }
    let selected = false
    await expect(
      useProjectStore
        .getState()
        .reload()
        .then(() => {
          selected = true
        }),
    ).resolves.toBeUndefined()
    expect(selected).toBe(true)
  })
})

describe('ProjectModal.onSaved applies the selection only after the reload lands', () => {
  it('AppLayout (sidebar 新增 / 新建项目 accelerator): reload → then jump', () => {
    const slice = onSavedSlice(read('src', 'renderer', 'src', 'components', 'layout', 'AppLayout.tsx'))
    const chained = slice.indexOf('reloadProjects().then(')
    const jump = slice.indexOf('handleProjectNewTask(project.id)')
    expect(chained).toBeGreaterThanOrEqual(0)
    expect(jump).toBeGreaterThan(chained)
    // No fire-and-forget reload left beside the jump.
    expect(slice).not.toMatch(/reloadProjects\(\)(?!\.then)/)
  })

  it('ProjectCards (welcome picker 新建项目): reload → then select', () => {
    const slice = onSavedSlice(read('src', 'renderer', 'src', 'components', 'welcome', 'ProjectCards.tsx'))
    const chained = slice.indexOf('reload().then(')
    const select = slice.indexOf('setProjectId(project.id)')
    expect(chained).toBeGreaterThanOrEqual(0)
    expect(select).toBeGreaterThan(chained)
    expect(slice).not.toMatch(/\breload\(\)(?!\.then)/)
  })

  it('the guard that makes the ordering load-bearing is still there', () => {
    // If the stale-selection self-heal is ever removed this pin goes with it;
    // until then, it is why the two callbacks above must wait for the list.
    const projectCards = read('src', 'renderer', 'src', 'components', 'welcome', 'ProjectCards.tsx')
    expect(projectCards).toContain('if (loaded && projectId && !projects.some((p) => p.id === projectId)) setProjectId(null)')
  })
})
