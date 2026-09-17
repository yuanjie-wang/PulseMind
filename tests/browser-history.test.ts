import { describe, expect, it } from 'vitest'
import { rankHistorySuggestions } from '../src/shared/browser/pane'

/** rankHistorySuggestions (PLAN-browser-pane-ux T3.4, 裁定 L4): host-prefix
 *  beats url-substring beats title-substring; peers by recency then visits.
 *  Pure — no IO, no i18n. */

const row = (url: string, title?: string, lastVisitAt = 0, visitCount = 1) => ({ url, title, lastVisitAt, visitCount })

describe('rankHistorySuggestions', () => {
  it('ranks host-prefix over url-substring over title-substring', () => {
    const ranked = rankHistorySuggestions('mail', [
      row('https://example.com/mailbox', '邮箱'),        // url-substring → rank 1
      row('https://mail.163.com/', '网易邮箱'),          // host-prefix → rank 0
      row('https://example.org/', 'mail 备忘'),          // title-substring → rank 2
    ])
    expect(ranked.map((r) => r.url)).toEqual([
      'https://mail.163.com/',
      'https://example.com/mailbox',
      'https://example.org/',
    ])
    expect(ranked.map((r) => r.rank)).toEqual([0, 1, 2])
  })

  it('orders peers by last_visit_at desc, then visit_count desc', () => {
    // 'example' is NOT a prefix of these hosts — all three fall to the
    // url-substring rank, so the peer ordering is what decides.
    const ranked = rankHistorySuggestions('example', [
      row('https://b.example/', 'B', 100, 9),
      row('https://a.example/', 'A', 200, 1),
      row('https://c.example/', 'C', 200, 5),
    ])
    expect(ranked.map((r) => r.url)).toEqual([
      'https://c.example/', // 同为最新：访问次数多的在前
      'https://a.example/',
      'https://b.example/', // 较旧
    ])
  })

  it('drops rows that match nothing and honours the limit', () => {
    const ranked = rankHistorySuggestions('zzz', [
      row('https://example.com/', '完全无关'),
      row('https://zzz.example/', 'host 命中'),
    ], 8)
    expect(ranked).toHaveLength(1)
    expect(ranked[0].url).toBe('https://zzz.example/')

    const limited = rankHistorySuggestions('example', [
      row('https://a.example/'), row('https://b.example/'), row('https://c.example/'),
    ], 2)
    expect(limited).toHaveLength(2)
  })

  it('empty or whitespace-only text yields nothing', () => {
    expect(rankHistorySuggestions('', [row('https://example.com/')])).toEqual([])
    expect(rankHistorySuggestions('   ', [row('https://example.com/')])).toEqual([])
  })

  it('matching is case-insensitive; a host prefix is still rank 0', () => {
    const ranked = rankHistorySuggestions('GitHub', [
      row('https://github.com/pulsemind', 'PulseMind'),
    ])
    expect(ranked).toHaveLength(1)
    expect(ranked[0].rank).toBe(0) // host 'github.com' 以 'github' 开头
    expect(ranked[0].title).toBe('PulseMind')
  })
})
