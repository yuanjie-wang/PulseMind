// ── Float overlay shift (PLAN-layout-modes 十三期 2026-11-04) ──
// 原生 WebContentsView 画在一切 DOM 之上——浏览器主视图下，左侧边栏（以及
// 右侧 dock）的下拉浮窗一旦右侵/左侵进浏览器主卡就被遮挡，z-index 无解。
// 与 pane 自己地址栏的 chromeOverlay 同思路（T3.5 先例）：渲染端量出可见
// 浮窗越过 webview 左/右缘的 px，经 browserPaneStore 随 pane-state 推给
// dock，dock 把 view 的左右缘临时内收让出浮窗（裁剪不缩放，浮窗关闭归零）。
//
// 本 hook 是唯一测量点，主窗 App 挂一次。测量走 body 级 MutationObserver——
// antd 浮窗（dropdown/select-dropdown/popover/tooltip）全部 portal 到 body，
// 无需逐个 Dropdown 接线；class 翻转（*-hidden）即开关信号。可见期间保持
// rAF 循环重测（吃掉 antd 开启动画的滑动与滚动位置变化），无浮窗即归零停表。

import { useEffect } from 'react'
import { useBrowserPaneStore } from '../stores/browserPaneStore'

const FLOAT_SELECTOR = '.ant-dropdown, .ant-select-dropdown, .ant-popover, .ant-tooltip'

export function useFloatOverlayShift(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof MutationObserver === 'undefined' || typeof requestAnimationFrame === 'undefined') {
      useBrowserPaneStore.getState().setFloatOverlay({ left: 0, right: 0 })
      return
    }

    let raf = 0
    let measuring = false

    const measure = (): void => {
      const card = document.querySelector('[data-pm-primary-browser-card]')
      let left = 0
      let right = 0
      let anyVisible = false
      if (card) {
        const cardRect = card.getBoundingClientRect()
        // webview 在卡内的真实矩形（dock 数学）：左右各收 1px 边框、顶部
        // 6px inset + 68 chrome、底部 6px inset——只对与该矩形相交的浮窗让位
        //（悬在 chrome 行上方的浮窗本来就是 DOM-on-DOM，可见，无需让）。
        const wvLeft = cardRect.left + 1
        const wvRight = cardRect.right - 1
        const wvTop = cardRect.top + 74
        const wvBottom = cardRect.bottom - 6
        for (const el of document.querySelectorAll(FLOAT_SELECTOR)) {
          // antd 的隐藏态是 *-hidden class——逐 class 判断（className 整串
          // 结尾匹配会被中间的 placement 类骗过）。
          let hidden = false
          el.classList.forEach((c) => {
            if (c.endsWith('-hidden')) hidden = true
          })
          if (hidden) continue
          const rect = el.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) continue
          if (rect.bottom <= wvTop || rect.top >= wvBottom) continue
          anyVisible = true
          // 只处理「骑在 webview 缘上」的浮窗：完全罩在 webview 内的浮窗
          // 无法用边缘内收救回（也不该发生——浮窗都锚在 webview 外的触发器上）。
          if (rect.right > wvLeft && rect.left < wvLeft) {
            left = Math.max(left, Math.ceil(rect.right - wvLeft) + 4)
          }
          if (rect.left < wvRight && rect.right > wvRight) {
            right = Math.max(right, Math.ceil(wvRight - rect.left) + 4)
          }
        }
      }
      const prev = useBrowserPaneStore.getState().floatOverlay
      if (prev.left !== left || prev.right !== right) {
        useBrowserPaneStore.getState().setFloatOverlay({ left, right })
      }
      // 可见期间持续重测（rAF）：吃掉开启动画的滑动、浮窗内容导致的自身
      // 位置微调；浮窗全关后停止，归零一拍即可。
      if (anyVisible) {
        raf = requestAnimationFrame(measure)
        measuring = true
      } else {
        measuring = false
      }
    }

    const schedule = (): void => {
      if (measuring) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }

    // 任何 body 变更都 schedule 一拍（rAF 合并到每帧最多一次 measure）：
    // 浮窗挂载/卸载、*-hidden 翻转、以及流式更新期间的位置漂移全覆盖。
    const observer = new MutationObserver(() => schedule())
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    // 挂载即测一拍（浮窗先开、enabled 后到的时序）。
    schedule()

    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
      useBrowserPaneStore.getState().setFloatOverlay({ left: 0, right: 0 })
    }
  }, [enabled])
}
