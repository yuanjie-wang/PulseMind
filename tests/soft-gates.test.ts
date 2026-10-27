/**
 * The two soft gates (2026-10-27): manual discipline echoed in the tool
 * RESULT when a call blows past it — a note, never a rejection (a legit
 * large write must not be blocked; reconcileTodo owns the todo's real state).
 *  - write >5KB → a size note after the success line;
 *  - todo_write claiming >1 in_progress → a discipline note after the snapshot.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-soft-gates-'))

const { ToolExecutor } = await import('../src/renderer/src/agent/tool-executors')
const { PlanManager } = await import('../src/renderer/src/agent/plan-manager')
const { setHost } = await import('../src/renderer/src/agent/host')
import type { ToolUseBlock, AgentMessage } from '../src/renderer/src/types/agent'

// Minimal host: writes always succeed into the void, nothing pre-exists on
// disk (so the write gate's new-file arm applies).
setHost({
  getFileStat: async () => null,
  writeFile: async () => ({ success: true }),
} as never)

// ── write >5KB note ────────────────────────────────────────────────────────

const WS = '/ws'
let ex: InstanceType<typeof ToolExecutor>
let lastResult: { content: string; isError: boolean } | null = null

beforeEach(() => {
  ex = new ToolExecutor(
    { workspaceDir: WS, platformInfo: { platform: 'darwin' } } as never,
    new Map(), {} as never, {} as never, () => {}, () => {},
  )
  // capture the MODEL-facing result text (the note rides addToolResult, not
  // the card's t.output preview)
  ;(ex as unknown as { addToolResult: unknown }).addToolResult = (
    _id: string, content: string, isError: boolean,
  ) => { lastResult = { content, isError } }
  lastResult = null
})

const doWrite = async (content: string): Promise<ToolUseBlock> => {
  const t = { type: 'tool_use', id: 't_write', name: 'write', input: { file_path: 'out.md', content }, status: 'queued' } as ToolUseBlock
  await ex.execWorkspaceTool(t)
  return t
}

describe('write size soft gate', () => {
  it('a >5KB write succeeds and carries the discipline note', async () => {
    const big = 'x'.repeat(6 * 1024)
    const t = await doWrite(big)
    expect(t.exitCode).toBe(0)
    expect(lastResult?.isError).toBe(false)
    expect(lastResult?.content).toContain('6 KB in one call')
    expect(lastResult?.content).toContain('under 5KB per write')
  })

  it('a small write gets no note', async () => {
    const t = await doWrite('hello')
    expect(t.exitCode).toBe(0)
    expect(lastResult?.content).toBe(`Written 5 bytes to ${WS}/out.md`)
  })
})

// ── todo_write multi-in_progress note ─────────────────────────────────────

const messages: AgentMessage[] = []
const results: Array<{ content: string; isError: boolean }> = []
const todoCall = (input: Record<string, unknown>): ToolUseBlock =>
  ({ type: 'tool_use', id: 't_todo', name: 'todo_write', input, status: 'pending' }) as ToolUseBlock

function makeManager(): InstanceType<typeof PlanManager> {
  return new PlanManager(
    (_id, content, isError) => results.push({ content, isError }),
    () => {},
    () => messages,
    () => {},
    () => [],
  )
}

describe('todo_write in_progress soft gate', () => {
  beforeEach(() => { results.length = 0; messages.length = 0 })

  it('several in_progress claims draw the one-at-a-time note', async () => {
    const mgr = makeManager()
    await mgr.execTodoWrite(todoCall({
      objective: 'ship',
      items: [
        { description: 'a', status: 'in_progress' },
        { description: 'b', status: 'in_progress' },
        { description: 'c' },
      ],
    }))
    expect(results[0].isError).toBe(false)
    expect(results[0].content).toContain('2 steps claim in_progress')
    expect(results[0].content).toContain('exactly one step')
  })

  it('a single in_progress claim stays note-free', async () => {
    const mgr = makeManager()
    await mgr.execTodoWrite(todoCall({
      objective: 'ship',
      items: [{ description: 'a', status: 'in_progress' }, { description: 'b' }],
    }))
    expect(results[0].isError).toBe(false)
    expect(results[0].content).not.toContain('claim in_progress')
  })
})
