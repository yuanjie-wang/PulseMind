// ── Workbench store (PLAN-workbench W7) ──
// Single right-side pane host state: which tool tab is frontmost (工作区 /
// 浏览器 / 工作计划 / 对话), one shared width, and per-conversation open/closed —
// each conversation remembers its own pane, and one with no entry (a fresh
// conversation included) starts closed. Auto-open entries all funnel through
// openTab: create_plan → 'plan', a fresh browser tab → 'browser', a file
// preview → 'workspace' (the standalone 文件预览 tab was merged into 工作区 —
// tree left, preview right), each tagged with the conversation it belongs to.
// Width is persisted; open state is deliberately not (a restart has no live
// plan or browser session to show). The deliverables aggregate tab that
// existed here for one day (2026-09-19) is gone — the per-turn cards in the
// transcript are the only deliverables surface; a persisted activeTab naming
// it (or the removed 'files') must not render an empty pane body, hence the
// ID set below.
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

/** The renderable tabs. A persisted `activeTab` outside this set (a tab that
 *  was since removed — 'files' merged into 'workspace') falls back to
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

/** 每个 tab 一份 pane 宽度（2026-11-06 用户裁定「按 tab 分开」）。此前是
 *  一个全局单标量：浏览器被拖宽到 800 之后，工作计划/工作区的面板被同一
 *  个数字撑开——浏览器确实需要宽，计划面板不需要。缺键 = 该 tab 从未拖过，
 *  回落 WORKBENCH_DEFAULT_WIDTH；仍是「用户机器上的几何」而非会话属性，
 *  所以会话之间共享（与 openByConversation 的按会话恰好相反）。 */
export type WorkbenchWidthByTab = Partial<Record<WorkbenchTab, number>>

/** 某个 tab 的生效宽度（per-tab 之后唯一的读数口子）。 */
export function widthForTab(widthByTab: WorkbenchWidthByTab, tab: WorkbenchTab): number {
  const w = widthByTab[tab]
  return typeof w === 'number' && Number.isFinite(w) ? w : WORKBENCH_DEFAULT_WIDTH
}

/** hook 形态：pane 宽度按当前 activeTab 取。**五个消费点必须全部走这一个
 *  口子**——面板自身宽、对话列 paddingRight 预留、drill-in 覆盖层（主窗 +
 *  会话弹出窗）、原生 webview 的 rightInset；任何一处读到别的 tab 的宽度，
 *  reserve 与面板就错位（多一条缝，或覆盖层压到 pane 上）。
 *  按**原始** activeTab 取（不是 WorkbenchPane 里 reconcile 后的渲染 tab）：
 *  调和差异只出现在「持久化的 activeTab 不在当前模式侧栏集合里」的首帧，
 *  此时只需五个点彼此一致，渲染的是哪张 body 不影响几何。 */
export function useWorkbenchWidth(): number {
  return useWorkbenchStore((s) => widthForTab(s.widthByTab, s.activeTab))
}

/** 工作区 tab's tree column (px) — the tree↔preview divider drag persists
 *  here, global like the pane width (pane geometry is about the user, not
 *  the conversation). Clamped at consumption: clampTreeWidth against the
 *  live row measurement, never trusted raw off the disk. */
export const WORKBENCH_DEFAULT_TREE_WIDTH = 180

/** How many conversations' open flags / modes to remember before MRU-pruning. */
const MAX_OPEN_MAPS = 20

