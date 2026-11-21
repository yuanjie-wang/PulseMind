// ── 冻结帧：折叠前先要一帧（2026-11-21，方案 ③）──
// 整窗浮层打开时原生 view 只能折叠让开（否则弹窗被页面吞掉），折叠后卡片是
// 空白的。这里在折叠**之前**向主进程要一帧当前页面，拿到才让 useBrowserPane
// 折叠——两次视觉变化合并成一次原子替换，页面看起来是「定格」，不是「先黑一下
// 再出现底图」。
//
// 时序（AppSimulator 那套 veiled/veiledShot 三态机的等价物，压成两个字段）：
//   idle        occluded=false                     不折、无图
//   capturing   occluded=true, freezeSettled=false  页面照旧在屏（弹窗还没露脸，
//                                                   但 antd 自己的入场动画本来也
//                                                   要这么多帧）
//   frozen      occluded=true, freezeSettled=true   折 + 铺图（freeze 可能为 null
//                                                   ＝没抓到，退化成空白底）
// 超时兜底必须有：抓图卡住时宁可空白，也不能让弹窗永远藏在页面下面。

import { useEffect } from 'react'
import { useBrowserPaneStore } from '../stores/browserPaneStore'

/** 等帧的上限。capturePage 通常 20–80ms；超过这个数说明它在排队或已失效，
 *  再等就变成「点了 ⌘K 没反应」。 */
export const FREEZE_TIMEOUT_MS = 300

export function useBrowserFreeze(): void {
  const occluded = useBrowserPaneStore((s) => s.occluded)

  useEffect(() => {
    const store = useBrowserPaneStore.getState()
    if (!occluded) {
      // 浮层关掉：底图与「有结论」一起归零，下一轮从干净状态重新抓。
      store.setFreeze(null)
      store.setFreezeSettled(false)
      return
    }

    let dead = false
    const timer = setTimeout(() => {
      if (!dead) useBrowserPaneStore.getState().setFreezeSettled(true)
    }, FREEZE_TIMEOUT_MS)

    void window.electronAPI
      .browserPaneFreezeFrame()
      .then((frame) => {
        if (dead) return
        clearTimeout(timer)
        const now = useBrowserPaneStore.getState()
        // 图晚到也要铺：超时后已经折叠了一次，这是把空白升级成冻结帧。
        now.setFreeze(frame ?? null)
        now.setFreezeSettled(true)
      })
      .catch(() => {
        if (dead) return
        clearTimeout(timer)
        useBrowserPaneStore.getState().setFreezeSettled(true)
      })

    return () => {
      dead = true
      clearTimeout(timer)
    }
  }, [occluded])
}
