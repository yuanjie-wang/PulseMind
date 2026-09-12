import { describe, it, expect } from 'vitest'
import { playwrightSugar, selectorOf } from '../src/shared/browser-client/playwright-sugar'
import { selectTabForUrl, tabUrlRank } from '../src/shared/browser-client/selection'
import { jsonSafe, serializeResult } from '../src/shared/browser-client/serialize'
import { assertAllowedUrl } from '../src/shared/browser-client/protocol'
import { createBrowserFacade } from '../src/shared/browser-client/facade'
import type { BrowserCommand, BrowserCommandResult } from '../src/shared/browser-client/protocol'

describe('playwright-sugar', () => {
  it('serializes getByRole with name', () => {
    expect(playwrightSugar.getByRole('button', { name: '登录' }).selector).toBe('internal:role=button[name="登录"]')
  })
  it('serializes role options as extra attribute brackets', () => {
    const s = playwrightSugar.getByRole('heading', { level: 1, name: /summary/i })
    expect(s.selector).toBe('internal:role=heading[name=/summary/i][level=1]')
  })
  it('chains child locators with >>', () => {
    const s = playwrightSugar.getByRole('list').getByRole('listitem').first()
    expect(s.selector).toBe('internal:role=list >> internal:role=listitem >> nth=0')
  })
  it('serializes text/label/placeholder/testid', () => {
    expect(playwrightSugar.getByText('提交', { exact: true }).selector).toBe('internal:text="提交"s')
    expect(playwrightSugar.getByText(/loading/i).selector).toBe('internal:text=/loading/i')
    expect(playwrightSugar.getByLabel('用户名').selector).toBe('internal:label="用户名"')
    expect(playwrightSugar.getByPlaceholder('搜索').selector).toBe('internal:placeholder="搜索"')
    expect(playwrightSugar.getByTestId('submit-btn').selector).toBe('internal:testid="submit-btn"')
  })
  it('selectorOf passes raw strings through', () => {
    expect(selectorOf('div > a')).toBe('div > a')
    expect(selectorOf(playwrightSugar.getByRole('link'))).toBe('internal:role=link')
  })
})

describe('selection', () => {
  const tabs = [
    { id: 'a', url: 'https://example.com/list?page=2' },
    { id: 'b', url: 'https://example.com/about' },
    { id: 'c', url: 'https://other.org/' },
  ]
  it('prefers the exact URL', () => {
    expect(selectTabForUrl(tabs, 'https://example.com/list?page=2')).toBe('a')
  })
  it('falls back to same origin, then same host', () => {
    expect(selectTabForUrl(tabs, 'https://example.com/list?page=9')).toBe('a')
    expect(selectTabForUrl([{ id: 'c', url: 'https://other.org/x' }], 'https://other.org/y')).toBe('c')
  })
  it('returns null when nothing matches', () => {
    expect(selectTabForUrl(tabs, 'https://unrelated.net/')).toBeNull()
  })
  it('ranks exact above same-origin; a subdomain is a different host', () => {
    expect(tabUrlRank('https://x.com/a', 'https://x.com/a')).toBe(3)
    expect(tabUrlRank('https://x.com/b', 'https://x.com/a')).toBe(2)
    expect(tabUrlRank('https://x.com:8443/', 'https://x.com/')).toBe(1)
    expect(tabUrlRank('https://a.x.com/', 'https://x.com/')).toBe(0)
  })
})

describe('serialize', () => {
  it('jsonSafe handles circulars and functions without throwing', () => {
    const obj: Record<string, unknown> = { name: 'x' }
    obj['self'] = obj
    obj['fn'] = () => 1
    const out = jsonSafe(obj) as Record<string, string>
    expect(out['name']).toBe('x')
    expect(String(out['self'])).toContain('circular')
    expect(String(out['fn'])).toContain('function')
  })
  it('serializeResult truncates over the byte cap with a hint', () => {
    const { text, truncated } = serializeResult({ big: 'x'.repeat(300_000) }, 1024)
    expect(truncated).toBe(true)
    expect(text.length).toBeLessThan(1200)
    expect(text).toContain('截断')
  })
})

describe('protocol url policy', () => {
  it('allows http/https and rejects everything else', () => {
    expect(assertAllowedUrl('http://a.com/')).toBe('http://a.com/')
    expect(assertAllowedUrl('https://a.com/x?y=1')).toBe('https://a.com/x?y=1')
    expect(() => assertAllowedUrl('file:///etc/passwd')).toThrow(/scheme/)
    expect(() => assertAllowedUrl('javascript:alert(1)')).toThrow(/scheme/)
    expect(() => assertAllowedUrl('not a url')).toThrow(/URL/)
  })
})

describe('facade against a mock execute', () => {
  it('routes calls to commands and emits screenshots out-of-band', async () => {
    const sent: BrowserCommand[] = []
    const images: Array<{ mime: string; base64: string }> = []
    const respond = (cmd: BrowserCommand): BrowserCommandResult => {
      sent.push(cmd)
      if (cmd.method === 'listTabs') return { ok: true, value: [{ id: 't1', url: 'https://a.com/' }] }
      if (cmd.method === 'getState') return { ok: true, value: { id: 't1', url: 'https://a.com/', title: 'A' } }
      if (cmd.method === 'screenshot') return { ok: true, value: { mime: 'image/png', base64: 'abc123' } }
      return { ok: true }
    }
    const facade = createBrowserFacade({ execute: respond, emitImage: (img) => images.push(img) })
    const tab = await facade.agent.browsers.open('https://a.com/deep')
    expect(sent[0].method).toBe('listTabs')
    expect(sent[1]).toEqual({ method: 'navigate', tabId: 't1', url: 'https://a.com/deep' })
    expect(tab.id).toBe('t1')
    const shot = await tab.screenshot()
    expect(shot.emitted).toBe(true)
    expect(images).toEqual([{ mime: 'image/png', base64: 'abc123' }])
  })
  it('surfaces command errors as thrown messages and rejects bad schemes early', async () => {
    const facade = createBrowserFacade({
      execute: () => ({ ok: false, error: { code: 'X', message: 'boom' } }),
      emitImage: () => {},
    })
    await expect(facade.agent.browsers.tabs.list()).rejects.toThrow('[X] boom')
    await expect(facade.agent.browsers.open('file:///etc/passwd')).rejects.toThrow(/scheme/)
  })
  it('tabs.get fails loudly on a stale id (批前重绑定协议)', async () => {
    const facade = createBrowserFacade({
      execute: (cmd) => cmd.method === 'listTabs' ? { ok: true, value: [] } : { ok: true },
      emitImage: () => {},
    })
    await expect(facade.agent.browsers.tabs.get('ghost')).rejects.toThrow(/tabs\.list/)
  })
})
