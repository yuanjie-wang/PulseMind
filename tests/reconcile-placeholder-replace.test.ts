import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same HOME sandbox as auto-mode-phantom-approval.test.ts — the engine import
// chain touches real stores, and a test must never write into the user's live
// ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-reconcile-replace-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')

import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'
import type { ContentBlock, ToolResultBlock, ToolUseBlock } from '../src/renderer/src/types/agent'

/** Construction-time cache warming pokes the host; nothing here needs it. */
const { setHost } = await import('../src/renderer/src/agent/host')
setHost(new Proxy({}, { get: () => () => Promise.resolve([] as unknown[]) }) as never)

const NOW = '2026-10-25T10:00:00.000Z'

function makeEngine(): InstanceType<typeof AgentEngine> {
  const engine = new AgentEngine({
    apiKey: 'test-key', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 1024,
    myName: 'tester', soul: '', yourName: 'user',
    adapter: {} as never, // never exercised: continueLoop is stubbed out below
    toolManager: new ToolManager() as never, skillManager: new SkillManager() as never,
    conversationId: 'conv_reconcile_replace',
  } as unknown as AgentEngineOptions)
  engine.continueLoop = async (): Promise<void> => {}
  return engine
}

/**
 * 2026-10-25 plan-tool evaluation: a manual spawn_agent re-dispatch was
 * answered by the adapters' reconcile fabrication while the sub-agent was
 * still running — the model read "interrupted or cancelled" for work that
 * completed and wrote its report, and the real envelope was later swallowed
 * by addToolResult's duplicate guard. Two halves pin the fix:
 *  - the reconcile placeholders are status-aware and marked _synthetic
 *    (covered in llm-adapters.test.ts);
 *  - HERE: a real result arriving later REPLACES a _synthetic placeholder in
 *    place, while a duplicate of a real result is still swallowed.
 */
describe('addToolResult vs the reconcile placeholder', () => {
  it('a _synthetic placeholder is replaced in place by the real result', () => {
    const engine = makeEngine()
    const block: ToolUseBlock = { type: 'tool_use', id: 't_spawn', name: 'spawn_agent', input: { task: 'x' }, status: 'completed' }
    const placeholder: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 't_spawn',
      content: 'Tool execution is still in progress — its real result will replace this line when the call settles. Do NOT re-dispatch the same task; if nothing else remains, say so briefly and wait.',
      is_error: false,
      tool_result_id: 'ph_1',
      _synthetic: true,
    }
    engine.messages = [
      { id: 'u1', role: 'user', contentBlocks: [{ type: 'text', text: 'go' } as ContentBlock], createdAt: NOW },
      { id: 'a1', role: 'assistant', contentBlocks: [block], createdAt: NOW },
      { id: 'u2', role: 'user', contentBlocks: [placeholder], createdAt: NOW },
    ]

    engine.addToolResult('t_spawn', '## Sub-Agent Result (completed)\n\nThe sub-agent completed the delegated task.', false)

    const owner = engine.messages.find(m => m.id === 'u2')!
    const results = engine.messages.flatMap(m => m.contentBlocks.filter((b): b is ToolResultBlock => b.type === 'tool_result'))
    // Replaced, not appended: exactly one result, in the placeholder's slot.
    expect(results).toHaveLength(1)
    expect(results[0]!.content).toContain('Sub-Agent Result (completed)')
    expect(results[0]!._synthetic).toBeUndefined()
    expect(owner.contentBlocks[0]).toBe(results[0])
  })

  it('a duplicate of a REAL result is still swallowed (unchanged guard)', () => {
    const engine = makeEngine()
    const block: ToolUseBlock = { type: 'tool_use', id: 't1', name: 'read', input: {}, status: 'completed' }
    engine.messages = [
      { id: 'a1', role: 'assistant', contentBlocks: [block], createdAt: NOW },
      { id: 'u1', role: 'user', contentBlocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'first', tool_result_id: 'r1' } as ContentBlock], createdAt: NOW },
    ]

    engine.addToolResult('t1', 'second', false)

    const results = engine.messages.flatMap(m => m.contentBlocks.filter((b): b is ToolResultBlock => b.type === 'tool_result'))
    expect(results).toHaveLength(1)
    expect(results[0]!.content).toBe('first')
  })
})
