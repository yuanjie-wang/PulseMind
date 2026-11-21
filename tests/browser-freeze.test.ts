// @vitest-environment jsdom
// 冻结帧取帧（2026-11-21，方案 ③）：折叠等这一拍。这里钉的是三个时序事实——
// 浮层关掉要归零（否则下一次折叠会用上一张旧图）、空帧/失败也要给结论（否则
// 弹窗永远藏在页面下面）、抓图卡死有超时兜底。都读不出源码，只能挂真 hook。

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FREEZE_TIMEOUT_MS, useBrowserFreeze } from '../src/renderer/src/hooks/useBrowserFreeze'
import { BrowserFreezeLayer } from '../src/renderer/src/components/browser/BrowserFreezeLayer'
import { useBrowserPaneStore } from '../src/renderer/src/stores/browserPaneStore'
import type { PaneFreezeFrame } from '../src/shared/browser/pane'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

const FRAME: PaneFreezeFrame = { src: 'data:image/png;base64,AAA', box: { x: 100, y: 74, width: 800, height: 450 } }

function Probe(): React.ReactElement | null {
  useBrowserFreeze()
  return null
}

let root: ReturnType<typeof createRoot> | null = null
let host: HTMLDivElement | null = null
let capture: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useBrowserPaneStore.getState().setOccluded(false)
  useBrowserPaneStore.getState().setFreeze(null)
  useBrowserPaneStore.getState().setFreezeSettled(false)
  capture = vi.fn(async () => FRAME as PaneFreezeFrame | null)
  vi.stubGlobal('electronAPI', { browserPaneFreezeFrame: capture })
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mount(): Promise<void> {
  await act(async () => {
    root = createRoot(host!)
    root.render(React.createElement(Probe))
  })
  await flush()
}

async function setOccluded(occluded: boolean): Promise<void> {
  await act(async () => useBrowserPaneStore.getState().setOccluded(occluded))
  await flush()
}

describe('useBrowserFreeze — 取帧与归零', () => {
  it('没有浮层不抓图', async () => {
    await mount()
    expect(capture).not.toHaveBeenCalled()
    expect(useBrowserPaneStore.getState().freezeSettled).toBe(false)
  })

  it('浮层出现 → 抓一帧并给结论（src + 主进程给的 box 原样进 store）', async () => {
    await mount()
    await setOccluded(true)
    expect(capture).toHaveBeenCalledTimes(1)
    const state = useBrowserPaneStore.getState()
    expect(state.freeze).toEqual(FRAME)
    expect(state.freezeSettled).toBe(true)
  })

  it('没东西可定格（null）也给结论——折叠要继续，只是没有底图', async () => {
    capture.mockResolvedValueOnce(null)
    await mount()
    await setOccluded(true)
    const state = useBrowserPaneStore.getState()
    expect(state.freeze).toBeNull()
    expect(state.freezeSettled).toBe(true)
  })

  it('抓图失败同样给结论（不能把弹窗卡在页面下面）', async () => {
    capture.mockRejectedValueOnce(new Error('capture failed'))
    await mount()
    await setOccluded(true)
    expect(useBrowserPaneStore.getState().freeze).toBeNull()
    expect(useBrowserPaneStore.getState().freezeSettled).toBe(true)
  })

  it('浮层关掉 → 图与结论一起归零（否则下一轮会拿旧图先折）', async () => {
    await mount()
    await setOccluded(true)
    expect(useBrowserPaneStore.getState().freeze).not.toBeNull()

    await setOccluded(false)
    expect(useBrowserPaneStore.getState().freeze).toBeNull()
    expect(useBrowserPaneStore.getState().freezeSettled).toBe(false)
  })

  it('抓图卡死：超时兜底给结论，折叠不被无限期押住', async () => {
    capture.mockImplementationOnce(() => new Promise<PaneFreezeFrame | null>(() => {}))
    vi.useFakeTimers()
    await mount()
    await act(async () => useBrowserPaneStore.getState().setOccluded(true))
    expect(useBrowserPaneStore.getState().freezeSettled).toBe(false)

    await act(async () => {
      vi.advanceTimersByTime(FREEZE_TIMEOUT_MS)
    })
    expect(useBrowserPaneStore.getState().freezeSettled).toBe(true)
  })
})

describe('BrowserFreezeLayer — 底图落在主进程给的盒子上', () => {
  async function renderLayer(): Promise<void> {
    await act(async () => {
      root = createRoot(host!)
      root.render(React.createElement(BrowserFreezeLayer))
    })
    await flush()
  }

  it('没有帧时什么都不渲染', async () => {
    await renderLayer()
    expect(document.querySelector('[data-pm-freeze-frame]')).toBeNull()
  })

  it('有帧就是一张 fixed 图，坐标/尺寸照抄 box（渲染端不复算几何）', async () => {
    useBrowserPaneStore.getState().setFreeze(FRAME)
    await renderLayer()
    const img = document.querySelector<HTMLImageElement>('[data-pm-freeze-frame]')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe(FRAME.src)
    expect(img!.style.position).toBe('fixed')
    expect(img!.style.left).toBe(`${FRAME.box.x}px`)
    expect(img!.style.top).toBe(`${FRAME.box.y}px`)
    expect(img!.style.width).toBe(`${FRAME.box.width}px`)
    expect(img!.style.height).toBe(`${FRAME.box.height}px`)
    // 底图不吃点击：没有遮罩的弹窗外面，点击该落到弹窗/卡片上。
    expect(img!.style.pointerEvents).toBe('none')
  })
})
