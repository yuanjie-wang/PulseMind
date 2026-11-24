// ── ASR 子进程父端口（2026-11-24，utilityProcess 迁移）──
// 同一份 asr-worker.js 要跑在两种宿主里：Electron utilityProcess 的
// `process.parentPort`（消息裹一层 MessageEvent，`e.data`）与 worker_threads 的
// `parentPort`（裸值）。差异只在这个模块收口，协议两边一致 —— 这里的测试钉
// 「两种端口各自怎么收发」，尤其是 utility 那层解包（不解包 = worker 收到的是
// MessageEvent、`msg.type` 恒 undefined，主进程只会等到初始化超时）。

import { describe, it, expect } from 'vitest'
import { openChildPort, resolveChildPort } from '../src/main/services/asr-port'

interface FakePort {
  on(event: 'message', listener: (value: unknown) => void): void
  postMessage(value: unknown): void
}

function fakePort(): FakePort & { sent: unknown[]; deliver: (value: unknown) => void } {
  const listeners: Array<(value: unknown) => void> = []
  const sent: unknown[] = []
  return {
    sent,
    on(_event, listener) {
      listeners.push(listener)
    },
    postMessage(value) {
      sent.push(value)
    },
    deliver(value) {
      for (const l of listeners) l(value)
    },
  }
}

describe('resolveChildPort — 两种宿主', () => {
  it('utility：收发走 process.parentPort，收消息时解包 MessageEvent.data', () => {
    const port = fakePort()
    const ch = resolveChildPort(port, null)
    expect(ch.channel).toBe('utility')
    const got: unknown[] = []
    ch.onMessage((m) => got.push(m))
    // Chromium 的实现把消息裹成 { data, ports }
    port.deliver({ data: { type: 'init', modelDir: '/x' }, ports: [] })
    expect(got).toEqual([{ type: 'init', modelDir: '/x' }])
    ch.postMessage({ type: 'ready' })
    expect(port.sent).toEqual([{ type: 'ready' }])
  })

  it('utility：没有 ports 键的值不解包（裸值/用户对象原样透传）', () => {
    const port = fakePort()
    const ch = resolveChildPort(port, null)
    const got: unknown[] = []
    ch.onMessage((m) => got.push(m))
    port.deliver({ data: 1 })
    port.deliver(42)
    expect(got).toEqual([{ data: 1 }, 42])
  })

  it('thread：收发走 parentPort 裸值，不做任何解包', () => {
    const port = fakePort()
    const ch = resolveChildPort(null, port)
    expect(ch.channel).toBe('thread')
    const got: unknown[] = []
    ch.onMessage((m) => got.push(m))
    port.deliver({ data: 1 })
    expect(got).toEqual([{ data: 1 }])
    ch.postMessage({ type: 'result', id: 3, text: 'hi' })
    expect(port.sent).toEqual([{ type: 'result', id: 3, text: 'hi' }])
  })

  it('两种端口都存在时 utility 优先（Electron 的 Node service 里也常能见到 thread 的 parentPort 被 polyfill）', () => {
    const ch = resolveChildPort(fakePort(), fakePort())
    expect(ch.channel).toBe('utility')
  })

  it('端口形状不对（只有 postMessage）→ 视为不存在', () => {
    const broken = { postMessage: () => undefined } as unknown as FakePort
    expect(() => resolveChildPort(broken, null)).toThrow(/没有父端口/)
    expect(() => resolveChildPort(null, null)).toThrow(/没有父端口/)
    // 但线程端口在时它只是被跳过，不阻断
    expect(resolveChildPort(broken, fakePort()).channel).toBe('thread')
  })
})

describe('openChildPort — 真实进程形态', () => {
  it('vitest 主线程（既非 utility 也非 worker）→ 直接抛可读错误，不静默挂着', () => {
    // 静默返回一个空端口会让主进程等满 60s 初始化超时，报错却指向「模型太大」
    expect(() => openChildPort()).toThrow(/没有父端口/)
  })
})