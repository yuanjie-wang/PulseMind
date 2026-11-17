/**
 * The window a REQUEST may actually fill — the input side only.
 *
 * A provider's context window is shared between input and output: a request
 * that sends N input tokens also asks for up to `max_tokens` output, and the
 * provider rejects the pair once N + max_tokens exceeds the window. Every
 * compaction gate in this engine compares usage against the window, so dividing
 * by the raw total is off by exactly the output reservation. At a 200K window
 * with a 32K ask, hard's passive 0.9× trigger fires at 180K and the next
 * request demands 212K — a guaranteed 400, and one that gets WORSE as max_tokens
 * grows, which is the opposite of what a bigger output allowance should mean.
 *
 * `opts.contextLength` therefore keeps meaning "the provider's total window":
 * that is what stream-runner's re-aim parses out of a provider error, and what
 * the context ring and the gauge show the user. This module is the one place
 * that converts it into the budget the gates may spend, so the reduction cannot
 * drift between its consumers: AgentEngine reaches it through one private
 * `inputWindow` getter (three gates) and one direct call (request-build, which
 * must read the caller's `opts` rather than `this.opts`).
 */

/** Assumed output ask when the caller cannot say what the model's limit is.
 *  Mirrors the main process's options assembly — `profile.maxTokens ?? 32768`
 *  (session-manager.ts, both call sites) — NOT ZCode's 32_000: a profile-backed
 *  session never hands the engine "unknown", so callers that read profiles on
 *  their own (the context ring's resolveMaxTokens) must fall back to the SAME
 *  number or the tick drifts off the engine's real boundary by the difference
 *  (768 tokens was a real review finding, 2026-11-17). */
export const DEFAULT_OUTPUT_RESERVE = 32_768

/**
 * The input-side budget for a total window of `contextLength`.
 *
 * THE RESERVE EQUALS THE ASK. ZCode caps its reservation at 21K
 * (`min(maxOutputTokens ?? 32_000, 21_000)` in compact/policy.ts), and that is
 * only sound because it ALSO clamps the outgoing `max_tokens` to the same 21K.
 * PulseMind writes no `max_tokens` at all (verified: stream-runner only READS
 * `stopReason === 'max_tokens'`), so it always asks for the full `opts.maxTokens`
 * — copying the cap alone reserves 21K while demanding 32K and overflows by the
 * difference. A cap here would need the wire clamp to go with it.
 *
 * What remains is a proportionality guard: the reserve may never exceed half
 * the window. Beyond half there is no input budget left to protect — the model
 * cannot both read its prompt and answer it — and a 0 budget is actively worse
 * than a small one, because every gate divides by it (`tokens < 0 * ratio` is
 * never true, so a post-turn prewarm would fire on every single round).
 */
export function effectiveInputWindow(contextLength: number, maxTokens?: number): number {
  const asked = typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_OUTPUT_RESERVE
  const reserve = Math.min(asked, Math.floor(contextLength / 2))
  return Math.max(0, contextLength - reserve)
}
