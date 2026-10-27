// ── dispatcher 缓存与 ProxyAgent 构造参数（mock undici / settings-store）──
// proxy-setting.test.ts 用真实 undici 钉端到端；这里把「缓存身份」与
// 「strictSSL → requestTls/proxyTls」两件纯逻辑的事钉死：
//   • 同 (proxyUrl, strictSSL) 复用同一实例（ProxyAgent 自带连接池，每请求
//     新建等于每次抓包都重新握手）；
//   • 任一变化 → 新实例 + 旧实例 close 排空（挂着的 keep-alive 不许泄）；
//   • strictSSL=false 就是 requestTls/proxyTls 双双 rejectUnauthorized:false
//     ——这是「Fiddler 解密 HTTPS 必须关它」这句话的机器可查形态。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  ctor: vi.fn(),
  instances: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
  settingsGet: vi.fn(),
}))

vi.mock('undici', () => ({
  ProxyAgent: class {
    close = vi.fn(async () => {
      /* drained */
    })
    constructor(opts: unknown) {
      state.ctor(opts)
      state.instances.push(this as unknown as { close: ReturnType<typeof vi.fn> })
    }
  },
}))

vi.mock('../src/main/storage/settings-store', () => ({
  settingsStore: { get: state.settingsGet },
}))

import { buildProxyAgent, resolveProxyDispatcher, withProxyDispatcher, resetProxyDispatcherCache } from '../src/main/utils/proxy'
import { ProxyConfigError } from '../src/shared/proxy'

describe('buildProxyAgent — strictSSL 就是构造参数', () => {
  beforeEach(() => state.ctor.mockClear())

  it('默认（严格）：不携带任何跳过校验的 TLS 选项', () => {
    buildProxyAgent('http://127.0.0.1:8888/', true)
    expect(state.ctor).toHaveBeenCalledWith({ uri: 'http://127.0.0.1:8888/', requestTls: undefined, proxyTls: undefined })
  })

  it('strictSSL=false：requestTls/proxyTls 双双 rejectUnauthorized:false（MITM 的通路）', () => {
    buildProxyAgent('http://127.0.0.1:8888/', false)
    expect(state.ctor).toHaveBeenCalledWith({
      uri: 'http://127.0.0.1:8888/',
      requestTls: { rejectUnauthorized: false },
      proxyTls: { rejectUnauthorized: false },
    })
  })
})

describe('resolveProxyDispatcher — 按 (proxyUrl, strictSSL) 缓存', () => {
  beforeEach(() => {
    resetProxyDispatcherCache()
    state.ctor.mockClear()
    state.instances.length = 0
  })

  it('空配置 = undefined（直连），且不构造任何 ProxyAgent', async () => {
    state.settingsGet.mockResolvedValue({ proxyUrl: '' })
    await expect(resolveProxyDispatcher()).resolves.toBeUndefined()
    expect(state.ctor).not.toHaveBeenCalled()
  })

  it('同配置复用同一实例（连接池不重建），配置变了换新实例并 close 旧的', async () => {
    state.settingsGet.mockResolvedValue({ proxyUrl: 'http://a:1', proxyStrictSSL: true })
    const first = await resolveProxyDispatcher()
    const again = await resolveProxyDispatcher()
    expect(first).toBe(again)
    expect(state.ctor).toHaveBeenCalledTimes(1)

    state.settingsGet.mockResolvedValue({ proxyUrl: 'http://a:1', proxyStrictSSL: false })
    const strictOff = await resolveProxyDispatcher()
    expect(strictOff).not.toBe(first)
    expect(state.instances[0].close).toHaveBeenCalledTimes(1)

    state.settingsGet.mockResolvedValue({ proxyUrl: 'http://b:2', proxyStrictSSL: false })
    const moved = await resolveProxyDispatcher()
    expect(moved).not.toBe(strictOff)
    expect(state.instances[1].close).toHaveBeenCalledTimes(1)
  })

  it('坏配置抛 ProxyConfigError（消费方各自收进自己的错误通道）', async () => {
    state.settingsGet.mockResolvedValue({ proxyUrl: 'socks5://127.0.0.1:1080' })
    await expect(resolveProxyDispatcher()).rejects.toThrow(ProxyConfigError)
  })
})

describe('withProxyDispatcher — fetch init 增强', () => {
  beforeEach(() => {
    resetProxyDispatcherCache()
    state.ctor.mockClear()
  })

  it('无代理：原对象原样返回（直连路径零包装开销）', async () => {
    state.settingsGet.mockResolvedValue({ proxyUrl: '' })
    const init: RequestInit = { method: 'POST', headers: { a: 'b' } }
    await expect(withProxyDispatcher(init)).resolves.toBe(init)
  })

  it('有代理：同一 init 多带一个 dispatcher', async () => {
    state.settingsGet.mockResolvedValue({ proxyUrl: 'http://a:1' })
    const init: RequestInit = { method: 'POST' }
    const wrapped = await withProxyDispatcher(init)
    expect(wrapped).not.toBe(init)
    expect(wrapped.method).toBe('POST')
    expect((wrapped as { dispatcher?: unknown }).dispatcher).toBeDefined()
  })
})
