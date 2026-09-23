// ── Context-size estimation: one shared contract ──
// Two readers hang off these numbers and they must never drift: the
// compactor's trigger chain (lightCompact / hardTruncate decide whether the
// next request fits) and the composer's context ring (what the user is shown).
// Until the 0.4.1 fix the ring read the last request's raw prompt_tokens while
// the compactor estimated chars/3.5 — both blind to everything appended AFTER
// the last successful request (one 11-wide spawn batch appends up to ~44k
// tokens in a single round, and a rejected request never stamps a new report,
// so the ring froze at the pre-batch value), and both undercounting CJK text
// ~3x (real Chinese is ~1-1.7 chars per token, not 3.5). The estimator is
// therefore CJK-aware, and the tail after a real token report is estimated
// with the same rule.

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
 *  report contributes it directly (providers exclude thinking / tool_use input
 *  from completion_tokens, so those blocks are still counted explicitly). */
export function estimateMessagesTokens(messages: AgentMessage[]): number {
  let total = 0
  for (const msg of messages) {
    if (msg.outputTokens) {
      total += msg.outputTokens
      for (const block of msg.contentBlocks) {
        if (block.type === 'text') continue // outputTokens already covers text
        if (block.type === 'tool_use') total += estimateTextTokens(JSON.stringify(block.input) + block.name)
        else if (block.type === 'thinking') total += estimateTextTokens((block as ThinkingBlock).thinking)
      }
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
 *  because a report already priced those bytes. */
export function contextTokensOf(messages: AgentMessage[], fixedOverhead = 0): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messages[i].inputTokens
    if (t && t > 0) {
      return Math.max(t + estimateMessagesTokens(messages.slice(i + 1)), estimateMessagesTokens(messages))
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
