/** Member guard + open() reuse semantics (browser tool).
 *
 *  The bug: an unknown member produced a bare `TypeError: tab.goto is not a
 *  function` — no menu, no pointer — and the model answered its own error by
 *  guessing again (`tab.playwright.getByRole`), then repeating a call that had
 *  already landed. Measured in conv_20260917151236.
 *
 *  The guard is a Proxy, and the load-bearing part of a Proxy here is not the
 *  throw: it is that `then` must stay undefined, or every `await` on the facade
 *  breaks. So the wiring is driven through the REAL kernel (`runBrowserCode`,
 *  a real node:vm context) and not only through direct property access — the
 *  await-through-a-proxy path has no other coverage.
 */

import { describe, expect, it } from 'vitest'
import { createBrowserFacade } from '../src/shared/browser-client/facade'
import { guardCallable, guardMembers, memberMenu, unknownMemberMessage } from '../src/shared/browser-client/member-guard'
import { runBrowserCode } from '../src/main/browser/kernel'
import type { BrowserCommand, BrowserCommandResult, BrowserTabInfo } from '../src/shared/browser-client/protocol'

const OK: BrowserCommandResult = { ok: true }

/** A host stub: one tab registry, recorded commands, and the raw execute so
 *  the kernel-driven tests can drive the very same host. */
function fakeHost(seed: BrowserTabInfo[] = []) {
  const sent: BrowserCommand[] = []
  let tabs = [...seed]
  const execute = async (cmd: BrowserCommand): Promise<BrowserCommandResult> => {
    sent.push(cmd)
    if (cmd.method === 'listTabs') return { ok: true, value: tabs }
    if (cmd.method === 'newTab') {
      const created = { id: `tab_${tabs.length + 1}`, url: (cmd.url as string) ?? 'about:blank' }
      tabs = [...tabs, created]
      return { ok: true, value: created }
    }
    if (cmd.method === 'getState') return { ok: true, value: { url: 'https://a.com/', title: 'A' } }
    if (cmd.method === 'getDescriptor') return { ok: true, value: { id: 'app-view', type: 'app-view', capabilities: [] } }
    return OK
  }
  const facade = createBrowserFacade({ execute, emitImage: () => {} })
  return { facade, execute, sent, tabs: () => tabs }
}

