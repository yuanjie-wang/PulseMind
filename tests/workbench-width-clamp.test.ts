// The workbench pane's persisted width must be clamped at every CONSUMPTION
// point, not only while dragging. The zustand-persisted width survives across
// windows and restarts; a drag under one viewport (or the 2026-10-06 zoom
// incident, whose 3× CSS viewport let a drag store 1854px) leaves a stored
// value larger than today's chat area, and the unclamped consumers rendered
// an absolutely-positioned pane wider than the window — the 侧边窗口撑满
// report. The drag handler always clamped; these scans own the render path:
// WorkbenchPane's root box + drag origin, and ChatView's paddingRight
// reserve, each through the shared clampPaneWidth.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const workbench = readFileSync(join(ROOT, 'src/renderer/src/components/workbench/WorkbenchPane.tsx'), 'utf-8')
const chatView = readFileSync(join(ROOT, 'src/renderer/src/components/layout/ChatView.tsx'), 'utf-8')

describe('persisted workbench width is clamped at consumption', () => {
  it('non-vacuity: the scans read the real persisted-width consumers', () => {
    expect(workbench).toContain('const width = useWorkbenchStore((s) => s.width)')
    expect(workbench).toContain('clampPaneWidth(d.startWidth + (d.startX - e.clientX), chatAreaWidth)')
    expect(chatView).toContain('paddingRight: workbenchOpen ?')
  })

  it('WorkbenchPane derives effWidth from the shared clamp and uses it for render + drag origin', () => {
    expect(workbench).toContain('const effWidth = clampPaneWidth(width, chatAreaWidth)')
    // Drag starts from what is on screen, not from the raw stored value —
    // otherwise the first drag move jumps back to the unclamped width.
    expect(workbench).toContain('startWidth: effWidth')
    // The root box renders the clamped width.
    expect(workbench).toMatch(/width: effWidth,\s*\n\s*background: 'var\(--pm-bg\)'/)
  })

  it('ChatView reserves the clamped width for the chat column', () => {
    expect(chatView).toContain('paddingRight: workbenchOpen ? clampPaneWidth(workbenchWidth, chatAreaWidth) : 0')
  })
})
