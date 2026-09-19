// ── useFocusTrap ──
// 弹层的焦点语义：进去时把焦点交给层内第一个可聚焦元素，Tab/Shift+Tab 在层内
// 循环（不会 Tab 到遮罩后面的页面），关闭时把焦点还给打开层之前的那个元素。
// 只管 Tab 循环与（可选的）Escape；组件自己的其余快捷键不受影响。
//
// jsdom/vitest 没有布局与真实焦点模型，本 hook 不做单测 —— 消费方以真实
// 浏览器探针验收（与 probe-panel-ask-user 的点击验收同一理由）。

import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export interface FocusTrapOptions {
  /** false 时不挂任何监听（弹层未打开）。 */
  active: boolean
  /** Escape 关闭回调。组件已自管 Escape（如 ImageViewer 的 window 监听）时
   *  省略，避免一次 Esc 两次关闭。 */
  onEscape?: () => void
  /** 复用一个已有的 ref（容器同时承担别的职责时），省略则内部自建。 */
  ref?: RefObject<HTMLElement | null>
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
  return nodes.filter((el) => el.offsetParent !== null || el === document.activeElement || el.getClientRects().length > 0)
}

export function useFocusTrap<T extends HTMLElement>(opts: FocusTrapOptions): RefObject<T | null> {
  const internalRef = useRef<T | null>(null)
  const { active, onEscape, ref } = opts
  // options 的最新值经 effect 同步（不能在 render 期写 ref）：监听器只在
  // active 翻转时挂/卸，Escape 回调在事件触发时经 ref 惰性读取。
  const optionsRef = useRef({ onEscape })
  useEffect(() => {
    optionsRef.current = { onEscape }
  })

  useEffect(() => {
    const container = (ref ?? internalRef).current as T | null
    if (!active || !container) return

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusables = getFocusable(container)
    const initial = focusables[0] ?? container
    initial.focus({ preventScroll: true })

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        const onEsc = optionsRef.current.onEscape
        if (onEsc) {
          e.stopPropagation()
          onEsc()
        }
        return
      }
      if (e.key !== 'Tab') return
      const items = getFocusable(container)
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const current = document.activeElement
      const inside = current instanceof Node && container.contains(current)
      if (e.shiftKey) {
        if (!inside || current === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (!inside || current === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    container.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus?.({ preventScroll: true })
    }
  }, [active, ref])

  return internalRef
}
