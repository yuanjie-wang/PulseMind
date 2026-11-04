/**
 * 预览视口帽（2026-10-30，用户报「浏览较大的文件明显卡顿」）：
 *
 * 预览的读路径此前零上限——svcReadFile 的 256MB 闸只管二进制读，
 * MAX_EDITABLE_BYTES 只挡编辑不挡浏览；几 MB 的文本被完整读入、完整 IPC、
 * 完整交给高亮器全文 token 化，渲染层秒级冻结。MAX_PREVIEW_CHARS 管
 * DOM/内存（截断 + 诚实提示）。帽以 UTF-16 code unit 计（string.length）：
 * 每字符 ≥1 字节，截断后的文本必然超过 MAX_EDITABLE_BYTES，编辑闸自己就会
 * 拒绝它。
 *
 * （第二道帽 HIGHLIGHT_MAX_CHARS / shouldSkipHighlight 已随预览查看态迁入
 * CM 实例而退役——2026-11-01 PLAN-codemirror-view；CM 视口只渲染可见行，
 * 帽失去了存在理由。）
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { capPreviewText, previewLimitLabel, MAX_PREVIEW_CHARS } from '../src/shared/preview/view-cap'

const root = join(__dirname, '..')
const src = (p: string): string => readFileSync(join(root, p), 'utf8')

const CONTENT = 'src/renderer/src/components/preview/PreviewContent.tsx'
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

  it('markdown/csv 视图路包 TruncationNotice；html 的 iframe 内容不经此路', () => {
    expect(code).toContain('<TruncationNotice show={state.truncated}><MarkdownPreview')
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

describe('text 视图接线：统一 CM 实例（PLAN-codemirror-view）', () => {
  const code = src(CONTENT)

  it('text 查看走 FileEditor 只读、编辑走同一实例（一个组件两个模式）', () => {
    expect(code).toContain('readOnly={!editMode}')
    expect(code).toContain('onChange={editMode ? updateDraft : undefined}')
    expect(code).toContain('value={editMode ? draft?.content ?? state.text : state.text}')
  })

  it('截断提示只对 view 态生效（编辑态文本 ≤ MAX_EDITABLE_BYTES，远小于 2M 帽）', () => {
    // show 折叠进布尔而不是条件 return：两态的树形必须同形（TruncationNotice
    // 常在），否则 view↔edit 翻转会因根位置元素类型变化整树重挂（探针实测
    // same-node=false 的教训）。
    expect(code).toContain('<TruncationNotice show={!editMode && state.truncated}>{body}</TruncationNotice>')
  })
})
