// ── 全窗浮层判定 + 观察（2026-11-21）──
// 原生 WebContentsView 恒合成在 DOM 之上（浏览器主视图下几乎铺满主卡），所以
// 居中 Modal / ⌘K 面板 / 遮罩一类「盖住整窗」的 DOM 浮层会被页面整个吞掉。
// 几何让位（useFloatOverlayShift）对这类无解——浮层盖的不是一条边，是一片。
//
// 这里只回答一个问题：**现在有没有一个整窗浮层在屏上**。答案交给
// useBrowserPane 与 browserActive 相与：dock 收到 false 就把 view 收成 0×0
// （折叠保留语义不变，页签与页面都活着），浮层关掉即一次 bounds 写回。
// 判据只认「整窗」——小浮窗（tooltip/下拉）仍走几何让位，不能拿折叠处理，
// 否则鼠标划过一颗图标页面就闪一次。
//
// 双判据是刻意的：遮罩按 alpha 算（title-bar-mask 的既有口径，antd 默认 0.45
// 与手写 [data-pm-mask] 都覆盖），另加一条无遮罩的兜底——`.ant-modal-wrap` 的
// CSS 是 fixed + inset:0，即使弹窗本体只有 400px 宽，它也整窗吃点击；它连同
// Drawer 的滑入面板一起算作遮挡物。只靠遮罩的话，`mask={false}` 的弹窗会漏。

import { MASK_SELECTOR, currentMaskAlpha, isOnScreen } from './title-bar-mask'

/** 无遮罩也算遮挡的元素。Drawer 的面板本体在 wrapper 里（`.ant-drawer-content-wrapper`），
 *  与 Modal 的滚动容器同族处理。 */
export const MASKLESS_OCCLUDER_SELECTOR = '.ant-modal-wrap, .ant-drawer-content-wrapper'

/** 变更过滤口径。**故意比判定口径宽**：遮罩自身要能被看见（它是「填充进来的
 *  那一拍」的主角），且 antd 关弹窗时 display:none 可能打在祖先
 *  （`.ant-modal-root` / `.ant-drawer`）上——只盯遮挡物自身会漏掉「祖先被藏起来」
 *  这一类变化，状态就停在 true。 */
export const OCCLUSION_WATCH_SELECTOR = `${MASK_SELECTOR}, ${MASKLESS_OCCLUDER_SELECTOR}, .ant-modal-root, .ant-drawer`

/**
 * 当前是否有整窗浮层在屏上。
 *
 * 遮罩走 `currentMaskAlpha`（同一份口径，标题栏按钮亮度用的也是它）；无遮罩的
 * 两种容器走可见性。纯背景模糊（alpha 0）的遮罩不计入——PulseMind 里没有这种，
 * 真加了再补一条 backdrop-filter 判据。
 */
export function hasOccludingOverlay(doc: Document = document): boolean {
  if (currentMaskAlpha(doc) > 0) return true
  for (const el of doc.querySelectorAll(MASKLESS_OCCLUDER_SELECTOR)) {
    if (isOnScreen(el)) return true
  }
  return false
}

/** 一次变更是否可能改变结论：节点自己就是遮挡物/容器，或它的子树里有
 *  （antd 先挂空容器、下一次提交才填内容——只判自身会漏掉填进来的那一拍；
 *  移除时子树仍在，querySelector 照样作答）。 */
function announcesOcclusion(node: Node): boolean {
  if (node.nodeType !== 1) return false
  const el = node as Element
  return Boolean(el.matches?.(OCCLUSION_WATCH_SELECTOR) || el.querySelector?.(OCCLUSION_WATCH_SELECTOR))
}

/**
 * 盯 document.body 的浮层进出，结论变化时回调一次（初始值也会报一拍：挂载前
 * 就开着的弹窗同样要折叠）。返回 disposer。
 *
 * 每条变更先过 `announcesOcclusion` 的廉价过滤再算——流式输出期间 body 变更
 * 极密，每次变更都做一次全文档 querySelectorAll 会把对话拖垮（title-bar-mask
 * 的 watcher 是同一个理由）。class/style 变更也要盯：antd 开关弹窗就是翻
 * display 与加 `*-hidden` 类。
 */
export function startOcclusionWatcher(win: Window = window, onChange: (occluded: boolean) => void): () => void {
  let last: boolean | null = null
  const report = (): void => {
    const next = hasOccludingOverlay(win.document)
    if (next === last) return
    last = next
    onChange(next)
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        const el = m.target as Element
        if (el.matches?.(OCCLUSION_WATCH_SELECTOR)) {
          report()
          return
        }
        continue
      }
      for (const nodes of [m.addedNodes, m.removedNodes]) {
        for (const node of nodes) {
          if (announcesOcclusion(node)) {
            report()
            return
          }
        }
      }
    }
  })
  observer.observe(win.document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
  report()
  return () => observer.disconnect()
}
