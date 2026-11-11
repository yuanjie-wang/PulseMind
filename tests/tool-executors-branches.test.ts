import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ToolExecutor } from '../src/renderer/src/agent/tool-executors'
import { execStageFinishTool } from '../src/renderer/src/agent/executors/stage-finish-tool'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'
import { MAX_READ_RESULT_TOKENS, READ_DEFAULT_LINE_LIMIT, READ_MAX_LINE_LIMIT } from '../src/renderer/src/agent/engine/engine-constants'
import { buildCommandFromSkillInput } from '../src/renderer/src/agent/command-builder'

/**
 * ToolExecutor 的分支补齐（AGENTS.md「单测纪律」2026-10-05）：直接实例化
 * ToolExecutor（构造参数即全部依赖，host 从 setHost 注入假实现），覆盖既有
 * 测试走不到的面 —— execWorkspaceTool 的 write/edit/office_edit 家族、
 * execReadOnlyTools 的 read 三通道（markitdown / 旧格式拒绝 / shell）、
 * execPickSkill 的白名单与 intent 选择矩阵、execBrowser/execWebFetch/
 * execMCPTool 的成败信封、createSubPlan 双门。
 */

function t(id: string, name: string, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input, status: 'pending', ...extra } as unknown as ToolUseBlock
}

function makeHarness(over: { opts?: Record<string, unknown> } = {}) {
  const results: Array<{ id: string, content: string, isError: boolean, maxTokens?: number, image?: string }> = []
  const host = {
    execCommandSync: vi.fn(async () => ({ code: 0, output: 'out' })),
    // Full stat shape (mtime + isDirectory included): the read-before-write
    // gate compares this signature against the ledger, and its isDirectory
    // guard decides whether an overwrite write is gated at all.
    getFileStat: vi.fn(async () => ({ size: 500, mtime: '2026-10-27T00:00:00.000Z', isDirectory: false })),
    convertFileToMarkdown: vi.fn(async () => null),
    writeFile: vi.fn(async () => ({ success: true })),
    patchFile: vi.fn(async () => ({ success: true, replacements: 1 })),
    editFile: vi.fn(async () => ({ success: true, replacements: 2 })),
    editDocx: vi.fn(async () => ({ success: true, results: [{ index: 0, op: 'replace_text', ok: true, detail: 'ok' }], outline: [], tables: [] })),
    editPptx: vi.fn(async () => ({ success: true, results: [], outline: [], tables: [] })),
    editXlsx: vi.fn(async () => ({ success: true, results: [], outline: [], tables: [] })),
    inspectOffice: vi.fn(async () => ({ success: true, summary: 'inspected' })),
    readOffice: vi.fn(async () => ({ success: true, summary: 'read it' })),
    gitInvoke: vi.fn(async () => ({ ok: true, data: { isRepo: false } })),
    mcpCallTool: vi.fn(async () => ({ success: true, result: 'pong' })),
    installSkill: vi.fn(async () => null),
    browserRunCode: vi.fn(async () => ({ result: 'clicked', console: [] as string[], images: [] as Array<{ base64: string }> })),
    apiFetch: vi.fn(async () => 'body text'),
  }
  setHost(host as unknown as PulseHost)
  const executor = new ToolExecutor(
    {
      apiKey: 'k', baseURL: 'https://x', model: 'm', maxTokens: 10,
      adapter: {} as never, conversationId: 'c1',
      skillManager: { getSkill: () => undefined, getEnabledSkills: () => [] },
      ...over.opts,
    } as never,
    new Map([['mcp_free', 'srv_free']]),
    {} as never,
    { execute: vi.fn(async () => 'office') } as never,
    (id: string, content: string, isError: boolean, image?: string, maxTokens?: number) => {
      results.push({ id, content, isError, maxTokens, image })
    },
    () => {},
  )
  return { executor, host, results }
}

beforeEach(() => {
  vi.clearAllMocks()
})

/** Seed the read-before-write ledger for one resolved path so a write/edit
 *  case exercises its own branch mechanics without driving a real read first
 *  (signature must match the harness getFileStat above). */
function prime(executor: ToolExecutor, path: string): void {
  executor.readFilePaths.set(path, { mtime: '2026-10-27T00:00:00.000Z', size: 500 })
}

