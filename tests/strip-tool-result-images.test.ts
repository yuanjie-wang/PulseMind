// Contract test for `stripToolResultImages` — extracted verbatim out of
// AgentEngine.prepareLoopRequest's closure on 2026-09-21 so the per-loop-
// iteration cost could be measured on the real function
// (scripts/probe-loop-iteration-perf.mjs).
//
// The extraction itself is behaviour-identical, so these tests do not "prove a
// fix" — they pin the contract that a future change has to keep, which is
// exactly what the perf work makes tempting: the obvious next step is to
// memoise this on message identity, and the two things that would silently
// break are (a) the early-exit identity sharing the API copy relies on, and
// (b) the image placeholder the model reads. Both are asserted here.
import { describe, expect, it } from 'vitest'
import { stripToolResultImages } from '../src/renderer/src/agent/strip-tool-results'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const AT = '2026-09-21T10:00:00.000Z'
const userMsg = (blocks: ContentBlock[]): AgentMessage =>
  ({ id: 'm1', role: 'user', createdAt: AT, contentBlocks: blocks })

/** Long enough to clear `isBase64Image`'s 1000-char floor and carry a JPEG prefix. */
const jpeg = '/9j/' + 'A'.repeat(2000)
const PLACEHOLDER = `[Image data stripped: ${Math.round(jpeg.length / 1024)} KB]`

describe('stripToolResultImages', () => {
  it('returns non-user messages by reference (identity sharing the API copy relies on)', () => {
    const message: AgentMessage = { id: 'a1', role: 'assistant', createdAt: AT, contentBlocks: [{ type: 'text', text: 'hi' }] }
    expect(stripToolResultImages(message)).toBe(message)
  })

  it('returns a user message with no tool_result block by reference', () => {
    const message = userMsg([{ type: 'text', text: 'plain turn' }])
    expect(stripToolResultImages(message)).toBe(message)
  })

  it('rebuilds when a tool_result is present, without mutating the original', () => {
    const block: ContentBlock = { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }
    const message = userMsg([block])
    const out = stripToolResultImages(message)
    expect(out).not.toBe(message)
    expect(out.contentBlocks).not.toBe(message.contentBlocks)
    // The live history keeps its own object graph — nothing written in place.
    expect(message.contentBlocks[0]).toBe(block)
  })

  it('keeps non-tool_result blocks of a rebuilt message by reference', () => {
    const text: ContentBlock = { type: 'text', text: 'keep me' }
    const out = stripToolResultImages(userMsg([text, { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }]))
    expect(out.contentBlocks[0]).toBe(text)
  })

  it('replaces base64 image data inside a JSON tool_result', () => {
    const content = JSON.stringify({ ok: true, shot: jpeg, note: 'keep' })
    const out = stripToolResultImages(userMsg([{ type: 'tool_result', tool_use_id: 'tu1', content }]))
    const block = out.contentBlocks[0] as { content: string }
    const parsed = JSON.parse(block.content) as { shot: string; note: string }
    expect(parsed.shot).toBe(PLACEHOLDER)
    expect(parsed.note).toBe('keep')
    expect(block.content).not.toContain('/9j/')
  })

  it('replaces a tool_result whose content IS the base64 payload (non-JSON path)', () => {
    // JSON.parse throws on a bare base64 blob, so this goes through the catch
    // branch, where the WHOLE content is the string stripImageData inspects —
    // a payload embedded in surrounding prose would NOT be caught here.
    const out = stripToolResultImages(userMsg([{ type: 'tool_result', tool_use_id: 'tu1', content: jpeg }]))
    expect((out.contentBlocks[0] as { content: string }).content).toBe(PLACEHOLDER)
  })

  it('leaves a tool_result with no image payload textually unchanged', () => {
    const content = JSON.stringify({ ok: true, text: 'x'.repeat(2000) })
    const out = stripToolResultImages(userMsg([{ type: 'tool_result', tool_use_id: 'tu1', content }]))
    expect((out.contentBlocks[0] as { content: string }).content).toBe(content)
  })

  it('handles a tool_result with empty content', () => {
    const out = stripToolResultImages(userMsg([{ type: 'tool_result', tool_use_id: 'tu1', content: '' }]))
    expect((out.contentBlocks[0] as { content: string }).content).toBe('')
  })
})
