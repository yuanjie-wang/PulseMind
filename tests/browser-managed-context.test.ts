/** ManagedBackend 的按会话共享 BrowserContext（2026-11-12）。
 *
 *  行为钉死，不依赖真实浏览器：`browser` 字段用 fake 注入（start() 只在
 *  字段为空时才真正 launch），context 创建/关闭全被记录。四条不变量：
 *   1. 同 scope 的 tab 共享一个 context，tab.close() 不关它（登录态跨 tab）；
 *   2. 不同 scope 互相隔离（跨会话不得串 cookie）；
 *   3. 无 scope 的 tab（internal fetchRendered）拿一次性 context，close 即关；
 *   4. stop() 清空 scope map——旧 context 不得借尸还魂；创建失败自愈——
 *      失败条目被逐出，下一个 tab 重试而不是继承 rejected promise。 */

import { describe, expect, it } from 'vitest'
import { ManagedBackend } from '../src/main/browser/backends/ManagedBackend'

interface FakeContext {
  closed: boolean
  newPage: () => Promise<Record<string, never>>
  close: () => Promise<void>
}

function makeBackend(failFirstNewContext = false): {
  backend: ManagedBackend
  contexts: FakeContext[]
} {
  const contexts: FakeContext[] = []
  let calls = 0
  const fakeBrowser = {
    isConnected: () => true,
    newContext: async (): Promise<FakeContext> => {
      calls++
      if (failFirstNewContext && calls === 1) throw new Error('boom')
      const context: FakeContext = {
        closed: false,
        newPage: async () => ({ context: () => context }) as unknown as Record<string, never>,
        close: async () => {
          context.closed = true
        },
      }
      contexts.push(context)
      return context
    },
  }
  const backend = new ManagedBackend()
  ;(backend as unknown as { browser: unknown }).browser = fakeBrowser
  return { backend, contexts }
}

describe('ManagedBackend per-scope context sharing', () => {
  it('tabs of one scope share a context and closing a tab keeps it', async () => {
    const { backend, contexts } = makeBackend()
    const t1 = await backend.newTab({ tabId: 't1', scopeId: 'convA' })
    const t2 = await backend.newTab({ tabId: 't2', scopeId: 'convA' })
    expect(contexts.length).toBe(1)
    expect(t1.page.context()).toBe(t2.page.context())

    await t1.close()
    await t2.close()
    expect(contexts[0].closed).toBe(false)
  })

  it('different scopes are isolated from each other', async () => {
    const { backend, contexts } = makeBackend()
    const a = await backend.newTab({ tabId: 'a', scopeId: 'convA' })
    const b = await backend.newTab({ tabId: 'b', scopeId: 'convB' })
    expect(contexts.length).toBe(2)
    expect(a.page.context()).not.toBe(b.page.context())
  })

  it('a scopeless tab gets a throwaway context that dies with the tab', async () => {
    const { backend, contexts } = makeBackend()
    const t = await backend.newTab({ tabId: 'fetch' })
    expect(contexts.length).toBe(1)
    await t.close()
    expect(contexts[0].closed).toBe(true)
  })

  it('stop() drops the scope map — a restarted backend hands out fresh contexts', async () => {
    const { backend, contexts } = makeBackend()
    const t = await backend.newTab({ tabId: 't1', scopeId: 'convA' })
    await backend.stop()
    // stop() closed the fake browser? The fake has no close — re-inject to
    // model "the backend launched a NEW browser".
    const second = makeBackend()
    ;(backend as unknown as { browser: unknown }).browser = (second.backend as unknown as { browser: unknown }).browser
    const t2 = await backend.newTab({ tabId: 't2', scopeId: 'convA' })
    expect(contexts.length).toBe(1) // the old scope entry is gone
    expect(t2.page.context()).not.toBe(t.page.context())
    await t.close()
    await t2.close()
    expect((second.contexts[0] as FakeContext).closed).toBe(false)
  })

  it('a failed context creation evicts itself — the next tab retries', async () => {
    const { backend, contexts } = makeBackend(true)
    await expect(backend.newTab({ tabId: 't1', scopeId: 'convA' })).rejects.toThrow('boom')
    const t2 = await backend.newTab({ tabId: 't2', scopeId: 'convA' })
    expect(contexts.length).toBe(1)
    expect(t2.page.context()).toBe(contexts[0])
    await t2.close()
  })
})