describe('execWorkspaceTool — write / edit', () => {
  it('write 成功：utf8 字节数 + append 分支 + 相对路径按 workspaceDir 解析', async () => {
    const { executor, host, results } = makeHarness({ opts: { workspaceDir: '/ws' } })
    prime(executor, '/ws/a.txt')
    await executor.execWorkspaceTool(t('t1', 'write', { file_path: 'a.txt', content: '中文' }))
    expect(host.writeFile).toHaveBeenCalledWith({ filePath: '/ws/a.txt', content: '中文', append: false })
    expect(results[0]).toMatchObject({ isError: false })
    expect(results[0].content).toContain(`Written ${new TextEncoder().encode('中文').length} bytes to /ws/a.txt`)
    expect(results[0].content).not.toContain('(appended)')

    await executor.execWorkspaceTool(t('t2', 'write', { file_path: 'a.txt', content: 'x', append: true }))
    expect(results[1].content).toContain('(appended)')
    expect(host.writeFile).toHaveBeenLastCalledWith({ filePath: '/ws/a.txt', content: 'x', append: true })
  })

  it('write：绝对路径原样、Windows 分隔符分支、缺 file_path 拒绝、写盘失败信封', async () => {
    let h = makeHarness({ opts: { workspaceDir: '/ws' } })
    prime(h.executor, '/abs/a.txt')
    await h.executor.execWorkspaceTool(t('t1', 'write', { file_path: '/abs/a.txt', content: 'x' }))
    expect(h.host.writeFile).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: '/abs/a.txt' }),)

    h = makeHarness({ opts: { workspaceDir: 'C:\\ws' } })
    prime(h.executor, 'C:\\ws\\a.txt')
    await h.executor.execWorkspaceTool(t('t2', 'write', { file_path: 'a.txt', content: 'x' }))
    expect(h.host.writeFile).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: 'C:\\ws\\a.txt' }),)

    h = makeHarness()
    await h.executor.execWorkspaceTool(t('t3', 'write', { content: 'x' }))
    expect(h.results[0]).toMatchObject({ isError: true, content: 'Error: file_path is required' })

    h = makeHarness()
    prime(h.executor, '/a')
    ;(h.host.writeFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'disk full' })
    await h.executor.execWorkspaceTool(t('t4', 'write', { file_path: '/a', content: 'x' }))
    expect(h.results[0]).toMatchObject({ isError: true, content: 'Error: disk full' })
  })

  it('edit：diff 走 patchFile，old_str 走 editFile，缺参拒绝', async () => {
    let h = makeHarness()
    prime(h.executor, '/a')
    await h.executor.execWorkspaceTool(t('t1', 'edit', { file_path: '/a', diff: '--- x' }))
    expect(h.host.patchFile).toHaveBeenCalledWith({ filePath: '/a', diff: '--- x' })
    expect(h.results[0].content).toContain('Applied 1 hunk(s)')

    ;(h.host.patchFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'no match' })
    await h.executor.execWorkspaceTool(t('t2', 'edit', { file_path: '/a', diff: '--- x' }))
    expect(h.results[1]).toMatchObject({ isError: true, content: 'Error: no match' })

    h = makeHarness()
    prime(h.executor, '/a')
    await h.executor.execWorkspaceTool(t('t3', 'edit', { file_path: '/a', old_str: 'a', new_str: 'b', multi: true }))
    expect(h.host.editFile).toHaveBeenCalledWith({ filePath: '/a', oldStr: 'a', newStr: 'b', multi: true })
    expect(h.results[0].content).toContain('Replaced 2 occurrence(s)')

    await h.executor.execWorkspaceTool(t('t4', 'edit', { file_path: '/a' }))
    expect(h.results[1]).toMatchObject({ isError: true, content: expect.stringContaining('old_str is required') })
  })
})

describe('execWorkspaceTool — office_edit 路由与算子校验', () => {
  it('扩展名选服务：docx/pptx/xlsx 各达各家；未知扩展名拒绝', async () => {
    let h = makeHarness()
    await h.executor.execWorkspaceTool(t('t1', 'office_edit', { file_path: '/a.docx', ops: [{ op: 'replace_text' }] }))
    expect(h.host.editDocx).toHaveBeenCalled()
    expect(h.results[0].isError).toBe(false)

    h = makeHarness()
    await h.executor.execWorkspaceTool(t('t2', 'office_edit', { file_path: '/a.pptx', ops: [{ op: 'set_shape_text' }] }))
    expect(h.host.editPptx).toHaveBeenCalled()

    h = makeHarness()
    await h.executor.execWorkspaceTool(t('t3', 'office_edit', { file_path: '/a.xlsx', ops: [{ op: 'set_cell' }] }))
    expect(h.host.editXlsx).toHaveBeenCalled()

    h = makeHarness()
    await h.executor.execWorkspaceTool(t('t4', 'office_edit', { file_path: '/a.odt', ops: [{ op: 'x' }] }))
    expect(h.results[0]).toMatchObject({ isError: true, content: expect.stringContaining('支持 .docx / .xlsx / .pptx') })
  })

  it('服务调用前的三道校验：空 ops / 读取算子迁移提示 / 未知 op 清单', async () => {
    let h = makeHarness()
    await h.executor.execWorkspaceTool(t('t1', 'office_edit', { file_path: '/a.docx', ops: [] }))
    expect(h.results[0]).toMatchObject({ isError: true, content: expect.stringContaining('ops is required') })
    expect(h.host.editDocx).not.toHaveBeenCalled()

    h = makeHarness()
    await h.executor.execWorkspaceTool(t('t2', 'office_edit', { file_path: '/a.docx', ops: [{ op: 'outline' }] }))
    expect(h.results[0].content).toContain('已由 office_read 承担')

    h = makeHarness()
    await h.executor.execWorkspaceTool(t('t3', 'office_edit', { file_path: '/a.xlsx', ops: [{ op: 'nonsense' }] }))
    expect(h.results[0].content).toContain('未知 op「nonsense」')
    expect(h.results[0].content).toContain('set_cell')
    expect(h.host.editXlsx).not.toHaveBeenCalled()
  })

  it('docx 成功信封富化：备份/变更摘要/表格/大纲/diff 预览', async () => {
    const { executor, host, results } = makeHarness()
    const long = Array.from({ length: 90 }, (_, i) => `l${i}`).join('\n')
    ;(host.editDocx as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      results: [{ index: 0, op: 'replace_text', ok: true, detail: 'replaced ok' }],
      backup: '/tmp/bak.docx',
      changeSummary: '1 段改写',
      tables: [{ index: 1, rows: 2, cols: 3 }],
      outline: [{ index: 0, style: 'H1', text: '标题' }],
      diff: long,
    })
    await executor.execWorkspaceTool(t('t1', 'office_edit', { file_path: '/a.docx', ops: [{ op: 'replace_text' }] }))
    const c = results[0].content
    expect(c).toContain('Edited /a.docx: replaced ok')
    expect(c).toContain('(备份: /tmp/bak.docx)')
    expect(c).toContain('变更摘要:')
    expect(c).toContain('表 1：2 行 × 3 列')
    expect(c).toContain('[0] H1: 标题')
    expect(c).toContain('变更预览:')
  })

  it('xlsx / pptx 大纲分支与失败信封', async () => {
    let h = makeHarness()
    ;(h.host.editXlsx as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true, results: [], outline: [{ sheet: 'S1', usedRange: 'A1:B2' }],
    })
    await h.executor.execWorkspaceTool(t('t1', 'office_edit', { file_path: '/a.xlsx', ops: [{ op: 'set_cell' }] }))
    expect(h.results[0].content).toContain('S1: A1:B2')

    h = makeHarness()
    ;(h.host.editPptx as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true, results: [], outline: [{ slide: 2, shapes: [{ shapeId: 5, phType: 'title', text: 'hello' }] }],
    })
    await h.executor.execWorkspaceTool(t('t2', 'office_edit', { file_path: '/a.pptx', ops: [{ op: 'set_shape_text' }] }))
    expect(h.results[0].content).toContain('slide 2: [5](title) hello')

    h = makeHarness()
    ;(h.host.editDocx as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'corrupt' })
    await h.executor.execWorkspaceTool(t('t3', 'office_edit', { file_path: '/a.docx', ops: [{ op: 'replace_text' }] }))
    expect(h.results[0]).toMatchObject({ isError: true, content: 'Error: corrupt' })
  })
})

