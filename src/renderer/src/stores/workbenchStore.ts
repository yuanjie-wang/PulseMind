// ── Workbench store (PLAN-workbench W7) ──
// Single right-side pane host state: which tool tab is frontmost (工作区 /
// 浏览器 / 工作计划 / 对话), the pane width, and open/closed — the frontmost
// tab and the width are per conversation (2026-11-12 用户裁定「侧边窗口的宽度
// 和 tab 选中状态，每个会话要独立管理」), and so is open/closed — each
// conversation remembers its own pane, and one with no entry (a fresh
// conversation included) starts closed. Auto-open entries all funnel through
// openTab: create_plan → 'plan', a fresh browser tab → 'browser', a file
// preview → 'workspace' (the standalone 文件预览 tab was merged into 工作区 —
// tree left, preview right), each tagged with the conversation it belongs to.
// Width is persisted, one scalar per conversation (2026-11-12 二次裁定「已打开
// 侧边窗口的状态下切 tab，不要再改变宽度」——按 tab 的维度退役，宽度只随
// 拖拽走); the open flag and the per-conversation tab are deliberately not
// persisted (a restart has no live plan or browser session to show, and every
// open path names its tab).
// The deliverables aggregate tab that existed here for one day (2026-09-19)
// is gone — the per-turn cards in the transcript are the only deliverables
// surface; a remembered tab naming it (or the removed 'files') must not
// render an empty pane body, hence the ID set below.
//
// 视图模式（PLAN-layout-modes 2026-11-03；二期裁定「模式跟任务走」）：
// `primaryByConversation` 是每个会话的主视图归属（chat 对话优先 / files 文件
// 优先 / browser 浏览器优先），侧 dock 永远承载剩下的三个 tab（sideTabsFor）。
// 模式跟任务走、不设全局切换器（2026-11-04 修订：会话头新增三态循环钮
// `nextPrimary`——仅会话界面（非 welcome）出现、按会话生效；welcome 任务
// 表单选「浏览器」物化的会话 = 浏览器优先（useChatController 物化时绑定）；
// 无条目（新会话/DRAFT）= 'chat'，
// 所以新建对话天然回到整页 welcome。与 openByConversation 同款内存态、同款
// MRU 剪枝、刻意不持久化（重启后浏览器页签本就不在，布局回归对话优先一致）。
// 项目沉浸窗口恒按 'chat' 消费（`PRIMARY_MODE_CLAMPED`）——它没有 dock、
// hideWorkbench 常开，非 chat 主视图会让对话列无处可达；会话弹出窗口自
// 2026-11-04 起自带头部循环钮、按本窗生效（各窗口独立渲染进程，模式不跨窗
// 泄漏）。openTab/autoOpenTab 内做
// activeTab 调和（reconcileActiveTab）：side 集合不含的 tab（包括「tab 就是
// 主视图自己」）按模式回落，杜绝渲染空 body。
//
// Conversation keys come from callers (previewPaneStore's DRAFT key covers
// new tasks with no row yet) — this store stays key-format-agnostic so it
// does not import previewPaneStore back.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { IS_PROJECT_WINDOW } from '../popout/boot'

export type WorkbenchTab = 'workspace' | 'browser' | 'plan' | 'chat'

/** 主视图归属（视图模式）。'chat' 对话优先（历史默认）；'files' 文件优先
 *  （主视图=目录树+文件预览）；'browser' 浏览器优先（主视图=浏览器）。 */
export type PrimaryPane = 'chat' | 'files' | 'browser'

/** 把主视图模式钳到 'chat' 的窗口形态。项目沉浸窗口：`hideWorkbench` + 无
 *  dock，非 chat 主视图会让对话列无处可达（chatSlot 只在 dock 渲染），所以
 *  恒按 'chat' 消费。会话弹出窗口 2026-11-04 起有自己的头部循环钮，按本窗
 *  生效（每个窗口是独立渲染进程，primaryByConversation 天然不跨窗泄漏）。 */
export const PRIMARY_MODE_CLAMPED = IS_PROJECT_WINDOW

