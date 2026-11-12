/** facade 入口的形状校验（2026-11-13 第三轮实测的三个漏点）。
 *
 *  真实浏览器跑出来的三类「内部错误当答案」：waitFor({url: 正则}) 漏出
 *  `url.includes is not a function`；mouse.drag(300,300,…) 漏出 Playwright 的
 *  `x: expected float, got undefined`；favorites.add({url, title}) 漏出
 *  `(t ?? "").trim is not a function` 且被误标成 FAVORite_LIMIT。修复原则与
 *  evaluate 的形状检查同款：在入口用模型自己的词汇报错。 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBrowserFacade } from '../src/shared/browser-client/facade'

const source = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf-8')

/** Fake execute: records the method name, answers tab creation properly. */
function makeFacade() {
  const methods: string[] = []
  const facade = createBrowserFacade({
    execute: async (cmd) => {
      methods.push(cmd.method)
      if (cmd.method === 'newTab' || cmd.method === 'listTabs') {
        return { ok: true, value: { id: 't1', url: 'https://a.com/' } }
      }
      return { ok: true, value: {} }
    },
    emitImage: () => {},
  })
  return { facade, methods }
}

describe('facade waitFor entry types', () => {
  it('a RegExp url is refused with the js-predicate teaching', async () => {
    const { facade } = makeFacade()
    const tab = await facade.agent.browsers.tabs.new()
    await expect(tab.waitFor({ url: /baidu/ as never })).rejects.toThrow(/js 谓词/)
    await expect(tab.waitFor({ selector: 3 as never })).rejects.toThrow(/CSS 选择器字符串/)
    await expect(tab.waitFor({ js: 42 as never })).rejects.toThrow(/表达式字符串或函数/)
  })
})

describe('facade mouse.drag shape + down/up primitives', () => {
  it('bare numbers / arrays are refused with the two-point signature', async () => {
    const { facade } = makeFacade()
    const tab = await facade.agent.browsers.tabs.new()
    await expect(tab.mouse.drag(300 as never, 400 as never)).rejects.toThrow(/两个点对象/)
    await expect(tab.mouse.drag([{ x: 1, y: 2 }] as never, { x: 3, y: 4 })).rejects.toThrow(/两个点对象/)
    await expect(tab.mouse.drag({ start: { x: 1, y: 2 } } as never, { x: 3, y: 4 })).rejects.toThrow(/两个点对象/)
  })

  it('two point objects reach mouseDrag; down/up reach mouseDown/mouseUp', async () => {
    const { facade, methods } = makeFacade()
    const tab = await facade.agent.browsers.tabs.new()
    await tab.mouse.drag({ x: 300, y: 300 }, { x: 400, y: 360 })
    await tab.mouse.down()
    await tab.mouse.up({ button: 'right' })
    expect(methods).toContain('mouseDrag')
    expect(methods).toContain('mouseDown')
    expect(methods).toContain('mouseUp')
  })
})

describe('facade favorites positional args', () => {
  it('object args are refused with the positional signature, before any store write', async () => {
    const { facade, methods } = makeFacade()
    const favorites = await facade.agent.browsers.favorites
    await expect(favorites.add({ url: 'https://x.test' } as never)).rejects.toThrow(/位置参数/)
    await expect(favorites.add('https://x.test', 42 as never)).rejects.toThrow(/title 只接受字符串/)
    await expect(favorites.remove({ url: 'https://x.test' } as never)).rejects.toThrow(/位置参数/)
    // Nothing reached the command layer — the bad shapes never become writes.
    expect(methods.every((m) => m === 'newTab' || m === 'listTabs')).toBe(true)
  })
})

describe('keyboard hold primitives (2026-11-13 第四轮)', () => {
  it('down/up reach keyboardDown/keyboardUp like their mouse counterparts', async () => {
    const { facade, methods } = makeFacade()
    const tab = await facade.agent.browsers.tabs.new()
    await tab.keyboard.down('Shift')
    await tab.keyboard.up('Shift')
    expect(methods).toContain('keyboardDown')
    expect(methods).toContain('keyboardUp')
  })

  it('descriptor browser capabilities cover the browser-level members that exist (漏报教训)', () => {
    // Last round over-reported ('recording' never existed); this round
    // under-reported (favorites/downloads worked but were absent). Both
    // directions make the inventory untrustworthy — pin the full set.
    for (const file of [
      'src/main/browser/backends/ManagedBackend.ts',
      'src/main/browser/backends/AppViewBackend.ts',
    ]) {
      const src = source(file)
      for (const member of ['favorites', 'downloads', 'documentation']) {
        expect(src, `${file} capabilities.browser misses ${member}`).toMatch(
          new RegExp(`browser: \\[[^\\]]*'${member}'`),
        )
      }
    }
    // The zombie word stays dead — scan the tab capability line itself (the
    // file's comment legitimately mentions 'recording' as history).
    const tabCaps = source('src/main/browser/backends/AppViewBackend.ts')
      .split('\n')
      .find((l) => l.trim().startsWith('tab: ['))
    expect(tabCaps).toBeDefined()
    expect(tabCaps).not.toContain('recording')
  })
})
