// ── 引用块的横向内边距与列表悬挂缩进（HTML 侧）──
// Word 用 `w:pBdr/@w:space` 表达「边框到文字的距离」，docx-preview 0.4.0 把
// 这个属性整个丢掉（parseBorderProperties 只映射 style/color/size），普通段落
// 又没有 `w:tcMar`——于是同一个 docx 在 Word 里文字离竖线 8pt，在应用内预览和
// 导出的 PDF 里贴着竖线。补一份按段落样式 id 命中的 CSS，两条渲染路径才对得上。
//
// 只做横向：竖直方向的内边距与间隙是定高空段落（见 shared/preview/docx-quote.ts
// 的文件头），CSS 再掺一脚会与那些空段落叠成双倍间距。
//
// 列表项同理，但坑更深一层：docx 的段落边框/底纹画在段落盒子上，`w:ind` 一动
// 整块（含竖线与底纹）就跟着移——列表行比兄弟行多缩进一阶，引用块的左缘立刻
// 断成两截、中间露出白缺口（2026-11-04 视觉验收实测）。所以列表项的 OOXML
// 缩进与引用正文**完全相同**，阶差只落在盒子内部：这里用 padding 把文字推深
// 一阶，再用 text-indent 把编号/子弹拉回内边距起点，折行与首行文字对齐。

import { DOCX_QUOTE_LIST_HANG_PT, DOCX_QUOTE_LIST_STYLE, DOCX_QUOTE_PAD_X_PT, DOCX_QUOTE_STYLE } from '../../../../shared/preview/docx-quote'

/** `docxClass` = 交给 renderAsync 的 className；样式类名由 docx-preview 拼成
 *  `<className>_<styleId>`。 */
export function docxQuoteCss(docxClass: string): string {
  const quote = `.${docxClass}_${DOCX_QUOTE_STYLE}`
  const list = `.${docxClass}_${DOCX_QUOTE_LIST_STYLE}`
  const listPad = DOCX_QUOTE_PAD_X_PT + DOCX_QUOTE_LIST_HANG_PT
  return [
    `${quote} { padding-left: ${DOCX_QUOTE_PAD_X_PT}pt; padding-right: ${DOCX_QUOTE_PAD_X_PT}pt; }`,
    `${list} { padding-left: ${listPad}pt; padding-right: ${DOCX_QUOTE_PAD_X_PT}pt; text-indent: -${DOCX_QUOTE_LIST_HANG_PT}pt; }`,
    // 编号/子弹是 docx-preview 自己的 `::before`（content 里只有字形、不带后缀），
    // 给它一个定宽盒子：首行文字因此落在 pad + hang 上，与折行严格对齐。
    // 类名写两遍是**提权**用的——docx-preview 的 `p.<numClass>::before` 同特异性
    // 且写在我们的样式表之后，不叠加选择器就会被它的 display 盖掉。
    `${list}${list}::before { display: inline-block; min-width: ${DOCX_QUOTE_LIST_HANG_PT}pt; }`,
  ].join('\n')
}