/** The renderable tabs. A remembered tab outside this set (a tab that was
 *  since removed — 'files' merged into 'workspace') falls back to
 *  'workspace' in WorkbenchPane instead of rendering a pane body with no
 *  view. */
export const WORKBENCH_TAB_IDS: ReadonlySet<WorkbenchTab> = new Set<WorkbenchTab>(['workspace', 'browser', 'plan', 'chat'])

/** 侧 dock 在各主视图模式下承载的 tab 集合（= 全集减去主视图自己）。 */
export function sideTabsFor(primary: PrimaryPane): WorkbenchTab[] {
  if (primary === 'files') return ['chat', 'browser', 'plan']
  if (primary === 'browser') return ['chat', 'workspace', 'plan']
  return ['workspace', 'browser', 'plan']
}

/** activeTab 调和：side 集合不含的 tab 按模式回落——files/browser 优先回落
 *  'chat'（对话永远在侧栏可达），chat 优先回落 'workspace'（历史默认）。 */
export function reconcileActiveTab(primary: PrimaryPane, tab: WorkbenchTab): WorkbenchTab {
  if (sideTabsFor(primary).includes(tab)) return tab
  return primary === 'chat' ? 'workspace' : 'chat'
}

/** 会话头循环钮的下一档（2026-11-04 裁定，修订二期「无全局切换器」）：
 *  chat → files → browser → chat。按会话生效（setConversationPrimary），
 *  与 welcome/新建任务的「任务创建面」入口互补——已有会话从此有换挡入口。 */
export function nextPrimary(primary: PrimaryPane): PrimaryPane {
  if (primary === 'chat') return 'files'
  if (primary === 'files') return 'browser'
  return 'chat'
}

export const WORKBENCH_DEFAULT_WIDTH = 420

/** pane 宽度：**每会话一份标量**（2026-11-12 用户裁定「宽度和 tab 选中状态
 *  每个会话独立管理」，同日二次裁定「已打开侧边窗口的状态下切 tab，不要再
 *  改变宽度」——2026-11-06 的按 tab 维度随之退役：浏览器需要宽、计划面板不
 *  需要的那层适配让位于「面板宽不随 tab 跳」的稳定面，宽度只随拖拽走）。 */
export type WorkbenchWidth = number

/** 某个会话的生效宽度（唯一读数口子）：缺键/非有限值回落默认值——不读任何
 *  tab 维度，切 tab 天然不改宽。 */
export function widthForConversation(s: Pick<WorkbenchState, 'widthByConversation'>, convKey: string | undefined): number {
  const w = convKey ? s.widthByConversation[convKey] : undefined
  return typeof w === 'number' && Number.isFinite(w) ? w : WORKBENCH_DEFAULT_WIDTH
}

/** hook 形态：pane 宽度按该会话取。**五个消费点必须全部走这一个口子**——
 *  面板自身宽、对话列 paddingRight 预留、drill-in 覆盖层（主窗 + 会话弹出
 *  窗）、原生 webview 的 rightInset；任何一处读到别的会话的宽度，reserve 与
 *  面板就错位（多一条缝，或覆盖层压到 pane 上）。宽度是会话标量，与 tab 无
 *  关——切 tab 改变的只有 body，不该改变几何。 */
export function useWorkbenchWidth(convKey: string | undefined): number {
  return useWorkbenchStore((s) => widthForConversation(s, convKey))
}

/** 工作区 tab's tree column (px) — the tree↔preview divider drag persists
 *  here, global like the pane width (pane geometry is about the user, not
 *  the conversation). Clamped at consumption: clampTreeWidth against the
 *  live row measurement, never trusted raw off the disk. */
export const WORKBENCH_DEFAULT_TREE_WIDTH = 180

/** How many conversations' open flags / modes / tabs / widths to remember
 *  before MRU-pruning. */
const MAX_OPEN_MAPS = 20