describe('execWorkspaceTool — office_inspect / office_read', () => {
  it('inspect 成败两态', async () => {
    let h = makeHarness()
    await h.executor.execWorkspaceTool(t('t1', 'office_inspect', { file_path: '/a.docx' }))
    expect(h.host.inspectOffice).toHaveBeenCalledWith({ filePath: '/a.docx' })
    expect(h.results[0].isError).toBe(false)
    expect(h.results[0].content).toContain('inspected')
    expect(h.results[0].content).toContain('下一步') // formatInspectResult 的 next-step 信封

    h = makeHarness()
    ;(h.host.inspectOffice as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'nope' })
    await h.executor.execWorkspaceTool(t('t2', 'office_inspect', { file_path: '/a.docx' }))
    expect(h.results[0]).toMatchObject({ isError: true, content: 'Error: nope' })
  })

  it('read 的入参映射直达 host，成败两态', async () => {
    let h = makeHarness()
    await h.executor.execWorkspaceTool(t('t1', 'office_read', {
      file_path: '/a.xlsx', offset: 2, limit: 50, tables: true, sheet: 'S1', range: 'A1:B2',
    }))
    expect(h.host.readOffice).toHaveBeenCalledWith({
      filePath: '/a.xlsx', offset: 2, limit: 50, tables: true, sheet: 'S1', range: 'A1:B2', slide: undefined, outline: false,
    })
    expect(h.results[0].maxTokens).toBe(MAX_READ_RESULT_TOKENS)

    h = makeHarness()
    ;(h.host.readOffice as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, summary: 'gone' })
    await h.executor.execWorkspaceTool(t('t2', 'office_read', { file_path: '/a.xlsx' }))
    expect(h.results[0]).toMatchObject({ isError: true, content: 'Error: gone' })
  })
})

