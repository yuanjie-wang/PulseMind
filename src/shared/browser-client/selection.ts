// ── Tab selection by URL (A-M1) ──
// Pure matching used by agent.browsers.open(url): reuse a same-site tab when
// one exists (exact URL > same origin > same host), otherwise open a new one.
// 工作流协议 §5.3: "新 URL 优先 open(url)(同站复用 + 原地跳转)".

export interface SelectableTab {
  id: string
  url: string
}

/** Rank a tab against the target URL: 3 exact (origin+path+query), 2 same
 *  origin, 1 same host, 0 no match. */
export function tabUrlRank(tabUrl: string, targetUrl: string): number {
  try {
    const tab = new URL(tabUrl)
    const target = new URL(targetUrl)
    if (tab.origin === target.origin && tab.pathname === target.pathname && tab.search === target.search) return 3
    if (tab.origin === target.origin) return 2
    if (tab.hostname === target.hostname) return 1
    return 0
  } catch {
    return 0
  }
}

/** Best matching tab id for the URL, or null when nothing matches. */
export function selectTabForUrl(tabs: SelectableTab[], url: string): string | null {
  return matchTabForUrl(tabs, url)?.id ?? null
}

export interface TabMatch {
  id: string
  /** The tab's URL as it was when matched (what the reuse note quotes). */
  url: string
  /** 3 exact · 2 same origin · 1 same host — open()'s note differs by rank,
   *  so the caller needs the strength, not just the id. */
  rank: number
}

/** The match AND its strength — `open()` reports whether the call reused a tab
 *  and whether that tab was already at the target address. */
export function matchTabForUrl(tabs: SelectableTab[], url: string): TabMatch | null {
  let best: TabMatch | null = null
  for (const tab of tabs) {
    const rank = tabUrlRank(tab.url, url)
    if (rank > 0 && (!best || rank > best.rank)) best = { id: tab.id, url: tab.url, rank }
  }
  return best
}
