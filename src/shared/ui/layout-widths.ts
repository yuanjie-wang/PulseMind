// ── Draggable column widths: sidebar + workspace tree↔preview split ──
// Pure clamp math for the two column dividers that took a drag handle
// (2026-10-26: 侧边栏 / 目录树↔预览). The workbench pane's own width keeps
// its clamp in shared/browser/pane.ts — that one is load-bearing on the
// main-process dock and must not move here.
//
// Both drags persist their width (localStorage via zustand persist) and clamp
// EVERY consumption against the live container, not just at drag time — a
// value dragged under one window/pane size survives onto a smaller one (the
// workbench pane's clamp-every-consumption lesson, WorkbenchPane.tsx).

/** Left nav sidebar. */
export const SIDEBAR_DEFAULT_WIDTH = 280
export const SIDEBAR_MIN_WIDTH = 220
/** Drag ceiling: the chat column always keeps at least 55% of the window. */
export const SIDEBAR_MAX_WINDOW_RATIO = 0.45

export function clampSidebarWidth(desired: number, windowWidth: number): number {
  const max = Math.max(SIDEBAR_MIN_WIDTH, Math.floor(windowWidth * SIDEBAR_MAX_WINDOW_RATIO))
  return Math.min(Math.max(Math.round(desired), SIDEBAR_MIN_WIDTH), max)
}

/** 工作区 tab's tree column (left of the preview). */
export const TREE_MIN_WIDTH = 150
/** The preview column's floor. On a pane too narrow to satisfy both, the
 *  tree's own minimum wins and the preview flexes below this — it keeps
 *  `flex: 1; min-width: 0`, so a stale-wide tree squeezes it instead of
 *  overflowing (a PANE_MIN_WIDTH=320 pane: 150 tree + 170 preview). */
export const PREVIEW_MIN_WIDTH = 240

export function clampTreeWidth(desired: number, rowWidth: number): number {
  const width = Math.max(TREE_MIN_WIDTH, Math.round(desired))
  // Unmeasured row (first paint, before the ResizeObserver lands): floor
  // only — the render clamp corrects it the moment the observation fires.
  if (rowWidth <= 0) return width
  const max = Math.max(TREE_MIN_WIDTH, rowWidth - PREVIEW_MIN_WIDTH)
  return Math.min(width, max)
}

/** Both new dividers' hit-area width. The workbench pane's handle carries
 *  the same 6 as PANE_DRAG_HANDLE_WIDTH (shared/browser/pane.ts) — one
 *  gesture thickness across all three, three definitions because the
 *  browser-pane one lives in a file the main process also reads. */
export const COLUMN_DRAG_HANDLE_WIDTH = 6

// ── Project window (immersive) explorer ↔ chat divider ──
// The project window's left region is a whole WorkspacePane (tree + preview),
// so its floor is far above a single tree column's — it must fit both columns
// at their own minimums plus the divider. The chat column keeps the same 360
// floor the workbench pane reserve uses, so a project window that is dragged
// narrow degrades by squeezing the explorer, never the conversation.

/** Explorer region (tree | preview) default + floor. */
export const EXPLORER_DEFAULT_WIDTH = 760
export const EXPLORER_MIN_WIDTH = 480
/** The chat column's floor in the project window. */
export const PROJECT_CHAT_MIN_WIDTH = 360

export function clampExplorerWidth(desired: number, totalWidth: number): number {
  const width = Math.max(EXPLORER_MIN_WIDTH, Math.round(desired))
  // Unmeasured row (first paint, before the ResizeObserver lands): floor
  // only — the render clamp corrects it the moment the observation fires.
  if (totalWidth <= 0) return width
  const max = Math.max(EXPLORER_MIN_WIDTH, totalWidth - PROJECT_CHAT_MIN_WIDTH)
  return Math.min(width, max)
}

// ── 任务向导（步骤卡 ↔ 助手栏）分隔条 ──
// 两栏都是编辑器卡：左边是任务配置（步骤内容），右边是任务助手。宽度归
// 助手栏（它当初是 shell 的 basis），可拖动的上限由配置栏自己的最小宽度
// 让出来——窗口一变窄，先压助手栏，而不是把配置表单压成一条缝。

/** 助手栏默认宽度（与旧的 shell basis 460 一致：外观在可拖之前不变）。 */
export const WIZARD_ASSIST_DEFAULT_WIDTH = 460
/** 助手栏下限：再窄转录与内嵌输入区都摆不下。 */
export const WIZARD_ASSIST_MIN_WIDTH = 300
/** 配置栏下限：画布/表单至少需要的横向空间。 */
export const WIZARD_CONFIG_MIN_WIDTH = 360

/** 行宽口径与调用方一致：传入值已扣掉两栏之间的 gap（行内容宽 − gap）。 */
export function clampWizardAssistWidth(desired: number, availableWidth: number): number {
  const width = Math.max(WIZARD_ASSIST_MIN_WIDTH, Math.round(desired))
  // 未测到行宽（首帧，ResizeObserver 还没回来）：只落 floor，渲染侧的同一
  // 个 clamp 会在测量到达的那一帧修正。
  if (availableWidth <= 0) return width
  const max = Math.max(WIZARD_ASSIST_MIN_WIDTH, availableWidth - WIZARD_CONFIG_MIN_WIDTH)
  return Math.min(width, max)
}

/** 沉浸窗口卡片化（2026-10-31 用户裁定）：三列各自圆角矩形包裹，列与窗口
 *  边缘、列与列之间一律留 5px。ProjectExplorer 的四周 padding 与 explorer↔chat
 *  gap、WorkspacePane（immersive）的树↔预览 gap，以及两处宽度 clamp 对可用
 *  行宽的扣减都用这一个常量——间距改这里，几何处处跟随。 */
export const IMMERSIVE_CARD_GAP = 5

/** 卡片的圆角（2026-10-31 沉浸裁定「三列各用圆角矩形包裹」；2026-11-03 主窗
 *  对话区/工作台卡片化沿用同一个值）。ProjectExplorer / WorkspacePane / 主窗
 *  ChatView 对话卡与 WorkbenchPane 卡都从这里取——圆角改这里，处处跟随。 */
export const IMMERSIVE_CARD_RADIUS = 8