describe('execReadOnlyTools — read 的三个通道', () => {
  it('可转换格式走 markitdown：分页 + 缓存注记 + read 专用预算', async () => {
    const h = makeHarness()
    ;(h.host.convertFileToMarkdown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ content: 'a\nb\nc', cachePath: '/tmp/x.md', hit: true })
    await h.executor.execReadOnlyTools([t('t1', 'read', { file_path: '/a.docx' })])
    expect(h.results[0].maxTokens).toBe(MAX_READ_RESULT_TOKENS)
    expect(h.results[0].content).toContain('(3 lines)')
    expect(h.results[0].content).toContain('Full conversion saved at: /tmp/x.md (cached)')

    // 无缓存路径的注记 + offset/limit 分页
    ;(h.host.convertFileToMarkdown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ content: 'a\nb\nc' })
    await h.executor.execReadOnlyTools([t('t2', 'read', { file_path: '/a.epub', offset: 2, limit: 1 })])
    expect(h.results[1].content).toContain('Range: lines 2-2')
    expect(h.results[1].content).toContain('Content converted from original file to markdown.')
  })

  it('size 三档格式化 + stat 失败显示 ?', async () => {
    const h = makeHarness()
    ;(h.host.getFileStat as ReturnType<typeof vi.fn>).mockResolvedValue({ size: 500 })
    await h.executor.execReadOnlyTools([t('t1', 'read', { file_path: '/a.txt' })])
    expect(h.results[0].content).toContain('Size: 500 B')

    ;(h.host.getFileStat as ReturnType<typeof vi.fn>).mockResolvedValue({ size: 2048 })
    await h.executor.execReadOnlyTools([t('t2', 'read', { file_path: '/a.txt' })])
    expect(h.results[1].content).toContain('2.0 KB')

    ;(h.host.getFileStat as ReturnType<typeof vi.fn>).mockResolvedValue({ size: 3_000_000 })
    await h.executor.execReadOnlyTools([t('t3', 'read', { file_path: '/a.txt' })])
    expect(h.results[2].content).toMatch(/Size: 2\.9 MB/)

    ;(h.host.getFileStat as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    await h.executor.execReadOnlyTools([t('t4', 'read', { file_path: '/a.txt' })])
    expect(h.results[3].content).toContain('Size: ?')
  })

  it('.doc / .ppt 旧格式拒绝并给迁移指引，不走 cat', async () => {
    const h = makeHarness()
    await h.executor.execReadOnlyTools([t('t1', 'read', { file_path: '/a.doc' }), t('t2', 'read', { file_path: '/a.ppt' })])
    expect(h.host.execCommandSync).not.toHaveBeenCalled()
    expect(h.results[0].content).toContain('旧版 Word 格式')
    expect(h.results[1].content).toContain('PowerPoint')
    expect(h.results[0].maxTokens).toBe(MAX_READ_RESULT_TOKENS)
  })

  it('shell 通道：wc -l 行数进元数据；错误三态（有输出不算错 / 空输出报失败 / 抛异常）', async () => {
    let h = makeHarness()
    ;(h.host.execCommandSync as ReturnType<typeof vi.fn>)
      // Faithful page: a 42-line file delivers 42 lines. The old stub handed
      // back ONE line while the header said 1-42 — exactly the dishonesty the
      // new case below pins, so it cannot be the baseline here.
      .mockResolvedValueOnce({ code: 0, output: Array.from({ length: 42 }, (_, i) => `L${i + 1}`).join('\n') })
      .mockResolvedValueOnce({ code: 0, output: '42 /a.txt' })
    await h.executor.execReadOnlyTools([t('t1', 'read', { file_path: '/a.txt' })])
    expect(h.results[0].content).toContain('(42 lines)')
    expect(h.results[0].content).toContain('Range: lines 1-42')

    h = makeHarness()
    ;(h.host.execCommandSync as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 1, output: 'partial but shown' })
    await h.executor.execReadOnlyTools([t('t2', 'read', { file_path: '/a.txt' })])
    expect(h.results[0].isError).toBe(false)
    expect(h.results[0].content).toContain('partial but shown')

    h = makeHarness()
    ;(h.host.execCommandSync as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 1, output: '' })
    await h.executor.execReadOnlyTools([t('t3', 'read', { file_path: '/a.txt' })])
    expect(h.results[0].isError).toBe(true)
    expect(h.results[0].content).toBe('Command failed (exit: 1)')

    h = makeHarness()
    ;(h.host.execCommandSync as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('spawn gone'))
    await h.executor.execReadOnlyTools([t('t4', 'read', { file_path: '/a.txt' })])
    expect(h.results[0]).toMatchObject({ isError: true, content: 'Error: spawn gone' })
  })

  it('read 分页诚实性（2026-10-29）：文件头的 Range 只报实际交付的行，不报请求值', async () => {
    // 复现：请求 limit 1000，命令侧曾独立硬卡 500 行，而元数据头按请求值
    // 算 readLen →「Range: lines 1-1000」。模型照此从 1001 续读，501-1000
    // 被静默跳过——没有任何错误、没有任何一轮会暴露它。头只能陈述真正
    // 交付的行数，这是模型决定下一次 offset 的唯一依据。
    const delivered = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n')
    const h = makeHarness()
    ;(h.host.execCommandSync as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ code: 0, output: delivered })
      .mockResolvedValueOnce({ code: 0, output: '3000 /a.txt' })
    await h.executor.execReadOnlyTools([t('t1', 'read', { file_path: '/a.txt', limit: 1000 })])
    expect(h.results[0].content).toContain('(3000 lines)')
    expect(h.results[0].content).toContain('Range: lines 1-500')
    expect(h.results[0].content).not.toContain('Range: lines 1-1000')
  })

  it('read 分页诚实性·行尾换行（2026-10-29 自检发现）：不得把末尾换行算成一行', async () => {
    // 真实 head / PowerShell 的输出总以换行收尾，裸 split('\n') 会多切出一个
    // 空串——600 行被算成 601 行。长页有 limit 和总行数兜住，只有「短尾页」
    // 与「wc -l 失败」会真的多报，而多报正是这条改动要消灭的方向。
    const page = Array.from({ length: 600 }, (_, i) => `L${i + 1}`).join('\n') + '\n'

    let h = makeHarness()
    ;(h.host.execCommandSync as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ code: 0, output: page })
      .mockResolvedValueOnce({ code: 0, output: '3000 /a.txt' })
    await h.executor.execReadOnlyTools([t('t1', 'read', { file_path: '/a.txt', limit: 1000 })])
    expect(h.results[0].content).toContain('Range: lines 1-600')
    expect(h.results[0].content).not.toContain('Range: lines 1-601')

    // 同一页但 wc -l 失败（totalLines=0）：总行数不再兜底，只剩交付行数
    h = makeHarness()
    ;(h.host.execCommandSync as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ code: 0, output: page })
      .mockResolvedValueOnce({ code: 1, output: '' })
    await h.executor.execReadOnlyTools([t('t2', 'read', { file_path: '/a.txt', limit: 1000 })])
    expect(h.results[0].content).toContain('Range: lines 1-600')
    expect(h.results[0].content).not.toContain('Range: lines 1-601')
  })

  it('read 分页上限单一来源：命令侧不得比引擎接受的上限更窄', () => {
    // 引擎侧 limit 允许到 READ_MAX_LINE_LIMIT，命令侧曾另卡一个常量 500 —
    // 两套数字各说一套。现在共享同一个常量，这条用例就是那条接缝。
    expect(buildCommandFromSkillInput('read', { file_path: '/a.txt', limit: 1000 }, 'darwin'))
      .toContain(`head -n ${READ_MAX_LINE_LIMIT}`)
    // 超大请求仍被同一上限收口（token 侧由 MAX_READ_RESULT_TOKENS 兜底）
    expect(buildCommandFromSkillInput('read', { file_path: '/a.txt', limit: 99999 }, 'darwin'))
      .toContain(`head -n ${READ_MAX_LINE_LIMIT}`)
    // 省略 limit 的默认页保持不变
    expect(buildCommandFromSkillInput('read', { file_path: '/a.txt' }, 'darwin'))
      .toContain(`head -n ${READ_DEFAULT_LINE_LIMIT}`)
  })

  it('getLineCount：win32 走 PowerShell 管道，非零退出与异常都归零', async () => {
    let h = makeHarness({ opts: { platformInfo: { platform: 'win32' } } })
    ;(h.host.execCommandSync as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ code: 0, output: 'content' })
      .mockResolvedValueOnce({ code: 0, output: '12' })
    await h.executor.execReadOnlyTools([t('t1', 'read', { file_path: 'C:\\a.txt' })])
    expect(h.host.execCommandSync).toHaveBeenLastCalledWith(expect.stringContaining('Measure-Object -Line'))
    expect(h.results[0].content).toContain('(12 lines)')

    h = makeHarness()
    ;(h.host.execCommandSync as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 1, output: '' })
    await h.executor.execReadOnlyTools([t('t2', 'read', { file_path: '/a.txt' })])
    expect(h.results[0].content).not.toContain(' lines)')
  })

  it('其他只读工具：空输出与失败的信封分支 + git 只读族委托', async () => {
    let h = makeHarness()
    await h.executor.execReadOnlyTools([t('t1', 'list_dir', { path: '/x' })])
    expect(h.results[0].content).toBe('out')

    ;(h.host.execCommandSync as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, output: '' })
    await h.executor.execReadOnlyTools([t('t2', 'list_dir', { path: '/x' })])
    expect(h.results[1].content).toBe('(no output)')

    ;(h.host.execCommandSync as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 3, output: '' })
    await h.executor.execReadOnlyTools([t('t3', 'list_dir', { path: '/x' })])
    expect(h.results[2].content).toBe('Command failed (exit: 3)')

    h = makeHarness()
    await h.executor.execReadOnlyTools([t('t4', 'git_status', { cwd: '/repo' })])
    expect(h.host.gitInvoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'status', cwd: '/repo' }))
    expect(h.results[0].isError).toBe(false)
  })
})

