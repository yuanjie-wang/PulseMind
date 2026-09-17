import { describe, it, expect, afterEach } from 'vitest'
import { ToolExecutor } from '../src/renderer/src/agent/tool-executors'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import type { AgentEngineOptions } from '../src/renderer/src/agent/types'
import type { ToolUseBlock } from '../src/shared/types/agent'

const SNAPSHOT = '── 交互元素编号 [N] ──\n[1] link "新闻" (a)\n\n── 页面结构（ARIA）──\n- document:'

function run(code: string, result: unknown, extra: Partial<{ error: string; console: string[] }> = {}) {
  const seen: string[] = []
  setHost({
    browserRunCode: async () => ({ result: String(result), truncated: false, images: [], console: extra.console ?? [], error: extra.error }),
  } as unknown as PulseHost)
  const t = { id: 't1', name: 'browser', input: { code } } as unknown as ToolUseBlock
  const ex = new ToolExecutor(
    { conversationId: 'conv_1' } as AgentEngineOptions,
    new Map(),
    null as never,
    null as never,
    (_id, content) => seen.push(content),
    () => {},
  )
  return ex.execBrowser(t).then(() => seen.join('\n'))
}

afterEach(() => setHost(null as unknown as PulseHost))

describe('execBrowser result framing', () => {
  it('puts a multi-line payload on its own line so the first line is the heading', async () => {
    const text = await run('return snap', SNAPSHOT)
    // `Result: ── 交互元素编号 [N] ──` would read as a label glued to a heading,
    // and the numbered index is the thing the model acts on — it opens the card.
    expect(text.startsWith('Result:\n── 交互元素编号 [N] ──')).toBe(true)
    expect(text).toContain('[1] link "新闻" (a)')
  })

  it('keeps single values on the one-line form', async () => {
    expect(await run('return 1', 'clicked')).toBe('Result: clicked')
    expect(await run('return 1', '42')).toBe('Result: 42')
  })

  it('reports an error alongside the result and marks the exit code', async () => {
    const seen: unknown[] = []
    setHost({ browserRunCode: async () => ({ result: 'null', truncated: false, images: [], console: [], error: 'boom' }) } as unknown as PulseHost)
    const t = { id: 't2', name: 'browser', input: { code: 'x' } } as unknown as ToolUseBlock
    const ex = new ToolExecutor(
      { conversationId: 'conv_1' } as AgentEngineOptions,
      new Map(),
      null as never,
      null as never,
      (id, content, isError) => seen.push({ id, content, isError }),
      () => {},
    )
    await ex.execBrowser(t)
    expect((seen[0] as { content: string }).content).toContain('Error: boom')
    expect((seen[0] as { isError: boolean }).isError).toBe(true)
    expect(t.exitCode).toBe(1)
  })
})
