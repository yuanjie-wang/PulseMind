// spawn_agent's round envelope budget (0.4.1): a wide parallel dispatch used
// to append up to 4k tokens PER envelope into ONE collector user message —
// ~44k for 11 experts — which sits inside every compaction layer's protection
// window (nanoCompact needs 20+ spawn calls before compressing one), so the
// next request went out oversized and the provider rejected it. The round's
// envelopes now split one shared allowance.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnEnvelopeBudget } from '../src/renderer/src/agent/executors/spawn-tool'
import { MAX_TOOL_RESULT_TOKENS, SPAWN_ROUND_ENVELOPE_BUDGET, MIN_SPAWN_ENVELOPE_BUDGET } from '../src/renderer/src/agent/engine/engine-constants'

const src = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

describe('spawnEnvelopeBudget', () => {
  it('a lone spawn keeps the full single-result cap', () => {
    expect(MAX_TOOL_RESULT_TOKENS).toBe(4_000)
    expect(spawnEnvelopeBudget(1)).toBe(MAX_TOOL_RESULT_TOKENS)
    expect(spawnEnvelopeBudget(3)).toBe(MAX_TOOL_RESULT_TOKENS) // 12000/3, clamped up
  })

  it('a wide batch splits the round budget, floored so a gist survives', () => {
    expect(spawnEnvelopeBudget(11)).toBe(Math.floor(SPAWN_ROUND_ENVELOPE_BUDGET / 11))
    expect(spawnEnvelopeBudget(50)).toBe(MIN_SPAWN_ENVELOPE_BUDGET)
  })

  it('never exceeds the single-result cap and never grows with the batch', () => {
    let prev = MAX_TOOL_RESULT_TOKENS
    for (let n = 1; n <= 60; n++) {
      const b = spawnEnvelopeBudget(n)
      expect(b).toBeLessThanOrEqual(MAX_TOOL_RESULT_TOKENS)
      expect(b).toBeLessThanOrEqual(prev)
      expect(b).toBeGreaterThanOrEqual(MIN_SPAWN_ENVELOPE_BUDGET)
      prev = b
    }
  })

  it('degenerate inputs read as a single dispatch', () => {
    expect(spawnEnvelopeBudget(0)).toBe(MAX_TOOL_RESULT_TOKENS)
    expect(spawnEnvelopeBudget(NaN)).toBe(MAX_TOOL_RESULT_TOKENS)
  })
})

describe('envelope budget wiring (source scans)', () => {
  it('the engine exposes the round\'s spawn count to the executor', () => {
    const engine = src('src/renderer/src/agent/AgentEngine.ts')
    expect(engine).toContain('countRoundSpawnCalls')
    expect(engine).toContain('() => this.countRoundSpawnCalls()')
  })

  it('spawn-tool passes the budget as addToolResult\'s maxTokens override', () => {
    const spawn = src('src/renderer/src/agent/executors/spawn-tool.ts')
    expect(spawn).toContain('spawnEnvelopeBudget(ex.spawnBatchTotal?.() ?? 1)')
    // both envelope calls (verbatim + full) carry the budget — v2 removed the
    // separate split envelopes (the split rides the standard envelope as a
    // note); create_sub_plan's own envelope is small and fixed-shaped.
    expect(spawn.match(/undefined,\s*\n?\s*envelopeBudget/g)?.length).toBe(2)
    expect(spawn).toContain(', undefined, envelopeBudget)')
  })
})