describe('execWorkspaceTool — git 写族', () => {
  it('git_commit 组动作并格式化提交结果', async () => {
    const { executor, host, results } = makeHarness({ opts: { workspaceDir: '/repo' } })
    ;(host.gitInvoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, data: { shortHash: 'abc', summary: 'fix', filesChanged: 2 } })
    await executor.execWorkspaceTool(t('t1', 'git_commit', { message: 'fix' }))
    expect(host.gitInvoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'commit', message: 'fix' }))
    expect(results[0].content).toContain('Committed abc: fix (2 file(s) changed)')
  })
})

describe('execMCPTool 信封', () => {
  it('对象结果 JSON 化、字符串结果直出、失败与无主双错误路', async () => {
    let h = makeHarness()
    ;(h.host.mcpCallTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true, result: { a: 1 } })
    await h.executor.execMCPTool(t('t1', 'mcp_free'))
    expect(h.results[0].content).toBe(JSON.stringify({ a: 1 }, null, 2))

    h = makeHarness()
    ;(h.host.mcpCallTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'boom' })
    await h.executor.execMCPTool(t('t2', 'mcp_free'))
    expect(h.results[0]).toMatchObject({ isError: true, content: 'MCP error: boom' })

    h = makeHarness()
    await h.executor.execMCPTool(t('t3', 'mcp_unknown'))
    expect(h.results[0].content).toContain('No MCP server provides tool')

    h = makeHarness()
    ;(h.host.mcpCallTool as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('transport dead'))
    await h.executor.execMCPTool(t('t4', 'mcp_free'))
    expect(h.results[0].content).toBe('MCP error: transport dead')
  })
})

