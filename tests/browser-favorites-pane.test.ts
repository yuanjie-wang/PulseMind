import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeFavoriteUrl, mergeSuggestions, rankHistorySuggestions, type RankedSuggestion } from '../src/shared/browser/pane'

const read = (p: string): string => readFileSync(new URL('../' + p, import.meta.url), 'utf-8')

describe('normalizeFavoriteUrl (L3)', () => {
  it('host lowercases, trailing slash and hash drop; query survives', () => {
    expect(normalizeFavoriteUrl('https://Zhihu.com/')).toBe('https://zhihu.com')
    expect(normalizeFavoriteUrl('https://a.com/b/#top')).toBe('https://a.com/b')
    expect(normalizeFavoriteUrl('https://a.com/b?x=1')).toBe('https://a.com/b?x=1')
    expect(normalizeFavoriteUrl('https://A.com/B/')).toBe('https://a.com/B')
  })
  it('same page, one entry', () => {
    expect(normalizeFavoriteUrl('https://a.com/b')).toBe(normalizeFavoriteUrl('https://a.com/b#top'))
  })
  it('non-http(s) passes through trimmed; empty is empty', () => {
    expect(normalizeFavoriteUrl('  about:blank  ')).toBe('about:blank')
    expect(normalizeFavoriteUrl('')).toBe('')
  })
})

describe('mergeSuggestions (M2) — favorites before history', () => {
  const favorites = [
    { url: 'https://mail.163.com', title: '网易邮箱', createdAt: 20 },
    { url: 'https://zhihu.com', title: '知乎', createdAt: 10 },
  ]
  const history = [
    { url: 'https://zhihu.com/question/1', title: '知乎问题' },
    { url: 'https://mail.163.com/inbox', title: '收件箱' },
    { url: 'https://github.com', title: 'GitHub' },
  ]

  it('favorites rank first with the star flag; history fills the rest', () => {
    const merged = mergeSuggestions('', favorites, history, 8)
    expect(merged[0]).toMatchObject({ url: 'https://mail.163.com', favorite: true })
    expect(merged[1]).toMatchObject({ url: 'https://zhihu.com', favorite: true })
    expect(merged.filter((s) => s.favorite)).toHaveLength(2)
    expect(merged.some((s) => s.url === 'https://github.com')).toBe(true)
  })

  it('same-URL favorites suppress the history duplicate (normalized key)', () => {
    const merged = mergeSuggestions('', favorites, [{ url: 'https://MAIL.163.com/', title: '重复' }], 8)
    expect(merged.filter((s) => s.url.replace(/\/$/, '').toLowerCase() === 'https://mail.163.com')).toHaveLength(1)
  })

  it('limit truncates; empty favorites degrade to pure history (现行为不变)', () => {
    expect(mergeSuggestions('', [], history, 2)).toHaveLength(2)
    const pure = mergeSuggestions('', [], history, 8)
    expect(pure.every((s) => !s.favorite)).toBe(true)
  })

  it('a typed needle filters both sides', () => {
    const merged = mergeSuggestions('zhihu', favorites, history, 8)
    expect(merged.some((s) => s.url.includes('zhihu'))).toBe(true)
    expect(merged.some((s) => s.url.includes('163.com'))).toBe(false)
  })

  it('rankHistorySuggestions output stays a valid history input (rank untouched)', () => {
    const ranked: RankedSuggestion[] = rankHistorySuggestions('git', [{ url: 'https://github.com', title: 'GitHub', visitCount: 3, lastVisitAt: 1 }], 8)
    const merged = mergeSuggestions('git', [], ranked, 8)
    expect(merged).toHaveLength(1)
  })
})

describe('wiring scans (M1 + M3)', () => {
  it('five IPC channels registered in the handler and exposed through preload/bridge', () => {
    const handler = read('src/main/ipc/browser.handler.ts')
    for (const ch of ['BROWSER_FAVORITE_ADD', 'BROWSER_FAVORITE_REMOVE', 'BROWSER_FAVORITE_LIST', 'BROWSER_FAVORITE_QUERY', 'BROWSER_FAVORITE_HAS']) {
      expect(handler).toContain(`IPC_CHANNELS.${ch}`)
    }
    const preload = read('src/preload/index.ts')
    expect(preload).toContain('browserFavoriteAdd')
    expect(preload).toContain('browserFavoriteHas')
    expect(read('src/shared/types/electron-bridge.ts')).toContain('browserFavoriteHas')
  })

  it('the facade carries the favorites object over three new protocol methods', () => {
    expect(read('src/shared/browser-client/protocol.ts')).toContain("method: 'listFavorites'")
    expect(read('src/shared/browser-client/protocol.ts')).toContain("method: 'addFavorite'")
    expect(read('src/shared/browser-client/protocol.ts')).toContain("method: 'removeFavorite'")
    const facade = read('src/shared/browser-client/facade.ts')
    // manifest 三角一致（review 修正）：favorites 走 guardMembers 声明制，
    // manifest 里必须有同名对象，documentation() 的 API 清单才会列出它。
    expect(facade).toContain("'agent.browsers.favorites'")
    expect(facade).toContain('favorites: guardMembers(')
    expect(read('src/shared/browser-client/manifest.ts')).toContain("'agent.browsers.favorites'")
    expect(facade).toContain("added: true | 'already'")
    expect(read('src/main/browser/BrowserService.ts')).toContain("case 'listFavorites'")
  })

  it('the manual carries the favorites red line (never reconstruct a URL)', () => {
    // 2026-10-26: the browser manual moved from tool-instructions.ts into the
    // `browser` built-in skill — the red line moved with it, verbatim.
    expect(read('src/renderer/src/skills/built-in/browser.ts')).toContain('favorites.list()')
    expect(read('src/renderer/src/skills/built-in/browser.ts')).toContain('never reconstruct a URL from memory')
  })

  it('the pane renders the star, the empty-state favorites section, and the row delete entry', () => {
    const pane = read('src/renderer/src/components/browser/BrowserPaneChrome.tsx')
    expect(pane).toContain('mergeSuggestions')
    expect(pane).toContain('toggleStar')
    expect(pane).toContain('收藏此页')
    // 删除入口（review 修正）：下拉行与空态行都要有 hover 显形的取消收藏按钮。
    expect(pane).toContain('data-pm-fav-del')
    expect(pane).toContain('StarOff')
  })
})
