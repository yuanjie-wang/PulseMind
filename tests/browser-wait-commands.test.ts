/** tab.waitFor 的条件等待执行器 runTabWait（2026-11-12）。
 *
 *  行为钉死，不需要真实浏览器：page 的四个等待原语全部 fake 并记录调用。
 *  真实页面的行为（selector 出现/超时）由 Playwright 自己保证——这里钉的是
 *  我们的契约：单触发器校验、超时钳制、四条分派路径、超时如实回答
 *  （met:false + 行动指引）而不是裸 throw、非超时错误照常上抛。 */

import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { describeWaitTrigger, runTabWait } from '../src/main/browser/PlaywrightCommands'
import { createBrowserFacade } from '../src/shared/browser-client/facade'

interface WaitCalls {
  locatorWaitFor: Array<{ selector: string; state: string; timeout: number }>
  waitForURL: Array<{ url: string; timeout: number }>
  waitForFunction: Array<{ js: unknown; timeout: number }>
  waitForLoadState: Array<{ state: string; timeout: number }>
}

const TIMEOUT_ERROR = Object.assign(new Error('TimeoutError: Timeout 15000ms exceeded.'), { name: 'TimeoutError' })

function fakePage(overrides: Partial<Record<string, never>> = {}): { page: Page; calls: WaitCalls } {
  const calls: WaitCalls = { locatorWaitFor: [], waitForURL: [], waitForFunction: [], waitForLoadState: [] }
  const page = {
    url: () => 'https://x.test/current',
    locator: (selector: string) => ({
      waitFor: async (opts: { state: string; timeout: number }) => {
        calls.locatorWaitFor.push({ selector, state: opts.state, timeout: opts.timeout })
      },
    }),
    waitForURL: async (url: string, opts: { timeout: number }) => {
      calls.waitForURL.push({ url, timeout: opts.timeout })
    },
    waitForFunction: async (js: unknown, _arg: unknown, opts: { timeout: number }) => {
      calls.waitForFunction.push({ js, timeout: opts.timeout })
    },
    waitForLoadState: async (state: string, opts: { timeout: number }) => {
      calls.waitForLoadState.push({ state, timeout: opts.timeout })
    },
    ...overrides,
  } as unknown as Page
  return { page, calls }
}

describe('runTabWait trigger validation', () => {
  it('rejects zero triggers and multiple triggers, naming what arrived', async () => {
    const { page } = fakePage()
    await expect(runTabWait(page, {})).rejects.toThrow(/需要一个等待条件/)
    await expect(runTabWait(page, { selector: '.a', url: 'https://x' })).rejects.toThrow(/只接受一个等待条件.*selector \+ url/)
    await expect(runTabWait(page, { selector: '.a', js: () => true })).rejects.toThrow(/selector \+ js/)
  })

  it('validates loadState against the three Playwright states', async () => {
    const { page } = fakePage()
    await expect(runTabWait(page, { loadState: 'bogus' as never })).rejects.toThrow(/loadState 只接受/)
  })

  it('a bare-substring url is refused with the glob teaching, before any waiting (2026-11-13)', async () => {
    // Playwright's url matching is exact/glob: 'example.com' alone matches only
    // a page whose address IS example.com — the model's substring reading
    // waited out the whole budget (measured in the four-round run).
    const { page, calls } = fakePage()
    await expect(runTabWait(page, { url: 'example.com' })).rejects.toThrow(/不是子串匹配/)
    await expect(runTabWait(page, { url: '/results' })).rejects.toThrow(/不是子串匹配/)
    // The glob teaching warns about the trailing slash: '*' does not cross '/',
    // and real URLs carry one after the domain ('**/*baidu.com*' measured false,
    // '**/*baidu.com/*' true — the first cut's suggested pattern was the trap).
    await expect(runTabWait(page, { url: 'baidu.com' })).rejects.toThrow(/\*\*\/\*baidu\.com\/\*/)
    // glob and full URLs pass through untouched.
    await runTabWait(page, { url: '**/results*' })
    await runTabWait(page, { url: 'https://x.test/results?q=1' })
    expect(calls.waitForURL.length).toBe(2)
  })

  it('a non-string url (RegExp) is refused with the js-predicate teaching (2026-11-13)', async () => {
    // The first cut died inside the preflight with `url.includes is not a
    // function` — an internal TypeError as the model-facing answer.
    const { page } = fakePage()
    await expect(runTabWait(page, { url: /baidu/ as never })).rejects.toThrow(/js 谓词/)
  })

  it('clamps timeoutMs into 1s–60s (default 15s)', async () => {
    const { page, calls } = fakePage()
    await runTabWait(page, { selector: '.a' })
    expect(calls.locatorWaitFor[0].timeout).toBe(15_000)
    await runTabWait(page, { selector: '.a', timeoutMs: 0 })
    expect(calls.locatorWaitFor[1].timeout).toBe(1_000)
    await runTabWait(page, { selector: '.a', timeoutMs: 600_000 })
    expect(calls.locatorWaitFor[2].timeout).toBe(60_000)
  })
})