describe('execPickSkill 矩阵', () => {
  const skillDef = { name: 'office', description: 'desc', category: 'cat', systemPrompt: 'SP' }

  it('注册表命中：磁盘新读（含失败回落）+ Location 行的有无', async () => {
    let h = makeHarness({ opts: { skillsDir: '/skills', skillManager: { getSkill: () => ({ definition: skillDef }), getEnabledSkills: () => [] } } })
    await h.executor.execPickSkill(t('t1', 'pick_skill', { name: 'office' }))
    expect(h.host.installSkill).toHaveBeenCalledWith('office')
    expect(h.results[0].content).toContain('**Location:** /skills/office/SKILL.md')
    expect(h.results[0].content).toContain('### Instructions\nSP')

    // installSkill 返回新定义 → 信封用新的；抛错 → 回落注册表
    h = makeHarness({ opts: { skillsDir: '/skills', skillManager: { getSkill: () => ({ definition: skillDef }), getEnabledSkills: () => [] } } })
    ;(h.host.installSkill as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...skillDef, systemPrompt: 'FRESH' })
    await h.executor.execPickSkill(t('t2', 'pick_skill', { name: 'office' }))
    expect(h.results[0].content).toContain('FRESH')

    h = makeHarness({ opts: { skillsDir: '/skills', skillManager: { getSkill: () => ({ definition: skillDef }), getEnabledSkills: () => [] } } })
    ;(h.host.installSkill as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk'))
    await h.executor.execPickSkill(t('t3', 'pick_skill', { name: 'office' }))
    expect(h.results[0].content).toContain('SP')

    h = makeHarness({ opts: { skillManager: { getSkill: () => ({ definition: skillDef }), getEnabledSkills: () => [] } } })
    await h.executor.execPickSkill(t('t4', 'pick_skill', { name: 'office' }))
    expect(h.results[0].content).not.toContain('**Location:**')
  })

  it('白名单外拒绝；经验兜底已退役（经验=记忆页走 memory_search）；未命中明确报错', async () => {
    let h = makeHarness({ opts: { allowedSkills: ['other'], skillManager: { getSkill: () => ({ definition: skillDef }), getEnabledSkills: () => [] } } })
    await h.executor.execPickSkill(t('t1', 'pick_skill', { name: 'office' }))
    expect(h.results[0]).toMatchObject({ isError: true })
    expect(h.results[0].content).toContain("not in this session's allowed skills")

    // 旧经验兜底分支被整段拆除：经验名不再可经 pick_skill 读到（回归守卫）
    h = makeHarness({ opts: { skillManager: { getSkill: () => undefined, getEnabledSkills: () => [] }, experienceManager: { read: vi.fn(async () => 'EXP BODY'), list: vi.fn(async () => [{ name: 'exp1', dir: '/exp/exp1', description: 'd' }]), touch: vi.fn(async () => {}) } } })
    await h.executor.execPickSkill(t('t2', 'pick_skill', { name: 'exp1' }))
    expect(h.results[0]).toMatchObject({ isError: true, content: 'Skill "exp1" not found.' })
    expect(h.results[0].content).not.toContain('EXP BODY')

    h = makeHarness({ opts: { skillManager: { getSkill: () => undefined, getEnabledSkills: () => [] } } })
    await h.executor.execPickSkill(t('t3', 'pick_skill', { name: 'ghost' }))
    expect(h.results[0]).toMatchObject({ isError: true, content: 'Skill "ghost" not found.' })
  })

  it('intent 路径：缺参报错、空库短路、选择失败/越权/落空/命中四态', async () => {
    let h = makeHarness()
    await h.executor.execPickSkill(t('t1', 'pick_skill', {}))
    expect(h.results[0]).toMatchObject({ isError: true, content: 'Error: Either "name" or "intent" must be provided' })

    h = makeHarness({ opts: { skillManager: { getSkill: () => undefined, getEnabledSkills: () => [] } } })
    await h.executor.execPickSkill(t('t2', 'pick_skill', { intent: 'edit docx' }))
    // 空候选池文案覆盖双源（PLAN-experience-sop B1：技能 + 经验页）
    expect(h.results[0].content).toBe('No skills or experiences available.')

    h = makeHarness({ opts: { skillManager: { getSkill: () => ({ definition: skillDef }), getEnabledSkills: () => [{ definition: skillDef }] } } })
    ;((h.executor as unknown as { skillSelectionAgent: { execute: ReturnType<typeof vi.fn> } }).skillSelectionAgent.execute).mockResolvedValueOnce('')
    await h.executor.execPickSkill(t('t3', 'pick_skill', { intent: 'x' }))
    expect(h.results[0].content).toBe('No matching skill found.')

    // 受限会话的技能候选被白名单过滤后为空；经验段为空（host 无经验页）时
    // 短路先于选择代理发生，越权分支退化为防御位。文案覆盖双源
    // （PLAN-experience-sop B1：候选表 = 白名单内技能 + 活经验页）。
    h = makeHarness({ opts: {
      allowedSkills: ['other'],
      skillManager: { getSkill: () => ({ definition: skillDef }), getEnabledSkills: () => [{ definition: skillDef }] },
    } })
    ;((h.executor as unknown as { skillSelectionAgent: { execute: ReturnType<typeof vi.fn> } }).skillSelectionAgent.execute).mockResolvedValueOnce('office')
    await h.executor.execPickSkill(t('t4', 'pick_skill', { intent: 'x' }))
    expect(h.results[0].content).toBe('No skills or experiences available.')
    expect(h.results[0].isError).toBe(false)

    h = makeHarness({ opts: { skillManager: { getSkill: () => undefined, getEnabledSkills: () => [{ definition: skillDef }] } } })
    ;((h.executor as unknown as { skillSelectionAgent: { execute: ReturnType<typeof vi.fn> } }).skillSelectionAgent.execute).mockResolvedValueOnce('nowhere')
    await h.executor.execPickSkill(t('t5', 'pick_skill', { intent: 'x' }))
    expect(h.results[0].content).toBe('"nowhere" selected but not available.')

    h = makeHarness({ opts: { skillManager: { getSkill: () => ({ definition: skillDef }), getEnabledSkills: () => [{ definition: skillDef }] } } })
    await h.executor.execPickSkill(t('t6', 'pick_skill', { intent: 'x' }))
    expect(h.results[0].isError).toBe(false)
    expect(h.results[0].content).toContain('## Selected Skill: office')
  })
})

describe('execBrowser / execWebFetch', () => {
  it('browser：空 code 转发 kernel（回能力清单，A4-r）；富结果分节；错误置 isError', async () => {
    let h = makeHarness()
    // 空 code 不再拒绝——原样转发给 host，kernel 回 capability manifest。
    await h.executor.execBrowser(t('t1', 'browser', {}))
    expect(h.results[0].isError).toBe(false)
    expect(h.host.browserRunCode).toHaveBeenCalledWith('', { timeoutMs: undefined, conversationId: 'c1' })

    h = makeHarness()
    ;(h.host.browserRunCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ result: 'a\nb', console: ['c1', 'c2'], images: [{ base64: 'QQ==' }] })
    await h.executor.execBrowser(t('t2', 'browser', { code: 'x', timeoutMs: 5 }))
    expect(h.host.browserRunCode).toHaveBeenCalledWith('x', { timeoutMs: 5, conversationId: 'c1' })
    expect(h.results[0].content).toContain('Result:\na\nb')
    expect(h.results[0].content).toContain('Console:\nc1\nc2')
    expect(h.results[0].content).toContain('[1 张截图已附加]')
    expect(h.results[0].isError).toBe(false)

    h = makeHarness()
    ;(h.host.browserRunCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ result: 'flat', error: 'page closed', console: [], images: [] })
    await h.executor.execBrowser(t('t3', 'browser', { code: 'x' }))
    expect(h.results[0]).toMatchObject({ isError: true })
    expect(h.results[0].content).toContain('Error: page closed')
    expect(h.results[0].content).toContain('Result: flat')
  })

  it('webfetch：缺 url / 成功信封 / 被拒 / 抛异常', async () => {
    let h = makeHarness()
    await h.executor.execWebFetch(t('t1', 'webfetch', {}))
    expect(h.results[0]).toMatchObject({ isError: true, content: 'Error: url is required' })

    h = makeHarness()
    ;(h.host.apiFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce('body here')
    await h.executor.execWebFetch(t('t2', 'webfetch', { url: 'https://x', method: 'post', body: 'data' }))
    expect(h.host.apiFetch).toHaveBeenCalledWith('https://x', { method: 'POST', headers: undefined, body: 'data' })
    expect(h.results[0].content).toContain('Size: 9 chars')
    expect(h.results[0].content).toContain('body here')

    h = makeHarness()
    ;(h.host.apiFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    await h.executor.execWebFetch(t('t3', 'webfetch', { url: 'https://x' }))
    expect(h.results[0].content).toContain('Request failed or was blocked')

    h = makeHarness()
    ;(h.host.apiFetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('dns'))
    await h.executor.execWebFetch(t('t4', 'webfetch', { url: 'https://x' }))
    expect(h.results[0].content).toBe('Error: dns')
  })
})

