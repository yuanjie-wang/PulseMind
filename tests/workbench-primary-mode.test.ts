// ── 视图模式状态机（PLAN-layout-modes 2026-11-03；二期裁定「模式跟任务走」）──
// workbenchStore 的按会话 primary（primaryByConversation）+ 侧栏 tab 集合推导
// + activeTab 调和 + auto-open 守卫 + welcome 浏览器任务的物化链路。几何换位
// 是接线扫描；可视几何归探针（probe-layout-modes.mjs）。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf-8')

const STORE = 'src/renderer/src/stores/workbenchStore.ts'
const CHAT_VIEW = 'src/renderer/src/components/layout/ChatView.tsx'
const CHAT_BODY = 'src/renderer/src/components/chat/ChatBody.tsx'
const WORKBENCH_PANE = 'src/renderer/src/components/workbench/WorkbenchPane.tsx'
const APP_LAYOUT = 'src/renderer/src/components/layout/AppLayout.tsx'
const APP = 'src/renderer/src/App.tsx'
const PREVIEW_STORE = 'src/renderer/src/stores/previewPaneStore.ts'
const CONTROLLER = 'src/renderer/src/hooks/useChatController.ts'
const WELCOME_CONTENT = 'src/renderer/src/components/chat/WelcomeContent.tsx'
const BROWSER_TASK_PANEL = 'src/renderer/src/components/welcome/BrowserTaskPanel.tsx'
const NEW_TASK_STORE = 'src/renderer/src/stores/newTaskStore.ts'
const PRIMARY_CYCLE = 'src/renderer/src/components/layout/primary-cycle.ts'
const POPOUT_APP = 'src/renderer/src/popout/PopoutApp.tsx'
const BROWSER_PANE_HOOK = 'src/renderer/src/hooks/useBrowserPane.ts'

async function freshStore() {
  vi.resetModules()
  return import('../src/renderer/src/stores/workbenchStore')
}

describe('sideTabsFor — 侧栏集合 = 全集减去主视图自己', () => {
  it('chat 优先保持历史顺序 workspace/browser/plan', async () => {
    const { sideTabsFor } = await freshStore()
    expect(sideTabsFor('chat')).toEqual(['workspace', 'browser', 'plan'])
  })

  it('files 优先侧栏是 对话/浏览器/计划（会话头循环钮可达，2026-11-04）', async () => {
    const { sideTabsFor } = await freshStore()
    expect(sideTabsFor('files')).toEqual(['chat', 'browser', 'plan'])
  })

  it('browser 优先侧栏是 对话/工作区/计划', async () => {
    const { sideTabsFor } = await freshStore()
    expect(sideTabsFor('browser')).toEqual(['chat', 'workspace', 'plan'])
  })
})

describe('reconcileActiveTab — side 集合外的 tab 按模式回落', () => {
  it('files 优先时 workspace 落回 chat（工作区已是主卡）', async () => {
    const { reconcileActiveTab } = await freshStore()
    expect(reconcileActiveTab('files', 'workspace')).toBe('chat')
  })

  it('browser 优先时 browser 落回 chat（浏览器已是主卡）', async () => {
    const { reconcileActiveTab } = await freshStore()
    expect(reconcileActiveTab('browser', 'browser')).toBe('chat')
  })

  it('chat 优先时 chat 落回 workspace（历史默认）', async () => {
    const { reconcileActiveTab } = await freshStore()
    expect(reconcileActiveTab('chat', 'chat')).toBe('workspace')
  })

  it('集合内的 tab 原样保留（plan 在三种模式都可达）', async () => {
    const { reconcileActiveTab } = await freshStore()
    expect(reconcileActiveTab('files', 'plan')).toBe('plan')
    expect(reconcileActiveTab('chat', 'browser')).toBe('browser')
  })
})

