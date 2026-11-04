/**
 * fast-code.ts（2026-10-31）：代码高亮的字符串构建器。旧 per-token React
 * 管线每次挂载 ~4ms/KB 阻塞（probe-tree-click-jank 实测 280 行文件一帧
 * 300-500ms，快速连点每击一个）；本模块用同一个 refractor tokenize，产物是
 * HTML 字符串走 dangerouslySetInnerHTML——浏览器 HTML 解析器建 span，React
 * 不见 per-token 元素。
 *
 * 2026-11-01 PLAN-codemirror-view 瘦身：预览查看态迁入 CM 实例，行号/reveal
 * 机械（block 行 span、gutter、data-reveal-line）随预览路径退役——本模块只剩
 * numberless 纯 token 流（聊天 fence / 技能浏览器）。瘦身时抓出一个既有 bug：
 * numberless 侧把行用 '' 接起来，换行被吞、聊天 fence 渲染成一坨折行（block
 * 行模式自带断行的理由从未适用于这条路）；现在 join('\n') 交还 pre-wrap 壳。
 * 钉子钉语义：转义、跨行 span 重开、换行保真、尾行、缓存。
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
    const html = highlightToHtml('const a = "<b>&"</b>', 'javascript', THEME)
    expect(html).toContain('color:hsl(301, 63%, 40%);') // keyword
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&amp;')
  })

  it('跨行 token（块注释）在每行重开同款样式', () => {
    const html = highlightToHtml('/* one\n two */ const x', 'javascript', THEME)
    const rows = html.split('\n')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row).toContain('color:hsl(230, 4%, 64%);font-style:italic;')
    }
    expect(html).toContain('/* one')
    expect(html).toContain(' two */')
  })

  it('numberless 换行保真：行间是字面 \\n（pre-wrap 壳断行），曾被 join("") 吞掉', () => {
    const html = highlightToHtml('const a\nconst b', 'javascript', THEME)
    expect(html.split('\n')).toHaveLength(2)
    expect(html).toContain('const</span> a\n<span')
  })

  it('纯 token 流：无每行 block span、无行号、无 reveal 属性（机械已退役）', () => {
    const html = highlightToHtml('const a\nconst b', 'javascript', THEME)
    expect(html).not.toContain('display:block')
    expect(html).not.toContain('pm-code-linenumber')
    expect(html).not.toContain('data-reveal-line')
    expect(html).toContain('color:hsl(301, 63%, 40%);')
  })

  it('尾随换行不产出空末行', () => {
    const html = highlightToHtml('a\nb\n', null, THEME)
    expect(html.split('\n')).toHaveLength(2)
    expect(html.endsWith('b')).toBe(true)
  })

  it('未注册语言回落转义纯文本（换行结构照旧），不抛错', () => {
    const html = highlightToHtml('a < b\n"quote"', 'nope-not-a-lang', THEME)
    expect(html).toContain('&lt; b')
    expect(html.split('\n')).toHaveLength(2)
  })

  it('同输入命中缓存（同一字符串产物），缓存可复位', () => {
    const code = 'const x = 1'
    const first = highlightToHtml(code, 'javascript', THEME)
    const second = highlightToHtml(code, 'javascript', THEME)
    expect(first).toBe(second)
    resetFastCodeCache()
    const third = highlightToHtml(code, 'javascript', THEME)
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
