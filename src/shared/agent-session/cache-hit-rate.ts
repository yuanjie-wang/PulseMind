// ── Prompt-cache hit rate ──
// A session's "命中率" is only meaningful when the numerator and the
// denominator are counted over the SAME requests, in the SAME unit. Three
// traps, each of which makes a healthy session look broken:
//
//  1. Mixing sidecar traffic into the denominator. Compaction summaries, title
//     generation and sub-agent calls are one-shot prompts with no stable
//     prefix — they can never hit, so counting them drags the figure down.
//  2. Averaging per-request ratios instead of weighting by tokens. A 200-token
//     request at 0% and a 60K request at 90% are not "45%".
//  3. Double-counting the cache fields into the denominator. Anthropic reports
//     `input_tokens` EXCLUDING cache reads, so its naive denominator
//     under-counts; OpenAI's `prompt_tokens` already includes them. Both
//     adapters normalize this away (AnthropicAdapter sums input +
//     cache_creation + cache_read; OpenAIAdapter passes `prompt_tokens` whole),
//     so every sample's `inputTokens` here IS the full billed prompt and needs
//     no further adjustment. Keeping that invariant is this module's premise —
//     a new adapter must uphold it or its samples lie.
//
// Unlike the figure ZCode publishes, this one is not hidden behind a threshold:
// it always reports, and `reliable` says separately whether enough requests
// were counted for the number to mean anything.

/** The minimum number of main-turn requests before a rate is worth quoting. */
export const CACHE_HIT_RATE_MIN_SAMPLES = 5

/** One request's prompt-cache accounting, in already-normalized units. */
export interface CacheHitSample {
  /** The FULL prompt size billed for this request — cache reads included. */
  inputTokens?: number
  /** The slice of `inputTokens` served from the prompt cache. */
  cacheReadTokens?: number
  /** True for one-shot sidecar traffic (summary, title, sub-agent) that has no
   *  stable prefix and must never enter the main-turn figure. */
  sidecar?: boolean
}

export interface CacheHitRate {
  /** cacheRead / input over the counted requests; 0 when nothing was counted. */
  hitRate: number
  /** False while fewer than CACHE_HIT_RATE_MIN_SAMPLES requests were counted. */
  reliable: boolean
  requestCount: number
  inputTokens: number
  cacheReadTokens: number
}

/**
 * Token-weighted prompt-cache hit rate over main-turn requests.
 *
 * A request that reported NO CACHE FIGURE is SKIPPED rather than counted as a
 * miss — and "no cache figure" means either half of the pair is absent. A
 * missing prompt size and a missing cache read are the same kind of hole:
 * missing data, not a miss. Folding either in as 0% is how a session with
 * honest partial reporting ends up looking like a total cache failure — and
 * once such a session reaches CACHE_HIT_RATE_MIN_SAMPLES the fiction is
 * stamped `reliable`, which is worse than the old NaN it replaced.
 *
 * Two live sources of that hole:
 *  - `messages.cached_tokens` only arrived in the 2026-10-25 migration
 *    (f653b3b), so every message persisted before it rehydrates with the field
 *    absent. Such a session has a full prompt size and no cache column at all.
 *  - A provider whose protocol has no cache accounting (most OpenAI-compatible
 *    gateways) never sets the field — OpenAIAdapter's `cacheHitOf` returns
 *    undefined, not 0, for exactly that reason.
 *
 * A provider that DOES support caching reports a real 0 on a cold miss, and
 * that lands below as a genuine miss. The distinction is PRESENCE, not value.
 */
export function computeCacheHitRate(samples: Iterable<CacheHitSample>): CacheHitRate {
  let inputTokens = 0
  let cacheReadTokens = 0
  let requestCount = 0
  for (const sample of samples) {
    if (sample.sidecar) continue
    const input = sample.inputTokens
    if (input === undefined || input === null || input <= 0) continue
    const read = sample.cacheReadTokens
    // Absent cache figure = missing data, not a miss (see the note above).
    // Dropping the whole sample keeps the numerator and the denominator over
    // the SAME requests; scoring it 0% would instead price a pre-migration or
    // no-cache-accounting session as a total cache failure.
    if (read === undefined || read === null) continue
    // Clamp: a gateway reporting a cache read larger than the prompt is
    // returning nonsense, and letting it through would push the rate past 1.
    // A negative figure is bogus too, but unlike an absent one it is not a
    // silent protocol: the field IS part of that provider's contract and this
    // is one corrupt response, so the request stays in the denominator scored
    // as a miss rather than quietly vanishing from what we were billed for.
    const hit = read < 0 ? 0 : Math.min(read, input)
    inputTokens += input
    cacheReadTokens += hit
    requestCount++
  }
  return {
    hitRate: inputTokens > 0 ? cacheReadTokens / inputTokens : 0,
    reliable: requestCount >= CACHE_HIT_RATE_MIN_SAMPLES,
    requestCount,
    inputTokens,
    cacheReadTokens,
  }
}
