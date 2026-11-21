// ── Message stats formatting: THE shared wording for both chat renderers ──
// The desktop chat (chat/MessageGroup.tsx) and the extension panel
// (extension/ui/format.ts, which re-exports for MessageBlocks) render the
// same completion-time / Token / cache-hit line under hand-mirrored shells —
// the panel cannot import MessageGroup (antd + renderer stores, G29/G42) —
// so the FORMATTERS live here and both sides import them; drift is
// structurally impossible (review_20261103 中6: the panel's private copies
// missed the 2026-11-01 min/k rewording and showed 184.6s / 1,234 where the
// desktop showed 3.1min / 1.2k for the same message).
//
// Pure, zero-dependency (no antd, no DOM, no renderer types) — importable
// from main, renderer and the extension's isolated world alike. If the
// wording changes again, change it HERE; there is no second copy to chase.

import { computeCacheHitRate } from '../agent-session/cache-hit-rate'

// ── Chat bubble time-of-day stamp ───────────────────────────────────────
// The stats toolbar under a bubble carries a CALENDAR stamp, not a duration
// (2026-11-21 user ruling: 耗时 made the row mix scopes — the tokens were one
// request's while the duration was the whole turn — and read as a claim about
// effort; the pair the user actually reason about is 输入消息的时间 ↔ 输出完成
// 的时间). The user side shows the send time, the assistant side the completion
// time; both are the SAME pure parts below. No clock is read: react-hooks
// purity rejects Date.now() during render, and a clock threaded down from the
// hosts would invalidate every bubble's memo once a minute for a fact that
// changes once a day — so the stamp is a pure function of the timestamp and
// the year (the one part only a clock could prove redundant) rides on the
// caller's tooltip.

export interface SentAt {
  /** Zero-padded local wall clock, "18:02" — the clock the bubble settled at. */
  clock: string
  /** Local calendar date; month is 1-based, as in RelativeTime. */
  year: number
  month: number
  day: number
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * The parts of a time-of-day stamp. Returns null for a missing or unparsable
 * timestamp, so the caller leaves the slot empty instead of printing "NaN:NaN"
 * — conversations persisted before the field existed carry none.
 */
export function describeSentAt(timestamp: string | number | Date | null | undefined): SentAt | null {
  if (timestamp == null) return null
  const time = timestamp instanceof Date ? timestamp.getTime() : typeof timestamp === 'number' ? timestamp : Date.parse(timestamp)
  if (!Number.isFinite(time)) return null

  const at = new Date(time)
  return {
    clock: `${pad2(at.getHours())}:${pad2(at.getMinutes())}`,
    year: at.getFullYear(),
    month: at.getMonth() + 1,
    day: at.getDate()
  }
}

/** 「1小时2分钟30秒」/「1h 2m 30s」— the live turn-elapsed format (2026-11-21
 *  user ruling: the running badge reads as whole-clock h/m/s, 精确到整数秒
 *  — TRUNCATE, never round: a ticking display must not show 60s as 「1分钟」
 *  one beat early or oscillate on a .5 boundary). Leading zero units drop
 *  (45s → 「45秒」, not 「0小时0分钟45秒」); seconds always show so the
 *  per-second tick is always visible. `lang` is a bare union on purpose —
 *  this module must stay importable from main and the extension (see header).
 *  This is the wall-style running clock for the live badge only — the settled
 *  toolbar shows calendar stamps (describeSentAt), not durations. */
export function formatDurationHms(ms: number, lang: 'zh' | 'en'): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (lang === 'en') {
    if (h > 0) return `${h}h ${m}m ${s}s`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
  }
  if (h > 0) return `${h}小时${m}分钟${s}秒`
  if (m > 0) return `${m}分钟${s}秒`
  return `${s}秒`
}

/** `999` / `1.2k` / `12.3k` — the token format. ≥1000 uses the k tier (same
 *  2026-11-01 ruling: a thousands-separated 「12,345」 is wide and reads as
 *  no magnitude); 1000 exactly is tiered too, so the display never forks. */
export function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return n.toLocaleString()
}

/** `83%` — the cache-hit rate off the message's own usage pair: inputTokens
 *  is the cached share's container (both adapters' streaming paths sum cache
 *  reads into it), so the pair alone prices the rate.
 *
 *  Routed through the session aggregator's single-sample path on purpose: one
 *  request's rate and the session's rate must be the SAME arithmetic, or the
 *  per-message line disagrees with the ring's tooltip on the very request they
 *  both describe. Sharing the path also inherits its guards — a gateway
 *  reporting cacheRead > prompt is clamped to 100% instead of printing 226%,
 *  and an empty denominator reads 0% instead of NaN. */
export function cacheHitRate(hitTokens: number, inputTokens: number): string {
  const { hitRate } = computeCacheHitRate([{ inputTokens, cacheReadTokens: hitTokens }])
  return `${Math.round(hitRate * 100)}%`
}
