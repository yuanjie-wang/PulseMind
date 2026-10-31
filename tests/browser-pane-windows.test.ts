/**
 * 浏览器窗格 per-window 注册表（PLAN-popout-browser-pane，2026-10-31）：
 * dock 从主窗单例改为按窗口注册表，BrowserService 的 pane 状态/push/freshness
 * 全部按 windowId 键控——弹窗承载自己的浏览器窗格，两窗各看各的 scope 零争用
 * （watch 守卫链保证一个会话只活在一个窗口）。
 *
 * 驱动真 BrowserService + 真 dock 注册表：electron stub 的
 * fromWebContents 恒 null，窗口解析经 resolveWindow seam 覆写映射到 fake
 * window（id/on/getContentSize/contentView），fake sender 记录收到的推送。
 * app-view backend 刻意不建（无 CDP）：viewOfTab 回 null、url/title 空，
 * scope 内的 tab 由台账直种——正好隔离出「per-window 路由」这一层。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents, WebContentsView } from 'electron'

process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-pane-windows-'))

const { BrowserService } = await import('../src/main/browser/BrowserService')
const { appViewDock } = await import('../src/main/browser/app-view-dock')

type FakeWin = BrowserWindow & { destroyed: boolean; destroy(): void }

const sent: Array<{ sender: WebContents; payload: Record<string, unknown> }> = []

const makeWindow = (id: number): FakeWin => {
  const added: unknown[] = []
  const removed: unknown[] = []
  const win = {
    id,
    destroyed: false,
    isDestroyed() { return this.destroyed },
    on() { return win },
    getContentSize() { return [1280, 800] },
    contentView: {
      addChildView: (v: unknown) => { added.push(v) },
      removeChildView: (v: unknown) => { removed.push(v) },
    },
    __added: added,
    __removed: removed,
    destroy() { this.destroyed = true },
  }
  return win as unknown as FakeWin
}

const makeSender = () => {
  const sender = {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    send(_channel: string, payload: Record<string, unknown>) { sent.push({ sender: sender as unknown as WebContents, payload }) },
  }
  return sender as unknown as WebContents & { __id: symbol }
}

const svc = new BrowserService()
const winBySender = new Map<WebContents, FakeWin>()
;(svc as unknown as { resolveWindow: (s: WebContents) => FakeWin | null }).resolveWindow = (s) => winBySender.get(s) ?? null

const stateOf = (convId: string, chatAreaWidth = 800) => ({ viewKind: 'chat', conversationId: convId, chatAreaWidth, browserActive: true, chromeOverlayHeight: 0 })

const seedTab = (id: string, scopeId: string) => {
  ;(svc as unknown as { tabs: Map<string, unknown> }).tabs.set(id, {
    id, backendId: 'app-view', scopeId, origin: 'user', createdAt: '2026-10-31T00:00:00.000Z',
    tab: { close: async () => {} },
  })
}

const reset = () => {
  sent.length = 0
  winBySender.clear()
  for (const key of ['paneWindows', 'lastPanePush', 'lastShownFresh', 'tabs', 'paneActiveTab'] as const) {
    ;(svc as unknown as Record<string, Map<unknown, unknown>>)[key] = new Map()
  }
  ;(svc as unknown as { paneWidth: number | null }).paneWidth = null
  ;(appViewDock as unknown as { docks: Map<number, unknown> }).docks.clear()
}

const sendsTo = (sender: WebContents) => sent.filter((s) => s.sender === sender).map((s) => s.payload)

beforeEach(reset)

describe('per-window pane registry', () => {
  it('two windows, two scopes: each sender receives ONLY its own scoped snapshot', () => {
    const winA = makeWindow(1); const winB = makeWindow(2)
    const senderA = makeSender(); const senderB = makeSender()
    winBySender.set(senderA, winA); winBySender.set(senderB, winB)
    seedTab('t1', 'conv_a')

    svc.handlePaneState(stateOf('conv_a'), senderA)
    svc.handlePaneState(stateOf('conv_b'), senderB)

    const a = sendsTo(senderA)
    const b = sendsTo(senderB)
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBeGreaterThan(0)
    const lastA = a[a.length - 1]
    const lastB = b[b.length - 1]
    // Window A shows conv_a WITH its tab; window B shows conv_b (none).
    expect(lastA.conversationId).toBe('conv_a')
    expect(lastA.visible).toBe(true)
    expect(lastA.tabs).toEqual([{ id: 't1', url: '', title: '', active: true }])
    expect(lastB.conversationId).toBe('conv_b')
    expect(lastB.visible).toBe(false)
    expect(lastB.tabs).toEqual([])
    // No cross-talk: A never learns B's scope, nor the reverse.
    expect(a.every((p) => p.conversationId === 'conv_a')).toBe(true)
    expect(b.every((p) => p.conversationId === 'conv_b')).toBe(true)
  })

  it('a renderer reload (same window, new sender) re-pushes identical content', () => {
    const winA = makeWindow(1)
    const senderA1 = makeSender(); const senderA2 = makeSender()
    winBySender.set(senderA1, winA); winBySender.set(senderA2, winA)
    seedTab('t1', 'conv_a')
    svc.handlePaneState(stateOf('conv_a'), senderA1)
    const before = sendsTo(senderA2).length
    // Same window id, fresh WebContents: the equality gate must not swallow
    // the re-push (review 2026-09-18 M1, now per window).
    svc.handlePaneState(stateOf('conv_a'), senderA2)
    expect(sendsTo(senderA2).length).toBeGreaterThan(before)
  })

  it('pane actions route to the SENDER window’s scope (no cross-window reach)', async () => {
    const winA = makeWindow(1); const winB = makeWindow(2)
    const senderA = makeSender(); const senderB = makeSender()
    winBySender.set(senderA, winA); winBySender.set(senderB, winB)
    seedTab('t1', 'conv_a')
    seedTab('t2', 'conv_a')
    svc.handlePaneState(stateOf('conv_a'), senderA)
    svc.handlePaneState(stateOf('conv_b'), senderB)
    sent.length = 0

    // B tries to select A's tab — the scope guard must drop it.
    await svc.handlePaneAction({ op: 'selectTab', tabId: 't1' } as never, senderB)
    // A selects its own OLDER tab (active falls back to the newest, t2 — so
    // this selection actually changes something and must push).
    await svc.handlePaneAction({ op: 'selectTab', tabId: 't1' } as never, senderA)

    const a = sendsTo(senderA)
    expect(a.length).toBeGreaterThan(0)
    const lastTabs = a[a.length - 1].tabs as Array<{ id: string; active: boolean }>
    expect(lastTabs.find((t) => t.id === 't1')?.active).toBe(true)
    expect(lastTabs.find((t) => t.id === 't2')?.active).toBe(false)
    // B's snapshot never shows A's tabs as its own.
    for (const p of sendsTo(senderB)) {
      for (const t of (p.tabs as Array<Record<string, unknown>>) ?? []) expect(t.id).not.toBe('t1')
    }
  })

  it('width drag clamps against the SENDER window’s chat area, applies to every dock', async () => {
    const winA = makeWindow(1); const winB = makeWindow(2)
    const senderA = makeSender(); const senderB = makeSender()
    winBySender.set(senderA, winA); winBySender.set(senderB, winB)
    svc.handlePaneState(stateOf('conv_a', 800), senderA)
    svc.handlePaneState(stateOf('conv_b', 1300), senderB)
    sent.length = 0

    await svc.handlePaneWidth(5000, senderA) // absurd — clamps to 60% of 800 = 480

    for (const p of sendsTo(senderA)) expect(p.width).toBe(480)
    for (const p of sendsTo(senderB)) expect(p.width).toBe(480)
    const dockA = appViewDock.dockFor(winA) as unknown as { width: number }
    const dockB = appViewDock.dockFor(winB) as unknown as { width: number }
    expect(dockA.width).toBe(480)
    expect(dockB.width).toBe(480)
  })

  it('a destroyed window is pruned (no entry, no further pushes)', async () => {
    const winA = makeWindow(1); const winB = makeWindow(2)
    const senderA = makeSender(); const senderB = makeSender()
    winBySender.set(senderA, winA); winBySender.set(senderB, winB)
    seedTab('t1', 'conv_a')
    svc.handlePaneState(stateOf('conv_a'), senderA)
    svc.handlePaneState(stateOf('conv_b'), senderB)
    expect(sendsTo(senderA).length).toBeGreaterThan(0)
    sent.length = 0

    winA.destroyed = true
    senderA.destroyed = true
    // Any service tick prunes — B's push runs the sweep.
    svc.handlePaneState(stateOf('conv_b'), senderB)

    expect((svc as unknown as { paneWindows: Map<number, unknown> }).paneWindows.has(1)).toBe(false)
    expect(sendsTo(senderA).length).toBe(0)
  })
})

describe('dock registry: re-parenting + holder-routed detach/zoom', () => {
  it('show() steals the view from the previous dock (re-parenting)', () => {
    const winA = makeWindow(1); const winB = makeWindow(2)
    const view = { setBounds: () => {}, webContents: { setZoomFactor: () => {} } } as unknown as WebContentsView
    appViewDock.show(winA, view)
    expect((winA as unknown as { __added: unknown[] }).__added).toContain(view)
    appViewDock.show(winB, view)
    // Removed from A, mounted in B — a view has exactly one parent.
    expect((winA as unknown as { __removed: unknown[] }).__removed).toContain(view)
    expect((winB as unknown as { __added: unknown[] }).__added).toContain(view)
  })

  it('detach and restampZoom route to the dock HOLDING the view', () => {
    const winA = makeWindow(1)
    const zoom = { calls: 0 }
    const view = { setBounds: () => {}, webContents: { setZoomFactor: () => { zoom.calls++ } } } as unknown as WebContentsView
    appViewDock.show(winA, view)
    // Visible is still false here — the show folded the view (0×0, no stamp).
    expect(zoom.calls).toBe(0)
    appViewDock.setVisible(winA, true)
    // The layout lift stamps the zoom once (the holding dock's own width).
    expect(zoom.calls).toBe(1)
    appViewDock.restampZoom(view)
    expect(zoom.calls).toBe(2)
    appViewDock.detach(view)
    // After detach nothing holds the view — no further stamp.
    appViewDock.restampZoom(view)
    expect(zoom.calls).toBe(2)
    expect((winA as unknown as { __removed: unknown[] }).__removed).toContain(view)
  })
})

// ── 沉浸窗口 pane 契约（2026-10-31 三面板：insets + paneWidth 直通）──
describe('immersive pane contract: insets + paneWidth 直通', () => {
  it('paneWidth 绕开 chatArea clamp；insets 到 dock；缺省 = 全 0（主窗/popout 旧几何不变）', () => {
    const win = makeWindow(31)
    const sender = makeSender()
    winBySender.set(sender, win)
    seedTab('t1', 'conv_a')
    svc.handlePaneState(
      { ...stateOf('conv_a'), paneWidth: 666, topInset: 38, rightInset: 5, bottomInset: 6 } as never,
      sender,
    )
    const dock = (appViewDock as unknown as { docks: Map<number, { width: number; topInset: number; rightInset: number; bottomInset: number }> })
      .docks.get(31)!
    // 直通：不是 clampPaneWidth(…, chatAreaWidth 800) 的旧数学。
    expect(dock.width).toBe(666)
    expect(dock.topInset).toBe(38)
    expect(dock.rightInset).toBe(5)
    expect(dock.bottomInset).toBe(6)
  })

  it('不带 inset/paneWidth 的推送（主窗/popout）：insets 全 0、宽度走旧 clamp', () => {
    const win = makeWindow(32)
    const sender = makeSender()
    winBySender.set(sender, win)
    svc.handlePaneState(stateOf('conv_a'), sender)
    const dock = (appViewDock as unknown as { docks: Map<number, { width: number; topInset: number; rightInset: number; bottomInset: number }> })
      .docks.get(32)!
    expect(dock.topInset).toBe(0)
    expect(dock.rightInset).toBe(0)
    expect(dock.bottomInset).toBe(0)
    expect(dock.width).toBe((svc as unknown as { resolvePaneWidthFor: (w: number) => number }).resolvePaneWidthFor(800))
  })

  it('dock layout() 把原生 view 收进卡片内容盒：paneTop += topInset、右缘收 rightInset、高度扣 bottomInset', () => {
    const win = makeWindow(33)
    const dock = appViewDock.dockFor(win as unknown as BrowserWindow)
    const boxes: Array<{ x: number; y: number; width: number; height: number }> = []
    const view = {
      setBounds: (b: { x: number; y: number; width: number; height: number }) => { boxes.push({ ...b }) },
      webContents: { setZoomFactor: () => {} },
    } as unknown as WebContentsView
    const d = dock as unknown as {
      attached: unknown
      mounted: Set<unknown>
      visible: boolean
      width: number
      setInsets: (t: number, r: number, b: number) => void
    }
    d.attached = view
    d.mounted = new Set([view])
    d.visible = true
    d.width = 500
    d.setInsets(38, 5, 6)
    const box = boxes[boxes.length - 1]
    // 内容 1280×800：paneTop = TITLE_BAR(56)+38；paneHeight = 800−94−6。
    // view 宽 = 500−3（webviewBox 自身的 divider 内缩），右缘 = 1280−5−1。
    expect(box.width).toBe(497)
    expect(box.x).toBe(1280 - 500 - 5 + 2)
    const height = Math.floor((497 * 9) / 16)
    const available = 800 - (56 + 38) - 6 - 100
    expect(box.y).toBe(56 + 38 + 100 + Math.floor((available - height) / 2))
    // 归零回落旧几何：pane 贴窗右缘、从 TITLE_BAR_HEIGHT 起。
    d.setInsets(0, 0, 0)
    const base = boxes[boxes.length - 1]
    expect(base.x).toBe(1280 - 500 + 2)
    expect(base.y).toBe(56 + 100 + Math.floor((800 - 56 - 100 - height) / 2))
  })
})
