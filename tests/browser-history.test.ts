import { describe, expect, it } from 'vitest'
import { historyVisitFor, hostLabel, isFreshTabUrl, rankHistorySuggestions } from '../src/shared/browser/pane'

/** rankHistorySuggestions (PLAN-browser-pane-ux T3.4, 裁定 L4): host-prefix
 *  beats url-substring beats title-substring; peers by recency then visits.
 *  Pure — no IO, no i18n. isFreshTabUrl/hostLabel (T4): the one freshness
 *  predicate shared by the dock's fold and the renderer's empty state. */

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

  // 用户复现（2026-09-17）：原样重输刚去过的完整网址（带 scheme），SQL LIKE
  // 能查到，但排序层三条规则全部落空 → 下拉不弹。scheme-less 比较是正解。
  it('re-typing the full URL with its scheme still matches the visit', () => {
    const rows = [row('https://www.baidu.com/', '百度一下，你就知道', 1000, 2)]
    expect(rankHistorySuggestions('https://www.baidu.com', rows)).toHaveLength(1)
    expect(rankHistorySuggestions('https://www.baidu.com/', rows)).toHaveLength(1)
    // scheme 写错（http vs https）也不该丢——用户记不清 scheme 是常态
    expect(rankHistorySuggestions('http://www.baidu.com', rows)).toHaveLength(1)
  })

  it('a scheme-typed needle ranks like its scheme-less form, below nothing new', () => {
    const ranked = rankHistorySuggestions('https://mail', [
      row('https://mail.163.com/', '网易邮箱'),   // host 以 'mail' 开头 → rank 0
      row('https://example.com/mail', '邮箱'),    // url 子串 → rank 1
    ])
    expect(ranked.map((r) => r.rank)).toEqual([0, 1])
  })
})

describe('isFreshTabUrl / hostLabel (T4)', () => {
  it('isFreshTabUrl: no URL and about:blank are unnavigated; everything else is not', () => {
    expect(isFreshTabUrl('')).toBe(true)
    expect(isFreshTabUrl('about:blank')).toBe(true)
    expect(isFreshTabUrl(undefined)).toBe(true)
    expect(isFreshTabUrl(null)).toBe(true)
    expect(isFreshTabUrl('https://www.baidu.com/')).toBe(false)
    expect(isFreshTabUrl('about:config')).toBe(false) // 只豁免空白页，不是整个 about: 方案
  })

  it('hostLabel: host out; unparseable input falls back to itself', () => {
    expect(hostLabel('https://www.baidu.com/s?wd=x')).toBe('www.baidu.com')
    expect(hostLabel('not a url')).toBe('not a url')
  })
})

/** 用户裁定 2026-11-09：先打开 A、自动跳到 B、再点进 C，历史里只该有 A。
 *  实测（scripts/probe-* 同款 playwright 点位）：302 与 JS 跳转在 goto 返回
 *  时分别停在 B 与 A —— 记 page.url() 就等于把落点当发起地址。 */
describe('historyVisitFor (只记发起地址)', () => {
  const A = 'https://short.example/a'
  const B = 'https://landing.example/b'

  it('a redirect records the START address, never the landing page', () => {
    // 302：goto 返回时 page.url() 已是 B
    expect(historyVisitFor(A, 'about:blank', B)).toEqual({ url: A, title: undefined })
    // 客户端 JS 跳转：goto 返回时还是 A，1.5s 后才到 B —— 两种时序同一个答案
    expect(historyVisitFor(A, 'https://prev.example/', A, 'A 的标题')).toEqual({ url: A, title: 'A 的标题' })
  })

  it('borrows the landed title only when the landing IS the start address', () => {
    expect(historyVisitFor(A, 'https://prev.example/', A, '页面名')).toEqual({ url: A, title: '页面名' })
    // 跳转后的 title 属于 B，安到 A 上就是把短链标成落地站的名字
    expect(historyVisitFor(A, 'about:blank', B, '落地站名字')).toEqual({ url: A, title: undefined })
    expect(historyVisitFor(A, 'about:blank', A, '')).toEqual({ url: A, title: undefined })
  })

  it('a trailing slash is not a redirect', () => {
    expect(historyVisitFor('https://a.example', 'about:blank', 'https://a.example/', 'A')).toEqual({
      url: 'https://a.example',
      title: 'A',
    })
  })

  it('not a visit: never committed, or landed on about:/chrome-error:', () => {
    expect(historyVisitFor(A, A, A, 'x')).toBeNull() // goto 没 commit，page.url 没动
    expect(historyVisitFor(A, 'about:blank', 'about:blank', 'x')).toBeNull() // 空页签
    expect(historyVisitFor(A, 'https://prev.example/', 'chrome-error://chromewebdata/', 'x')).toBeNull() // 导航失败
    expect(historyVisitFor('', 'about:blank', B)).toBeNull()
    expect(historyVisitFor(A, 'about:blank', '')).toBeNull()
  })
})
