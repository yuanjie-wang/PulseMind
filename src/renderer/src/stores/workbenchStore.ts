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
  width: number
  activeTab: WorkbenchTab
  treeWidth: number
  setOpen: (convKey: string, open: boolean) => void
  setWidth: (width: number) => void
  setTreeWidth: (treeWidth: number) => void
  setActiveTab: (tab: WorkbenchTab) => void
  /** 绑定一个会话的主视图模式（welcome 浏览器任务物化时调用），并按新模式
   *  调和全局 activeTab。 */
  setConversationPrimary: (convKey: string, primary: PrimaryPane) => void
  /** Bring a tab to the front, opening this conversation's workbench if closed. */
  openTab: (convKey: string, tab: WorkbenchTab) => void
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
      width: WORKBENCH_DEFAULT_WIDTH,
      activeTab: 'workspace',
      treeWidth: WORKBENCH_DEFAULT_TREE_WIDTH,
      setOpen: (convKey, open) => set((s) => ({ openByConversation: touchMap(s.openByConversation, convKey, open) })),
      setWidth: (width) => set({ width }),
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
      // primaryByConversation 刻意不持久化——重启后浏览器页签本就不在，布局
      // 回归对话优先与 openByConversation 的「重启无活面板」裁定一致。
      partialize: (s) => ({ width: s.width, activeTab: s.activeTab, treeWidth: s.treeWidth }) as WorkbenchState,
    },
  ),
)