describe('createSubPlan 双门', () => {
  it('无 spawnPlanSplit 拒；有门无桥拒；有桥透传', () => {
    let h = makeHarness()
    expect(h.executor.createSubPlan([{ title: 'x' }])).toEqual({ ok: false, reason: 'create_sub_plan is not available for this dispatch' })

    h = makeHarness({ opts: { spawnPlanSplit: { nodeRef: 'n1', attemptId: 'a', createdIds: [] } } })
    expect(h.executor.createSubPlan([{ title: 'x' }])).toEqual({ ok: false, reason: 'no parent plan channel — the bridge was not wired' })

    const merge = vi.fn(() => ({ ok: true as const, nodeIds: ['n2'] }))
    h = makeHarness({ opts: { spawnPlanSplit: { nodeRef: 'n1', attemptId: 'a', createdIds: [] } } })
    ;(h.executor as unknown as { parentPlanMerge: unknown }).parentPlanMerge = merge
    expect(h.executor.createSubPlan([{ title: 'x' }], 'too heavy')).toEqual({ ok: true, nodeIds: ['n2'] })
    expect(merge).toHaveBeenCalledWith([{ title: 'x' }], 'too heavy')
  })
})

describe('export_document — deck 退役指引可达（review_20261006 中9）', () => {
  it('deck + content：deck 不被静默丢弃，指引入/Error 落地', async () => {
    const h = makeHarness()
    await h.executor.execWorkspaceTool(t('t1', 'office_export', { format: 'pptx', content: '# 走兜底的旧调用', deck: { slides: [] } }))
    expect(h.results[0].isError).toBe(true)
    expect(h.results[0].content).toContain('deck 参数已退役')
    expect(h.results[0].content).toContain('htmlPath')
    // 不该走到 host 的导出通道
    expect((h.host as unknown as Record<string, ReturnType<typeof vi.fn>>).exportDocument).toBeUndefined()
  })

  it('deck 单独出现：拿到退役指引而非通用的「三选一」报错', async () => {
    const h = makeHarness()
    await h.executor.execWorkspaceTool(t('t2', 'office_export', { format: 'pptx', deck: { slides: [] } }))
    expect(h.results[0].isError).toBe(true)
    expect(h.results[0].content).toContain('deck 参数已退役')
    expect(h.results[0].content).not.toContain('三选一')
  })

  it('无 deck 的调用不受影响：仍按原校验链走（对照）', async () => {
    const h = makeHarness()
    await h.executor.execWorkspaceTool(t('t3', 'office_export', { format: 'pptx' }))
    expect(h.results[0].content).toContain('content / sourcePath / htmlPath 三选一')
  })
})

// ── audit 2026-10-10（工具审计修复批）─────────────────────────────────────
describe('execReadOnlyTools — search 语义与目录坐标（#4/#5/#6）', () => {
  it('search 空输出 → No matches found.，非错误（rg/grep 无匹配退出码 1）', async () => {
    const { executor, host, results } = makeHarness({ opts: { platformInfo: { platform: 'darwin' } } })
    ;(host.execCommandSync as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ code: 1, output: '' })
    await executor.execReadOnlyTools([t('t1', 'search', { query: 'ghost' })])
    expect(results[0]).toMatchObject({ content: 'No matches found.', isError: false })
  })

  it('search 非空输出（含 2>&1 并入的错误文本）→ 原样放行，非错误', async () => {
    const { executor, host, results } = makeHarness({ opts: { platformInfo: { platform: 'darwin' } } })
    ;(host.execCommandSync as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ code: 0, output: 'rg: error: bad regex' })
    await executor.execReadOnlyTools([t('t1', 'search', { query: '(' })])
    expect(results[0]).toMatchObject({ content: 'rg: error: bad regex', isError: false })
  })

  it('search 省略 search_dir → 命令落在 workspaceDir；find 相对路径挂 workspace', async () => {
    const { executor, host } = makeHarness({ opts: { platformInfo: { platform: 'darwin' }, workspaceDir: '/ws' } })
    const mock = host.execCommandSync as ReturnType<typeof vi.fn>
    mock.mockResolvedValue({ code: 0, output: 'hit' })
    await executor.execReadOnlyTools([t('t1', 'search', { query: 'x' })])
    expect(mock.mock.calls[0][0] as string).toContain(`'x' '/ws'`)
    await executor.execReadOnlyTools([t('t2', 'find', { pattern: 'y', search_dir: 'src' })])
    expect(mock.mock.calls[1][0] as string).toContain(`find '/ws/src'`)
  })

  it('read 相对 file_path 挂 workspaceDir——stat 与 shell 同一坐标（#6）', async () => {
    const { executor, host } = makeHarness({ opts: { platformInfo: { platform: 'darwin' }, workspaceDir: '/ws' } })
    await executor.execReadOnlyTools([t('t1', 'read', { file_path: 'src/a.ts' })])
    expect(host.getFileStat).toHaveBeenCalledWith('/ws/src/a.ts')
    const cmd = (host.execCommandSync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(cmd).toContain('tail -n +1 "/ws/src/a.ts"')
  })

  it('read 的 ~ 路径原样到达（挂 workspace 会拼出字面量 ~ 目录）', async () => {
    const { executor, host } = makeHarness({ opts: { platformInfo: { platform: 'darwin' }, workspaceDir: '/ws' } })
    await executor.execReadOnlyTools([t('t1', 'read', { file_path: '~/.pulsemind/mem.md' })])
    expect(host.getFileStat).toHaveBeenCalledWith('~/.pulsemind/mem.md')
    const cmd = (host.execCommandSync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(cmd).toContain('tail -n +1 "$HOME')
  })

  it('list_dir 相对 dir_path 挂 workspaceDir', async () => {
    const { executor, host } = makeHarness({ opts: { platformInfo: { platform: 'darwin' }, workspaceDir: '/ws' } })
    await executor.execReadOnlyTools([t('t1', 'list_dir', { dir_path: 'sub' })])
    const cmd = (host.execCommandSync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(cmd).toContain('ls -la "/ws/sub"')
  })
})

describe('execBrowser — 多截图信封（#7）', () => {
  it('多张时如实说仅附第 1 张，imageData 仍是第一张', async () => {
    const { executor, host, results } = makeHarness()
    ;(host.browserRunCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      result: 'ok', console: [], images: [{ base64: 'AAA' }, { base64: 'BBB' }],
    })
    await executor.execBrowser(t('t1', 'browser', { code: 'x' }))
    expect(results[0].content).toContain('2 张截图')
    expect(results[0].content).toContain('仅第 1 张已附加')
    expect(results[0].image).toBe('AAA')
  })

  it('单张时维持原文案（负控）', async () => {
    const { executor, host, results } = makeHarness()
    ;(host.browserRunCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      result: 'ok', console: [], images: [{ base64: 'AAA' }],
    })
    await executor.execBrowser(t('t1', 'browser', { code: 'x' }))
    expect(results[0].content).toContain('[1 张截图已附加]')
    expect(results[0].content).not.toContain('仅第 1 张')
  })
})

