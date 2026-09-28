// The provider context-overflow rescue (0.4.1: "ring says 35%, model says
// overflow"). The provider's 400 is the only ground truth the estimates
// answer to, so stream-runner classifies the rejection, parses the named
// limit, and prepareLoopRequest forces the API copy under it via
// compactor.emergencyTruncate. The wiring is source-scanned because vitest
// here is node-env — the loop cannot be driven end to end.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isContextOverflowRejection,
  parseContextOverflowLimit,
} from '../src/renderer/src/agent/engine/context-estimate'

const src = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

describe('context-overflow classification', () => {
  it('recognises the OpenAI-style English rejection', () => {
    const msg = "This model's maximum context length is 65536 tokens. However, your messages resulted in 70040 tokens. Please reduce the length of the messages."
    expect(isContextOverflowRejection(msg)).toBe(true)
    expect(parseContextOverflowLimit(msg)).toBe(65536) // the named limit, not the 70040 actual
  })

  it('recognises the Anthropic-style rejection and takes the smaller bound', () => {
    const msg = 'prompt is too long: 210000 tokens > 200000 token maximum'
    expect(isContextOverflowRejection(msg)).toBe(true)
    expect(parseContextOverflowLimit(msg)).toBe(200000)
  })

  it('recognises a Chinese rejection', () => {
    const msg = '输入的上下文长度超限：最大 32768 个 token，当前 41000 个 token'
    expect(isContextOverflowRejection(msg)).toBe(true)
    expect(parseContextOverflowLimit(msg)).toBe(32768)
  })

  it('does not confuse a request id with the token limit', () => {
    const msg = 'context length exceeded (request req_998877), your input is too long for this model'
    expect(isContextOverflowRejection(msg)).toBe(true)
    expect(parseContextOverflowLimit(msg)).toBeNull() // no length keyword near the digits
  })

  it('leaves unrelated errors alone', () => {
    expect(isContextOverflowRejection('rate limit exceeded, retry after 30 seconds')).toBe(false)
    expect(isContextOverflowRejection('Connection reset by peer')).toBe(false)
    expect(parseContextOverflowLimit('401 Unauthorized')).toBeNull()
  })
})

describe('rescue wiring (source scans)', () => {
  it('stream-runner parks the parsed limit, retries once, and clears on success', () => {
    const runner = src('src/renderer/src/agent/engine/stream-runner.ts')
    expect(runner).toContain('isContextOverflowRejection')
    expect(runner).toContain('contextOverflowLimit = limit')
    expect(runner).toContain('contextOverflowRetries += 1')
    expect(runner).toContain('contextOverflowLimit = null')
    expect(runner).toContain('contextOverflowRetries = 0')
  })

  it('prepareLoopRequest answers the parked limit with emergencyTruncate', () => {
    const engine = src('src/renderer/src/agent/AgentEngine.ts')
    expect(engine).toContain('this.compactor.emergencyTruncate(pipelineMessages')
    // The summarizer source is the PRE-PIPELINE copy (apiMessages): the
    // dropped-region arithmetic inside (original minus kept) must span
    // emergency's drops too when the overflow flag is parked, not just
    // nano→light→hard's share of the already-truncated copy.
    expect(engine).toContain('injectHistorySummary(apiMessages')
  })

  it('the forced cut ignores the trigger thresholds that missed the overflow', () => {
    const compactor = src('src/renderer/src/agent/engine/context-compactor.ts')
    expect(compactor).toContain('emergencyTruncate(messages: AgentMessage[]')
    expect(compactor).toContain('tool_result_search')
  })

  it('a contextLength smaller than the real limit is called out', () => {
    const runner = src('src/renderer/src/agent/engine/stream-runner.ts')
    expect(runner).toContain('fix the profile\'s 上下文长度 setting')
  })
})
