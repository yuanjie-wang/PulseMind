// ── Message stats formatting: THE shared wording for both chat renderers ──
// The desktop chat (chat/MessageGroup.tsx) and the extension panel
// (extension/ui/format.ts, which re-exports for MessageBlocks) render the
// same 耗时 / Token / cache-hit line under hand-mirrored shells — the panel
// cannot import MessageGroup (antd + renderer stores, G29/G42) — so the
// FORMATTERS live here and both sides import them; drift is structurally
// impossible (review_20261103 中6: the panel's private copies missed the
// 2026-11-01 min/k rewording and showed 184.6s / 1,234 where the desktop
// showed 3.1min / 1.2k for the same message).
//
// Pure, zero-dependency (no antd, no DOM, no renderer types) — importable
// from main, renderer and the extension's isolated world alike. If the
// wording changes again, change it HERE; there is no second copy to chase.

/** `950ms` / `1.4s` / `3.1min` — the 耗时 format. ≥2 minutes switches to
 *  minutes (2026-11-01 user ruling: 「184.6s」reads as no magnitude,
 *  「3.1min」reads as one); the 0.1s precision only matters for short tasks,
 *  and the minute tier keeps the same one-decimal shape. */
export function formatDuration(ms: number): string {
  if (ms >= 120_000) return `${(ms / 60_000).toFixed(1)}min`
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
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
 *  reads into it), so the pair alone prices the rate. */
export function cacheHitRate(hitTokens: number, inputTokens: number): string {
  return `${Math.round((hitTokens / inputTokens) * 100)}%`
}
