// ── 引用块的几何（md → docx → 预览/PDF 的共用常量）──
// 引用块的观感由两套渲染器分担，而它们读的**不是同一个东西**：
//   · Word 读 OOXML：竖边框 + 底纹 + `w:pBdr/@w:space`（边框到文字的距离）
//     + 段落自身的缩进；
//   · docx-preview（应用内预览与 PDF 转换页都是它）只把 `w:pBdr` 映射成
//     CSS border，**整个丢弃 `w:space`**（0.4.0 的 parseBorderProperties），
//     padding 的唯一来源是表格单元格的 `w:tcMar`——普通段落没有内边距。
// 所以横向内边距必须在 HTML 侧另外补一份 CSS（docxQuoteCss），两边的数值
// 只能有一处真源，否则预览/PDF 与 Word 会慢慢漂开——就是这个文件。
//
// 竖直方向刻意不用 CSS padding：段落底纹不覆盖 spacing，靠 spacing 撑出的
// 间隙在两条引擎里都会把色带切成白条。上下内边距与段间间隙一律用**精确定高
// 的空段落**（空段落也带着同一套底纹/边框），两条引擎对「精确行高的空段落」
// 渲染一致，色带因此是连续的一整块。

/** 引用段落挂的段落样式 id（docx-preview 落成 `.<docxClass>_PulseMindQuote`）。
 *  样式本身不声明任何属性——它的唯一职责是给 HTML 侧一个选择器锚点。 */
export const DOCX_QUOTE_STYLE = 'PulseMindQuote'

/** 引用块里列表项挂的样式 id——同一条 CSS 锚点的第二份。
 *  列表项**必须与引用正文共用同一个 `w:ind/@w:left`**：docx 的段落边框/底纹
 *  画在段落盒子（margin 之后）上，而 `w:ind` 会整体移动这个盒子——列表行只要
 *  比兄弟行多缩进一阶，它的竖线与底纹就会整块右移，引用块的左缘断成两截、
 *  露出白缺口。所以悬挂缩进只能落在盒子**内部**：Word 侧靠制表位，HTML 侧靠
 *  padding + text-indent（见 docxQuoteCss）。 */
export const DOCX_QUOTE_LIST_STYLE = 'PulseMindQuoteList'

/** 引用块内列表项的悬挂缩进（pt）：编号/子弹落在引用正文的左内边距里，
 *  文字与折行落在 pad + hang 上。 */
export const DOCX_QUOTE_LIST_HANG_PT = 12

/** 左右内边距（pt）。Word 侧写成 `w:space`，HTML 侧写成 CSS padding。 */
export const DOCX_QUOTE_PAD_X_PT = 8

/** 上下内边距（pt）：引用块首段之上、末段之下的色带高度。 */
export const DOCX_QUOTE_PAD_Y_PT = 6

/** 引用块内相邻子块之间的间隙（pt）——同样取自色带，不切白条。 */
export const DOCX_QUOTE_GAP_PT = 4
