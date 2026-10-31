/**
 * fast-code.ts（2026-10-31）：代码高亮的字符串构建器。旧 per-token React
 * 管线每次挂载 ~4ms/KB 阻塞（probe-tree-click-jank 实测 280 行文件一帧
 * 300-500ms，快速连点每击一个）；本模块用同一个 refractor tokenize，产物是
 * HTML 字符串走 dangerouslySetInnerHTML——浏览器 HTML 解析器建 span，React
 * 不见 per-token 元素。钉子钉语义：转义、跨行 span 重开、reveal 属性、
 * 行号几何、尾行、缓存。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { highlightToHtml, codeShellStyles, resetFastCodeCache } from '../src/renderer/src/components/common/fast-code'

// 与 oneLight 同形的迷你主题：键 → 样式对象。
const THEME = {
  'pre[class*="language-"]': { color: 'hsl(230, 8%, 24%)', whiteSpace: 'pre', overflow: 'auto', borderRadius: '0.3em' },
  'code[class*="language-"]': { color: 'hsl(230, 8%, 24%)' },
  comment: { color: 'hsl(230, 4%, 64%)', fontStyle: 'italic' },
  keyword: { color: 'hsl(301, 63%, 40%)' },
  string: { color: 'hsl(119, 34%, 47%)' }
}

afterEach(() => resetFastCodeCache())

describe('highlightToHtml', () => {
  it('token span 携带主题内联样式，正文被转义', () => {
    const html = highlightToHtml('const a = "<b>&"</b>', 'javascript', THEME, {})
    expect(html).toContain('color:hsl(301, 63%, 40%);') // keyword
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&amp;')
  })

  it('跨行 token（块注释）在每行重开同款样式', () => {
    const html = highlightToHtml('/* one\n two */ const x', 'javascript', THEME, { lineNumbers: true })
    // 行间零分隔（pre-wrap 壳里行间的换行文本节点会渲染成空行盒——间距翻倍
    // 的回归钉）：行数用 block 行 span 计。
    const rows = html.split('<span style="display:block;padding-left:')
    expect(rows.length - 1).toBe(2)
    for (const row of rows.slice(1)) {
      expect(row).toContain('color:hsl(230, 4%, 64%);font-style:italic;')
    }
    expect(html).toContain('/* one')
    expect(html).toContain(' two */')
  })

  it('reveal：仅 reveal 态带 data-reveal-line，值是 String(n)，目标行带闪烁样式', () => {
    const code = 'a\nb\nc'
    const plain = highlightToHtml(code, null, THEME, { lineNumbers: true })
    expect(plain).not.toContain('data-reveal-line')
    const revealed = highlightToHtml(code, null, THEME, { lineNumbers: true, revealLine: 2 })
    expect(revealed).toContain('data-reveal-line="1"')
    expect(revealed).toContain('data-reveal-line="2"')
    expect(revealed).toContain('data-reveal-line="3"')
    // 目标行带 warn 底色；别的行不带（按行 span 切分，不按 \n）
    const row2 = revealed.split('<span data-reveal-line="2"')[1]?.split('<span data-reveal-line="3"')[0] ?? ''
    expect(row2).toContain('background:var(--pm-warn-bg)')
    const row1 = revealed.split('<span data-reveal-line="1"')[1]?.split('<span data-reveal-line="2"')[0] ?? ''
    expect(row1).not.toContain('background:var(--pm-warn-bg)')
  })

  it('行号几何：悬挂缩进与行号盒都用 <digits>.25em（库同款算术）', () => {
    const code10 = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')
    const html10 = highlightToHtml(code10, null, THEME, { lineNumbers: true })
    // 10 行 → 最大行号 '10' 两位 → 2 + 1.25
    expect(html10).toContain('padding-left:3.25em')
    expect(html10).toContain('min-width:3.25em')
    const code100 = Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n')
    const html100 = highlightToHtml(code100, null, THEME, { lineNumbers: true })
    expect(html100).toContain('padding-left:4.25em')
  })

  it('尾随换行不产出空末行', () => {
    const html = highlightToHtml('a\nb\n', null, THEME, { lineNumbers: true })
    expect(html.split('display:block;padding-left:').length - 1).toBe(2)
    expect(html).toContain('>b<')
  })

  it('无行号的聊天代码是纯 token 流（无每行 span），换行由 pre-wrap 承担', () => {
    const html = highlightToHtml('const a\nconst b', 'javascript', THEME, {})
    expect(html).not.toContain('display:block')
    expect(html).toContain('color:hsl(301, 63%, 40%);')
  })

  it('未注册语言回落转义纯文本（行结构照旧），不抛错', () => {
    const html = highlightToHtml('a < b\n"quote"', 'nope-not-a-lang', THEME, { lineNumbers: true })
    expect(html).toContain('&lt; b')
    expect(html.split('display:block;padding-left:').length - 1).toBe(2)
  })

  it('同输入命中缓存（同一字符串产物），缓存可复位', () => {
    const code = 'const x = 1'
    const first = highlightToHtml(code, 'javascript', THEME, {})
    const second = highlightToHtml(code, 'javascript', THEME, {})
    expect(first).toBe(second)
    resetFastCodeCache()
    const third = highlightToHtml(code, 'javascript', THEME, {})
    expect(third).toBe(first)
  })
})

describe('codeShellStyles', () => {
  it('pre 壳 = 主题基座 + 应用卡片面（背景被覆盖、ink/度量来自主题）', () => {
    const { pre, code } = codeShellStyles(THEME, 12, 'Menlo, Consolas, monospace')
    expect(pre.background).toBe('var(--pm-code-bg)')
    expect(pre.margin).toBe(0)
    expect(pre.padding).toBe(12)
    expect(pre.color).toBe('hsl(230, 8%, 24%)') // 主题 ink（应用卡面色不覆盖它）
    expect(pre.borderRadius).toBe('0.3em')
    expect(code).toEqual({ whiteSpace: 'pre-wrap', fontFamily: 'Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.6 })
  })
})
