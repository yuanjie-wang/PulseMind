// ── Editor layout primitives ──
// The design language shared by the app's "list · form · assistant" editors
// (the capability center's expert editor, the task wizard). Two shapes are in
// use, chosen by whether the assistant outlives the form:
//   · expert editor — assistant INSIDE EDITOR_SURFACE, as an accessory of the
//     form (the surface is one gray rounded card, the assistant a white card
//     within it);
//   · task wizard — assistant a PAGE-LEVEL PEER of the step card, because it
//     spans every wizard step (user 2026-11-08：「任务助手的UI要从编辑面板中
//     独立出来，因为它是可以贯穿整个编辑和配置流程的」). Both columns are
//     cards of the IMMERSIVE recipe — border only, no fill (user 2026-11-09：
//     「不想要浅灰色的背景了，就像沉浸模式那样的无底色圆角矩形包裹」), and
//     the gap between them carries a drag handle ( widths in
//     shared/ui/layout-widths).
// Kept as shared constants so the editors cannot drift.

import type React from 'react'
import { IMMERSIVE_CARD_RADIUS } from '../../../../shared/ui/layout-widths'

/** Column title row — a muted caption sitting above the column's body. */
export const EDITOR_COLUMN_HEADER: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--pm-text-muted)',
  padding: '0 0 8px 2px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
}

/** Width of an editor's list column (the switcher column, not a pane). */
export const EDITOR_LIST_WIDTH = 216

/** The gray surface the form and the assistant share (expert editor). */
export const EDITOR_SURFACE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'var(--pm-fill)',
  borderRadius: 12,
  padding: 12,
  display: 'flex',
  gap: 12,
  minHeight: 0,
}

/** The task wizard's step card: the IMMERSIVE card recipe (border only, no
 *  fill — user 2026-11-09「就像沉浸模式那样的无底色圆角矩形包裹」), same
 *  recipe as the immersive window's three columns. `overflow: hidden` clips
 *  the scrolling form body at the rounded corners; the divider handle between
 *  the two columns is a SIBLING, so this clip never eats it. */
export const EDITOR_CARD_SURFACE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  boxSizing: 'border-box',
  background: 'var(--pm-bg)',
  border: '1px solid var(--pm-separator-faint)',
  borderRadius: IMMERSIVE_CARD_RADIUS,
  overflow: 'hidden',
  padding: 12,
  display: 'flex',
  gap: 12,
  minHeight: 0,
}

/** The assistant column card (inside EDITOR_SURFACE in the expert editor, a
 *  page-level sibling of it in the task wizard). In the wizard it lives one
 *  level deeper, inside EDITOR_ASSIST_SHELL — the shell IS the card there
 *  (the immersive recipe), so this one drops its own ground and radius and
 *  only carries the column's geometry. */
export const EDITOR_CHAT_CARD: React.CSSProperties = {
  flex: '0 1 460px',
  minWidth: 300,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  background: 'var(--pm-card)',
  borderRadius: 10,
  padding: '6px 12px 12px',
}

/** 助手栏自己的卡片外壳（user 2026-11-09：「任务助手需要使用灰色圆角边框
 *  包裹，要有向右收缩和展开能力」；同日再裁定「不想要浅灰色的背景了，就像
 *  沉浸模式那样的无底色圆角矩形包裹」——灰底退场，与步骤卡同一份沉浸配方）。
 *  壳里不再套第二张卡：内容卡在 framed 形态下透明、无圆角（壳就是卡）。
 *  宽度归外壳（basis 460 / minWidth 300，向导会按拖拽结果覆盖 basis），
 *  折叠时换成 EDITOR_ASSIST_RAIL 那套几何。 */
export const EDITOR_ASSIST_SHELL: React.CSSProperties = {
  flex: '0 0 460px',
  minWidth: 300,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  minHeight: 0,
  background: 'var(--pm-bg)',
  border: '1px solid var(--pm-separator-faint)',
  borderRadius: IMMERSIVE_CARD_RADIUS,
  overflow: 'hidden',
  padding: 12,
  transition: 'flex-basis 160ms ease, min-width 160ms ease',
}

/** 收起态：整栏缩成右侧一条竖排窄条（展开钮 + 竖向标题）。宽度一档到
 *  底——44 刚好容下一个小尺寸图标钮。卡片配方与展开态同一份（它是同一栏的
 *  另一个形态，换底色会让收起/展开看起来像换了个控件）。 */
export const EDITOR_ASSIST_RAIL: React.CSSProperties = {
  flex: '0 0 44px',
  width: 44,
  minWidth: 44,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 8,
  minHeight: 0,
  background: 'var(--pm-bg)',
  border: '1px solid var(--pm-separator-faint)',
  borderRadius: IMMERSIVE_CARD_RADIUS,
  overflow: 'hidden',
  padding: '8px 0',
  transition: 'flex-basis 160ms ease, min-width 160ms ease',
}