/** A typo'd member is the one failure the model cannot read off a stack trace. */
function expectUnknown(fn: () => unknown, patterns: RegExp[]): void {
  let message = ''
  try {
    fn()
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  expect(message).not.toBe('')
  for (const p of patterns) expect(message).toMatch(p)
}

describe('member guard messages', () => {
  it("lists the object's own members, classified, so the menu cannot go stale", () => {
    expect(memberMenu({ id: 'x', navigate: () => {}, tabs: {} })).toBe('navigate（方法），tabs（子对象），id（字段）')
    // derived from the object, not from a hand-written list
    expect(memberMenu({ id: 'x', navigate: () => {}, fresh: () => {} })).toContain('fresh')
  })

  it('names the member, the label, the menu and the docs pointer', () => {
    const message = unknownMemberMessage('tab', 'goto', { navigate: () => {} })
    expect(message).toContain('未知成员 tab.goto')
    expect(message).toContain('tab 可用：navigate（方法）')
    expect(message).toContain('agent.documentation()')
  })
})

describe('the facade answers an unknown member with the menu', () => {
  it('tab.goto (the measured typo) names navigate/domSnapshot and the open path', async () => {
    const { facade } = fakeHost()
    const tab = await facade.agent.browsers.tabs.new()
    expectUnknown(
      () => (tab as unknown as Record<string, unknown>)['goto'],
      [/未知成员 tab\.goto/, /navigate/, /domSnapshot/, /agent\.browsers\.open/],
    )
  })

  it('tab.playwright.getByRole spells out the two same-named surfaces', async () => {
    const { facade } = fakeHost()
    const tab = await facade.agent.browsers.tabs.new()
    expectUnknown(
      () => (tab.playwright as unknown as Record<string, unknown>)['getByRole'],
      [/未知成员 tab\.playwright\.getByRole/, /agent\.playwright\.getByRole/, /tab\.playwright\(3, 'click'\)/, /定位器/],
    )
  })

  it('agent.playwright.<op> points back at tab.playwright (the reverse confusion)', () => {
    const { facade } = fakeHost()
    expectUnknown(
      () => (facade.agent.playwright as unknown as Record<string, unknown>)['click'],
      [/未知成员 agent\.playwright\.click/, /tab\.playwright/, /getByRole/],
    )
  })

  it('a locator chain typo names the chain methods', () => {
    const { facade } = fakeHost()
    const locator = facade.agent.playwright.getByRole('button', { name: '登录' })
    expectUnknown(
      () => (locator as unknown as Record<string, unknown>)['getByNmae'],
      [/未知成员 locator\.getByNmae/, /getByRole/, /nth/, /tab\.playwright/],
    )
  })

  it('guards every level of the graph, not just tab', () => {
    const { facade } = fakeHost()
    expectUnknown(() => (facade.agent as unknown as Record<string, unknown>)['browser'], [/未知成员 agent\.browser/, /agent\.browsers/])
    expectUnknown(() => (facade.agent.browsers as unknown as Record<string, unknown>)['tab'], [/未知成员 agent\.browsers\.tab/, /open/])
    expectUnknown(() => (facade.agent.browsers.tabs as unknown as Record<string, unknown>)['gett'], [/未知成员 agent\.browsers\.tabs\.gett/, /list/])
    expectUnknown(() => (facade.agent.browsers.user as unknown as Record<string, unknown>)['claim'], [/未知成员 agent\.browsers\.user\.claim/, /claimTab/])
    expectUnknown(() => (facade.agent.documentation as unknown as Record<string, unknown>)['fetch'], [/未知成员 agent\.documentation\.fetch/, /list/])
  })

  it('keeps the protocol probes reachable: then/toJSON are undefined, not errors', () => {
    const tab = guardMembers({ id: 't1', navigate: () => {} }, 'tab')
    const loose = tab as unknown as Record<string, unknown>
    expect(loose['then']).toBeUndefined()
    expect(loose['toJSON']).toBeUndefined()
    // Object.prototype stays reachable too: serializers and comparisons walk it,
    // and a guard that hides it breaks them for no gain.
    expect(typeof loose['toString']).toBe('function')
    expect(loose['constructor']).toBe(Object)
    expect(String(tab)).toBe('[object Object]')
  })

  it('a guarded callable still calls, and still guards its members', () => {
    const fn = Object.assign((n: number) => n + 1, { get: (n: number) => n })
    const guarded = guardCallable(fn, 'thing', '（提示。）')
    expect(guarded(1)).toBe(2)
    expect(guarded.get(2)).toBe(2)
    expectUnknown(() => (guarded as unknown as Record<string, unknown>)['gett'], [/未知成员 thing\.gett/, /get/, /提示/])
  })
})

describe('open() says what it did', () => {
  it('a new tab: opened=new and a note naming the id and the URL', async () => {
    const { facade } = fakeHost()
    const tab = await facade.agent.browsers.open('https://a.com/')
    expect(tab.opened).toBe('new')
    expect(tab.note).toContain('已新建')
    expect(tab.note).toContain(tab.id)
    expect(tab.note).toContain('https://a.com/')
  })

  it('a same-site tab: opened=reused, the note quotes the old address and denies a second tab', async () => {
    const { facade, sent } = fakeHost([{ id: 't7', url: 'https://a.com/list' }])
    const tab = await facade.agent.browsers.open('https://a.com/detail')
    expect(tab.opened).toBe('reused')
    expect(tab.id).toBe('t7')
    expect(tab.note).toContain('已复用 t7')
    expect(tab.note).toContain('https://a.com/list')
    expect(tab.note).toContain('没有新开标签页')
    expect(sent.map((c) => c.method)).toEqual(['listTabs', 'navigate'])
  })

  it('the same address twice: the note says so, and repeating never grows the tab set', async () => {
    const { facade, tabs } = fakeHost()
    const first = await facade.agent.browsers.open('https://a.com/')
    const second = await facade.agent.browsers.open('https://a.com/')
    expect(second.opened).toBe('reused')
    expect(second.id).toBe(first.id)
    expect(second.note).toContain('地址本就是')
    expect(tabs()).toHaveLength(1)
  })

  it('tabs.new() is always new, and names which kind of page it is', async () => {
    const { facade } = fakeHost()
    expect((await facade.agent.browsers.tabs.new()).note).toContain('空白页')
    expect((await facade.agent.browsers.tabs.new({ url: 'https://b.com/' })).note).toContain('已新建')
    expect((await facade.agent.browsers.tabs.new()).opened).toBe('new')
  })
})

describe('documentation: one object, both shapes', () => {
  it('is callable AND carries list/get — the drift the workflow text promised', async () => {
    const { facade } = fakeHost()
    expect(await facade.agent.browsers.documentation()).toContain('Effective API')
    // the exact path written in the docs' own last line
    expect(await facade.agent.documentation.get('screenshots')).toContain('tab.screenshot()')
    expect((await facade.agent.documentation.list()).map((d) => d.name)).toContain('workflow')
    expect(facade.agent.browsers.documentation).toBe(facade.agent.documentation)
  })

  it('an unknown document names the listing call', async () => {
    const { facade } = fakeHost()
    await expect(facade.agent.documentation.get('nope')).rejects.toThrow(/文档不存在或当前后端不可用/)
    await expect(facade.agent.documentation.get('nope')).rejects.toThrow(/documentation\.list\(\)/)
  })
})

describe('inside the real vm kernel', () => {
  it('awaits a guarded handle, and opened/note reach the model', async () => {
    const { execute } = fakeHost()
    const out = await runBrowserCode(
      { code: [`const { browsers } = agent`, `const tab = await browsers.open('https://a.com/')`, `console.log(tab.note)`, `return tab`].join('\n') },
      execute,
    )
    expect(out.error).toBeUndefined()
    expect(out.result).toContain('"opened":"new"')
    expect(out.result).toContain('已新建')
    expect(out.console.join('\n')).toContain('已新建')
  })

  it('surfaces an unknown member as a readable error, not a bare TypeError', async () => {
    const { execute } = fakeHost([{ id: 't1', url: 'https://a.com/' }])
    const out = await runBrowserCode(
      { code: [`const tab = await agent.browsers.tabs.get('t1')`, `return tab.goto('https://b.com/')`].join('\n') },
      execute,
    )
    expect(out.error).toMatch(/未知成员 tab\.goto/)
    expect(out.error).toMatch(/navigate/)
    expect(out.error).not.toMatch(/is not a function/)
  })

  it('a guarded handle survives console.log (the JSON.stringify path)', async () => {
    const { execute } = fakeHost()
    const out = await runBrowserCode(
      { code: [`const tab = await agent.browsers.open('https://a.com/')`, `console.log({ tab })`, `return 1`].join('\n') },
      execute,
    )
    expect(out.error).toBeUndefined()
    expect(out.console.join('\n')).toContain('"opened":"new"')
  })
})
