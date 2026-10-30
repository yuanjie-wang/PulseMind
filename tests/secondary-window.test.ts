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

  it('the explorer consumes the clamp and exposes probe targets', () => {
    const ex = read('renderer/src/popout/ProjectExplorer.tsx')
    expect(ex).toContain('clampExplorerWidth(rawExplorerWidth, rowWidth)')
    expect(ex).toContain('data-pm-explorer-column')
    expect(ex).toContain('data-pm-explorer-drag-handle')
    expect(ex).toContain('direction: 1')
    // The tree/preview surface is REUSED, not re-implemented.
    expect(ex).toContain('<WorkspacePane conversationId={conversationId} />')
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
