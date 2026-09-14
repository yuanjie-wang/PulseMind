import { describe, it, expect } from 'vitest'
import { makeTab, openTabInList, closeTabInList, MAX_OPEN_TABS, type PreviewTab } from '../src/renderer/src/stores/preview-tabs'

const tab = (path: string): PreviewTab => ({ path, kind: 'text', title: path })

describe('openTabInList', () => {
  it('appends new tabs, keeps order for existing ones', () => {
    let tabs = openTabInList([], '/a.md')
    tabs = openTabInList(tabs, '/b.md')
    expect(tabs.map((t) => t.path)).toEqual(['/a.md', '/b.md'])
    expect(openTabInList(tabs, '/a.md')).toBe(tabs) // no-op, same reference
  })

  it('evicts the oldest tab beyond the cap', () => {
    let tabs: PreviewTab[] = []
    for (let i = 0; i < MAX_OPEN_TABS + 3; i++) tabs = openTabInList(tabs, `/f${i}.txt`)
    expect(tabs).toHaveLength(MAX_OPEN_TABS)
    expect(tabs[0].path).toBe('/f3.txt')
    expect(tabs[MAX_OPEN_TABS - 1].path).toBe(`/f${MAX_OPEN_TABS + 2}.txt`)
  })

  it('makeTab derives kind and title from the path', () => {
    expect(makeTab('/x/报告.md')).toEqual({ path: '/x/报告.md', kind: 'markdown', title: '报告.md' })
  })
})

describe('closeTabInList', () => {
  const tabs = [tab('/a.md'), tab('/b.md'), tab('/c.md')]

  it('keeps activation when a background tab closes', () => {
    const r = closeTabInList(tabs, '/b.md', '/a.md')
    expect(r.tabs.map((t) => t.path)).toEqual(['/a.md', '/c.md'])
    expect(r.nextActive).toBeUndefined()
  })

  it('activates the successor when the active tab closes', () => {
    const r = closeTabInList(tabs, '/b.md', '/b.md')
    expect(r.tabs.map((t) => t.path)).toEqual(['/a.md', '/c.md'])
    expect(r.nextActive).toBe('/c.md')
  })

  it('activates the previous tab when closing the last one', () => {
    const r = closeTabInList(tabs, '/c.md', '/c.md')
    expect(r.nextActive).toBe('/b.md')
  })

  it('reports null when the strip empties', () => {
    const r = closeTabInList([tab('/only.md')], '/only.md', '/only.md')
    expect(r.tabs).toEqual([])
    expect(r.nextActive).toBeNull()
  })

  it('ignores unknown paths', () => {
    expect(closeTabInList(tabs, '/ghost.md', '/a.md').tabs).toBe(tabs)
  })
})
