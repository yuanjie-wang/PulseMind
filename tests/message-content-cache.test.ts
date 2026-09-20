// PLAN-long-task-perf M2-T1 — the block-level signature cache in
// message-content.ts. The safety nets (message-content-roundtrip,
// session-mirror, terminal-status-sweep) prove the diff channels still work;
// these tests pin the CACHE's own contract: identity-keyed, exclusion-aware.
import { describe, expect, it, vi } from 'vitest'
import { messageContentSignature } from '../src/shared/agent-session/message-content'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const msg = (id: string, blocks: ContentBlock[]): AgentMessage =>
  ({ id, role: 'assistant', createdAt: '2026-09-20T10:00:00.000Z', contentBlocks: blocks })

describe('block signature cache (M2-T1)', () => {
  it('does not re-stringify a block it has already signed (the B1 fix, observable)', () => {
    // A tool_use block: its signature IS a JSON.stringify of its stripped
    // content copy, so a cache miss is visible as a stringify call and a hit
    // as zero. (The join itself is not a stringify, by design.)
    const block: ContentBlock = { type: 'tool_use', id: 't1', name: 'read', input: { file_path: '/w/a.ts' }, output: 'x'.repeat(1000), status: 'completed', exitCode: 0 }
    const message = msg('m1', [block])
    messageContentSignature(message)
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      messageContentSignature(message)
      // ZERO stringify calls on the second signing: the block sig comes from
      // the WeakMap and the message signature is a plain join — the old code
      // (and any wrapper-stringify regression) makes at least one.
      expect(stringify).toHaveBeenCalledTimes(0)
    } finally {
      stringify.mockRestore()
    }
  })

  it('re-stringifies a REBUILT block, and the signature still equals the original', () => {
    const block: ContentBlock = { type: 'text', text: 'same' }
    const before = messageContentSignature(msg('m1', [block]))
    const rebuilt: ContentBlock = { type: 'text', text: 'same' }
    const after = messageContentSignature(msg('m1', [rebuilt]))
    expect(before).toBe(after)
  })

  it('in-place RUNTIME writes do not move the signature (the exclusion contract, enforced)', () => {
    const block: ContentBlock = { type: 'tool_use', id: 't1', name: 'exec', input: { command: 'ls' } }
    const message = msg('m1', [block])
    const before = messageContentSignature(message)
    // The exact in-place writes the engine performs (approveTool, addToolResult):
    ;(block as { status?: string }).status = 'completed'
    ;(block as { exitCode?: number }).exitCode = 0
    ;(block as { output?: string }).output = 'x'.repeat(5000)
    ;(block as { subConvId?: string }).subConvId = 'sub_1'
    expect(messageContentSignature(message)).toBe(before)
  })

  it('in-place CONTENT writes are masked too — which is precisely why the engine may never make them (E4, documented)', () => {
    const block: ContentBlock = { type: 'text', text: 'before' }
    const message = msg('m1', [block])
    const before = messageContentSignature(message)
    ;(block as { text: string }).text = 'mutated in place'
    // The cache returns the old signature for the same reference. This is the
    // sharp edge the plan's D3/E4 ruling accepts: engine content changes MUST
    // go through object rebuilds (patchToolUse's rule), or the content diff
    // channel silently misses them.
    expect(messageContentSignature(message)).toBe(before)
  })
})
