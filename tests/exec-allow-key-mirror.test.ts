import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same HOME sandbox as auto-mode-phantom-approval.test.ts — the engine import
// chain touches real stores, and a test must never write into the user's live
// ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-exec-allow-key-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')

import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'
import type { AgentMessage, ContentBlock, ToolUseBlock } from '../src/renderer/src/types/agent'
import { messageContentSignature } from '../src/shared/agent-session/message-content'
import { applySessionEvent, freshSessionState } from '../src/shared/agent-session/mirror'

/** Construction-time cache warming pokes the host; nothing here needs it. */
const { setHost } = await import('../src/renderer/src/agent/host')
setHost(new Proxy({}, { get: () => () => Promise.resolve([] as unknown[]) }) as never)

const NOW = '2026-09-28T10:00:00.000Z'

function makeEngine(): InstanceType<typeof AgentEngine> {
  const engine = new AgentEngine({
    apiKey: 'test-key', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 1024,
    myName: 'tester', soul: '', yourName: 'user',
    adapter: {} as never, // never exercised: continueLoop is stubbed out below
    toolManager: new ToolManager() as never, skillManager: new SkillManager() as never,
    conversationId: 'conv_exec_allow_key',
    approvalMode: 'outside-ask',
  } as unknown as AgentEngineOptions)
  engine.continueLoop = async (): Promise<void> => {}
  return engine
}

/**
 * review_20260928 高1: the 本会话总是允许 stamp was written IN PLACE onto the
 * stream's tool_use blocks — after `stream-runner` had already appended them to
 * a message and notified, and after `messageContentSignature` had cached those
 * block objects' signatures in its WeakMap. An in-place write never re-signed
 * the message, so no `messages_update` ever shipped, the desktop mirror (a
 * protocol client) never saw `_allowKey`, and the third approval button only
 * ever appeared through a snapshot re-hydration (切走会话再切回来).
 *
 * The contract this test pins is the full wire chain, each link REAL:
 * engine stamping rebuilds the block → the message's content signature CHANGES
 * (exactly what `emitMessagesInner` diffs into a `messages_update`) → the real
 * `applySessionEvent` fold delivers `_allowKey` onto the mirrored block, which
 * is what ApprovalArea renders the third button from.
 */
describe('the 本会话总是允许 stamp must reach a mirror client', () => {
  async function runHeldBatch() {
    const engine = makeEngine()
    const lsBlock: ToolUseBlock = { type: 'tool_use', id: 't_ls', name: 'exec', input: { command: 'ls' }, status: 'pending' }
    const bashBlock: ToolUseBlock = { type: 'tool_use', id: 't_bash', name: 'exec', input: { command: 'bash -c "echo hi"' }, status: 'pending' }
    const assistantMsg: AgentMessage = { id: 'a1', role: 'assistant', contentBlocks: [lsBlock, bashBlock], createdAt: NOW }
    engine.messages = [
      { id: 'u1', role: 'user', contentBlocks: [{ type: 'text', text: 'run these' } as ContentBlock], createdAt: NOW },
      assistantMsg,
    ]
    // What the stream-append notify registered: the message's signature BEFORE
    // stamping, computed off the raw stream objects.
    const signatureBefore = messageContentSignature(assistantMsg)
    // Mirror what a client held after that append.
    const state = freshSessionState()
    applySessionEvent(state, { type: 'messages_append', fromIndex: 0, items: [structuredClone(engine.messages[0]), structuredClone(assistantMsg)] })

    await engine.handleToolUseResponse([lsBlock, bashBlock])
    return { engine, state, lsBlock, bashBlock, signatureBefore }
  }

  it('stamping rebuilds the block, re-signs the message, and the mirror fold carries _allowKey', async () => {
    const { engine, lsBlock, bashBlock, signatureBefore } = await runHeldBatch()

    // The ladder really held both calls.
    expect(engine.agentStatus.status).toBe('awaiting_approval')

    const msgNow = engine.messages.find(m => m.id === 'a1') as AgentMessage
    // THE contract: emitMessagesInner diffs messageContentSignature — a changed
    // signature IS a messages_update on the wire. (The old in-place stamp left
    // this identical, which is why the button never rendered live.)
    expect(messageContentSignature(msgNow)).not.toBe(signatureBefore)

    // The storable command's block was REPLACED, not edited: fresh identity is
    // what re-signs, and the engine must hold the SAME object the message does,
    // so executor status writes land on the block the mirror patches by id.
    const lsNow = msgNow.contentBlocks[0] as ToolUseBlock
    expect(lsNow).not.toBe(lsBlock)
    expect((lsNow as { _allowKey?: string })._allowKey).toBe('ls')
    expect(engine.toolUseBlocks[0]).toBe(lsNow)

    // `bash -c` keys as null (review_20260928 高2): no stamp, identity untouched
    // — the third button must not exist for it.
    const bashNow = msgNow.contentBlocks[1] as ToolUseBlock
    expect(bashNow).toBe(bashBlock)
    expect((bashNow as { _allowKey?: string })._allowKey).toBeUndefined()
  })

  it('folding the updated message onto the mirror block yields the button data', async () => {
    const { engine, state } = await runHeldBatch()
    const msgNow = engine.messages.find(m => m.id === 'a1') as AgentMessage

    // The fold is the real shared reducer (desktop chat / tool studio / panel).
    applySessionEvent(state, { type: 'messages_update', items: [structuredClone(msgNow)] })

    const mirrored = state.messages[1].contentBlocks[0] as ToolUseBlock
    expect((mirrored as { _allowKey?: string })._allowKey).toBe('ls')
  })
})