describe('runTabWait dispatch paths', () => {
  it('selector → locator.waitFor(state visible)', async () => {
    const { page, calls } = fakePage()
    const r = await runTabWait(page, { selector: '.result', timeoutMs: 5000 })
    expect(r.met).toBe(true)
    expect(calls.locatorWaitFor).toEqual([{ selector: '.result', state: 'visible', timeout: 5000 }])
    expect(r.waitedFor).toContain('.result')
    expect(r.pageUrl).toBe('https://x.test/current')
  })

  it('url → page.waitForURL', async () => {
    const { page, calls } = fakePage()
    await runTabWait(page, { url: '**/results?q=*' })
    expect(calls.waitForURL).toEqual([{ url: '**/results?q=*', timeout: 15_000 }])
  })

  it('js → page.waitForFunction, string and function forms both pass through', async () => {
    const { page, calls } = fakePage()
    await runTabWait(page, { js: 'document.readyState === "complete"' })
    await runTabWait(page, { js: () => document.querySelectorAll('.item').length >= 10 })
    expect(calls.waitForFunction.length).toBe(2)
    expect(typeof calls.waitForFunction[1].js).toBe('function')
  })

  it('loadState → page.waitForLoadState', async () => {
    const { page, calls } = fakePage()
    const r = await runTabWait(page, { loadState: 'networkidle' })
    expect(r.met).toBe(true)
    expect(calls.waitForLoadState).toEqual([{ state: 'networkidle', timeout: 15_000 }])
  })
})

describe('runTabWait timeout honesty', () => {
  it('a timeout answers met:false with the note, instead of throwing', async () => {
    const { page } = fakePage({
      locator: (() => ({
        waitFor: async () => {
          throw TIMEOUT_ERROR
        },
      })) as never,
    })
    const r = await runTabWait(page, { selector: '.never', timeoutMs: 2000 })
    expect(r.met).toBe(false)
    expect(r.note).toContain('不要盲目重试')
    expect(r.pageUrl).toBe('https://x.test/current')
  })

  it('a non-timeout failure still throws (usage errors must not masquerade as timeouts)', async () => {
    const { page } = fakePage({
      waitForLoadState: (async () => {
        throw new Error('page has been closed')
      }) as never,
    })
    await expect(runTabWait(page, { loadState: 'load' })).rejects.toThrow(/page has been closed/)
  })
})

describe('describeWaitTrigger', () => {
  it('names each trigger in the outcome', () => {
    expect(describeWaitTrigger({ selector: '.x' })).toContain('.x')
    expect(describeWaitTrigger({ url: '**/a' })).toContain('**/a')
    expect(describeWaitTrigger({ js: '1' })).toContain('JS')
    expect(describeWaitTrigger({ loadState: 'networkidle' })).toContain('networkidle')
  })
})

// The facade entry additionally validates before invoking; the single-trigger
// contract lives there for the sandbox model's vocabulary — pin it too.
describe('facade waitFor entry validation', () => {
  const fakeExecute = async (cmd: { method: string }): Promise<unknown> =>
    cmd.method === 'newTab' || cmd.method === 'listTabs'
      ? { ok: true, value: { id: 't1', url: 'https://a.com/' } }
      : { ok: true, value: { met: true, waitedFor: 'x', elapsedMs: 1, pageUrl: 'https://x/' } }

  it('zero/multiple triggers fail at the facade with the model-facing message', async () => {
    const facade = createBrowserFacade({ execute: fakeExecute as never, emitImage: () => {} })
    const tab = await facade.agent.browsers.tabs.new()
    await expect(tab.waitFor({} as never)).rejects.toThrow(/需要一个等待条件/)
    await expect(tab.waitFor({ selector: '.a', loadState: 'load' })).rejects.toThrow(/只接受一个等待条件/)
  })

  it('a well-formed call reaches the command layer', async () => {
    const seen: Array<{ method: string }> = []
    const facade = createBrowserFacade({
      execute: async (cmd) => {
        seen.push({ method: cmd.method })
        return (await fakeExecute(cmd)) as never
      },
      emitImage: () => {},
    })
    const tab = await facade.agent.browsers.tabs.new()
    const r = await tab.waitFor({ selector: '.a' })
    expect(r.met).toBe(true)
    expect(seen[seen.length - 1]).toEqual({ method: 'waitFor' })
  })
})
