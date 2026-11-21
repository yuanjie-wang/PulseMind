// ── 浮层遮挡 → 折叠浏览器原生 view（2026-11-21）──
// 浏览器主视图下 view 几乎铺满主卡，居中 Modal / ⌘K 面板 / 遮罩会被它整个吞掉，
// 几何让位对这类无解（盖的不是一条边，是一片）——唯一的解法是让 view 让开：
// 遮罩在屏上期间把 browserActive 推成 false，dock 收到就收成 0×0（折叠保留，
// 页签与页面都活着），浮层关掉即一次 bounds 写回。
//
// 判定与观察住在 utils/overlay-occlusion（纯 DOM，jsdom 可测）；这里只把结论
// 写进 store，由 useBrowserPane 的推送与 browserActive 相与。主窗 App 与
// 会话弹出/沉浸窗口 PopoutApp 各挂一次——每个窗口有自己的 store 与自己的 dock，
// 而弹窗是整窗的，各窗各测自己的 body。

import { useEffect } from 'react'
import { useBrowserPaneStore } from '../stores/browserPaneStore'
import { startOcclusionWatcher } from '../utils/overlay-occlusion'

export function useBrowserOcclusion(): void {
  useEffect(() => {
    const stop = startOcclusionWatcher(window, (occluded) => useBrowserPaneStore.getState().setOccluded(occluded))
    return () => {
      stop()
      // 卸载（含 StrictMode 的假卸载）时归零：重新挂载会立刻重测一拍，
      // 留着 true 会让一次 dev 热更把页面永久折叠。
      useBrowserPaneStore.getState().setOccluded(false)
    }
  }, [])
}