describe('store 动作 — primary 跟任务走（按会话）', () => {
  beforeEach(() => {
    // zustand persist 在 node 环境没有 localStorage，静默降级为纯内存。
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    })
  })

  it('setConversationPrimary 落 map 并调和 activeTab', async () => {
    const mod = await freshStore()
    const s = mod.useWorkbenchStore.getState()
    // 'workspace' 在 browser 侧栏集合内（侧栏=对话/工作区/计划）——合法保留；
    // 被顶掉的是 'browser'（浏览器已是主卡）。
    mod.useWorkbenchStore.getState().setActiveTab('browser')
    s.setConversationPrimary('conv1', 'browser')
    const st = mod.useWorkbenchStore.getState()
    expect(st.primaryByConversation['conv1']).toBe('browser')
    expect(st.activeTab).toBe('chat')
  })

  it('无条目（新会话/DRAFT）= chat —— 新建对话天然回整页 welcome', async () => {
    const mod = await freshStore()
    // useConversationPrimary 是 hook（裸环境不可调），无条目回落走 conversationPrimaryOf。
    expect(mod.conversationPrimaryOf('conv_novel')).toBe('chat')
    expect(mod.conversationPrimaryOf(undefined)).toBe('chat')
  })

  it('openTab 按「该会话」的主视图调和 activeTab', async () => {
    const mod = await freshStore()
    const s = mod.useWorkbenchStore.getState()
    s.setConversationPrimary('convB', 'browser')
    // 会话 A（chat 优先）上手动弹工作区：'workspace' 在 A 的侧栏集合里，保留。
    s.openTab('convA', 'workspace')
    expect(mod.useWorkbenchStore.getState().activeTab).toBe('workspace')
    // 会话 B（browser 优先）上手动弹浏览器 tab：被主视图顶掉 → 调和 chat
    // （'workspace' 在 browser 侧栏集合里，不会触发调和）。
    s.openTab('convB', 'browser')
    expect(mod.useWorkbenchStore.getState().activeTab).toBe('chat')
    expect(mod.useWorkbenchStore.getState().openByConversation['convB']).toBe(true)
  })

  it('autoOpenTab：目标 tab 被「该会话的主视图」顶掉时零动作', async () => {
    const mod = await freshStore()
    const s = mod.useWorkbenchStore.getState()
    s.setConversationPrimary('convB', 'browser')
    mod.autoOpenTab('convB', 'browser')
    let st = mod.useWorkbenchStore.getState()
    expect(st.openByConversation['convB']).toBeUndefined()
    // 会话 A（chat 优先）：浏览器 0→N 的 auto-open 照常生效。
    mod.autoOpenTab('convA', 'browser')
    st = mod.useWorkbenchStore.getState()
    expect(st.openByConversation['convA']).toBe(true)
    expect(st.activeTab).toBe('browser')
  })

  it('autoOpenTab：primaryTab 映射 files↔workspace（禁等值比的回归钉）', async () => {
    const mod = await freshStore()
    const s = mod.useWorkbenchStore.getState()
    s.setConversationPrimary('convF', 'files')
    mod.autoOpenTab('convF', 'workspace')
    // 文件优先下工作区已是主卡——'workspace' ≠ 'files' 的等值比陷阱会漏守卫。
    expect(mod.useWorkbenchStore.getState().openByConversation['convF']).toBeUndefined()
  })

  it('persist 不携带 primaryByConversation（重启回归对话优先，与 openByConversation 同裁定）', () => {
    const src = read(STORE)
    // 2026-11-06 起落盘形状提成具名纯函数（宽度按 tab 分开），断言口径从
    // 「partialize 的字面写法」改为「落盘字段就这三个」。
    expect(src).toContain('partialize: workbenchPersistShape')
    expect(src).toContain('return { widthByTab: s.widthByTab, activeTab: s.activeTab, treeWidth: s.treeWidth } as WorkbenchState')
    expect(src).not.toContain('primaryByConversation: s.')
    expect(src).not.toContain('openByConversation: s.')
  })

  it('只有项目沉浸窗口恒按 chat 消费；弹出窗口按本窗生效（2026-11-04 裁定）', async () => {
    const mod = await freshStore()
    // 测试进程不是 popout/project 窗口；分支本身由源码扫描钉住。
    expect(mod.PRIMARY_MODE_CLAMPED).toBe(false)
    mod.useWorkbenchStore.getState().setConversationPrimary('convB', 'browser')
    expect(mod.conversationPrimaryOf('convB')).toBe('browser')
    const src = read(STORE)
    // 钳位只归项目沉浸窗口（hideWorkbench + 无 dock → 非 chat 主视图会让对话
    // 列无处可达）；会话弹出窗口自 2026-11-04 起自带头部循环钮、按本窗生效。
    expect(src).toContain('export const PRIMARY_MODE_CLAMPED = IS_PROJECT_WINDOW')
    expect(src).not.toContain('IS_POPOUT')
    expect(src).toMatch(/conversationPrimaryOf[\s\S]{0,80}if \(PRIMARY_MODE_CLAMPED\) return 'chat'/)
    expect(src).toMatch(/useConversationPrimary[\s\S]{0,160}PRIMARY_MODE_CLAMPED \|\| !convKey \? 'chat'/)
  })
})