interface WorkbenchState {
  /** Pane open per conversation key; absent = closed. */
  openByConversation: Record<string, boolean>
  /** 主视图归属 per conversation（视图模式跟任务走）；absent = 'chat'。 */
  primaryByConversation: Record<string, PrimaryPane>
  /** Pane width per conversation（2026-11-12 裁定，标量见 WorkbenchWidth 的
   *  注释）；缺键回落 WORKBENCH_DEFAULT_WIDTH。落盘。 */
  widthByConversation: Record<string, number>
  /** Active tab per conversation（2026-11-12 裁定）；absent = 'workspace'
   *  （见 activeTabOf）。与 open/primary 同款内存态——重启无活面板，每条
   *  open 路径都显式点名 tab。 */
  activeTabByConversation: Record<string, WorkbenchTab>
  treeWidth: number
  setOpen: (convKey: string, open: boolean) => void
  /** 写入某个会话的宽度（拖拽手的天然语义：宽度属于会话，与眼前是哪张 tab
   *  无关——切 tab 不改宽）。 */
  setWidth: (convKey: string, width: number) => void
  setTreeWidth: (treeWidth: number) => void
  setActiveTab: (convKey: string, tab: WorkbenchTab) => void
  /** 绑定一个会话的主视图模式（welcome 浏览器任务物化时调用），并按新模式
   *  调和该会话的 activeTab。 */
  setConversationPrimary: (convKey: string, primary: PrimaryPane) => void
  /** Bring a tab to the front, opening this conversation's workbench if closed. */
  openTab: (convKey: string, tab: WorkbenchTab) => void
}

/** 持久化迁移链。v1 → v2（2026-11-06 width 单标量 → widthByTab）：旧值只
 *  继承给 browser（当日裁定）；v2 → v3（2026-11-12 宽度/tab 按会话独立，同
 *  日二次裁定「切 tab 不改宽」把按 tab 维度整个退役）：全局 activeTab 与
 *  widthByTab 一并剥除——v2 的 per-tab 值在新标量模型里没有载体（哪个 tab
 *  的宽度都不该替会话定宽），各会话从默认宽度起步、拖一次即按会话记住；两
 *  个旧字段已从状态里删除，留着的旧键只会成为 merge 进来的死字段，这里剥
 *  掉。导出成纯函数：测试直接跑迁移，不依赖 persist 的运行时 API。 */
export function migrateWorkbenchPersisted(persisted: unknown, version: number): WorkbenchState {
  let s = persisted as Partial<WorkbenchState> & { width?: number; activeTab?: WorkbenchTab; widthByTab?: Record<string, number> }
  if (version < 2) {
    const { width: legacy, ...rest } = s
    const kept: Record<string, number> = typeof legacy === 'number' && Number.isFinite(legacy) ? { browser: legacy } : {}
    s = { ...rest, widthByTab: kept }
  }
  if (version < 3) {
    const rest = { ...s }
    delete rest.activeTab
    delete rest.widthByTab
    s = { ...rest, widthByConversation: {} }
  }
  return s as WorkbenchState
}

/** 落盘形状（2026-11-12 起宽度是会话标量 widthByConversation；全局
 *  activeTab 与 v2 的 widthByTab 退役不再写）。同样导出成纯函数供测试断言
 *  「旧字段没有被写回去」。 */
export function workbenchPersistShape(s: WorkbenchState): WorkbenchState {
  // primaryByConversation / activeTabByConversation 刻意不持久化——重启后
  // 浏览器页签本就不在，布局回归对话优先 + 每条 open 路径显式点名 tab，与
  // openByConversation 的「重启无活面板」裁定一致。
  return {
    widthByConversation: s.widthByConversation,
    treeWidth: s.treeWidth,
  } as WorkbenchState
}

/** Re-insert `convKey` as most-recently-used, then prune beyond the cap —
 *  same shape as previewPaneStore's touch(); a pruned conversation just
 *  re-enters as closed / chat / workspace / 默认宽. `value` is spliced in
 *  verbatim so the open (boolean), mode (PrimaryPane), tab (WorkbenchTab)
 *  and width (number) maps share one pruner. */
function touchMap<T>(map: Record<string, T>, convKey: string, value: T): Record<string, T> {
  const rest = { ...map }
  delete rest[convKey]
  const entries = Object.entries(rest)
  entries.push([convKey, value])
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_OPEN_MAPS)))
}

