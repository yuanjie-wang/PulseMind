// notify 的 sink 路由（utils/notify-core.ts）：绑定/解绑语义 + 两个失败
// 助手的留痕契约。antd 不进测试进程 —— notify.tsx 的绑定壳由应用启动路径
// 覆盖（menu-wiring 扫描）。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { setNotifySink, resolveNotifySink, notifyFailure, reportSilentFailure, type NotifySink } from '../src/renderer/src/utils/notify-core'

function makeSink(): NotifySink & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    success: (m) => calls.push(`success:${m}`),
    error: (m) => calls.push(`error:${m}`),
    warning: (m) => calls.push(`warning:${m}`),
    info: (m) => calls.push(`info:${m}`),
  }
}

afterEach(() => {
  setNotifySink(null)
  vi.restoreAllMocks()
})

describe('sink 绑定', () => {
  it('未绑定时 resolveNotifySink 为 null（调用方回退静态 sink）', () => {
    expect(resolveNotifySink()).toBeNull()
  })
  it('绑定后返回同一实例；传 null 解绑', () => {
    const sink = makeSink()
    setNotifySink(sink)
    expect(resolveNotifySink()).toBe(sink)
    setNotifySink(null)
    expect(resolveNotifySink()).toBeNull()
  })
  it('重复绑定以最后一次为准（NotifyBridge 卸载/重挂）', () => {
    const a = makeSink()
    const b = makeSink()
    setNotifySink(a)
    setNotifySink(b)
    expect(resolveNotifySink()).toBe(b)
  })
})

describe('notifyFailure —— 用户主动操作失败：toast + 留痕', () => {
  it('有 sink 时 toast 用户文案，同时打 [notify][scope] 标签', () => {
    const sink = makeSink()
    setNotifySink(sink)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    notifyFailure('memory.search', new Error('boom'), '搜索失败')
    expect(sink.calls).toEqual(['error:搜索失败'])
    expect(spy).toHaveBeenCalledWith('[notify][memory.search]', expect.any(Error))
  })
  it('userMessage 缺省时回落到 err.message；非 Error 也走 String', () => {
    const sink = makeSink()
    setNotifySink(sink)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    notifyFailure('x', new Error('plain'))
    notifyFailure('y', 'stringy')
    expect(sink.calls).toEqual(['error:plain', 'error:stringy'])
  })
  it('无 sink（未绑定）时不 toast、不抛错，留痕仍在', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => notifyFailure('scope.x', new Error('e'), 'msg')).not.toThrow()
    expect(spy).toHaveBeenCalledWith('[notify][scope.x]', expect.any(Error))
  })
})

describe('reportSilentFailure —— 后台任务失败：不 toast，只留痕', () => {
  it('绝不触碰 sink，打 [silent-failure][scope] 标签', () => {
    const sink = makeSink()
    setNotifySink(sink)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    reportSilentFailure('mcp-summary', new Error('bg'))
    expect(sink.calls).toEqual([])
    expect(spy).toHaveBeenCalledWith('[silent-failure][mcp-summary]', expect.any(Error))
  })
})
