import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same HOME sandbox as turn-duration.test.ts — the engine import chain touches
// real stores, and a test must never write into the user's live ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-phantom-approval-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')

import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'
import type { AgentMessage, ContentBlock, ToolUseBlock } from '../src/renderer/src/types/agent'

/** Construction-time cache warming pokes the host; nothing here needs it. */
const { setHost } = await import('../src/renderer/src/agent/host')
setHost(new Proxy({}, { get: () => () => Promise.resolve([] as unknown[]) }) as never)

const NOW = '2026-09-25T10:00:00.000Z'

function makeEngine(approvalMode: 'auto' | 'outside-ask'): InstanceType<typeof AgentEngine> {
  const engine = new AgentEngine({
    apiKey: 'test-key', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 1024,
    myName: 'tester', soul: '', yourName: 'user',
    adapter: {} as never, // never exercised: continueLoop is stubbed out below
    toolManager: new ToolManager() as never, skillManager: new SkillManager() as never,
    conversationId: 'conv_phantom_approval',
    approvalMode,
  } as unknown as AgentEngineOptions)
  engine.continueLoop = async (): Promise<void> => {}
  return engine
}

/**
 * 用户反馈 2026-09-25：「即使权限设为完全访问，权限审批框也会先出现，再自动消失」。
 *
 * Two defects painted the approval ladder for a call it never held:
 *  - the pre-dispatch marking enumerated the auto-run groups and skipped
 *    otherTools (shell exec) and gated MCP, so at 'auto' those executed while
 *    still wearing the stream's 'pending';
 *  - addToolResult parked the engine on awaiting_approval after EVERY result
 *    in a batch, without checking the remaining calls were actually held.
 * Together: batch [read, exec] — the read's result parked the engine while the
 * exec block was still 'pending', the UI derived heldCalls from exactly that
 * pair, and the box vanished the moment execOtherTool started and wrote
 * 'running'. The UI rule itself (heldCalls = pending && parked, ApprovalArea /
 * ExecutionSegment) is unchanged; what the engine must guarantee is that the
 * pair never occurs unless the ladder really is holding a call.
 */
describe('auto mode must never paint the approval ladder mid-batch', () => {
  /** Drive the real handleToolUseResponse over a [read, exec] batch whose read
   *  completes inside dispatch and whose exec is still draining at the tail. */
  async function runBatch(mode: 'auto' | 'outside-ask') {
    const engine = makeEngine(mode)
    const readBlock: ToolUseBlock = { type: 'tool_use', id: 't_read', name: 'read', input: { path: 'a.txt' }, status: 'pending' }
    const execBlock: ToolUseBlock = { type: 'tool_use', id: 't_exec', name: 'exec', input: { command: 'ls' }, status: 'pending' }
    const assistantMsg: AgentMessage = { id: 'a1', role: 'assistant', contentBlocks: [readBlock, execBlock], createdAt: NOW }
    engine.messages = [{ id: 'u1', role: 'user', contentBlocks: [{ type: 'text', text: '看看再跑' } as ContentBlock], createdAt: NOW }, assistantMsg]

    // Snapshot the exact pair the UI derives heldCalls from, at every notify.
    const seen: Array<{ status: string; exec: ToolUseBlock['status'] }> = []
    engine.notify = () => { seen.push({ status: engine.agentStatus.status, exec: execBlock.status }) }

    engine.toolExecutor.execReadOnlyTools = async (tools: ToolUseBlock[]) => {
      for (const t of tools) { t.status = 'completed'; t.exitCode = 0; t.output = 'file body' }
      engine.addToolResult(tools[0].id, 'file body', false) // mid-batch: exec still in pendingToolIds
    }
    engine.toolExecutor.execOtherTool = async (t: ToolUseBlock) => { t.status = 'running' } // never settles

    await engine.handleToolUseResponse([readBlock, execBlock])
    return { engine, seen, readBlock, execBlock }
  }

  it('auto: the exec call leaves pending from the first notify and the engine never parks', async () => {
    const { engine, seen, execBlock } = await runBatch('auto')

    expect(seen.length).toBeGreaterThan(0)
    // The pre-dispatch marking owns the status now — a call that executes
    // immediately must not sit at the stream's 'pending' for even one notify.
    // It is marked 'queued' (accepted, hourglass) rather than 'running':
    // the executor's own entry mark is what flips it to actually executing
    // (2026-09-30, 排队中/执行中 split) — the stub below writes 'running'
    // exactly where the real execOtherTool entry does.
    expect(seen[0].exec).toBe('queued')
    // No result landing mid-batch may flip the park on in unrestricted mode.
    expect(seen.every(s => s.status !== 'awaiting_approval')).toBe(true)
    expect(engine.agentStatus.status).not.toBe('awaiting_approval')
    expect(execBlock.status).toBe('running')
  })

  it('outside-ask (control): the same batch still parks the held exec for approval', async () => {
    const { engine, seen, execBlock } = await runBatch('outside-ask')

    // The read's result parked the engine on the held exec — the flash fix may
    // not flatten the real ladder. The parked pair is present and stays put.
    expect(seen.some(s => s.status === 'awaiting_approval' && s.exec === 'pending')).toBe(true)
    expect(engine.agentStatus.status).toBe('awaiting_approval')
    expect(execBlock.status).toBe('pending')
  })
})