/** 非 hook 场景（effect / 事件回调）读一个会话生效的主视图：项目沉浸窗口恒
 *  'chat'，无条目回落 'chat'。 */
export function conversationPrimaryOf(convKey: string | undefined): PrimaryPane {
  if (PRIMARY_MODE_CLAMPED) return 'chat'
  if (!convKey) return 'chat'
  return useWorkbenchStore.getState().primaryByConversation[convKey] ?? 'chat'
}

/** hook 形态的会话主视图——组件里一律读这个，不裸订阅 primaryByConversation。 */
export function useConversationPrimary(convKey: string | undefined): PrimaryPane {
  return useWorkbenchStore((s) => (PRIMARY_MODE_CLAMPED || !convKey ? 'chat' : (s.primaryByConversation[convKey] ?? 'chat')))
}

/** 某个会话生效（原始、未经 reconcile）的侧栏 tab：无条目回落 'workspace'
 *  （历史默认）。选择器与 getState() 快照两用——不裸订阅 activeTabByConversation。 */
export function activeTabOf(s: Pick<WorkbenchState, 'activeTabByConversation'>, convKey: string | undefined): WorkbenchTab {
  return (convKey ? s.activeTabByConversation[convKey] : undefined) ?? 'workspace'
}

/** 主视图顶掉的那个 side tab：files ↔ 工作区（文件预览已在主卡）、
 *  browser ↔ 浏览器（浏览器已是主卡）、chat 不顶任何 tab。auto-open 守卫
 *  的对照表——primary 枚举值与 tab id 只在 browser 上同名，不能用等值比。 */
function primaryTab(primary: PrimaryPane): WorkbenchTab | null {
  if (primary === 'files') return 'workspace'
  if (primary === 'browser') return 'browser'
  return null
}

/** auto-open 漏斗的统一入口（视图模式守卫）：目标 tab 被该会话的主视图顶掉
 *  时零动作——文件优先下文件预览已在主卡，浏览器优先下浏览器已是主卡，不必
 *  再弹 dock / 翻 side tab。其余路径与 openTab 相同。 */
export function autoOpenTab(convKey: string, tab: WorkbenchTab): void {
  if (primaryTab(conversationPrimaryOf(convKey)) === tab) return
  useWorkbenchStore.getState().openTab(convKey, tab)
}

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set) => ({
      openByConversation: {},
      primaryByConversation: {},
      widthByConversation: {},
      activeTabByConversation: {},
      treeWidth: WORKBENCH_DEFAULT_TREE_WIDTH,
      setOpen: (convKey, open) => set((s) => ({ openByConversation: touchMap(s.openByConversation, convKey, open) })),
      // 宽度属于会话（标量）：切 tab 只换 body 不换几何，只有拖拽写这里。
      setWidth: (convKey, width) => set((s) => ({ widthByConversation: touchMap(s.widthByConversation, convKey, width) })),
      setTreeWidth: (treeWidth) => set({ treeWidth }),
      setActiveTab: (convKey, tab) => set((s) => ({ activeTabByConversation: touchMap(s.activeTabByConversation, convKey, tab) })),
      setConversationPrimary: (convKey, primary) =>
        set((s) => ({
          primaryByConversation: touchMap(s.primaryByConversation, convKey, primary),
          // 模式换挡即调和该会话的侧栏 tab：side 集合外的 tab（含被主视图
          // 顶掉的）按新模式回落，杜绝渲染空 body。
          activeTabByConversation: touchMap(s.activeTabByConversation, convKey, reconcileActiveTab(primary, activeTabOf(s, convKey))),
        })),
      openTab: (convKey, tab) =>
        set((s) => ({
          openByConversation: touchMap(s.openByConversation, convKey, true),
          activeTabByConversation: touchMap(
            s.activeTabByConversation,
            convKey,
            reconcileActiveTab(PRIMARY_MODE_CLAMPED ? 'chat' : (s.primaryByConversation[convKey] ?? 'chat'), tab),
          ),
        })),
    }),
    {
      name: 'pulsemind-workbench',
      version: 3,
      migrate: migrateWorkbenchPersisted,
      partialize: workbenchPersistShape,
    },
  ),
)
