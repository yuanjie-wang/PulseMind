// CDP idle-disconnect wiring（2026-10-29 白屏根因）：app-view 后端的
// connectOverCDP 会话存活期间，Playwright 的浏览器级
// Target.setAutoAttach(waitForDebuggerOnStart) 把主窗新建的沙箱子帧扣在
// 「等待调试器」态——工作区预览的 local-file iframe 请求被协议层正常 200 服务，
// 文档却永远不提交（白屏，直到重启）。修复 = 连接只在 agent 浏览器命令实际
// 流动时存活：start() 武装 90s 空闲定时器，到点只关 Playwright 句柄（视图是
// Electron 自己的 WebContentsView，存活），下一条命令 start() 重连 + 按记号
// 重新定位页面。AppViewBackend 拖着 electron，vitest 进不去——这里按本仓的
// wiring 扫描口径钉源码形状。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const backendSrc = readFileSync(join(__dirname, '../src/main/browser/backends/AppViewBackend.ts'), 'utf-8')
const serviceSrc = readFileSync(join(__dirname, '../src/main/browser/BrowserService.ts'), 'utf-8')
const adapterSrc = readFileSync(join(__dirname, '../src/main/browser/backends/BackendAdapter.ts'), 'utf-8')

describe('app-view CDP idle-disconnect wiring', () => {
  it('start() arms the idle disconnect on every connect (keepalive path)', () => {
    // both the fresh-connect and the already-connected early return re-arm —
    // a command arriving mid-window must push the timer back out.
    const startBody = backendSrc.slice(backendSrc.indexOf('async start():'), backendSrc.indexOf('async stop():'))
    expect(startBody.match(/armIdleDisconnect\(\)/g)?.length).toBe(2)
  })

  it('the idle timeout drops ONLY the Playwright handle — views survive', () => {
    expect(backendSrc).toContain('CDP_IDLE_DISCONNECT_MS = 90_000')
    const disconnect = backendSrc.slice(backendSrc.indexOf('private disconnectCdp'), backendSrc.indexOf('async refreshTab'))
    expect(disconnect).toContain('this.browser.close()')
    expect(disconnect).toContain('this.browser = null')
    // 视图与 token 表不得在断开路径里被清（折叠保留、tab 存活的契约）
    expect(disconnect).not.toContain('this.views.clear()')
    expect(disconnect).not.toContain('destroyView')
  })

  it('stop() clears the timer (app quit must not hang on the handle)', () => {
    const stopBody = backendSrc.slice(backendSrc.indexOf('async stop():'), backendSrc.indexOf('/** Re-arm on every'))
    expect(stopBody).toContain('clearIdleDisconnect()')
  })

  it('refreshTab re-resolves a live page for an existing view', () => {
    expect(backendSrc).toContain('async refreshTab(tabId: string)')
    // the marker is re-injected before the sweep: newTab injects it on the
    // about:blank it starts from — every real tab navigated away since.
    const refresh = backendSrc.slice(backendSrc.indexOf('async refreshTab'), backendSrc.indexOf('viewOf(tabId'))
    expect(refresh).toContain('MARKER_KEY')
    expect(refresh).toContain('findPageByToken')
  })

  it('the adapter seam declares refreshTab (optional — managed has no wedge)', () => {
    expect(adapterSrc).toContain('refreshTab?(tabId: string): Promise<BackendTab>')
  })

  it('BrowserService re-resolves stale handles at the agent command boundary', () => {
    expect(serviceSrc).toContain('private async ensureLivePage(entry: ServiceTab)')
    expect(serviceSrc).toContain('await this.ensureLivePage(entry)')
    // the probe + refresh shape: dead handle → refreshTab
    const helper = serviceSrc.slice(serviceSrc.indexOf('private async ensureLivePage'), serviceSrc.indexOf('  /** CDP idle-disconnect') > -1 ? serviceSrc.length : undefined)
    expect(helper).toContain('refreshTab(entry.id)')
  })
})