interface WorkbenchState {
  /** Pane open per conversation key; absent = closed. */
  openByConversation: Record<string, boolean>
  /** 主视图归属 per conversation（视图模式跟任务走）；absent = 'chat'。 */
  primaryByConversation: Record<string, PrimaryPane>
  /** 每个 tab 的 pane 宽度；缺键 = 默认值（见 widthForTab）。 */
  widthByTab: WorkbenchWidthByTab
  activeTab: WorkbenchTab
  treeWidth: number
  setOpen: (convKey: string, open: boolean) => void
  /** 写入某个 tab 的宽度；`tab` 缺省 = 当前 activeTab（拖拽手的天然语义：
   *  拖的是眼前这一张面板）。 */
  setWidth: (width: number, tab?: WorkbenchTab) => void
  setTreeWidth: (treeWidth: number) => void
  setActiveTab: (tab: WorkbenchTab) => void
  /** 绑定一个会话的主视图模式（welcome 浏览器任务物化时调用），并按新模式
   *  调和全局 activeTab。 */
  setConversationPrimary: (convKey: string, primary: PrimaryPane) => void
  /** Bring a tab to the front, opening this conversation's workbench if closed. */
  openTab: (convKey: string, tab: WorkbenchTab) => void
}

/** v1 → v2 持久化迁移（2026-11-06 width 单标量 → widthByTab）。旧值**只继承
 *  给 browser**——用户裁定「浏览器保留调过的宽带，工作计划/工作区回默认」；
 *  其余 tab 无键即回落 WORKBENCH_DEFAULT_WIDTH，历史那次拖宽不再把计划面板
 *  撑开。导出成纯函数：测试直接跑迁移，不依赖 persist 的运行时 API。 */
export function migrateWorkbenchPersisted(persisted: unknown, version: number): WorkbenchState {
  if (version >= 2) return persisted as WorkbenchState
  const old = persisted as Omit<Partial<WorkbenchState>, 'width'> & { width?: number }
  const { width: legacy, ...rest } = old
  const kept = typeof legacy === 'number' && Number.isFinite(legacy) ? { browser: legacy } : {}
  return { ...rest, widthByTab: kept } as WorkbenchState
}

/** 落盘形状（2026-11-06 起是 widthByTab；单标量 width 不再写）。同样导出成
 *  纯函数供测试断言「旧字段没有被写回去」。 */
export function workbenchPersistShape(s: WorkbenchState): WorkbenchState {
  // primaryByConversation 刻意不持久化——重启后浏览器页签本就不在，布局回归
  // 对话优先与 openByConversation 的「重启无活面板」裁定一致。
  return { widthByTab: s.widthByTab, activeTab: s.activeTab, treeWidth: s.treeWidth } as WorkbenchState
}

/** Re-insert `convKey` as most-recently-used, then prune beyond the cap —
 *  same shape as previewPaneStore's touch(); a pruned conversation just
 *  re-enters as closed / chat. `value` is spliced in verbatim so the open
 *  map (boolean) and the mode map (PrimaryPane) share one pruner. */
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
      widthByTab: {},
      activeTab: 'workspace',
      treeWidth: WORKBENCH_DEFAULT_TREE_WIDTH,
      setOpen: (convKey, open) => set((s) => ({ openByConversation: touchMap(s.openByConversation, convKey, open) })),
      setWidth: (width, tab) => set((s) => ({ widthByTab: { ...s.widthByTab, [tab ?? s.activeTab]: width } })),
      setTreeWidth: (treeWidth) => set({ treeWidth }),
      setActiveTab: (activeTab) => set({ activeTab }),
      setConversationPrimary: (convKey, primary) =>
        set((s) => ({
          primaryByConversation: touchMap(s.primaryByConversation, convKey, primary),
          // 模式换挡即调和侧栏 tab：side 集合外的 activeTab（含被主视图顶掉的）
          // 按新模式回落，杜绝渲染空 body。
          activeTab: reconcileActiveTab(primary, s.activeTab),
        })),
      openTab: (convKey, tab) =>
        set((s) => ({
          openByConversation: touchMap(s.openByConversation, convKey, true),
          activeTab: reconcileActiveTab(PRIMARY_MODE_CLAMPED ? 'chat' : (s.primaryByConversation[convKey] ?? 'chat'), tab),
        })),
    }),
    {
      name: 'pulsemind-workbench',
      version: 2,
      migrate: migrateWorkbenchPersisted,
      partialize: workbenchPersistShape,
    },
  ),
)
