// @vitest-environment jsdom
// 整窗浮层 → 折叠（2026-11-21）的**接线末段**：store 里的 occluded 必须真的改变
// 推给主进程的 browserActive。源码扫描只能证明「字样在」，证明不了「相与生效」——
// 少一个 `!`、deps 漏项、分支写错一处，扫描全绿而弹窗依旧被页面吞掉。所以这里挂
// 真 hook、真 store，只桩掉 electronAPI，按真实推送顺序断言。

import React, { act } from 'react'
import { useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrowserPaneBinding } from '../src/renderer/src/hooks/useBrowserPane'
import { useBrowserPaneStore } from '../src/renderer/src/stores/browserPaneStore'
import { useWorkbenchStore } from '../src/renderer/src/stores/workbenchStore'
import type { BrowserPaneState } from '../src/shared/browser/pane'

const CONV = 'conv_20261121_occlusion'
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

let pushes: BrowserPaneState[] = []
const lastPush = (): BrowserPaneState => pushes.at(-1)!

function Probe(props: { conversationId: string }): React.ReactElement | null {
  const ref = useRef<HTMLDivElement | null>(null)
  useBrowserPaneBinding(props.conversationId, ref, true)
  return null
}

let root: ReturnType<typeof createRoot> | null = null
let host: HTMLDivElement | null = null

beforeEach(() => {
  pushes = []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('electronAPI', {
    browserPaneSetState: vi.fn(async (state: BrowserPaneState) => {
      pushes.push(state)
    }),
    browserPaneSetWidth: vi.fn(async () => {}),
    browserPaneAction: vi.fn(async () => {}),
  })
  useBrowserPaneStore.getState().setOccluded(false)
  useBrowserPaneStore.getState().setFreeze(null)
  useBrowserPaneStore.getState().setFreezeSettled(false)
  useBrowserPaneStore.getState().setPrimaryPaneWidth(640)
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
  useWorkbenchStore.getState().setConversationPrimary(CONV, 'chat')
  useWorkbenchStore.getState().setOpen(CONV, false)
  vi.unstubAllGlobals()
})

async function mount(): Promise<void> {
  await act(async () => {
    root = createRoot(host!)
    root.render(React.createElement(Probe, { conversationId: CONV }))
  })
  await flush()
}

async function flip(occluded: boolean): Promise<void> {
  await act(async () => {
    const store = useBrowserPaneStore.getState()
    store.setOccluded(occluded)
    // 抓帧「有结论」由 useBrowserFreeze 置（它有自己的测试）；这里直接给结论，
    // 因为折叠等的是这两个字段的合取。
    if (occluded) store.setFreezeSettled(true)
  })
  await flush()
}

describe('occluded 与 browserActive 相与', () => {
  it('抓帧没回来时先不折，结论一到才折（先抓后折，页面不先黑一下）', async () => {
    await act(async () => useWorkbenchStore.getState().setConversationPrimary(CONV, 'browser'))
    await mount()
    expect(lastPush().browserActive).toBe(true)

    // 浮层已在屏上、抓图还在路上：页面必须继续在屏（此时折了就是空白）。
    await act(async () => useBrowserPaneStore.getState().setOccluded(true))
    await flush()
    expect(lastPush().browserActive).toBe(true)

    // 抓帧有了结论（图可能为空）——折叠与铺图同一拍。
    await act(async () => useBrowserPaneStore.getState().setFreezeSettled(true))
    await flush()
    expect(lastPush().browserActive).toBe(false)
  })

  it('浏览器主视图：弹窗开 → browserActive false，关 → 回来', async () => {
    await act(async () => useWorkbenchStore.getState().setConversationPrimary(CONV, 'browser'))
    await mount()
    expect(lastPush().browserActive).toBe(true)

    await flip(true)
    expect(lastPush().browserActive).toBe(false)

    await flip(false)
    expect(lastPush().browserActive).toBe(true)
  })

  it('侧栏形态（工作台停在浏览器 tab）：同样折叠', async () => {
    await act(async () => {
      useWorkbenchStore.getState().setConversationPrimary(CONV, 'chat')
      useWorkbenchStore.getState().setOpen(CONV, true)
      useWorkbenchStore.getState().setActiveTab(CONV, 'browser')
    })
    await mount()
    expect(lastPush().browserActive).toBe(true)

    await flip(true)
    expect(lastPush().browserActive).toBe(false)
  })

  it('工作台停在非浏览器 tab 时，浮层不影响判定（本来就是折叠的）', async () => {
    await act(async () => {
      useWorkbenchStore.getState().setConversationPrimary(CONV, 'chat')
      useWorkbenchStore.getState().setOpen(CONV, true)
      useWorkbenchStore.getState().setActiveTab(CONV, 'workspace')
    })
    await mount()
    expect(lastPush().browserActive).toBe(false)
    await flip(true)
    expect(lastPush().browserActive).toBe(false)
  })

  it('浮层期间几何照常推送（insets/paneWidth 不因此丢档）', async () => {
    await act(async () => useWorkbenchStore.getState().setConversationPrimary(CONV, 'browser'))
    await mount()
    await flip(true)
    const push = lastPush()
    expect(push.browserActive).toBe(false)
    expect(push.chromeHeight).toBe(68)
    expect(push.paneWidth).toBe(643)
  })
})
