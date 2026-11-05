/**
 * 对话弹出为独立窗口（PLAN-conversation-popout，2026-10-30 用户四连裁定 +
 * 「携带配套右边侧边窗口」）。架构依据：会话托管在主进程、AGENT_SESSION_EVENT
 * 已广播给所有窗口、createSession 幂等、snapshot() 供中途附接——popout 只是
 * 同一 IPC 协议的第二个桌面客户端。
 *
 * 单写者是本功能的硬裁定：popout 以 savesEnabled:false 运行（只驱动、不写库），
 * 主窗通过 adoptConversation 收养被弹出的会话（建镜像 + 播种保存基线），10s
 * sweep 与 beforeunload 兜底自然覆盖它。full-save 的 deleteMessagesNotIn 让
 * 双写会互相删行——门存在的理由。
 *
 * 本文件钉：纯函数（剔除弹出的驱逐候选 / popout 注册表折叠）+ 三层 wiring
 * 扫描（channels/preload/bridge、popout-window、index 挂点、persistence 门与
 * 收养、engine isRead/seed、App/main/PopoutApp/useBrowserPane/ConversationRows）。
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'

const { selectEvictionCandidates } = await import('../src/renderer/src/hooks/useConversationEngine')
const { usePopoutWatchStore, isPoppedOut, routeToProjectWindow } = await import('../src/renderer/src/stores/popoutWatchStore')

// ── 纯逻辑：boot 模式探测（jsdom：真 window.location.search） ────────────────

describe('parsePopoutParam (boot flag)', () => {
  const importWithSearch = async (search: string): Promise<typeof import('../src/renderer/src/popout/boot')> => {
    const dom = new JSDOM(`<!doctype html><html><body></body></html>`, { url: `http://localhost/${search}` })
    ;(globalThis as unknown as { window: unknown }).window = dom.window
    vi.resetModules() // boot.ts caches the parse result module-level
    return import('../src/renderer/src/popout/boot')
  }

  it('reads ?popout=<convId> and flips IS_POPOUT', async () => {
    const boot = await importWithSearch('?popout=conv_20261030')
    expect(boot.parsePopoutParam()).toEqual({ convId: 'conv_20261030' })
    expect(boot.IS_POPOUT).toBe(true)
  })

  it('no param = main window (null + IS_POPOUT false)', async () => {
    const boot = await importWithSearch('')
    expect(boot.parsePopoutParam()).toBeNull()
    expect(boot.IS_POPOUT).toBe(false)
  })

  it('an empty value does not pop out (falsy id → main window)', async () => {
    const boot = await importWithSearch('?popout=')
    expect(boot.parsePopoutParam()).toBeNull()
  })
})

// ── 纯函数：驱逐候选剔除被弹出的会话 ─────────────────────────────────────────

describe('selectEvictionCandidates × poppedOut', () => {
  const entries = [
    { id: 'a', status: 'completed' as const, touchedAt: 100 },
    { id: 'b', status: 'idle' as const, touchedAt: 200 },
    { id: 'c', status: 'idle' as const, touchedAt: 300 },
  ]

  it('excludes conversations with a popout attached (their client would die)', () => {
    expect(selectEvictionCandidates(entries, '', new Set(['b']))).toEqual(['a', 'c'])
    expect(selectEvictionCandidates(entries, '', new Set(['a', 'b', 'c']))).toEqual([])
  })

  it('absent/short set keeps the old behavior byte-identical', () => {
    expect(selectEvictionCandidates(entries, '')).toEqual(['a', 'b', 'c'])
    expect(selectEvictionCandidates(entries, 'c', new Set())).toEqual(['a', 'b'])
  })

  it('the active conversation is still excluded regardless of the popout set', () => {
    expect(selectEvictionCandidates(entries, 'b', new Set(['a']))).toEqual(['c'])
  })
})

// ── 纯逻辑：popout 注册表 ────────────────────────────────────────────────────

describe('popoutWatchStore', () => {
  it('add/remove fold idempotently and isPoppedOut reads non-reactively', () => {
    const { add, remove, byConversation } = usePopoutWatchStore.getState()
    expect(Object.keys(byConversation)).toEqual([])

    add('conv_x')
    add('conv_x') // idempotent — same object when unchanged
    expect(isPoppedOut('conv_x')).toBe(true)
    expect(isPoppedOut('conv_y')).toBe(false)

    add('conv_y')
    remove('conv_x')
    expect(isPoppedOut('conv_x')).toBe(false)
    expect(isPoppedOut('conv_y')).toBe(true)

    remove('conv_y')
    remove('conv_y') // idempotent
    expect(Object.keys(usePopoutWatchStore.getState().byConversation)).toEqual([])
  })
})

// ── 纯逻辑：主窗点击的项目会话路由（沉浸窗口优先，2026-11-01） ────────────────

describe('routeToProjectWindow (click routing)', () => {
  const convs = [
    { key: 'loose', label: 'loose' },
    { key: 'p1', label: 'in project', projectId: 'proj_1' },
  ]
  // A REAL jsdom window (not a bare stub): later tests in this file rely on
  // window.localStorage surviving — a bare object broke the zustand-persist
  // stores applyPopoutSeed touches.
  const withElectron = (impl: unknown): void => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
    const w = dom.window as unknown as { electronAPI?: unknown }
    w.electronAPI = { projectWindowFocusConversation: impl }
    ;(globalThis as unknown as { window: unknown }).window = w
  }

  it('a project conversation delegates to the immersive window and reports taken', async () => {
    const focus = vi.fn().mockResolvedValue(true)
    withElectron(focus)
    await expect(routeToProjectWindow(convs, 'p1')).resolves.toBe(true)
    expect(focus).toHaveBeenCalledWith('proj_1', 'p1')
  })

  it('false from main (no window open) falls through to the in-window open', async () => {
    const focus = vi.fn().mockResolvedValue(false)
    withElectron(focus)
    await expect(routeToProjectWindow(convs, 'p1')).resolves.toBe(false)
  })

  it('a loose conversation (no projectId) never invokes main', async () => {
    const focus = vi.fn()
    withElectron(focus)
    await expect(routeToProjectWindow(convs, 'loose')).resolves.toBe(false)
    expect(focus).not.toHaveBeenCalled()
  })

  it('an IPC failure falls through (never blocks the in-window open)', async () => {
    withElectron(vi.fn().mockRejectedValue(new Error('boom')))
    await expect(routeToProjectWindow(convs, 'p1')).resolves.toBe(false)
  })
})

// ── wiring 扫描：三层 + 各处连接点 ───────────────────────────────────────────

const ROOT = join(process.cwd(), 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

describe('popout IPC: channels → preload → bridge', () => {
  it('declares the channels', () => {
    const ch = read('shared/ipc-channels.ts')
    expect(ch).toContain("POPOUT_OPEN: 'popout:open'")
    expect(ch).toContain("POPOUT_LIST: 'popout:list'")
    expect(ch).toContain("POPOUT_SEED: 'popout:seed'")
    expect(ch).toContain("POPOUT_EVENT: 'popout:event'")
    expect(ch).toContain("CONVERSATION_TITLE_CHANGED: 'conversation:title-changed'")
  })

  it('preload exposes popoutOpen / popoutSeed / popoutList / onPopoutEvent / onConversationTitleChanged', () => {
    const pre = read('preload/index.ts')
    expect(pre).toContain('popoutOpen: (convId: string, title?: string, seed?: PopoutWorkbenchSeed)')
    expect(pre).toContain('ipcRenderer.invoke(IPC_CHANNELS.POPOUT_OPEN, convId, title, seed)')
    expect(pre).toContain('popoutSeed: (convId: string)')
    expect(pre).toContain('ipcRenderer.invoke(IPC_CHANNELS.POPOUT_SEED, convId)')
    expect(pre).toContain('popoutList: (): Promise<string[]>')
    expect(pre).toContain('ipcRenderer.invoke(IPC_CHANNELS.POPOUT_LIST)')
    expect(pre).toContain('onPopoutEvent:')
    expect(pre).toContain('ipcRenderer.on(IPC_CHANNELS.POPOUT_EVENT, listener)')
    expect(pre).toContain('onConversationTitleChanged:')
    expect(pre).toContain('ipcRenderer.on(IPC_CHANNELS.CONVERSATION_TITLE_CHANGED, listener)')
  })

  it('the bridge types declare the same methods', () => {
    const b = read('shared/types/electron-bridge.ts')
    expect(b).toContain('popoutOpen: (convId: string, title?: string, seed?: PopoutWorkbenchSeed) => Promise<void>')
    expect(b).toContain('popoutSeed: (convId: string) => Promise<PopoutWorkbenchSeed | null>')
    expect(b).toContain('workbenchTab')
    expect(b).toContain('previewPaths')
    expect(b).toContain('activePreviewPath')
    expect(b).toContain('popoutList: () => Promise<string[]>')
    expect(b).toContain("onPopoutEvent: (callback: (event: { type: 'opened' | 'closed'; sessionId: string }) => void) => () => void")
    expect(b).toContain('onConversationTitleChanged:')
  })
})

describe('main: popout window module', () => {
  const pop = read('main/popout-window.ts')

  it('loads the renderer entry with the popout query param (dev URL + prod file)', () => {
    expect(pop).toContain("devUrl.searchParams.set('popout', convId)")
    expect(pop).toContain("loadFile(join(__dirname, '../renderer/index.html'), { query: { popout: convId } })")
    expect(pop).toContain("preload: join(__dirname, '../preload/index.js')")
    // A hidden popout still streams a live turn.
    expect(pop).toContain('backgroundThrottling: false')
  })

  it('stashes the donor seed in an in-memory registry (2026-10-31 ruling)', () => {
    // 弹出携带侧边窗口的打开状态：popoutOpen 收 seed → popoutSeeds.set；弹窗
    // 经 POPOUT_SEED 取回；窗口关闭即删——纯内存，不落任何持久化。
    expect(pop).toContain('const popoutSeeds = new Map<string, PopoutWorkbenchSeed>()')
    expect(pop).toContain('if (seed) popoutSeeds.set(convId, seed)')
    expect(pop).toContain('popoutSeeds.delete(convId)')
    expect(pop).toContain('export function getPopoutSeed(convId: string): PopoutWorkbenchSeed | null')
    expect(pop).toContain('return popoutSeeds.get(convId) ?? null')
  })

  it('carries the main window navigation gates and a sticky title', () => {
    expect(pop).toContain('setWindowOpenHandler')
    expect(pop).toContain('will-navigate')
    expect(pop).toContain("win.on('page-title-updated'")
  })

  it('one popout per conversation (focus existing) and closes cleanly', () => {
    expect(pop).toContain('popouts.get(convId)')
    expect(pop).toContain('existing.focus()')
    expect(pop).toContain('export function closeAllPopouts')
    expect(pop).toContain('export function broadcastPopoutEvent')
  })

  it('BOTH lifecycle events are actually sent (a sender-less event is invisible)', () => {
    // The pin that was missing: asserting the FUNCTION exists is not enough —
    // the 'opened' call site is what carries adoption + read receipt + the
    // welcome retreat + the raise-on-click guard. Its absence shipped once
    // (found in testing 2026-10-30) and silently broke all four.
    expect(pop).toContain("broadcastPopoutEvent('opened', convId)")
    expect(pop).toContain("broadcastPopoutEvent('closed', convId)")
  })

  it('exposes the live popout list for the main window to re-sync on mount', () => {
    expect(pop).toContain('export function listPopoutConversations')
    // The list must include what a PROJECT window is driving (2026-10-30):
    // its conversations are adopted + saved by the main window exactly like a
    // popout's, so a reloaded main window that only saw `popouts` would
    // re-open them in-window and stop saving them.
    expect(pop).toContain('return [...popouts.keys(), ...watchedSessions.keys()]')
  })

  it('never attaches the main-window browser dock (appViewDock is a singleton)', () => {
    expect(pop).not.toContain('appViewDock')
  })
})

describe('main: lifecycle + handler registration', () => {
  it('closing the main window closes every popout', () => {
    expect(read('main/index.ts')).toContain("mainWindow.on('closed', closeAllPopouts)")
  })
  it('theme flips refresh popout title bars too (caller-resolved mode, 2026-11-02)', () => {
    expect(read('main/index.ts')).toContain('refreshPopoutTitleBarTheme(bootThemeMode)')
  })
  it('the popout handler is registered', () => {
    expect(read('main/ipc/index.ts')).toContain('registerPopoutHandlers()')
    const h = read('main/ipc/popout.handler.ts')
    expect(h).toContain('IPC_CHANNELS.POPOUT_OPEN')
    expect(h).toContain('IPC_CHANNELS.POPOUT_LIST')
    // The seed fetch: popout boot pulls the donor state before rendering.
    expect(h).toContain('IPC_CHANNELS.POPOUT_SEED')
    expect(h).toContain('listPopoutConversations')
    expect(h).toContain('getPopoutSeed(convId)')
  })
  it('the title write fans out (OS title + sidebar list broadcast)', () => {
    const ch = read('main/ipc/conversation.handler.ts')
    expect(ch).toContain('setPopoutTitle(id, title)')
    expect(ch).toContain('win.webContents.send(IPC_CHANNELS.CONVERSATION_TITLE_CHANGED')
  })
})

describe('renderer: single-writer gate + adoption', () => {
  const pers = read('renderer/src/hooks/useConversationPersistence.ts')

  it('every transcript write path is gated on savesEnabled', () => {
    expect(pers).toContain('const savesEnabled = options.savesEnabled !== false')
    // saveConversationById / sync saver / debounced / tick / streaming-end
    expect(pers).toContain('if (!convId || !savesEnabled) return false')
    expect(pers).toContain('if (!convId || !savesEnabled) return')
    expect(pers).toContain('if (!savesEnabled) return')
    expect(pers).toContain('if (savesEnabled) saveCurrentConversation()')
  })

  it('adopts a popped conversation: snapshot-first, never clobbers a live engine', () => {
    expect(pers).toContain('const adoptConversation = useCallback')
    expect(pers).toContain('agentSessionSnapshot(key)')
    // The cold arm only runs when the engine AND the snapshot are both empty.
    expect(pers).toContain('engine.messages.length === 0 && snapMsgs.length === 0 && dbMsgs.length > 0')
    expect(pers).toContain('seedSessionSnapshot(key, snap!)')
    // The baseline is always the DB truth.
    expect(pers).toContain('saveQueueRef.current.seed(key, baseline)')
    expect(pers).toContain('adoptConversation,')
  })

  it('follows cross-window title changes into its own list — WITH the project binding', () => {
    expect(pers).toContain('window.electronAPI.onConversationTitleChanged')
    // The binding rides the push (2026-11-01 用户报「沉浸模式新建的会话归到了
    // 普通对话」): a conversation created in a secondary window is unknown to
    // the other windows' lists — the first-sighting re-add must carry projectId,
    // or the row groups under 对话 while its DB binding stays correct.
    expect(pers).toContain('titleInListRef.current(id, title, projectId)')
    // Main side: the broadcast reads the row's binding at the authoritative
    // moment (right after the title write), so every window can re-add bound.
    const handler = read('main/ipc/conversation.handler.ts')
    expect(handler).toContain('const projectId = getConversationProjectId(id)')
    expect(handler).toContain('CONVERSATION_TITLE_CHANGED, { id, title, projectId }')
  })
})

describe('renderer: engine hook', () => {
  const eng = read('renderer/src/hooks/useConversationEngine.ts')

  it('judges 已读 with the popout registry (watching there counts too)', () => {
    expect(eng).toContain('activeEngineIdRef.current === sessionId || isPoppedOut(sessionId)')
  })

  it('excludes popped conversations from the eviction sweep', () => {
    expect(eng).toContain('usePopoutWatchStore.getState().byConversation')
    expect(eng).toContain('new Set(Object.keys(popped))')
  })

  it('exposes the two mirror seeders (no React state, no engine write)', () => {
    expect(eng).toContain('const seedSessionSnapshot = useCallback')
    expect(eng).toContain('const seedSessionHistory = useCallback')
    expect(eng).toContain('seedSessionSnapshot,')
    expect(eng).toContain('seedSessionHistory,')
  })
})

describe('renderer: controller', () => {
  const ctrl = read('renderer/src/hooks/useChatController.ts')

  it('threads savesEnabled into persistence and exposes boot/adopt primitives', () => {
    expect(ctrl).toContain('savesEnabled: options.savesEnabled')
    expect(ctrl).toContain('adoptConversation: persistence.adoptConversation')
    expect(ctrl).toContain('getOrCreateEngine: engine.getOrCreateEngine')
    expect(ctrl).toContain('activateEngine: engine.activateEngine')
    expect(ctrl).toContain('activateConversation: persistence.activateConversation')
    expect(ctrl).toContain('seedSessionSnapshot: engine.seedSessionSnapshot')
    expect(ctrl).toContain('markConversationRead: engine.markConversationRead')
  })

  it('the main window never titles a conversation a popout owns', () => {
    expect(ctrl).toContain('if (isPoppedOut(convId)) return')
  })
})

describe('renderer: main entry + App wiring', () => {
  it('main.tsx branches on the popout param', () => {
    const main = read('renderer/src/main.tsx')
    expect(main).toContain('parsePopoutParam()')
    expect(main).toContain('<PopoutApp convId={popout.convId} />')
    expect(main).toContain(': <App />')
  })

  it('App.tsx adopts + read-receipts on popout events, and opens popouts', () => {
    const app = read('renderer/src/App.tsx')
    expect(app).toContain('window.electronAPI.onPopoutEvent')
    expect(app).toContain('usePopoutWatchStore.getState().add(sessionId)')
    expect(app).toContain('usePopoutWatchStore.getState().remove(sessionId)')
    expect(app).toContain('markConversationRead(sessionId)')
    expect(app).toContain('void adoptConversation(sessionId)')
    // Seed object: workbench open tab + preview file tabs + active file + the
    // conversation's own primary mode (2026-11-04). Assembled once in
    // popoutSeedFor — every popoutOpen entry point carries the same seed.
    expect(app).toContain('window.electronAPI.popoutOpen(key, label, popoutSeedFor(key))')
    expect(app).toContain('wb.openByConversation[key] ? wb.activeTab : undefined')
    expect(app).toContain('pp.tabsByConversation[key]?.map((t) => t.path)')
    expect(app).toContain('pp.activeByConversation[key] ?? null')
    expect(app).toContain('onPopoutConversation=')
    // A renderer reload rebuilds the registry empty — re-sync from main.
    expect(app).toMatch(/window\.electronAPI\s*\.\s*popoutList\(\)/)
  })

  it('the browser pane: project windows are pane TARGETS now (2026-10-31 三面板) — the old early-return is gone', () => {
    // 2026-10-31 the dock registry became per-window — a conversation popout
    // pushes its own pane state; since the same day's 三面板 ruling the
    // project window does too (its `IS_PROJECT_WINDOW` branch is a PUSH with
    // rightPanel-driven browserActive, not an early return anymore).
    const pane = read('renderer/src/hooks/useBrowserPane.ts')
    expect(pane).not.toContain('if (IS_PROJECT_WINDOW) return')
    expect(pane).toContain('if (IS_PROJECT_WINDOW) {')
    expect(pane).toContain("browserActive: rightPanel === 'browser'")
    expect(pane).not.toContain('IS_POPOUT || IS_PROJECT_WINDOW')
  })

  it('the sidebar row menu offers 弹出为独立窗口 (optional prop → hideable)', () => {
    const rows = read('renderer/src/components/layout/ConversationRows.tsx')
    expect(rows).toContain("t('conversationSidebar.popOut')")
    expect(rows).toContain("key: 'popout'")
    expect(rows).toContain('onPopout?: (key: string, label: string) => void')
  })
})

describe('renderer: PopoutApp', () => {
  const pop = read('renderer/src/popout/PopoutApp.tsx')

  it('runs the controller save-muted (single writer lives in the main window)', () => {
    expect(pop).toContain('savesEnabled: false')
  })

  it('boots snapshot-first — never the switch path that would clobber a live engine', () => {
    expect(pop).toContain('agentSessionSnapshot(convId)')
    expect(pop).toContain('seedSessionSnapshot(convId, snap!)')
    // The switch/activation primitives the main window uses are NOT called
    // here (the doc comment naming them is fine).
    expect(pop).not.toContain('handleSelectConversation(')
    expect(pop).not.toContain('setActiveConversationKey(')
  })

  it('renders the full ChatView (which brings the workbench pane)', () => {
    expect(pop).toContain('<ChatView')
    expect(pop).toContain('<InstallNotifier')
    expect(pop).toContain('<SubAgentSessionView')
  })

  it('wires the browser task entry + float overlay for its browser primary (review_20261105 中1/中3)', () => {
    // 中1：循环钮把 browser 主视图送进弹窗后，welcome 切到浏览器档必须有真
    // 通道——与主窗 App 同构：createBrowserTask 铸容器，pane 快照报到「提交
    // 目标」会话名下再 browserPaneAction 开页签（handlePaneAction 按
    // event.sender 解析窗口，落弹窗自己的 pane）。prop 已改必填，漏传编译失败。
    expect(pop).toContain('createBrowserTask,')
    expect(pop).toContain('onBrowserTaskStart={handleBrowserTaskStart}')
    expect(pop).toContain("browserPaneAction({ op: 'navigate', url: pending.url })")
    expect(pop).toContain('useBrowserPaneStore((s) => s.update.conversationId)')
    // 中3：dock 下拉浮窗左/右侵进原生 view 的遮挡在弹窗同样发生——补挂同一
    // 测量点；弹窗无换页视图，主窗的 viewKind 门在这里没有对应物。
    expect(pop).toContain("useFloatOverlayShift(primary === 'browser')")
  })

  it('keeps the boot flag module as the single per-window mode detector', () => {
    const boot = read('renderer/src/popout/boot.ts')
    expect(boot).toContain('new URLSearchParams(window.location.search).get')
    expect(boot).toContain('export const IS_POPOUT')
    // The seed does NOT ride the URL — it lives in popout/seed.ts.
    expect(boot).not.toContain('wb')
  })

  it('fetches the donor seed BEFORE the first render (main.tsx)', () => {
    const main = read('renderer/src/main.tsx')
    expect(main).toContain('loadAndApplyPopoutSeed')
    expect(main).toContain('loadAndApplyPopoutSeed(popout.convId).then(renderRoot)')
    // Failure still boots the popout (closed = the previous behavior).
    expect(main).not.toContain('catch(() => renderRoot())')
  })

  it('sizes the popout to the donor window dimensions (2026-10-31 追加裁定)', () => {
    // 「窗口宽度，包括侧边窗口宽度，要保持一致」+「高度也改一致」：handler 读
    // 发送方 bounds，openPopoutWindow 用 donor 宽高（夹进工作区）；缺席回落
    // 42%×78% 形态。侧边窗格宽度不需要传递——workbenchStore.width 走
    // localStorage persist，两个窗口本来就读同一份。
    const h = read('main/ipc/popout.handler.ts')
    expect(h).toContain('BrowserWindow.fromWebContents(event.sender)')
    expect(h).toContain('donor.getBounds()')
    expect(h).toContain('void openPopoutWindow(convId, title, seed, donorBounds?.width, donorBounds?.height)')
    const win = read('main/popout-window.ts')
    expect(win).toContain('? Math.max(420, Math.min(workArea.width, Math.round(donorWidth * 0.9)))')
    expect(win).toContain('? Math.max(360, Math.min(workArea.height, Math.round(donorHeight * 0.9)))')
    expect(win).toContain(': Math.max(480, Math.min(720, Math.round(workArea.width * 0.42)))')
    expect(win).toContain(': Math.max(480, Math.min(workArea.height, Math.round(workArea.height * 0.78)))')
  })

  it('lands the first hydration at the tail (chat scroll-to-bottom on popout)', () => {
    // 「会话区滚动条滚动到底部」：弹窗的 conversationId 首帧即 convId（回退），
    // prevConvIdRef 看不到切换——首水合必须也走 switch 落底路径（同步落底 +
    // bottom-pin），否则内容在一次性 rAF 之后继续长高、停在半途。
    const chat = read('renderer/src/components/layout/ChatView.tsx')
    expect(chat).toContain('const isConvSwitch = prevConvIdRef.current !== conversationId || !landedOnceRef.current')
    expect(chat).toContain('landedOnceRef.current = true')
    // 探针锚点：滚动容器的稳定选择器（PLAN-layout-modes 后住在 ChatBody——
    // 两个宿主的滚动容器共用同一个选择器）。
    expect(read('renderer/src/components/chat/ChatBody.tsx')).toContain('data-pm-chat-scroll')
  })
})

describe('renderer: applyPopoutSeed (2026-10-31 裁定)', () => {
  const importFresh = async (): Promise<typeof import('../src/renderer/src/popout/seed')> => {
    vi.resetModules() // both stores are module-level singletons
    return import('../src/renderer/src/popout/seed')
  }

  it('opens the workbench on the seeded tab', async () => {
    const seed = await importFresh()
    const { useWorkbenchStore } = await import('../src/renderer/src/stores/workbenchStore')
    seed.applyPopoutSeed('conv_seed', { workbenchTab: 'browser' })
    expect(useWorkbenchStore.getState().openByConversation['conv_seed']).toBe(true)
    expect(useWorkbenchStore.getState().activeTab).toBe('browser')
  })

  it('restores the preview tab strip and the active file', async () => {
    const seed = await importFresh()
    const { usePreviewPaneStore } = await import('../src/renderer/src/stores/previewPaneStore')
    seed.applyPopoutSeed('conv_seed', {
      workbenchTab: 'workspace',
      previewPaths: ['/ws/a.md', '/ws/b.md'],
      activePreviewPath: '/ws/b.md',
    })
    const s = usePreviewPaneStore.getState()
    expect(s.tabsByConversation['conv_seed'].map((t) => t.path)).toEqual(['/ws/a.md', '/ws/b.md'])
    expect(s.tabsByConversation['conv_seed'][0].kind).toBe('markdown')
    expect(s.activeByConversation['conv_seed']).toBe('/ws/b.md')
  })

  it('an active path outside the carried tabs is dropped (fail-closed)', async () => {
    const seed = await importFresh()
    const { usePreviewPaneStore } = await import('../src/renderer/src/stores/previewPaneStore')
    seed.applyPopoutSeed('conv_seed', { previewPaths: ['/ws/a.md'], activePreviewPath: '/ws/ghost.md' })
    expect(usePreviewPaneStore.getState().activeByConversation['conv_seed']).toBeNull()
  })

  it('no seed / empty seed = no seeding (closed stays closed)', async () => {
    const seed = await importFresh()
    const { useWorkbenchStore } = await import('../src/renderer/src/stores/workbenchStore')
    const { usePreviewPaneStore } = await import('../src/renderer/src/stores/previewPaneStore')
    seed.applyPopoutSeed('conv_plain', null)
    seed.applyPopoutSeed('conv_plain', {})
    expect(useWorkbenchStore.getState().openByConversation['conv_plain']).toBeUndefined()
    expect(usePreviewPaneStore.getState().tabsByConversation['conv_plain']).toBeUndefined()
  })

  it('loadAndApplyPopoutSeed fetches over IPC and never rejects', async () => {
    const seed = await importFresh()
    const { useWorkbenchStore } = await import('../src/renderer/src/stores/workbenchStore')
    const electron = (globalThis as unknown as { window: { electronAPI?: unknown } }).window
    electron.electronAPI = {
      popoutSeed: (_id: string) => Promise.resolve({ workbenchTab: 'plan', previewPaths: [] }),
    }
    await expect(seed.loadAndApplyPopoutSeed('conv_ipc')).resolves.toBeUndefined()
    expect(useWorkbenchStore.getState().openByConversation['conv_ipc']).toBe(true)
    // A rejecting invoke must NOT bubble — the popout boots closed instead.
    electron.electronAPI = { popoutSeed: () => Promise.reject(new Error('ipc down')) }
    await expect(seed.loadAndApplyPopoutSeed('conv_ipc')).resolves.toBeUndefined()
  })

  // ── 主视图模式（2026-11-04 裁定「对话在主窗是什么视图模式，弹出独立弹窗后
  // 要保持一致」）── primaryByConversation 不持久化、每窗一份内存态，所以弹窗
  // 只能靠 donor seed 拿到主窗的模式。
  it.each(['files', 'browser'] as const)('seeds the %s primary AND opens the dock', async (primary) => {
    const seed = await importFresh()
    const { useWorkbenchStore } = await import('../src/renderer/src/stores/workbenchStore')
    seed.applyPopoutSeed('conv_mode', { primary })
    const s = useWorkbenchStore.getState()
    expect(s.primaryByConversation['conv_mode']).toBe(primary)
    // chatSlot 只在 dock 里渲染：非 chat 模式不补 setOpen，对话列不可达。
    expect(s.openByConversation['conv_mode']).toBe(true)
  })

  it('chat / absent primary adds no map entry (no entry = chat priority)', async () => {
    const seed = await importFresh()
    const { useWorkbenchStore } = await import('../src/renderer/src/stores/workbenchStore')
    seed.applyPopoutSeed('conv_chat', { primary: 'chat' })
    seed.applyPopoutSeed('conv_absent', { previewPaths: [] })
    const s = useWorkbenchStore.getState()
    expect(s.primaryByConversation['conv_chat']).toBeUndefined()
    expect(s.primaryByConversation['conv_absent']).toBeUndefined()
    expect(s.openByConversation['conv_chat']).toBeUndefined()
  })

  it('a seeded side tab is reconciled against the seeded mode, not the fresh-store chat default', async () => {
    const seed = await importFresh()
    const { useWorkbenchStore } = await import('../src/renderer/src/stores/workbenchStore')
    // 文件优先下工作区就是主卡，dock 的侧栏集合只剩 chat/browser/plan ——
    // 种子里带的 workspace 必须按模式回落（否则 dock 渲染一个空 body）。
    seed.applyPopoutSeed('conv_files_tab', { primary: 'files', workbenchTab: 'workspace' })
    const files = useWorkbenchStore.getState()
    expect(files.primaryByConversation['conv_files_tab']).toBe('files')
    expect(files.activeTab).toBe('chat')
    // 浏览器优先下 workspace 是合法的侧栏成员，照常保留。
    seed.applyPopoutSeed('conv_browser_tab', { primary: 'browser', workbenchTab: 'workspace' })
    const browser = useWorkbenchStore.getState()
    expect(browser.primaryByConversation['conv_browser_tab']).toBe('browser')
    expect(browser.activeTab).toBe('workspace')
  })

  it('wiring: the donor assembles the seed from the live mode and both entries carry it', () => {
    const app = read('renderer/src/App.tsx')
    expect(app).toContain('primary: conversationPrimaryOf(key)')
    // 一次组装、两处（新建弹窗 / 聚焦已弹窗）+ welcome 快捷入口，各写一份必然漂移。
    expect(app.match(/popoutSeedFor\(key\)/g)?.length).toBe(3)
    expect(app).not.toMatch(/popoutOpen\(key\)\s*$/)
    // 类型面：seed 携带模式，缺席 = 'chat'（无条目即对话优先）。
    const bridge = read('shared/types/electron-bridge.ts')
    expect(bridge).toMatch(/primary\?: 'chat' \| 'files' \| 'browser'/)
  })
})

describe('renderer: popout UX rulings (2026-10-30 追加)', () => {
  const layout = read('renderer/src/components/layout/AppLayout.tsx')
  const app = read('renderer/src/App.tsx')

  it('header actions sit at the top-right, inset past the OS caption buttons', () => {
    // Both buttons moved out of the centered title group into one absolutely
    // positioned cluster at the top-right corner; the cluster's `right` carries
    // the OS-controls inset, or a button there would be hidden/dead on Windows.
    // The inset comes from shared/window-chrome's titleBarActionsRight, which
    // adds the platform's own gutter (24px on macOS, the tighter 9px beside
    // Windows/Linux caption buttons — user ruling 2026-11-04).
    expect(layout).toContain('TITLE_BAR_ACTIONS_RIGHT')
    expect(layout).toContain('right: TITLE_BAR_ACTIONS_RIGHT')
    expect(layout).toContain('const TITLE_BAR_ACTIONS_RIGHT = titleBarActionsRight(windowControls)')
    const cluster = layout.indexOf('right: TITLE_BAR_ACTIONS_RIGHT')
    expect(layout.indexOf('icon={<PanelRightIcon size={14} filled={workbenchOpen} />}', cluster)).toBeGreaterThan(cluster)
    expect(layout.indexOf('onPopoutConversation(activeConvKey, activeConvTitle', cluster)).toBeGreaterThan(cluster)
    expect(layout).toContain('icon={<ExportOutlined style={{ fontSize: 14 }} />}')
    // The popout window's own header follows the same rule.
    expect(read('renderer/src/popout/PopoutApp.tsx')).toContain('right: TITLE_BAR_ACTIONS_RIGHT')
  })

  it('Windows/Linux actions wear the caption-button look (macOS keeps the app one)', () => {
    // The class + CSS vars come from shared/window-chrome's resolveCaptionButtonStyle;
    // the stylesheet lives in the GLOBAL index.html because the popout window
    // renders PopoutApp without AppLayout (probe-popout-boot caught the popout's
    // button unstyled on macOS when the class lived only in AppLayout).
    const global = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8')
    expect(global).toContain('.pm-caption-btn')
    expect(global).toContain('.header-pane-btn')
    // Double-class stacking: antd's runtime-injected :hover is (0,2,0) and lands
    // later, so equal specificity loses whatever the !important.
    expect(global).toContain('.pm-caption-btn.pm-caption-btn:hover')
    for (const file of ['renderer/src/components/layout/AppLayout.tsx', 'renderer/src/popout/PopoutApp.tsx']) {
      const src = read(file)
      expect(src).toContain('CAPTION_STYLE_ACTIONS')
      expect(src).toContain("'pm-caption-btn'")
      expect(src).toContain('captionButtonVars(')
    }
  })

  it('popping the ACTIVE conversation returns the main window to welcome', () => {
    // The mount-only popout subscription reads the live active key through a
    // ref and clears the view when the popped conversation is the active one.
    expect(app).toContain('activeConvKeyRef.current === sessionId')
    expect(app).toContain('createNewConversationRef.current()')
  })

  it('clicking a popped conversation raises its window instead of reopening it', () => {
    // Sidebar + project list select handlers short-circuit on isPoppedOut.
    // prettier 展开单行 if 块——对空白鲁棒。
    expect(layout).toMatch(/if \(isPoppedOut\(key\)\) \{\s*onFocusPoppedConversation\?\.\(key\)\s*return\s*\}/)
    expect(layout).toContain('onFocusPoppedConversation?: (key: string) => void')
    // Welcome quick entries do the same via popoutOpen (which focuses).
    expect(app).toMatch(/if \(isPoppedOut\(key\)\) \{\s*void window\.electronAPI\.popoutOpen\(key, undefined, popoutSeedFor\(key\)\)\s*return\s*\}/)
    // The wiring hands the focus handler down.
    expect(app).toMatch(/onFocusPoppedConversation=\{\(key\) => \{\s*void window\.electronAPI\.popoutOpen\(key, undefined, popoutSeedFor\(key\)\)\s*\}\}/)
  })
})

// ── wiring 扫描：沉浸窗口的点击路由（拉起 + 切换，2026-11-01） ────────────────

describe('project immersive window: click → raise + switch (2026-11-01)', () => {
  it('declares the two new channels (invoke + targeted switch order)', () => {
    const ch = read('shared/ipc-channels.ts')
    expect(ch).toContain("PROJECT_WINDOW_FOCUS_CONV: 'project-window:focus-conv'")
    expect(ch).toContain("POPOUT_SWITCH: 'popout:switch'")
  })

  it('preload + bridge expose projectWindowFocusConversation / onPopoutSwitch', () => {
    const pre = read('preload/index.ts')
    expect(pre).toContain('projectWindowFocusConversation: (projectId: string, convId: string): Promise<boolean>')
    expect(pre).toContain('ipcRenderer.invoke(IPC_CHANNELS.PROJECT_WINDOW_FOCUS_CONV, projectId, convId)')
    expect(pre).toContain('onPopoutSwitch:')
    expect(pre).toContain('ipcRenderer.on(IPC_CHANNELS.POPOUT_SWITCH, listener)')
    const b = read('shared/types/electron-bridge.ts')
    expect(b).toContain('projectWindowFocusConversation: (projectId: string, convId: string) => Promise<boolean>')
    expect(b).toContain('onPopoutSwitch: (callback: (event: { sessionId: string }) => void) => () => void')
  })

  it('main: focusProjectConversation prefers the conversation popout, then switches the project window', () => {
    const pop = read('main/popout-window.ts')
    expect(pop).toContain('export function focusProjectConversation(projectId: string, convId: string): boolean')
    // popouts first: a single-conversation popout is the precise holder, and
    // switching a project window onto a popout-held session would put one
    // conversation in two windows — the invariant openPopoutWindow guards too.
    expect(pop).toContain('const popout = popouts.get(convId)')
    // The switch order is a TARGETED send to the holding window only: the main
    // window's POPOUT_EVENT else-branch would drop the conversation from the
    // popped registry, and other project windows must not react.
    expect(pop).toContain('win.webContents.send(IPC_CHANNELS.POPOUT_SWITCH, { sessionId: convId })')
    expect(pop).not.toContain("broadcastPopoutEvent('switch'")
  })

  it('the focus-conv invoke is registered in the popout handler', () => {
    const h = read('main/ipc/popout.handler.ts')
    expect(h).toContain('IPC_CHANNELS.PROJECT_WINDOW_FOCUS_CONV')
    expect(h).toContain('focusProjectConversation(projectId, convId)')
  })

  it('PopoutApp subscribes to the remote switch (project windows only, mount-only)', () => {
    const pop = read('renderer/src/popout/PopoutApp.tsx')
    expect(pop).toContain('window.electronAPI.onPopoutSwitch')
    expect(pop).toContain('switchProjectConversationRef.current(sessionId)')
    // The subscription is project-window gated; a conversation popout (fixed
    // convId) has nothing to switch.
    expect(pop).toContain('if (!isProjectWindow) return\n    return window.electronAPI.onPopoutSwitch')
  })

  it('both main-window click sites route through routeToProjectWindow before opening in-window', () => {
    const layout = read('renderer/src/components/layout/AppLayout.tsx')
    const app = read('renderer/src/App.tsx')
    // Project sidebar list (项目 tab) + welcome quick entries.
    expect(layout).toContain('routeToProjectWindow(conversations, key).then((taken) => {')
    expect(app).toContain('routeToProjectWindow(conversations, key).then((taken) => {')
  })
})
