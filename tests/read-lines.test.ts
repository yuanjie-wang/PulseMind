/**
 * read 的行号坐标系（2026-10-28）：默认页 200→500、硬帽 500→1000，内容行带
 * 绝对行号前缀（cat -n 同款）——模型获得跨回合共享坐标系（「改 350 行附近」
 * 成为合法表达），大文件少几轮往返。前缀是坐标不是内容：read/edit 两本手册
 * 各有一句「edit/write 时剥掉前缀」的回声，头部 Numbering 行同教。
 *
 * read-before-write 台账不受影响：台账记 mtime/size，行号只是表示层；edit 的
 * old_str 匹配发生在主进程的原始字节上。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-read-lines-'))

const { ToolExecutor, numberReadLines } = await import('../src/renderer/src/agent/tool-executors')
const { setHost } = await import('../src/renderer/src/agent/host')
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

// ── numberReadLines（纯函数） ────────────────────────────────────────────────

describe('numberReadLines', () => {
  it('prefixes absolute line numbers starting at the requested offset, cat -n style', () => {
    expect(numberReadLines('a\nb\nc', 1)).toBe('     1\ta\n     2\tb\n     3\tc')
    // A second page continues the file's coordinates, not its own.
    expect(numberReadLines('x\ny', 350)).toBe('   350\tx\n   351\ty')
  })

  it('empty content passes through untouched', () => {
    expect(numberReadLines('', 1)).toBe('')
  })
})

// ── read 分支集成（真 executor + 感知命令的 host 桩） ────────────────────────

const WS = '/ws'
const FILE_LINES = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`)
const FILE = FILE_LINES.join('\n')

let lastResult: { content: string; isError: boolean } | null = null

function makeExecutor(): InstanceType<typeof ToolExecutor> {
  setHost({
    getFileStat: async () => ({ size: FILE.length, isDirectory: false }),
    // wc -l returns the line count; cat/sed return the content.
    execCommandSync: async (cmd: string) => {
      if (/wc -l/.test(cmd)) return { code: 0, output: `${FILE_LINES.length} ${WS}/a.ts` }
      return { code: 0, output: FILE }
    },
  } as never)
  const ex = new ToolExecutor(
    { workspaceDir: WS, platformInfo: { platform: 'darwin' } } as never,
    new Map(), {} as never, {} as never, () => {}, () => {},
  )
  ;(ex as unknown as { addToolResult: unknown }).addToolResult = (
    _id: string, content: string, isError: boolean,
  ) => { lastResult = { content, isError } }
  lastResult = null
  return ex
}

const doRead = async (input: Record<string, unknown> = {}): Promise<ToolUseBlock> => {
  const ex = makeExecutor()
  const t = { type: 'tool_use', id: 't_read', name: 'read', input: { file_path: 'a.ts', ...input }, status: 'queued' } as ToolUseBlock
  await ex.execReadOnlyTools([t])
  return t
}

describe('read branch line numbering', () => {
  it('numbers content lines with absolute coordinates and teaches the stripping rule', async () => {
    const t = await doRead()
    expect(t.exitCode).toBe(0)
    expect(lastResult?.isError).toBe(false)
    expect(lastResult?.content).toContain('     1\tline-1')
    expect(lastResult?.content).toContain('    12\tline-12')
    // A second page states its absolute range in the header (the content
    // pairing for offset>0 is numberReadLines' own pin above — the shell stub
    // here returns the whole file, so a content match would be a lie).
    const page2 = await doRead({ offset: 10 })
    expect(page2.exitCode).toBe(0)
    expect(lastResult?.content).toContain('Range: lines 10-12')
    // The header names the coordinate contract.
    expect(lastResult?.content).toContain('Numbering:')
    expect(lastResult?.content).toContain('Strip the prefixes')
  })

  it('error reads stay number-free', async () => {
    setHost({
      getFileStat: async () => null,
      execCommandSync: async () => ({ code: 1, output: '' }),
    } as never)
    const ex = new ToolExecutor(
      { workspaceDir: WS, platformInfo: { platform: 'darwin' } } as never,
      new Map(), {} as never, {} as never, () => {}, () => {},
    )
    ;(ex as unknown as { addToolResult: unknown }).addToolResult = (
      _id: string, content: string, isError: boolean,
    ) => { lastResult = { content, isError } }
    lastResult = null
    const t = { type: 'tool_use', id: 't_read', name: 'read', input: { file_path: 'a.ts' }, status: 'queued' } as ToolUseBlock
    await ex.execReadOnlyTools([t])
    expect(t.exitCode).not.toBe(0)
    expect(lastResult?.content).not.toContain('\tline-')
  })
})

// ── wiring 扫描 ──────────────────────────────────────────────────────────────

const ROOT = join(process.cwd(), 'src', 'renderer', 'src')

describe('read lines wiring', () => {
  const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

  it('schema states the new paging and the coordinate contract', () => {
    const src = read('tools/built-in-tools.ts')
    expect(src).toContain('default 500, hard cap 1000')
    expect(src).toContain('cat -n style')
  })

  it('read and edit manuals both teach stripping the prefixes', () => {
    const src = read('tools/tool-instructions.ts')
    expect(src).toContain('WITHOUT the prefixes')
    expect(src).toContain('copy the text WITHOUT them')
  })

  it('numbering is presentation applied once, at the exit — never before a count', () => {
    const src = read('agent/tool-executors.ts')
    // 唯一的表现层出口：formatReadOutput 把正文拼上去之前才加前缀。
    expect(src).toContain('numberReadLines(rawContent, offset)')
    // 两路都不得先编号再交给头部。头部一旦测量编号后的字符串，末尾换行就变成
    // 幽灵行（600 行交付却报 601，2026-10-29）——这条负控就是那个回归路径。
    expect(src).not.toContain('content = numberReadLines')
    // 界面预览仍拿编号形态（shell 路与 markitdown 路各一处）。
    expect(src).toContain('t.output = isError ? content : numberReadLines(content, offset)')
    expect(src).toContain('t.output = numberReadLines(content, offset)')
  })
})
