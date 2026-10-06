import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ToolExecutor } from '../src/renderer/src/agent/tool-executors'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'
import { MAX_READ_RESULT_TOKENS } from '../src/renderer/src/agent/engine/engine-constants'

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
  const results: Array<{ id: string, content: string, isError: boolean, maxTokens?: number }> = []
  const host = {
    execCommandSync: vi.fn(async () => ({ code: 0, output: 'out' })),
    getFileStat: vi.fn(async () => ({ size: 500 })),
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
    (id: string, content: string, isError: boolean, _image?: string, maxTokens?: number) => {
      results.push({ id, content, isError, maxTokens })
    },
    () => {},
  )
  return { executor, host, results }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('execWorkspaceTool — write / edit', () => {
  it('write 成功：utf8 字节数 + append 分支 + 相对路径按 workspaceDir 解析', async () => {
    const { executor, host, results } = makeHarness({ opts: { workspaceDir: '/ws' } })
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
    await h.executor.execWorkspaceTool(t('t1', 'write', { file_path: '/abs/a.txt', content: 'x' }))
    expect(h.host.writeFile).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: '/abs/a.txt' }),)

    h = makeHarness({ opts: { workspaceDir: 'C:\\ws' } })
    await h.executor.execWorkspaceTool(t('t2', 'write', { file_path: 'a.txt', content: 'x' }))
    expect(h.host.writeFile).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: 'C:\\ws\\a.txt' }),)

    h = makeHarness()
    await h.executor.execWorkspaceTool(t('t3', 'write', { content: 'x' }))
    expect(h.results[0]).toMatchObject({ isError: true, content: 'Error: file_path is required' })

    h = makeHarness()
    ;(h.host.writeFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'disk full' })
    await h.executor.execWorkspaceTool(t('t4', 'write', { file_path: '/a', content: 'x' }))
    expect(h.results[0]).toMatchObject({ isError: true, content: 'Error: disk full' })
  })

  it('edit：diff 走 patchFile，old_str 走 editFile，缺参拒绝', async () => {
    let h = makeHarness()
    await h.executor.execWorkspaceTool(t('t1', 'edit', { file_path: '/a', diff: '--- x' }))
    expect(h.host.patchFile).toHaveBeenCalledWith({ filePath: '/a', diff: '--- x' })
    expect(h.results[0].content).toContain('Applied 1 hunk(s)')

    ;(h.host.patchFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, error: 'no match' })
    await h.executor.execWorkspaceTool(t('t2', 'edit', { file_path: '/a', diff: '--- x' }))
    expect(h.results[1]).toMatchObject({ isError: true, content: 'Error: no match' })

    h = makeHarness()
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
      filePath: '/a.xlsx', offset: 2, limit: 50, tables: true, sheet: 'S1', range: 'A1:B2', slide: undefined,
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
      .mockResolvedValueOnce({ code: 0, output: 'file content here' })
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

  it('白名单外拒绝；未命中走经验库；都不在则明确报错', async () => {
    let h = makeHarness({ opts: { allowedSkills: ['other'], skillManager: { getSkill: () => ({ definition: skillDef }), getEnabledSkills: () => [] } } })
    await h.executor.execPickSkill(t('t1', 'pick_skill', { name: 'office' }))
    expect(h.results[0]).toMatchObject({ isError: true })
    expect(h.results[0].content).toContain('not in this session\'s allowed skills')

    h = makeHarness({ opts: { skillManager: { getSkill: () => undefined, getEnabledSkills: () => [] }, experienceManager: { read: vi.fn(async () => 'EXP BODY'), list: vi.fn(async () => [{ name: 'exp1', dir: '/exp/exp1', description: 'd' }]), touch: vi.fn(async () => {}) } } })
    await h.executor.execPickSkill(t('t2', 'pick_skill', { name: 'exp1' }))
    expect(h.results[0].content).toContain('## Selected Experience: exp1')
    expect(h.results[0].content).toContain('EXP BODY')
    expect(h.results[0].content).toContain('**Location:** /exp/exp1/SKILL.md')

    h = makeHarness({ opts: { skillManager: { getSkill: () => undefined, getEnabledSkills: () => [] } } })
    await h.executor.execPickSkill(t('t3', 'pick_skill', { name: 'ghost' }))
    expect(h.results[0]).toMatchObject({ isError: true, content: 'Skill or experience "ghost" not found.' })
  })

  it('intent 路径：缺参报错、空库短路、选择失败/越权/落空/命中四态', async () => {
    let h = makeHarness()
    await h.executor.execPickSkill(t('t1', 'pick_skill', {}))
    expect(h.results[0]).toMatchObject({ isError: true, content: 'Error: Either "name" or "intent" must be provided' })

    h = makeHarness({ opts: { skillManager: { getSkill: () => undefined, getEnabledSkills: () => [] } } })
    await h.executor.execPickSkill(t('t2', 'pick_skill', { intent: 'edit docx' }))
    expect(h.results[0].content).toBe('No skills or experiences enabled.')

    h = makeHarness({ opts: { skillManager: { getSkill: () => ({ definition: skillDef }), getEnabledSkills: () => [{ definition: skillDef }] } } })
    ;((h.executor as unknown as { skillSelectionAgent: { execute: ReturnType<typeof vi.fn> } }).skillSelectionAgent.execute).mockResolvedValueOnce('')
    await h.executor.execPickSkill(t('t3', 'pick_skill', { intent: 'x' }))
    expect(h.results[0].content).toBe('No matching skill found.')

    // 越权选择必须穿过空库短路：经验库不过 allowedSkills 过滤，列表因此非空，
    // 选择代理回报一个白名单外的技能名才到达 L711 的越权分支
    h = makeHarness({ opts: {
      allowedSkills: ['other'],
      skillManager: { getSkill: () => ({ definition: skillDef }), getEnabledSkills: () => [{ definition: skillDef }] },
      experienceManager: { read: vi.fn(async () => 'E'), list: vi.fn(async () => [{ name: 'exp1', description: 'd' }]), touch: vi.fn(async () => {}) },
    } })
    ;((h.executor as unknown as { skillSelectionAgent: { execute: ReturnType<typeof vi.fn> } }).skillSelectionAgent.execute).mockResolvedValueOnce('office')
    await h.executor.execPickSkill(t('t4', 'pick_skill', { intent: 'x' }))
    expect(h.results[0].isError).toBe(true)
    expect(h.results[0].content).toContain('outside this session\'s allowed skills')

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
  it('browser：空 code 拒绝；富结果分节；错误置 isError', async () => {
    let h = makeHarness()
    await h.executor.execBrowser(t('t1', 'browser', {}))
    expect(h.results[0]).toMatchObject({ isError: true, content: 'Error: code is required' })

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
    await h.executor.execWorkspaceTool(t('t1', 'export_document', { format: 'pptx', content: '# 走兜底的旧调用', deck: { slides: [] } }))
    expect(h.results[0].isError).toBe(true)
    expect(h.results[0].content).toContain('deck 参数已退役')
    expect(h.results[0].content).toContain('htmlPath')
    // 不该走到 host 的导出通道
    expect((h.host as unknown as Record<string, ReturnType<typeof vi.fn>>).exportDocument).toBeUndefined()
  })

  it('deck 单独出现：拿到退役指引而非通用的「三选一」报错', async () => {
    const h = makeHarness()
    await h.executor.execWorkspaceTool(t('t2', 'export_document', { format: 'pptx', deck: { slides: [] } }))
    expect(h.results[0].isError).toBe(true)
    expect(h.results[0].content).toContain('deck 参数已退役')
    expect(h.results[0].content).not.toContain('三选一')
  })

  it('无 deck 的调用不受影响：仍按原校验链走（对照）', async () => {
    const h = makeHarness()
    await h.executor.execWorkspaceTool(t('t3', 'export_document', { format: 'pptx' }))
    expect(h.results[0].content).toContain('content / sourcePath / htmlPath 三选一')
  })
})
