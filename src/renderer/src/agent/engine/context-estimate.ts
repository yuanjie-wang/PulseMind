// ── Context-size estimation: one shared contract ──
// Two readers hang off these numbers and they measure DIFFERENT quantities on
// purpose (conv_20260927170026, 2026-09-28): the compactor's trigger chain
// (lightCompact / hardTruncate decide whether the outgoing copy fits) must
// price the WHOLE transcript — it is the only thing standing between an
// append-only history and a provider overflow — while the composer's ring
// must show what the model actually sees, i.e. the last real request's priced
// size plus whatever accumulated since. The old single answer served neither:
// the ring took Math.max(report, full-transcript estimate), so once the
// transcript outgrew the window the ring pinned at >100% forever (775.2K
// shown against an 88K wire request) and stayed there across restarts, while
// the compactor — which NEEDS that transcript-pressure number — kept working.
// `contextTokensOf` remains the trigger-chain contract; `requestTokensOf` is
// the ring's.
//
// The estimator itself is CJK-aware (the 0.4.1 ring froze at 35% on a
// chars/3.5 estimate while real Chinese is ~1-1.7 chars per token). One more
// correction from the same conversation: providers INCLUDE thinking and
// tool-call arguments in their completion/output reports (DeepSeek's
// completion_tokens covered a 29.5k-char thinking block as output_tokens=
// 14242; OpenAI details reasoning_tokens as a breakdown of completion), so a
// message carrying a real report contributes that report ALONE — the old
// explicit per-block additions double-counted ~300k tokens of thinking in a
// long reasoning session.

import type { AgentMessage, ToolResultBlock, ThinkingBlock } from '../../types/agent'

const CJK_PATTERN = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g

/** Rough token estimate for one string: CJK chars ≈ 1 token, everything else
 *  ≈ 1 token per 4 chars. The length diff of a CJK-stripped copy avoids the
 *  per-match array a global `.match()` builds for megabyte strings. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  const cjk = text.length - text.replace(CJK_PATTERN, '').length
  return cjk + Math.ceil((text.length - cjk) / 4)
}

/** Token estimate over a message list. A message carrying a real outputTokens
 *  report contributes it directly and ALONE — completion/output reports
 *  already price the text, the thinking and the tool-call arguments (see the
 *  header). Only report-less messages estimate block by block. */
export function estimateMessagesTokens(messages: AgentMessage[]): number {
  let total = 0
  for (const msg of messages) {
    if (msg.outputTokens) {
      total += msg.outputTokens
      continue
    }
    for (const block of msg.contentBlocks) {
      if (block.type === 'text') total += estimateTextTokens(block.text)
      else if (block.type === 'tool_use') total += estimateTextTokens(JSON.stringify(block.input) + block.name)
      else if (block.type === 'tool_result') total += estimateTextTokens((block as ToolResultBlock).content)
      else if (block.type === 'thinking') total += estimateTextTokens((block as ThinkingBlock).thinking)
    }
  }
  return total
}

/** Whole-context estimate: prefer the latest real inputTokens report (it covers
 *  everything up to the message carrying it), estimate just the tail after it —
 *  a spawn batch or a new user turn appended since is invisible to that report
 *  — and guard with the full heuristic so a stale post-compaction report can
 *  never read smaller than the history actually holds. `fixedOverhead` (system
 *  prompt + tool schemas) only applies when no real report anchors the number,
 *  because a report already priced those bytes.
 *
 *  This transcript-pressure reading is the COMPACTOR's contract, not the
 *  ring's — the max-guard is what pins the number at "whole transcript" once
 *  the history outgrows the window, which is exactly the pressure the copy
 *  pipeline must react to. See `requestTokensOf` for the display-side reader. */
export function contextTokensOf(messages: AgentMessage[], fixedOverhead = 0): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messages[i].inputTokens
    if (t && t > 0) {
      return Math.max(t + estimateMessagesTokens(messages.slice(i + 1)), estimateMessagesTokens(messages))
    }
  }
  return estimateMessagesTokens(messages) + fixedOverhead
}

/** What the model actually sees: the last REAL request's priced size plus the
 *  CJK-aware estimate of whatever was appended since. The anchor is persisted
 *  on the message row (`input_tokens`), so the number survives a restart — the
 *  full-transcript fallback never kicks in for a conversation that has made
 *  even one request. This is the context ring's reader; deliberately NOT the
 *  max-guarded `contextTokensOf`, whose whole-transcript guard is the
 *  compactor's trigger input and read 775K against an 88K wire request
 *  (conv_20260927170026). Slightly over-reads between a big tail landing and
 *  the next compaction pass — that is honest: it is the size the next request
 *  WOULD have, before the copy pipeline cuts it. */
export function requestTokensOf(messages: AgentMessage[], fixedOverhead = 0): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messages[i].inputTokens
    if (t && t > 0) {
      return t + estimateMessagesTokens(messages.slice(i + 1))
    }
  }
  return estimateMessagesTokens(messages) + fixedOverhead
}

// ── Provider context-overflow rejection ────────────────────────────────
// The ring and the trigger chain are estimates; the provider's own 400 is the
// ground truth. Classify it and parse the named limit so prepareLoopRequest
// can force the request under it instead of re-sending the same payload.

const CONTEXT_OVERFLOW_PATTERN = /(maximum context length|context length|prompt is too long|too many (input )?tokens|input (length|tokens).{0,20}exceed|.{0,8}exceed.{0,20}context|上下文.{0,8}(超长|超限|过长|超出)|长度超过)/i

/** True when an error message reads as a provider context-overflow rejection —
 *  separate from parseContextOverflowLimit because a rejection that names no
 *  number still must trigger the rescue (the caller then halves its
 *  configured contextLength). */
export function isContextOverflowRejection(message: string): boolean {
  return CONTEXT_OVERFLOW_PATTERN.test(message)
}

/** The token limit a provider names in its context-overflow rejection, or null
 *  when the message names no number (the caller falls back to half the
 *  configured contextLength). Numbers are read only from length/token context
 *  so a request id or timestamp in the same message cannot win, and the
 *  SMALLEST one wins because OpenAI-style messages name the limit first and
 *  the actual size second ("maximum context length is 65536 tokens. However,
 *  your messages resulted in 70040"). */
export function parseContextOverflowLimit(message: string): number | null {
  if (!CONTEXT_OVERFLOW_PATTERN.test(message)) return null
  const numbers: number[] = []
  for (const segment of message.split(/[\n。；,;:!！?？()（）]/)) {
    if (!/token|length|长度|上下文|context/i.test(segment)) continue
    for (const m of segment.matchAll(/\d{3,}/g)) {
      const n = Number(m[0])
      if (n >= 256) numbers.push(n)
    }
  }
  return numbers.length > 0 ? Math.min(...numbers) : null
}
