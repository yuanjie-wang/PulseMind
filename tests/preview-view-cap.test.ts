/**
 * 预览视口帽（2026-10-30，用户报「浏览较大的文件明显卡顿」）：
 *
 * 预览的读路径此前零上限——svcReadFile 的 256MB 闸只管二进制读，
 * MAX_EDITABLE_BYTES 只挡编辑不挡浏览；几 MB 的文本被完整读入、完整 IPC、
 * 完整交给 react-syntax-highlighter 全文 token 化，渲染层秒级冻结。
 * 两道帽各管一个成本：MAX_PREVIEW_CHARS 管 DOM/内存（截断 + 诚实提示），
 * HIGHLIGHT_MAX_CHARS 管 token 化（超限走纯 <pre>，tokenizer 才是秒级成本）。
 * 帽以 UTF-16 code unit 计（string.length）：每字符 ≥1 字节，截断后的文本
 * 必然超过 MAX_EDITABLE_BYTES，编辑闸自己就会拒绝它。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { capPreviewText, shouldSkipHighlight, previewLimitLabel, MAX_PREVIEW_CHARS, HIGHLIGHT_MAX_CHARS } from '../src/shared/preview/view-cap'

const root = join(__dirname, '..')
const src = (p: string): string => readFileSync(join(root, p), 'utf8')

const CONTENT = 'src/renderer/src/components/preview/PreviewContent.tsx'
const TEXT_PREVIEW = 'src/renderer/src/components/preview/TextPreview.tsx'
const ZH = 'src/renderer/src/i18n/locales/zh.ts'
const EN = 'src/renderer/src/i18n/locales/en.ts'

describe('capPreviewText（纯函数）', () => {
  it('帽内原样返回，不截断', () => {
    expect(capPreviewText('hello')).toEqual({ text: 'hello', truncated: false })
    // 恰在帽上 = 帽内。
    expect(capPreviewText('x'.repeat(MAX_PREVIEW_CHARS))).toEqual({ text: 'x'.repeat(MAX_PREVIEW_CHARS), truncated: false })
  })

  it('超帽截断：保头去尾 + truncated 标记', () => {
    const big = 'a'.repeat(MAX_PREVIEW_CHARS) + 'TAIL'
    const capped = capPreviewText(big)
    expect(capped.truncated).toBe(true)
    expect(capped.text.length).toBe(MAX_PREVIEW_CHARS)
    expect(capped.text.endsWith('TAIL')).toBe(false)
    expect(capped.text.startsWith('a')).toBe(true)
  })
})

describe('shouldSkipHighlight（纯函数）', () => {
  it('帽内高亮、帽上跳过', () => {
    expect(shouldSkipHighlight('x'.repeat(HIGHLIGHT_MAX_CHARS))).toBe(false)
    expect(shouldSkipHighlight('x'.repeat(HIGHLIGHT_MAX_CHARS + 1))).toBe(true)
  })
})

describe('previewLimitLabel', () => {
  it('从常量派生，提示与帽不漂移', () => {
    expect(previewLimitLabel()).toBe('2M')
  })
})

describe('PreviewContent 接线：读入即截断 + 粘性提示', () => {
  const code = src(CONTENT)

  it('usePreviewFile 读后过帽，ready 态携带 truncated', () => {
    expect(code).toContain('import { capPreviewText, previewLimitLabel }')
    expect(code).toContain('const capped = capPreviewText(text)')
    expect(code).toContain("{ status: 'ready', text: capped.text, truncated: capped.truncated }")
    expect(code).toContain('{ status: ' + "'ready'; text: string; truncated: boolean }")
  })

  it('markdown/text/csv 三条视图路包 TruncationNotice；html 的 iframe 内容不经此路', () => {
    expect(code).toContain('<TruncationNotice show={state.truncated}><MarkdownPreview')
    expect(code).toContain('<TruncationNotice show={state.truncated}><TextPreview')
    expect(code).toContain('<TruncationNotice show={state.truncated}><CsvPreview')
    expect(code).toContain("if (kind === 'html') return <HtmlPreview path={path} reloadTick={reloadTick} />")
  })

  it('提示是粘性横幅，标签从 previewLimitLabel 派生', () => {
    expect(code).toContain("position: 'sticky'")
    expect(code).toContain('data-pm-preview-truncated')
    expect(code).toContain("t('previewPane.viewTruncated', { limit: previewLimitLabel() })")
  })

  it('i18n key 双语在位，带 {{limit}} 插值', () => {
    expect(src(ZH)).toContain("viewTruncated: '文件过大，仅显示前 {{limit}}")
    expect(src(EN)).toContain('viewTruncated: ')
  })
})

describe('TextPreview 接线：超限跳过 token 化', () => {
  const code = src(TEXT_PREVIEW)

  it('shouldSkipHighlight 命中走 PlainCode（与未知扩展名同路）', () => {
    expect(code).toContain("import { shouldSkipHighlight } from '../../../../shared/preview/view-cap'")
    expect(code).toContain('if (!lang || shouldSkipHighlight(text)) return <PlainCode code={text} />')
    expect(code).toContain('return <CodeHighlight code={text} lang={lang} lineNumbers revealLine={revealLine} />')
  })
})
