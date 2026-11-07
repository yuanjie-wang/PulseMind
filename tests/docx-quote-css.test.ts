// 引用块的 HTML 侧几何（PLAN-docx-native-styles 2026-11-04 视觉验收后的一刀）。
// docx-preview 0.4.0 把 `w:pBdr/@w:space` 整个丢掉，横向内边距只能由 CSS 补；
// 列表项的阶差也不能走 `w:ind`（段落边框/底纹画在缩进后的盒子上，一缩整块右移，
// 引用块左缘会断）——所以这里是「同盒内位移」那一半。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { docxQuoteCss } from '../src/renderer/src/components/preview/docx-quote-css'
import { DOCX_QUOTE_LIST_HANG_PT, DOCX_QUOTE_LIST_STYLE, DOCX_QUOTE_PAD_X_PT, DOCX_QUOTE_STYLE } from '../src/shared/preview/docx-quote'

const css = docxQuoteCss('docx')

describe('docxQuoteCss', () => {
  it('引用正文只补横向内边距（竖直方向是定高空段落，CSS 再给会叠成双倍）', () => {
    expect(css).toContain(`.docx_${DOCX_QUOTE_STYLE} { padding-left: ${DOCX_QUOTE_PAD_X_PT}pt; padding-right: ${DOCX_QUOTE_PAD_X_PT}pt; }`)
    // 只声明横向：竖直 padding 一旦出现，就与 md-to-docx 的定高间隔段落相加
    const rule = css.split('\n').find((line) => line.startsWith(`.docx_${DOCX_QUOTE_STYLE} `))
    expect(rule).not.toContain('padding-top')
    expect(rule).not.toContain('padding-bottom')
  })

  it('列表项在盒子内部位移一步：padding = 内边距 + 悬挂量，text-indent 拉回标记', () => {
    const listPad = DOCX_QUOTE_PAD_X_PT + DOCX_QUOTE_LIST_HANG_PT
    expect(css).toContain(
      `.docx_${DOCX_QUOTE_LIST_STYLE} { padding-left: ${listPad}pt; padding-right: ${DOCX_QUOTE_PAD_X_PT}pt; text-indent: -${DOCX_QUOTE_LIST_HANG_PT}pt; }`,
    )
  })

  it('标记的 ::before 拿到定宽盒子（docx-preview 不写后缀，靠它撑出 标记↔文字 的间距）', () => {
    // 类名写两遍是提权：docx-preview 的 `p.<numClass>::before` 同特异性且更靠后
    const before = css.split('\n').find((line) => line.includes('::before'))
    expect(before).toContain(`.docx_${DOCX_QUOTE_LIST_STYLE}.docx_${DOCX_QUOTE_LIST_STYLE}::before`)
    expect(before).toContain('display: inline-block')
    expect(before).toContain(`min-width: ${DOCX_QUOTE_LIST_HANG_PT}pt`)
  })
})

describe('docxQuoteCss wiring', () => {
  const read = (p: string) => readFileSync(p, 'utf8')

  it('两条渲染路径（PDF 转换页 / 应用内预览）都从同一个模块取样式', () => {
    const page = read('src/renderer/docx2pdf/index.ts')
    expect(page).toContain("from '../src/components/preview/docx-quote-css'")
    expect(page).toContain('docxQuoteCss(DOCX_CLASS)')
    // 必须在 renderAsync 之前插入：分页测量要量到带内边距的盒子
    expect(page.indexOf('docxQuoteCss(DOCX_CLASS)')).toBeLessThan(page.indexOf('await renderAsync('))
    const preview = read('src/renderer/src/components/preview/DocxPreview.tsx')
    expect(preview).toContain("from './docx-quote-css'")
    expect(preview).toContain('<style>{docxQuoteCss(DOCX_CLASS)}</style>')
  })

  it('样式 id 与内边距的唯一真源是 shared/preview/docx-quote（OOXML 侧同源）', () => {
    const generator = read('src/main/office-export/md-to-docx.ts')
    // md-to-docx 不得手写 id：Word 与 HTML 两侧靠同一组常量对齐
    expect(generator).toContain("from '../../shared/preview/docx-quote'")
    const imported = generator.slice(generator.indexOf('shared/preview/docx-quote') - 300, generator.indexOf('shared/preview/docx-quote'))
    for (const name of ['DOCX_QUOTE_STYLE', 'DOCX_QUOTE_LIST_STYLE', 'DOCX_QUOTE_PAD_X_PT']) {
      expect(imported).toContain(name)
    }
    // 列表项的 OOXML 盒子必须与引用正文同缩进：多一阶 `hanging` 就把边框撕成两截
    const listBox = generator.slice(generator.indexOf('function quoteListBox'))
    expect(listBox.slice(0, listBox.indexOf('}'))).not.toContain('hanging')
  })
})
