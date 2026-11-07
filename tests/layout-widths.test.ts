import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  clampSidebarWidth,
  clampTreeWidth,
  PREVIEW_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  TREE_MIN_WIDTH,
} from '../src/shared/ui/layout-widths'

// ── Draggable column widths (2026-10-26) ────────────────────────────────────
// Two dividers took a drag handle: the nav sidebar (antd Sider, was a fixed
// 280) and the 工作区 tree↔preview split (was a fixed 40% share). The pure
// clamp math lives in shared/ui/layout-widths; the component wiring is pinned
// by source scan, the same discipline as cached-tokens-persistence (the
// geometry itself is real-browser territory — probe-sidebar-drag.mjs and
// probe-workspace-tree.mjs §16 drive the handles with a real mouse).

describe('clampSidebarWidth', () => {
  it('keeps the drag inside [220, 45% of the window]', () => {
    expect(clampSidebarWidth(100, 1200)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(5000, 1200)).toBe(Math.floor(1200 * 0.45))
    expect(clampSidebarWidth(333.6, 1200)).toBe(334)
  })
  it('never clamps below the minimum even on a tiny window', () => {
    // 400 * 0.45 = 180 < 220 — the chat column may not reclaim the sidebar's
    // whole floor by shrinking the window.
    expect(clampSidebarWidth(100, 400)).toBe(SIDEBAR_MIN_WIDTH)
  })
  it('leaves in-range values (the default) alone', () => {
    expect(clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, 1200)).toBe(SIDEBAR_DEFAULT_WIDTH)
  })
})

describe('clampTreeWidth', () => {
  it('keeps the drag inside [150, row − 240]', () => {
    expect(clampTreeWidth(100, 540)).toBe(TREE_MIN_WIDTH)
    expect(clampTreeWidth(5000, 540)).toBe(540 - PREVIEW_MIN_WIDTH)
    expect(clampTreeWidth(200, 540)).toBe(200)
  })
  it('on a pane too narrow for both floors, the tree minimum wins (preview flexes)', () => {
    // 320-wide pane: 320 − 240 = 80 < 150 — max falls back to the tree's own floor.
    expect(clampTreeWidth(200, 320)).toBe(TREE_MIN_WIDTH)
  })
  it('with no row measurement yet, floors only', () => {
    expect(clampTreeWidth(5000, 0)).toBe(5000)
    expect(clampTreeWidth(100, 0)).toBe(TREE_MIN_WIDTH)
  })
})

const ROOT = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

describe('layout width wiring', () => {
  it('AppLayout: sidebar drag handle wired to the hook, clamp and store', () => {
    const src = read('src/renderer/src/components/layout/AppLayout.tsx')
    expect(src).toContain('data-pm-sidebar-drag-handle')
    expect(src).toContain('useColumnDrag')
    expect(src).toContain('clampSidebarWidth')
    expect(src).toContain('useSidebarStore')
    // The Sider's collapse tween must not fight the drag (inline none only
    // while dragging — undefined otherwise, so antd's rule applies again).
    expect(src).toMatch(/transition: sidebarDrag\.dragging \? 'none' : undefined/)
    // antd consumes `width` — the clamped value, never the raw stored one.
    expect(src).toMatch(/width=\{effSidebarWidth\}/)
    // The handle is the drag region opt-out: the full-height column crosses
    // the title row's app-drag region.
    expect(src).toMatch(/WebkitAppRegion: 'no-drag'/)
  })

  it('sidebarStore persists the width under its own localStorage key', () => {
    const src = read('src/renderer/src/stores/sidebarStore.ts')
    expect(src).toContain("name: 'pulsemind-sidebar'")
    expect(src).toMatch(/partialize: \(s\) => \(\{ width: s\.width \}\)/)
  })

  it('WorkspacePane: tree↔preview divider wired, the fixed share is gone', () => {
    const src = read('src/renderer/src/components/workbench/WorkspacePane.tsx')
    expect(src).toContain('data-pm-tree-drag-handle')
    expect(src).toContain('clampTreeWidth')
    expect(src).toContain('setTreeWidth')
    expect(src).toContain('ResizeObserver')
    // The old percentage shape must not survive next to the px store.
    expect(src).not.toContain('TREE_SHARE')
    expect(src).not.toMatch(/width: `\$\{/)
    // Direction invariant (the first cut shipped this backwards): both new
    // columns are LEFT-aligned with the handle on their right edge, so the
    // border must follow the pointer — rightward travel widens. The mirrored
    // -1 belongs to right-docked panes (WorkbenchPane's own inline drag).
    expect(src).toMatch(/direction: 1,/)
  })

  it('AppLayout: the sidebar drag is border-follows-pointer too', () => {
    const src = read('src/renderer/src/components/layout/AppLayout.tsx')
    expect(src).toMatch(/direction: 1,/)
  })

  it('workbenchStore persists treeWidth with the per-tab pane widths', () => {
    const src = read('src/renderer/src/stores/workbenchStore.ts')
    expect(src).toContain('WORKBENCH_DEFAULT_TREE_WIDTH')
    // 2026-11-06：宽度按 tab 分开（widthByTab），落盘形状随之改名。
    expect(src).toContain('partialize: workbenchPersistShape')
    expect(src).toContain('return { widthByTab: s.widthByTab, activeTab: s.activeTab, treeWidth: s.treeWidth } as WorkbenchState')
  })

  it('both drags share the pointer guards the workbench handle paid for', () => {
    const src = read('src/renderer/src/hooks/useColumnDrag.ts')
    expect(src).toContain('setPointerCapture')
    // pointercancel fires no pointerup — a hover must not keep resizing.
    expect(src).toMatch(/e\.buttons === 0/)
    // Only the pointer that started the drag may end it.
    expect(src).toMatch(/e\.pointerId !== d\.pointerId/)
  })
})