describe('execPickSkill — 白名单只拦技能（#9 的经验半边已随池退役）', () => {
  it('受限会话按名读经验：兜底已拆除，明确 not found（PLAN-memory-wiki M2b 回归守卫）', async () => {
    const h = makeHarness({ opts: {
      allowedSkills: ['other'],
      skillManager: { getSkill: () => undefined, getEnabledSkills: () => [] },
      experienceManager: { read: vi.fn(async () => 'EXP BODY'), list: vi.fn(async () => [{ name: 'exp1', dir: '/exp/exp1' }]), touch: vi.fn(async () => {}) },
    } })
    await h.executor.execPickSkill(t('t1', 'pick_skill', { name: 'exp1' }))
    expect(h.results[0].isError).toBe(true)
    expect(h.results[0].content).toBe('Skill "exp1" not found.')
  })

  it('受限会话按名读白名单外技能仍拒（裁定不变）', async () => {
    const skillDef = { name: 'office', description: 'desc', category: 'cat', systemPrompt: 'SP' }
    const h = makeHarness({ opts: {
      allowedSkills: ['other'],
      skillManager: { getSkill: () => ({ definition: skillDef }), getEnabledSkills: () => [] },
    } })
    await h.executor.execPickSkill(t('t1', 'pick_skill', { name: 'office' }))
    expect(h.results[0].isError).toBe(true)
    expect(h.results[0].content).toContain("not in this session's allowed skills")
  })
})

// ── 阶段完成协议（2026-11-11）──
// finish_stage 是 pipeline 阶段的完成信号：合法调用只写引擎上的结算记录，
// 参数不合法在当回合内回错误（不消耗 maxStageContinues），没有阶段配置时
// 绝不抢占同名用户工具。
describe('execOtherTool — finish_stage 阶段完成协议', () => {
  const config = { verdicts: ['成功', '需修订'], verdictDefs: { 成功: '可以交付' } }

  it('合法调用：记录归一后的契约并返回非错误结果', async () => {
    const { executor, results } = makeHarness({ opts: { stageFinish: config } })
    const record = vi.fn()
    executor.recordStageFinish = record
    const block = t('t1', 'finish_stage', { verdict: ' 成功 ', summary: ' 做完了 ', artifacts: ['out/a.md'] })
    await executor.execOtherTool(block)
    expect(record).toHaveBeenCalledWith({ verdict: '成功', summary: '做完了', artifacts: ['out/a.md'] })
    expect(results[0]).toMatchObject({ id: 't1', isError: false })
    expect(results[0].content).toContain('阶段结果已记录')
    expect(block.exitCode).toBe(0)
  })

  it('verdict 越表：当回合回错误、不记录（不结算）', async () => {
    const { executor, results } = makeHarness({ opts: { stageFinish: config } })
    const record = vi.fn()
    executor.recordStageFinish = record
    const block = t('t1', 'finish_stage', { verdict: '失败', summary: 'x' })
    await executor.execOtherTool(block)
    expect(record).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject({ id: 't1', isError: true })
    expect(results[0].content).toContain('成功')
    expect(block.exitCode).toBe(1)
  })

  it('无阶段配置：不抢占同名调用，交回常规分派', async () => {
    // 用户工具工作室可以自建同名工具；没有阶段配置时执行器必须放手。
    const claimed = await execStageFinishTool(
      { opts: {} } as never,
      t('t1', 'finish_stage', { verdict: '成功', summary: 'x' }),
    )
    expect(claimed).toBe(false)
  })

  it('配置在但引擎未接记录通道：明确报不可用，不假装成功', async () => {
    const { executor, results } = makeHarness({ opts: { stageFinish: config } })
    const block = t('t1', 'finish_stage', { verdict: '成功', summary: 'x' })
    await executor.execOtherTool(block)
    expect(results[0]).toMatchObject({ id: 't1', isError: true })
    expect(results[0].content).toContain('not available')
    expect(block.exitCode).toBe(1)
  })
})
