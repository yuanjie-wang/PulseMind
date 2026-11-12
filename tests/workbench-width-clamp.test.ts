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
    // 2026-11-12 起宽度按会话取（useWorkbenchWidth(<会话键>)）。
    expect(workbench).toContain('const width = useWorkbenchWidth(key)')
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
    // 卡片形态（2026-11-03）reserve 再加一个卡边距；非卡片形态（弹窗）零加宽。
    expect(chatView).toContain('paddingRight: workbenchOpen ? clampPaneWidth(workbenchWidth, chatAreaWidth) + (card ? WORKBENCH_CARD_MARGIN : 0) : 0')
  })

  it('卡片形态：对话卡与工作台卡成对出现，浏览器 dock 三 inset 随形态携带', () => {
    // ChatView 只在 card 形态把 card 传给 WorkbenchPane 与 pane binding——
    // 沉浸窗口这条旧路径不携带，几何逐字节不变（2026-11-04 起会话弹出窗口
    // 也套卡，见下一条）。
    expect(chatView).toContain('card={card}')
    expect(chatView).toContain('useBrowserPaneBinding(conversationId, paneRootRef, card)')
    // 工作台卡：窗口边距 + 1px 全边框接管 borderLeft + 沉浸同款圆角。
    expect(workbench).toContain('card ? WORKBENCH_CARD_MARGIN : 0')
    expect(workbench).toContain("border: '1px solid var(--pm-separator-faint)'")
    expect(workbench).toContain('borderRadius: IMMERSIVE_CARD_RADIUS')
    // binding 的非沉浸分支按形态携带 dock 补偿（shared/browser/pane 的常量）。
    const binding = readFileSync(join(ROOT, 'src/renderer/src/hooks/useBrowserPane.ts'), 'utf-8')
    expect(binding).toContain('cardMode')
    expect(binding).toContain('topInset: WORKBENCH_CARD_TOP_INSET')
    expect(binding).toContain('rightInset: WORKBENCH_CARD_RIGHT_INSET')
    expect(binding).toContain('bottomInset: WORKBENCH_CARD_BOTTOM_INSET')
  })

  it('会话弹出窗口与主窗同一套卡（2026-11-04 统一）：card 直通 + Layout 灰底底衬', () => {
    const popout = readFileSync(join(ROOT, 'src/renderer/src/popout/PopoutApp.tsx'), 'utf-8')
    // 分叉的根因就是这一个 flag：App.tsx 传了、PopoutApp 没传。项目沉浸窗口
    // 自带 ProjectExplorer 三列卡，所以 card = !isProjectWindow。
    expect(popout).toContain('const card = !isProjectWindow')
    expect(popout).toContain('card={card}')
    // 底衬必须走 antd Layout（它自绘 colorBgLayout），不能自己写颜色——
    // 卡片是 var(--pm-bg)，白卡放在白底上等于没有卡。
    expect(popout).toContain("<Layout style={{ flex: 1, minHeight: 0, position: 'relative' }}>")
    // 子代理 drill-in 覆盖层与主窗同款卡盒（right 收进工作台卡 + 双倍边距）。
    expect(popout).toContain('clampPaneWidth(workbenchWidth, chatAreaWidth) + WORKBENCH_CARD_MARGIN * 2')
    // 标题栏底色落在真实存在的变量上（--pm-bg-container 从未定义，取值非法
    // 即透明，只是碰巧露出了根底色）。
    expect(popout).not.toContain("'var(--pm-bg-container)'")
  })
})