describe('接线扫描 — welcome 浏览器任务链路（模式跟任务走）', () => {
  it('旧禁令形态仍是禁令：无标题栏全局切换器残留（禁的是无会话上下文的切换器）', () => {
    expect(read(APP_LAYOUT)).not.toContain('data-pm-primary-switch')
    expect(read(APP_LAYOUT)).not.toContain('setPrimary(')
  })

  it('nextPrimary 三态循环：chat → files → browser → chat（2026-11-04 裁定）', async () => {
    const { nextPrimary } = await freshStore()
    expect(nextPrimary('chat')).toBe('files')
    expect(nextPrimary('files')).toBe('browser')
    expect(nextPrimary('browser')).toBe('chat')
  })

  it('循环钮只在会话动作簇、welcome 门控、补开 dock（AppLayout 接线）', () => {
    const layout = read(APP_LAYOUT)
    const cycle = read(PRIMARY_CYCLE)
    // 探针钩子名（data-pm-primary-switch 禁用字面量的替代）。
    expect(layout).toContain('data-pm-primary-cycle')
    // welcome 门控：仅会话界面出现——welcome 正在显示（chat 优先 + 零消息）
    // 时隐藏，浏览器任务容器（零消息但 browser 优先）不是 welcome，照常显示。
    expect(layout).toContain('activeConvShowCycle && (')
    // 循环走 store 纯函数 + 按会话生效（勿在组件内联三目链）。共用模块
    // primary-cycle.ts 持有换挡动作（弹出窗口用同一份，2026-11-04）。
    expect(layout).toContain('cyclePrimaryMode(wbKey, primary)')
    expect(cycle).toContain('const next = nextPrimary(primary)')
    expect(cycle).toContain('setConversationPrimary(wbKey, next)')
    // dock 补开臂：files/browser 下 chatSlot 只在 dock 渲染，关着时对话列
    // 不可达——与浏览器任务物化路径 setOpen(true) 同语义。
    expect(cycle).toMatch(/next !== 'chat'\) useWorkbenchStore\.getState\(\)\.setOpen\(wbKey, true\)/)
    // 图标表三值齐备，且与新建任务子菜单同源同形（用户裁定 2026-11-04：
    // 键=当前模式、图标即状态不宣传下一档；「需要和新建任务子菜单的图标保持
    // 一致，相同语义」——对话/工作区/浏览器 直接取子菜单的 对话/项目/浏览器
    // 三档，本文件不自选字形）。
    expect(cycle).toContain("chat: newTaskModeIcon('chat')")
    expect(cycle).toContain("files: newTaskModeIcon('project')")
    expect(cycle).toContain("browser: newTaskModeIcon('browser')")
    expect(cycle).not.toContain('@ant-design/icons')
    // 子菜单那侧仍是三档的唯一字形真源。
    const registry = read('src/renderer/src/navigation/registry.ts')
    expect(registry).toContain('export function newTaskModeIcon(mode: NewTaskMode)')
    expect(registry).toContain("icon: MessageOutlined, view: 'chat', isAction: true, taskMode: 'chat'")
    expect(registry).toContain("icon: FolderOutlined, view: 'chat', isAction: true, taskMode: 'project'")
    expect(registry).toContain("icon: GlobalOutlined, view: 'chat', isAction: true, taskMode: 'browser'")
    // 表只有一份：AppLayout 不复制（两处各写一份必然漂移）。
    expect(layout).not.toContain('chat: MessageOutlined')
    // 读法走 hook，勿裸订阅 map。
    expect(layout).toContain('useConversationPrimary(wbKey)')
    // App 传 welcome 门控信号：welcome 正在显示（chat + 零消息 + 非流式）时
    // 隐藏；browser 优先的零消息容器不算 welcome。
    expect(read(APP)).toContain("activeConvShowCycle={!!activeConvKey && (primary !== 'chat' || messages.length > 0 || isRequesting)}")
    // i18n 三键两语齐备（文案=当前视图 + 点击切换）。
    const zh = read('src/renderer/src/i18n/locales/zh.ts')
    const en = read('src/renderer/src/i18n/locales/en.ts')
    expect(zh).toContain("primaryViewChat: '对话视图 · 点击切换'")
    expect(zh).toContain("primaryViewWorkspace: '工作区视图 · 点击切换'")
    expect(zh).toContain("primaryViewBrowser: '浏览器视图 · 点击切换'")
    expect(en).toContain("primaryViewChat: 'Chat view · click to switch'")
    expect(en).toContain("primaryViewWorkspace: 'Workspace view · click to switch'")
    expect(en).toContain("primaryViewBrowser: 'Browser view · click to switch'")
    // 按钮顺序（2026-11-04 裁定）：循环钮 → 弹出独立窗口 → 侧边窗口开关
    // （弹出与开关换位——弹窗动作贴着循环钮，开关收最右）。
    const cycleIdx = layout.indexOf('data-pm-primary-cycle')
    const popoutIdx = layout.indexOf("t('conversationSidebar.popOut')")
    const toggleIdx = layout.indexOf('appLayout.showWorkbench')
    expect(cycleIdx).toBeGreaterThan(-1)
    expect(popoutIdx).toBeGreaterThan(cycleIdx)
    expect(toggleIdx).toBeGreaterThan(popoutIdx)
  })

  it('welcome 切换器：主卡三档，窄面两档（review_20261105 中2：browser 只在主卡有出口）', () => {
    const view = read(CHAT_VIEW)
    expect(view).toContain("{ label: t('welcome.modeBrowser'), value: 'browser' }")
    const body = read(CHAT_BODY)
    // 窄面没有 BrowserTaskPanel（URL 表单只存在于整页 welcome）——「浏览器」
    // 档在那里是点了没反应的死档，切换器必须过滤掉它；主卡 welcome 留在
    // browser 档时窄面按 chat 显示（narrowMode 派生）。
    expect(body).not.toContain("{ label: t('welcome.modeBrowser'), value: 'browser' }")
    expect(body).toContain("{ label: t('welcome.modeChat'), value: 'chat' }")
    expect(body).toContain("{ label: t('welcome.modeProject'), value: 'project' }")
    expect(body).toContain("taskMode === 'browser' ? 'chat' : taskMode")
    // i18n 键两语齐备。
    expect(read('src/renderer/src/i18n/locales/zh.ts')).toContain("modeBrowser: '浏览器'")
    expect(read('src/renderer/src/i18n/locales/en.ts')).toContain("modeBrowser: 'Browser'")
  })

  it('WelcomeContent：browser 模式挂 BrowserTaskPanel（URL + 近期历史）', () => {
    const src = read(WELCOME_CONTENT)
    expect(src).toContain("mode === 'browser' ? (")
    expect(src).toContain('<BrowserTaskPanel disabled={!hasApiKey} onBrowserTaskStart=')
    // 未配置密钥 = 面板照常显示、整体禁用（2026-11-04 用户裁定改口「输出框
    // 还是要显示的，只是禁用」）：URL 行不再整块退场——撤下它 welcome 只剩
    // 一张密钥卡，看不出这个形态本来能做什么。臂内不得再有 null 分支。
    const browserArmStart = src.indexOf("mode === 'browser' ? (")
    const browserArm = src.slice(browserArmStart, src.indexOf(') : (', browserArmStart))
    expect(browserArm).toContain('<BrowserTaskPanel disabled={!hasApiKey}')
    expect(browserArm).not.toContain('hasApiKey ?')
    const panel = read(BROWSER_TASK_PANEL)
    expect(panel).toContain('data-pm-browser-task-url')
    expect(panel).toContain('data-pm-browser-task-history-item')
    // 历史卡高度贴合内容（2026-11-05 裁定「历史少不用撑满至底部，看上去太空
    // 了」）：wrapper flex '0 1 auto'——grow 0 贴内容、shrink 1 仍在历史多/
    // 短窗时收缩自滚。改回 flex:1 半空灰卡就回来，勿动。
    expect(panel).toContain("flex: '0 1 auto'")
    // 禁用面三处必须齐：输入框、打开钮、历史行——只撤一处等于留死路。
    const urlStart = panel.indexOf('data-pm-browser-task-url')
    const urlInput = panel.slice(urlStart, panel.indexOf('onPressEnter', urlStart))
    expect(urlInput).toContain('disabled={disabled}')
    // 禁用的输入框不许抢焦点：autoFocus 随 disabled 门。
    expect(urlInput).toContain('autoFocus={!disabled}')
    const openBtn = panel.slice(panel.indexOf("aria-label={t('welcome.browserOpenAction')}"))
    expect(openBtn).toMatch(/disabled=\{disabled\}[\s\S]{0,200}onClick/)
    expect(panel).toMatch(/if \(disabled\) return/)
    expect(panel).toContain("cursor: disabled ? 'default' : 'pointer'")
    // URL 归一化与 pane 地址栏同一把尺。
    expect(panel).toContain('normalizeAddressBarInput')
    // 回车串场钉（四期实测）：preventDefault 掐断 keypress，IME 组合回车不提交。
    expect(panel).toMatch(/onPressEnter=\{\(e\) => \{[\s\S]{0,600}e\.preventDefault\(\)[\s\S]{0,400}isComposing[\s\S]{0,200}start\(url\)/)
    // 近期历史 = browserHistoryQuery('') 全量近序，面板截前 8。
    expect(panel).toContain("browserHistoryQuery('')")
    // 零历史整卡退场（2026-11-04 裁定：没有访问记录就不需要近期访问区）——
    // 历史卡是条件渲染，「暂无访问记录」空态壳已撤。
    expect(panel).toContain('{history.length > 0 && (')
    expect(panel).not.toContain('browserHistoryEmpty')
  })

  it('控制器物化：浏览器任务绑定该会话主视图并打开 dock', () => {
    const src = read(CONTROLLER)
    expect(src).toMatch(/task\.mode === 'browser'[\s\S]{0,200}setConversationPrimary\(convId, 'browser'\)/)
    expect(src).toMatch(/task\.mode === 'browser'[\s\S]{0,260}setOpen\(convId, true\)/)
    // newTaskStore 的模式联合三值齐备。
    expect(read(NEW_TASK_STORE)).toContain("export type NewTaskMode = 'chat' | 'project' | 'browser'")
  })

  it('createBrowserTask：URL 容器会话零消息（三期裁定）', () => {
    const src = read(CONTROLLER)
    expect(src).toMatch(/const createBrowserTask = useCallback/)
    // 标题即 URL；乐观列表铸容器，无 startLoop / 无 handleRequest。
    expect(src).toMatch(/createBrowserTask[\s\S]{0,800}label: url/)
    const body = src.slice(src.indexOf('const createBrowserTask'), src.indexOf('const createBrowserTask') + 1400)
    expect(body).toContain("setConversationPrimary(convId, 'browser')")
    expect(body).toContain('setOpen(convId, true)')
    expect(body).toContain("setActiveTab('chat')")
    expect(body).toContain('persistence.activateConversation(convId)')
    // 引擎活跃会话（2026-11-04）：「输入消息无响应」的根因——容器不经侧栏切换，
    // 只激活 persistence 那一半时，dock 里发的消息只进镜像、不进 React。
    // 顺序同物化分支：先 activateEngine 再 activateConversation。
    expect(body.indexOf('engine.activateEngine(convId)')).toBeGreaterThan(-1)
    expect(body.indexOf('engine.activateEngine(convId)')).toBeLessThan(body.indexOf('persistence.activateConversation(convId)'))
    expect(body).not.toContain('startLoop')
    // 暴露给 App（锚 Return 节——文件里更早的 return { 是回调体）。
    expect(src).toMatch(/── 8\. Return ──[\s\S]{0,2400}createBrowserTask,/)
  })

  it('App：URL 提交 → 零消息容器（三期裁定），pane 绑定后开页签直达', () => {
    const src = read(APP)
    // 双匹配（review_20261104 中1）：pending 带 {convId, url}，守卫比对提交
    // 目标而非当前活跃会话——回声未到时切走，不让别的会话的绑定回声替导航。
    expect(src).toContain('pendingBrowserUrl.current = { convId, url }')
    expect(src).toContain('if (browserPaneConversationId !== pending.convId) return')
    // 三期：不再发「打开 <url>」消息——createBrowserTask 只铸容器。
    expect(src).toContain('createBrowserTask(url)')
    expect(src).not.toContain('browserOpenTask')
    // 等 pane 快照报到提交目标会话名下再开页签；navigate 无 tabId = 开新页签直达。
    expect(src).toContain("browserPaneAction({ op: 'navigate', url: pending.url })")
    // 订阅面收窄（review_20261104 中2）：只取 conversationId，整对象订阅会把
    // 每次 url/title 推送拖进全 App 重渲染。
    expect(src).toContain('useBrowserPaneStore((s) => s.update.conversationId)')
    expect(src).not.toContain('useBrowserPaneStore((s) => s.update)\n')
    // 交接给 ChatView。
    expect(src).toContain('onBrowserTaskStart={handleBrowserTaskStart}')
    // prop 必填（review_20261105 中1）：可选 + `?? (() => {})` 兜底曾让
    // PopoutApp 漏传静默成 noop——编译器兜底，两个宿主都必须传真通道。
    expect(read(CHAT_VIEW)).toContain('onBrowserTaskStart: (url: string) => void')
    expect(read(CHAT_VIEW)).not.toContain('onBrowserTaskStart?:')
    expect(read(CHAT_VIEW)).toContain('<WelcomeContent')
    const welcomeContent = read(WELCOME_CONTENT)
    expect(welcomeContent).toContain('onBrowserTaskStart: (url: string) => void')
    expect(welcomeContent).not.toContain('?? (() => {})')
  })

  it('welcome 浏览器模式无自由输入框（四期修正裁定）：composer wrapper 退场', () => {
    const view = read(CHAT_VIEW)
    // 2026-11-04 两形态裁定把条件收得更紧：composer 只在 chat 恒显、project
    // 已选时出现——browser 仍被排除在外（URL 表单是唯一入口），project 未选
    // 时同样整块退场（卡片网格是唯一入口）。同日追加了密钥门：没配 API Key
    // 时 chat/project 两形态的输入框整块退场（发送必然失败，位置由
    // WelcomeContent 的 ApiKeyGuide 卡接管）。卸载无损性已没有草稿通道兜底：
    // welcome 的试试 chips 改为点一下即发送（2026-11-04），手打文字卸载即失
    // （见 tests/welcome-starter-send.test.ts）。
    expect(view).toMatch(/\{hasApiKey && \(taskMode === 'chat' \|\| \(taskMode === 'project' && !!newTaskProjectId\)\) && \([\s\S]{0,200}composerShakeRef/)
    // 未配置密钥的引导卡（2026-11-04 用户裁定重设计，替换旧 warn 色方块）：
    // 主 welcome 与 dock 窄面共用 ApiKeyGuide，两处都必须有它。
    expect(read('src/renderer/src/components/chat/WelcomeContent.tsx')).toContain('<ApiKeyGuide />')
    expect(read(CHAT_BODY)).toContain('<ApiKeyGuide compact />')
    expect(read(CHAT_BODY)).toContain('hasApiKey ? (')
    // 浏览器主视图的 dock 对话 tab 保留 composer（四期修正：上轮删错了面）。
    expect(view).not.toContain('noComposer')
    expect(read(CHAT_BODY)).not.toContain('noComposer')
    expect(read('src/renderer/src/i18n/locales/zh.ts')).not.toContain('browserSessionHint')
  })

  it('十四期接线：新建任务子菜单三档，档位分流 welcome 形态', () => {
    const reg = read('src/renderer/src/navigation/registry.ts')
    expect(reg).toContain('NEW_TASK_SUBMENU')
    expect(reg).toContain("taskMode: 'browser'")
    // 三档 view 都是 'chat'（任务形态不是导航视图）。
    expect(reg).toMatch(
      /NEW_TASK_SUBMENU: SidebarNavItem\[\] = \[[\s\S]{0,400}view: 'chat', isAction: true, taskMode: 'chat'[\s\S]{0,200}view: 'chat', isAction: true, taskMode: 'project'[\s\S]{0,200}view: 'chat', isAction: true, taskMode: 'browser'/,
    )
    // 主条目挂子菜单。
    expect(reg).toMatch(/menu\.newTask[^\n]*submenu: NEW_TASK_SUBMENU/)
    // SidebarNav 分流。
    const nav = read('src/renderer/src/components/layout/SidebarNav.tsx')
    expect(nav).toContain('onCreateNewWithMode?.(item.taskMode)')
    // AppLayout handler：setMode + 三档 shake + 建新会话；本体仍走 listTab。
    const layout = read(APP_LAYOUT)
    expect(layout).toContain('handleNewTaskWithMode')
    expect(layout).toMatch(/mode === 'browser' \? 'browserUrl'/)
    expect(layout).toContain('onCreateNewWithMode={handleNewTaskWithMode}')
    // BrowserTaskPanel 接 browserUrl shake。
    expect(read(CHAT_BODY.replace('chat/ChatBody', 'welcome/BrowserTaskPanel'))).toContain(`data-welcome-shake="browserUrl"`)
    // shake target 三值齐备。
    expect(read(NEW_TASK_STORE)).toContain("'composer' | 'projectPicker' | 'browserUrl'")
  })

  it('布局换位接线沿用一期：主卡按会话 primary 切换，chatSlot 进 dock', () => {
    const view = read(CHAT_VIEW)
    expect(view).toContain('useConversationPrimary(wbKey)')
    expect(view).toContain("primary === 'files' ? (")
    expect(view).toContain("chatSlot={primary !== 'chat' ? chatBody : undefined}")
    expect(view).toContain("if (isWelcomeForm && primary === 'chat') {")
    expect(read(WORKBENCH_PANE)).toContain('useConversationPrimary(conversationId ?? DRAFT_CONVERSATION_KEY)')
    expect(read(WORKBENCH_PANE)).toContain("activeTab === 'chat' && chatSlot")
    // auto-open 漏斗三处统一 autoOpenTab。
    expect(read(PREVIEW_STORE)).toContain("autoOpenTab(key, 'workspace')")
    expect(read(CHAT_VIEW)).toContain("autoOpenTab(wbKey, 'browser')")
    expect(read(APP)).toContain("autoOpenTab(key, 'plan')")
    // 子代理覆盖层按会话模式取锚。
    expect(read(APP)).toContain('useConversationPrimary(wbKey)')
  })

  it('十三期接线：浮窗让位（测量 hook → 推送 → dock 裁剪）', () => {
    // 字段与透传。
    expect(read('src/shared/browser/pane.ts')).toContain('leftOverlay?: number')
    expect(read('src/shared/browser/pane.ts')).toContain('rightOverlay?: number')
    const service = read('src/main/browser/BrowserService.ts')
    expect(service).toContain('appViewDock.setSideOverlays(win, state.leftOverlay ?? 0, state.rightOverlay ?? 0)')
    // dock 裁剪：左右缘内收、zoom 仍按 this.width（页面不 reflow 的关键）。
    const dock = read('src/main/browser/app-view-dock.ts')
    expect(dock).toContain('box.x += this.leftOverlay')
    expect(dock).toContain('box.width = Math.max(0, box.width - this.leftOverlay - this.rightOverlay)')
    // 渲染端：测量 hook（body 级 observer + antd 浮窗选择器 + webview 矩形）
    // 与 browserPrimary 推送。
    const hook = read('src/renderer/src/hooks/useFloatOverlayShift.ts')
    expect(hook).toContain("'.ant-dropdown, .ant-select-dropdown, .ant-popover, .ant-tooltip'")
    expect(hook).toContain('data-pm-primary-browser-card')
    expect(hook).toContain('setFloatOverlay')
    const push = read('src/renderer/src/hooks/useBrowserPane.ts')
    expect(push).toContain('leftOverlay: floatOverlay.left,')
    expect(push).toContain('rightOverlay: floatOverlay.right,')
    // App 挂载（enabled = 浏览器主视图 && chat 视图）+ 卡标记。
    expect(read(APP)).toMatch(/useFloatOverlayShift\(primary === 'browser' && viewKindForOverlay === 'chat'\)/)
    expect(read(CHAT_VIEW)).toContain('data-pm-primary-browser-card')
  })

  it('刀二接线沿用：browser-primary 推送、dock chromeBase、主卡浏览器 chrome', () => {
    const hook = read(BROWSER_PANE_HOOK)
    expect(hook).toContain("const browserActive = browserPrimary || (workbenchOpen && workbenchTab === 'browser')")
    expect(hook).toContain('chromeHeight: PRIMARY_PANE_CHROME_HEIGHT')
    // 卡片补偿只在 cardMode 生效（2026-11-04：弹出窗口也有浏览器主视图，
    // 它没有卡片——无卡时必须零 inset，否则原生 view 落位偏 5-6px）。
    expect(hook).toContain('rightInset: reserve + (cardMode ? WORKBENCH_CARD_MARGIN : 0)')
    expect(hook).toContain('...(cardMode ? { topInset: WORKBENCH_CARD_TOP_INSET, bottomInset: WORKBENCH_CARD_BOTTOM_INSET } : {})')
    const dock = read('src/main/browser/app-view-dock.ts')
    expect(dock).toContain('this.chromeBase + this.chromeOverlay')
    const chatView = read(CHAT_VIEW)
    expect(chatView).toContain("primary === 'browser' ? (")
    expect(chatView).toContain('<BrowserPaneChrome pane={browserPane}')
  })

  it('弹出窗口头部也有循环钮（2026-11-04 裁定）：同一份表 + welcome 门控', () => {
    const popout = read(POPOUT_APP)
    // 探针钩子与主窗同名（两窗是同一颗钮）。
    expect(popout).toContain('data-pm-primary-cycle')
    // 换挡动作走共用模块，不在窗口里复制 store 调用。
    expect(popout).toContain('cyclePrimaryMode(wbKey, primary)')
    // 门控与主窗同款：零消息的 chat 优先态不出现；项目窗口恒不出现（它没有
    // dock，非 chat 主视图会让对话列不可达）。
    expect(popout).toContain("const showPrimaryCycle = !isProjectWindow && (primary !== 'chat' || messages.length > 0 || isRequesting)")
    // 图标/文案表共用——PopoutApp 不复制一份。
    expect(popout).toContain('PRIMARY_CYCLE_ICON[primary]')
    expect(popout).not.toContain('chat: MessageOutlined')
    // 读法走 hook。
    expect(popout).toContain('useConversationPrimary(wbKey)')
    // 位置：循环钮在侧栏开关之前（与主窗同簇逻辑），且都在非项目窗口分支里。
    expect(popout.indexOf('data-pm-primary-cycle')).toBeGreaterThan(-1)
    expect(popout.indexOf('data-pm-primary-cycle')).toBeLessThan(popout.indexOf("t('appLayout.showWorkbench')"))
  })
})
