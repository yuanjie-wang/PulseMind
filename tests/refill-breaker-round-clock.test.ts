import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same HOME sandbox as auto-mode-phantom-approval.test.ts — the engine import
// chain touches real stores, and a test must never write into the user's live
// ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-refill-clock-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')

import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'
import type { AgentMessage, ContentBlock, ToolUseBlock } from '../src/renderer/src/types/agent'

/** Construction-time cache warming pokes the host; nothing here needs it. */
const { setHost } = await import('../src/renderer/src/agent/host')
setHost(new Proxy({}, { get: () => () => Promise.resolve([] as unknown[]) }) as never)

const NOW = '2026-09-30T10:00:00.000Z'

function makeEngine(approvalMode: 'auto' | 'outside-ask'): InstanceType<typeof AgentEngine> {
  const engine = new AgentEngine({
    apiKey: 'test-key', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 1024,
    myName: 'tester', soul: '', yourName: 'user',
    adapter: {} as never, // never exercised: continueLoop is stubbed out below
    toolManager: new ToolManager() as never, skillManager: new SkillManager() as never,
    conversationId: 'conv_refill_clock',
    approvalMode,
  } as unknown as AgentEngineOptions)
  engine.continueLoop = async (): Promise<void> => {}
  return engine
}

// ── review_20260930 中2: the refill breaker's round clock must see one tick
// per model round whose tool results landed, on EVERY landing shape. The
// measured facts this pins: an approval-driven round ticks at its dispatch
// tail (the held results land after the click, but the only reader —
// evaluateRefillBreaker — runs at the next request build, after the landing),
// and the two synthetic batches that never enter dispatch tick explicitly.

describe('refill breaker round clock covers every landing path', () => {
  it('an approval-driven round ticks exactly once (dispatch tail; the landing adds no second tick)', async () => {
    const engine = makeEngine('outside-ask')
    const execBlock: ToolUseBlock = { type: 'tool_use', id: 't_exec', name: 'exec', input: { command: 'ls' }, status: 'pending' }
    const assistantMsg: AgentMessage = { id: 'a1', role: 'assistant', contentBlocks: [execBlock], createdAt: NOW }
    engine.messages = [{ id: 'u1', role: 'user', contentBlocks: [{ type: 'text', text: 'run it' } as ContentBlock], createdAt: NOW }, assistantMsg]
    engine.notify = () => {}

    await engine.handleToolUseResponse([execBlock])
    expect(engine.agentStatus.status).toBe('awaiting_approval')
    expect(engine.compactTracking.toolRoundsSinceDrop).toBe(1)

    // The approval's landing (what approveTool's executor eventually calls)
    // must not double-count the round.
    engine.addToolResult(execBlock.id, 'done', false)
    expect(engine.compactTracking.toolRoundsSinceDrop).toBe(1)
  })

  it('a max_tokens synthetic batch ticks like its truncated sibling', async () => {
    const engine = makeEngine('auto')
    const block: ToolUseBlock = { type: 'tool_use', id: 't_max', name: 'exec', input: { command: 'ls' }, status: 'completed' }
    engine.messages = [{ id: 'a1', role: 'assistant', contentBlocks: [block], createdAt: NOW }]
    engine.notify = () => {}

    await engine.handleMaxTokensResponse([block])
    expect(engine.compactTracking.toolRoundsSinceDrop).toBe(1)
  })

  it('an all-oversized batch (every call rejected, none dispatched) ticks', async () => {
    const engine = makeEngine('auto')
    const big = 'x'.repeat(600_000)
    const block: ToolUseBlock = { type: 'tool_use', id: 't_big', name: 'write', input: { file_path: 'a.txt', content: big }, status: 'pending' }
    engine.messages = [{ id: 'a1', role: 'assistant', contentBlocks: [block], createdAt: NOW }]
    engine.notify = () => {}

    await engine.handleToolUseResponse([block])
    expect(engine.compactTracking.toolRoundsSinceDrop).toBe(1)
  })
})
