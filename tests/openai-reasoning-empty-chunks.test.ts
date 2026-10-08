import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same HOME sandbox rule as the engine tests — the import chain touches stores.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-openai-reasoning-'))

const { openaiAdapter } = await import('../src/renderer/src/llm/OpenAIAdapter')

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

/**
 * The opencode zen gateway keeps the `reasoning_content` FIELD on every chunk
 * and sends an EMPTY STRING once the real reasoning is over (2026-10-08, user
 * report 「满屏 thinking」: one reply rendered one EMPTY Thinking bar per
 * content delta — 70 empty-string chunks in a single round). The adapter must
 * open a thinking block on real reasoning only; empty strings are noise.
 */

function pump(chunks: string[]): { thinking: string[]; text: string[]; emptyThinkingBlocks: number } {
  const blocks: Array<{ type: string; thinking?: string; text?: string }> = []
  let finished = false
  const parser = openaiAdapter.createStreamParser({
    onContentBlockStart: (_i, b) => { blocks.push({ ...b } as { type: string }) },
    onContentBlockDelta: (i, d) => {
      const block = blocks[i] as { thinking?: string; text?: string }
      if (d.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + d.thinking
      if (d.type === 'text_delta') block.text = (block.text ?? '') + d.text
    },
    onContentBlockStop: () => {},
    onStreamComplete: () => { finished = true },
  })
  for (const c of chunks) parser.processChunk(c)
  parser.flush()
  expect(finished).toBe(true)
  return {
    thinking: blocks.filter(b => b.type === 'thinking').map(b => b.thinking ?? ''),
    text: blocks.filter(b => b.type === 'text').map(b => b.text ?? ''),
    emptyThinkingBlocks: blocks.filter(b => b.type === 'thinking' && !(b.thinking ?? '').trim()).length,
  }
}

describe('OpenAI stream parser: empty-string reasoning_content opens nothing', () => {
  it('real reasoning opens ONE block; empty-string chunks on content deltas open none', () => {
    const chunks = [
      // the real reasoning phase
      sse({ choices: [{ delta: { reasoning_content: '先核对数据源。' } }] }),
      sse({ choices: [{ delta: { reasoning_content: '再交叉验证。' } }] }),
      // the gateway's tail shape: every content chunk still carries the field, as ""
      sse({ choices: [{ delta: { reasoning_content: '', content: '老' } }] }),
      sse({ choices: [{ delta: { reasoning_content: '', content: '大，查好了' } }] }),
      sse({ choices: [{ delta: { reasoning_content: '', content: '。' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
      'data: [DONE]\n\n',
    ]
    const r = pump(chunks)
    expect(r.thinking).toHaveLength(1)
    expect(r.thinking[0]).toBe('先核对数据源。再交叉验证。')
    expect(r.emptyThinkingBlocks).toBe(0)
    expect(r.text.join('')).toBe('老大，查好了。')
  })

  it('reasoning-only round still works (the thinking-only retry shape)', () => {
    const r = pump([
      sse({ choices: [{ delta: { reasoning_content: '我停止思考，正式输出。' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      'data: [DONE]\n\n',
    ])
    expect(r.thinking).toHaveLength(1)
    expect(r.thinking[0]).toContain('我停止思考')
    expect(r.text.join('')).toBe('')
  })
})
