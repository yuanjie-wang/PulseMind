/**
 * 项目沉浸窗口（2026-10-30）：复用 popout 的次级窗口机制扩成「项目窗口」。
 *
 * 架构依据与 popout 同源：会话托管在主进程、AGENT_SESSION_EVENT 广播给所有
 * 窗口、createSession 幂等、snapshot() 供中途附接 —— 项目窗口只是同一 IPC 协议
 * 的又一个客户端，不新造窗口类。
 *
 * 两条本功能的核心裁定（见 AGENTS.md「项目窗口」Gotcha）：
 *   • watch 按「当前会话」而非「整个项目」—— ruling ⑦ 要防的是同一个会话同时
 *     出现在两个窗口；同项目的两个不同会话分处两窗没有冲突（两条 session，
 *     主窗两个镜像都写）。所以直接沿用 popout 的会话级 POPOUT_EVENT 语义。
 *   • 项目窗口里工作台直接关闭（hideWorkbench），不做 tab 白名单。
 *
 * 本文件钉：纯函数（?project 解析 / explorer 宽度 clamp）+ 四处 wiring——
 * channels/preload/bridge、popout-window（幂等/watch 广播/守卫/并集）、
 * popout.handler 注册、渲染端的模式分支与单写者链。
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'

const { clampExplorerWidth, EXPLORER_MIN_WIDTH, PROJECT_CHAT_MIN_WIDTH } =
  await import('../src/shared/ui/layout-widths')

// ── 纯逻辑：?project 解析（jsdom：真 window.location.search） ────────────────

describe('parseProjectParam (boot flag)', () => {
  const importWithSearch = async (search: string): Promise<typeof import('../src/renderer/src/popout/boot')> => {
    const dom = new JSDOM(`<!doctype html><html><body></body></html>`, { url: `http://localhost/${search}` })
    ;(globalThis as unknown as { window: unknown }).window = dom.window
    vi.resetModules() // boot.ts caches the parse result module-level
    return import('../src/renderer/src/popout/boot')
  }

  it('reads ?project=<projectId> and flips IS_PROJECT_WINDOW', async () => {
    const boot = await importWithSearch('?project=proj_20261030')
    expect(boot.parseProjectParam()).toEqual({ projectId: 'proj_20261030' })
    expect(boot.IS_PROJECT_WINDOW).toBe(true)
    // The two flags are independent — a project window is not a popout.
    expect(boot.IS_POPOUT).toBe(false)
  })

  it('a popout URL leaves the project flag off (and vice versa)', async () => {
    const boot = await importWithSearch('?popout=conv_1')
    expect(boot.parseProjectParam()).toBeNull()
    expect(boot.IS_PROJECT_WINDOW).toBe(false)
    expect(boot.IS_POPOUT).toBe(true)
  })

  it('no param = main window; an empty value does not open a window', async () => {
    const boot = await importWithSearch('')
    expect(boot.parseProjectParam()).toBeNull()
    expect(boot.IS_PROJECT_WINDOW).toBe(false)

    const empty = await importWithSearch('?project=')
    expect(empty.parseProjectParam()).toBeNull()
    expect(empty.IS_PROJECT_WINDOW).toBe(false)
  })
})

// ── 纯函数：explorer ↔ chat 分隔 ────────────────────────────────────────────

describe('clampExplorerWidth', () => {
  it('clamps to the explorer floor and to (row − chat floor)', () => {
    expect(clampExplorerWidth(10, 1600)).toBe(EXPLORER_MIN_WIDTH)
    expect(clampExplorerWidth(760, 1600)).toBe(760)
    expect(clampExplorerWidth(1500, 1600)).toBe(1600 - PROJECT_CHAT_MIN_WIDTH)
  })

  it('rounds, and floors a too-narrow row so the explorer never vanishes', () => {
    expect(clampExplorerWidth(640.6, 1600)).toBe(641)
    // A row narrower than both floors: the explorer keeps its minimum (the chat
    // column carries flex:1; minWidth:0, so it squeezes rather than overflowing).
    expect(clampExplorerWidth(900, 700)).toBe(EXPLORER_MIN_WIDTH)
  })

  it('an unmeasured row (first paint) only floors', () => {
    expect(clampExplorerWidth(760, 0)).toBe(760)
    expect(clampExplorerWidth(10, 0)).toBe(EXPLORER_MIN_WIDTH)
  })
})

// ── wiring 扫描 ─────────────────────────────────────────────────────────────

const ROOT = join(process.cwd(), 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

describe('secondary-window IPC: channels → preload → bridge', () => {
  it('declares the two new channels alongside the popout family', () => {
    const ch = read('shared/ipc-channels.ts')
    expect(ch).toContain("PROJECT_WINDOW_OPEN: 'project-window:open'")
    expect(ch).toContain("SECONDARY_WATCH: 'secondary:watch'")
  })

  it('preload exposes projectWindowOpen / secondaryWatch', () => {
    const pre = read('preload/index.ts')
    expect(pre).toContain('projectWindowOpen: (projectId: string, name?: string)')
    expect(pre).toContain('ipcRenderer.invoke(IPC_CHANNELS.PROJECT_WINDOW_OPEN, projectId, name)')
    expect(pre).toContain('secondaryWatch: (sessionId: string | null)')
    expect(pre).toContain('ipcRenderer.invoke(IPC_CHANNELS.SECONDARY_WATCH, sessionId)')
  })

  it('the bridge types declare the same methods', () => {
    const b = read('shared/types/electron-bridge.ts')
    expect(b).toContain('projectWindowOpen: (projectId: string, name?: string) => Promise<void>')
    expect(b).toContain('secondaryWatch: (sessionId: string | null) => Promise<void>')
  })

  it('both invokes are registered, and the watch goes through the window module', () => {
    const h = read('main/ipc/popout.handler.ts')
    expect(h).toContain('IPC_CHANNELS.PROJECT_WINDOW_OPEN')
    expect(h).toContain('IPC_CHANNELS.SECONDARY_WATCH')
    // Main resolves the sending window itself — the renderer never names one.
    expect(h).toContain('recordSecondaryWatchFromSender(event.sender, sessionId ?? null)')
  })
})

describe('main: the project window reuses the secondary-window module', () => {
  const pop = read('main/popout-window.ts')

  it('one window per project (focus existing) and a three-column size', () => {
    expect(pop).toContain('export async function openProjectWindow')
    expect(pop).toContain('projectWindows.get(projectId)')
    // Deliberately wider than a conversation popout (480–720): the project
    // window carries tree | preview | chat.
    expect(pop).toContain('Math.max(1000, Math.min(workArea.width, Math.round(workArea.width * 0.9)))')
  })

  it('loads the renderer entry with the project query param (dev URL + prod file)', () => {
    expect(pop).toContain("devUrl.searchParams.set('project', projectId)")
    expect(pop).toContain("loadFile(join(__dirname, '../renderer/index.html'), { query: { project: projectId } })")
  })

  it('BOTH watch broadcasts are actually sent (a sender-less event is invisible)', () => {
    // Same lesson the popout paid for (2026-10-30): asserting the FUNCTION
    // exists is not enough — the call sites are what carry adoption + the read
    // receipt + the welcome retreat. A conversation SWITCH must emit the
    // 'closed' for the one it leaves, or the main window keeps it hidden.
    expect(pop).toContain("broadcastPopoutEvent('closed', sid)")
    expect(pop).toContain('watchedSessions.set(sessionId, win)')
    expect(pop).toContain("broadcastPopoutEvent('opened', sessionId)")
  })

  it('a conversation already in a project window is raised, never re-minted', () => {
    // Without this guard the sidebar's 置前 path (`popoutOpen`) would open a
    // SECOND window carrying the same conversation: two live clients on one
    // session, the exact state ruling ⑦ forbids.
    const guard = pop.indexOf('const holder = watchedSessions.get(convId)')
    expect(guard).toBeGreaterThan(-1)
    expect(pop.indexOf('existing.focus()', guard)).toBeGreaterThan(guard)
  })

  it('closing the window and closing everything how it releases the watch', () => {
    expect(pop).toContain('projectWindows.delete(projectId)')
    expect(pop).toContain('watchedSessions.delete(sid)')
    // closeAllPopouts takes project windows with it (main-window close ruling).
    expect(pop).toContain('for (const win of projectWindows.values())')
    // …and the OS-theme refresh covers them too.
    expect(pop).toContain('...popouts.values(), ...projectWindows.values()')
  })

  it('the pre-existing popout contract is untouched', () => {
    expect(pop).toContain("devUrl.searchParams.set('popout', convId)")
    expect(pop).toContain("loadFile(join(__dirname, '../renderer/index.html'), { query: { popout: convId } })")
    expect(pop).toContain("broadcastPopoutEvent('opened', convId)")
    expect(pop).toContain("broadcastPopoutEvent('closed', convId)")
  })
})

describe('renderer: window mode + single-writer chain', () => {
  it('main.tsx branches on the project param BEFORE the popout one', () => {
    const main = read('renderer/src/main.tsx')
    expect(main).toContain('parseProjectParam()')
    expect(main).toContain('<PopoutApp projectId={project.projectId} />')
    expect(main).toContain('<PopoutApp convId={popout.convId} />')
  })

  it('PopoutApp is save-muted and claims its conversation through main', () => {
    const pop = read('renderer/src/popout/PopoutApp.tsx')
    expect(pop).toContain('savesEnabled: false')
    // The watch rides the EFFECTIVE active conversation, so a draft's minted
    // id (after the first message) is claimed too — keying on convId alone
    // would miss it.
    expect(pop).toContain('const watchedKey = conversationKeyOf(activeConversationKey) ?? null')
    expect(pop).toContain('window.electronAPI.secondaryWatch(watchedKey)')
    // A switch only moves convId; the boot effect re-attaches snapshot-first.
    expect(pop).toContain('agentSessionSnapshot(convId)')
    expect(pop).toContain('seedSessionSnapshot(convId, snap!)')
    expect(pop).not.toContain('handleSelectConversation(')
    expect(pop).not.toContain('setActiveConversationKey(')
  })

  it('the project window picks the latest conversation, or starts a project draft', () => {
    const pop = read('renderer/src/popout/PopoutApp.tsx')
    // Deterministic: the DB list, not the controller's (which has no loading
    // flag, so 「empty project」 and 「list in flight」 would be the same state).
    expect(pop).toContain('window.electronAPI.projectGet(projectId)')
    expect(pop).toContain('window.electronAPI.listConversations()')
    expect(pop).toContain("sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))")
    expect(pop).toContain('startProjectDraft()')
    expect(pop).toContain(".setMode('project')")
    expect(pop).toContain('createNewConversationRef.current?.(projectId)')
  })

  it('the project window renders the explorer and mutes the chat workbench', () => {
    const pop = read('renderer/src/popout/PopoutApp.tsx')
    expect(pop).toContain('<ProjectExplorer conversationId={activeConvKey}>')
    expect(pop).toContain('hideWorkbench={isProjectWindow}')
    expect(pop).toContain('hideTaskSwitcher={isProjectWindow}')
    // The workbench toggle is absent there (nothing to toggle).
    expect(pop).toContain('{!isProjectWindow && (')
  })

  it('the project window keeps its new-task binding pinned to the project', () => {
    const pop = read('renderer/src/popout/PopoutApp.tsx')
    // The draft arm renders ChatView's welcome form, whose project picker
    // (ProjectCards) writes useNewTaskStore.projectId directly — without this
    // pin one click there would send the task into another project's workspace.
    expect(pop).toContain('const pin = (): void => {')
    expect(pop).toContain("if (s.mode !== 'project' || s.projectId !== projectId)")
    expect(pop).toContain('return useNewTaskStore.subscribe(pin)')
  })

  it('the draft surface is a hint block, never the welcome page (2026-10-30)', () => {
    const pop = read('renderer/src/popout/PopoutApp.tsx')
    // 用户裁定「新建会话不需要 welcome 页面，干净点就行」：logo/问候/建议/
    // 项目卡在钉死的项目里都没有意义，空区只放一段提示。
    expect(pop).toContain('data-pm-draft-hint')
    expect(pop).toContain("t('projectWindow.draftTitle', { name: project.name })")
    expect(pop).toContain('welcomeHint={draftHint}')
    const chat = read('renderer/src/components/layout/ChatView.tsx')
    expect(chat).toContain('welcomeHint?: React.ReactNode')
    // hint 在场就不挂 WelcomeContent——整台欢迎机器都不启动。
    expect(chat).toContain('{welcomeHint ?? (')
    expect(chat.indexOf('{welcomeHint ?? (')).toBeLessThan(chat.indexOf('<WelcomeContent'))
    for (const loc of ['zh', 'en'] as const) {
      const locSrc = read(`renderer/src/i18n/locales/${loc}.ts`)
      expect(locSrc).toContain('draftTitle:')
      expect(locSrc).toContain('draftSubtitle:')
    }
  })

  it('carries NO conversation sidebar (2026-10-31 用户裁定，撤回 10-30 的一版)', () => {
    const pop = read('renderer/src/popout/PopoutApp.tsx')
    // 沉浸窗口就是 目录树｜预览｜对话 三栏，会话切换走头部 ▾ 下拉——
    // 左侧会话侧边栏曾加过一版（复用 ConversationRows + 共享 sidebarStore），
    // 被裁定不要。这些残留再出现即是回归。
    expect(pop).not.toContain('data-pm-immersive-sidebar')
    expect(pop).not.toContain('data-pm-sidebar-toggle')
    expect(pop).not.toContain('<ConversationRows')
    expect(pop).not.toContain('useSidebarStore')
    // 会话列表的唯一入口仍是头部的项目切换器。
    expect(pop).toContain('data-pm-project-switcher')
  })

  it('the send button wears the project hue (project store must be loaded)', () => {
    const pop = read('renderer/src/popout/PopoutApp.tsx')
    // ChatView 的 composerProjectHue 走 useProjectHue → useProjectStore；这个窗口
    // 只 projectGet、从不加载 store，hue 恒 undefined，按钮永远是中性色——
    // 2026-10-30 用户反馈「发送按钮还是需要使用项目配色」。
    expect(pop).toContain('useProjectStore.getState().reload()')
    expect(pop).toContain('if (!isProjectWindow) return')
  })

  it('the composer is width-capped and cannot leave the column (2026-10-30/31)', () => {
    const ex = read('renderer/src/popout/ProjectExplorer.tsx')
    // 对话列可以很宽，composer 的 952 帽顶满整列；min(640, 100%) 让卡在宽列里
    // 保持对话应用的体量、窄列里永不越界（100% 是硬约束）。
    expect(ex).toContain('[data-pm-chat-column] .ant-sender { max-width: min(640px, 100%); }')
    // 欢迎态 wrapper 是 width:100% + 左右 24px padding，应用无全局 border-box
    // reset —— content-box 下 wrapper 总宽 = 列宽 + 48，天生越列；主窗两侧各溢
    // 24 不可见，沉浸窗口右缘就是窗口边，卡在越界内容盒里居中即被裁
    // （2026-10-31 用户实测「还是超出了屏幕」）。
    expect(ex).toContain("[data-pm-chat-column] [data-welcome-shake='composer'] { box-sizing: border-box; max-width: min(1048px, 100%); }")
  })

  it('the explorer consumes the clamp and exposes probe targets', () => {
    const ex = read('renderer/src/popout/ProjectExplorer.tsx')
    // 卡片化（2026-10-31 用户裁定「三列各用圆角矩形包裹，边缘/列间 5px」）：
    // 渲染 clamp 的行宽要扣掉 explorer↔chat 的那个 gap（rowWidth 来自
    // contentRect，不含四周 padding，只差列间一个 gap）。
    expect(ex).toContain('clampExplorerWidth(rawExplorerWidth, rowWidth - IMMERSIVE_CARD_GAP)')
    expect(ex).toContain('data-pm-explorer-column')
    expect(ex).toContain('data-pm-explorer-drag-handle')
    expect(ex).toContain('direction: 1')
    // The tree/preview surface is REUSED, not re-implemented — in the immersive
    // form (2026-10-31: tab strip into the preview column, no address bar).
    expect(ex).toContain('<WorkspacePane conversationId={conversationId} immersive />')
  })

  it('三列圆角矩形卡片化：四周与列间 5px（2026-10-31 用户裁定）', () => {
    const ex = read('renderer/src/popout/ProjectExplorer.tsx')
    const pane = read('renderer/src/components/workbench/WorkspacePane.tsx')
    // 行吃四周 padding（窗口边缘 5px）+ explorer↔chat gap；对话卡自带
    // 圆角边框（border-box 让 flex 宽度含边框）。
    expect(ex).toContain('padding: IMMERSIVE_CARD_GAP')
    expect(ex).toContain('gap: IMMERSIVE_CARD_GAP')
    expect(ex).toContain("border: '1px solid var(--pm-separator-faint)'")
    expect(ex).toContain("boxSizing: 'border-box'")
    // 树/预览两卡的圆角边框在 WorkspacePane 的 immersive 分支（工作台形态
    // 保持 borderRight 分隔不变）。
    expect(pane).toContain('...(immersive ? IMMERSIVE_CARD : { borderRight:')
    expect(pane).toContain('...(immersive ? IMMERSIVE_CARD : {})')
    // 树↔预览的 gap 也只在沉浸形态。
    expect(pane).toContain('gap: immersive ? IMMERSIVE_CARD_GAP : undefined')
    // 间距常量单一来源（改一处，几何处处跟随）。
    expect(ex).toContain("from '../../../shared/ui/layout-widths'")
    expect(ex).toContain('IMMERSIVE_CARD_GAP')
  })

  it('the explorer width store clamps at every consumption, not just at drag time', () => {
    const store = read('renderer/src/stores/secondaryLayoutStore.ts')
    expect(store).toContain('EXPLORER_DEFAULT_WIDTH')
    expect(store).toContain("name: 'pulsemind-project-window-layout'")
    expect(store).toContain('partialize')
  })
})

describe('renderer: App wiring', () => {
  it('the sidebar entry reaches main through one IPC', () => {
    expect(read('renderer/src/App.tsx')).toContain(
      'window.electronAPI.projectWindowOpen(projectId, name)',
    )
    const layout = read('renderer/src/components/layout/AppLayout.tsx')
    expect(layout).toContain('onEnterProjectWindow?: (projectId: string, name: string) => void')
    expect(layout).toContain('onEnterImmersive={(project) => onEnterProjectWindow?.(project.id, project.name)}')
  })
})

describe('三面板（2026-10-31 用户裁定：左 目录树|全文检索，右 对话|浏览器|工作计划）', () => {
  it('面板态住 secondaryLayoutStore 但不持久化（2026-10-31 裁定：进窗恒从 文件/对话 起步）', () => {
    const store = read('renderer/src/stores/secondaryLayoutStore.ts')
    expect(store).toContain("leftPanel: 'tree'")
    expect(store).toContain("rightPanel: 'chat'")
    expect(store).toContain('setLeftPanel: (leftPanel)')
    expect(store).toContain('setRightPanel: (rightPanel)')
    // partialize 刻意只带 explorerWidth——面板选择是每窗内存态，持久化
    // 「上次用的面板」会违背「进入沉浸模式默认 文件/对话」的裁定（阴性钉）。
    expect(store).toContain('partialize: (s) => ({ explorerWidth: s.explorerWidth })')
    expect(store).not.toContain('leftPanel: s.leftPanel')
    // PopoutApp 挂载显式置默认（压掉旧持久化 JSON 里的残留字段）。
    const pop = read('renderer/src/popout/PopoutApp.tsx')
    expect(pop).toContain("useSecondaryLayoutStore.getState().setLeftPanel('tree')")
    expect(pop).toContain("useSecondaryLayoutStore.getState().setRightPanel('chat')")
  })

  it('binding 沉浸分支：browserActive 换源右卡面板态 + 卡片 insets + paneWidth 直通', () => {
    const hook = read('renderer/src/hooks/useBrowserPane.ts')
    // 旧的 IS_PROJECT_WINDOW 早退改为沉浸分支——推送仍在，判定源换成
    // rightPanel；viewKind 恒 'chat'（页签 scope 永远挂当前会话）。
    expect(hook).toContain('if (IS_PROJECT_WINDOW) {')
    expect(hook).toContain("browserActive: rightPanel === 'browser'")
    expect(hook).toContain("viewKind: 'chat'")
    expect(hook).toContain('topInset: IMMERSIVE_BROWSER_TOP_INSET')
    expect(hook).toContain('rightInset: IMMERSIVE_BROWSER_RIGHT_INSET')
    expect(hook).toContain('bottomInset: IMMERSIVE_BROWSER_BOTTOM_INSET')
    expect(hook).toContain('paneWidth: immersiveCardWidth + 3')
    // 浏览器面板的动作回调薄包装独立导出（第二消费面不得再跑一份推送）。
    expect(hook).toContain('export function useBrowserPaneActions')
  })

  it('ImmersivePanels：对话保活 display 切换 + 浏览器/计划接线 + 跳转切回对话', () => {
    const panels = read('renderer/src/popout/ImmersivePanels.tsx')
    expect(panels).toContain("display: rightPanel === 'chat' ? 'flex' : 'none'")
    expect(panels).toContain('<BrowserPaneChrome pane={pane} onAction={action} />')
    // 计划节点跳转先切回对话面板——否则滚动落在看不见的隐藏面板里。
    expect(panels).toContain("setRightPanel('chat')")
    expect(panels).toContain('onPlanJump?.(msgId)')
    // 卡宽测量进 store（paneWidth 直通的数据源），卸载清零。
    expect(panels).toContain('setImmersiveCardWidth(w > 0 ? w : null)')
    expect(panels).toContain('useEffect(() => () => useBrowserPaneStore.getState().setImmersiveCardWidth(null), [])')
    // 顶部 inset 的算术钉死（5 窗边 + 1 边框 + 32 切换器）。
    expect(panels).toContain('IMMERSIVE_BROWSER_TOP_INSET = IMMERSIVE_CARD_GAP + 1 + IMMERSIVE_SWITCHER_HEIGHT')
    expect(panels).toContain('IMMERSIVE_BROWSER_RIGHT_INSET = IMMERSIVE_CARD_GAP')
    expect(panels).toContain('IMMERSIVE_BROWSER_BOTTOM_INSET = IMMERSIVE_CARD_GAP + 1')
  })

  it('PopoutApp 把三面板装进右卡（plan 与全部回调直达）', () => {
    const pop = read('renderer/src/popout/PopoutApp.tsx')
    expect(pop).toContain('<ImmersivePanels')
    expect(pop).toContain('onPlanJump={setPlanScrollToMsgId}')
    expect(pop).toContain('highlightPlanNodeId={highlightPlanNodeId}')
  })

  it('左卡切换器 + SearchPanel panel 变体（工作台 strip 形态不变）', () => {
    const pane = read('renderer/src/components/workbench/WorkspacePane.tsx')
    expect(pane).toContain('data-pm-left-panel-switcher')
    expect(pane).toContain('variant="panel"')
    // 2026-10-31 用户裁定：文案「文件 / 搜索」（不再叫 目录树/全文检索）。
    expect(pane).toContain("['tree', '文件']")
    expect(pane).toContain("['search', '搜索']")
    const search = read('renderer/src/components/workbench/SearchPanel.tsx')
    // 缺省 strip 逐字节保留：主窗树列底条（帽 48% + 顶边框）不回归。
    expect(search).toContain("variant = 'strip'")
    expect(search).toContain("panel ? { flex: 1, minHeight: 0 } : { flexShrink: 0, maxHeight: '48%' }")
  })

  it('搜索面板四连裁定（2026-10-31）：Aa 胶囊、✕ 移除、结果行重排+命中高亮', () => {
    const search = read('renderer/src/components/workbench/SearchPanel.tsx')
    // ② Aa 去边框改胶囊（hover/[data-on] 态走注入的类选择器，深色不吃灰边）。
    expect(search).toContain('pm-search-aa')
    expect(search).toContain('data-on={caseSensitive}')
    expect(search).toContain('aria-pressed={caseSensitive}')
    expect(search).toContain(".pm-search-aa[data-on='true'] { background: var(--pm-tile-soft); color: var(--pm-link); font-weight: 600; }")
    expect(search).not.toContain("border: '1px solid var(--pm-separator-faint)'")
    // ③ 关闭按钮移除：主窗工具条本就两向开合，✕ 三处冗余（onClose 全链退场）。
    expect(search).not.toContain('onClose')
    expect(search).not.toContain('DeleteOutlined')
    expect(search).not.toContain('关闭内容搜索')
    // ④ 结果行两行结构 + 命中高亮（固定串 indexOf 即真坐标；命中 ± 窗口）。
    expect(search).toContain('pm-search-hit-path')
    expect(search).toContain('pm-search-hit-line')
    expect(search).toContain('pm-search-hit-mark')
    expect(search).toContain('text.toLowerCase().indexOf(debounced.toLowerCase())')
  })
})
