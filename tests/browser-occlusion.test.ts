// @vitest-environment jsdom
// 整窗浮层 → 折叠浏览器 view（2026-11-21）。判定与观察都是「看不见的开关」：
// 选择器漏一个、观察器不触发、状态不随关闭回落，在 review 里读起来都是同一段
// 代码——所以这里驱动真 watcher 跑真 jsdom body，另加一条接线扫描（store →
// 推送相与 → 两个窗口挂载），缺一环弹窗照样被页面吞掉。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MASKLESS_OCCLUDER_SELECTOR, OCCLUSION_WATCH_SELECTOR, hasOccludingOverlay, startOcclusionWatcher } from '../src/renderer/src/utils/overlay-occlusion'

const ROOT = join(__dirname, '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf-8')

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function mask(alpha: number, className = 'ant-modal-mask'): HTMLElement {
  const el = document.createElement('div')
  el.className = className
  el.style.backgroundColor = `rgba(0, 0, 0, ${alpha})`
  return el
}

function wrap(className: string): HTMLElement {
  const el = document.createElement('div')
  el.className = className
  return el
}

const reports: boolean[] = []
const stops: Array<() => void> = []
const watch = (): void => {
  stops.push(startOcclusionWatcher(window, (occluded) => reports.push(occluded)))
}

beforeEach(() => {
  document.body.innerHTML = ''
  reports.length = 0
})

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  document.body.innerHTML = ''
})

describe('hasOccludingOverlay — 什么算「整窗浮层」', () => {
  it('空 body 不算', () => {
    expect(hasOccludingOverlay()).toBe(false)
  })

  it('antd 默认遮罩算（alpha 0.45）', () => {
    document.body.appendChild(mask(0.45))
    expect(hasOccludingOverlay()).toBe(true)
  })

  it('手写 [data-pm-mask]（图片查看器）算', () => {
    const el = mask(0.85, '')
    el.setAttribute('data-pm-mask', '')
    document.body.appendChild(el)
    expect(hasOccludingOverlay()).toBe(true)
  })

  it('Drawer 遮罩算', () => {
    document.body.appendChild(mask(0.45, 'ant-drawer-mask'))
    expect(hasOccludingOverlay()).toBe(true)
  })

  it('在 DOM 里但 display:none 的遮罩不算', () => {
    const hidden = mask(0.45)
    hidden.style.display = 'none'
    document.body.appendChild(hidden)
    expect(hasOccludingOverlay()).toBe(false)
  })

  it('无遮罩的 Modal 也靠 wrap 兜住（mask={false} 的漏网）', () => {
    document.body.appendChild(wrap('ant-modal-wrap'))
    expect(hasOccludingOverlay()).toBe(true)
    const el = wrap('ant-drawer-content-wrapper')
    document.body.appendChild(el)
    expect(hasOccludingOverlay()).toBe(true)
  })

  it('关掉的 wrap（display:none）不算', () => {
    const el = wrap('ant-modal-wrap')
    el.style.display = 'none'
    document.body.appendChild(el)
    expect(hasOccludingOverlay()).toBe(false)
  })

  it('纯背景模糊的遮罩（alpha 0）不计——PulseMind 里没有这种，口径写在这里', () => {
    document.body.appendChild(wrap('ant-modal-mask'))
    expect(hasOccludingOverlay()).toBe(false)
  })
})

describe('startOcclusionWatcher — 结论随浮层进出翻转', () => {
  it('挂载即报一拍 false（没有浮层也要有初始值）', () => {
    watch()
    expect(reports).toEqual([false])
  })

  it('弹窗开→true，关→false', async () => {
    watch()
    document.body.appendChild(mask(0.45))
    await flush()
    expect(reports).toEqual([false, true])

    document.body.lastElementChild!.remove()
    await flush()
    expect(reports).toEqual([false, true, false])
  })

  it('先挂空容器、下一拍才填遮罩，也能看见（antd 的提交顺序）', async () => {
    watch()
    const root = document.createElement('div')
    document.body.appendChild(root)
    await flush()
    expect(reports).toEqual([false])

    root.appendChild(mask(0.45))
    await flush()
    expect(reports).toEqual([false, true])
  })

  it('wrap 自身翻 display 就能看见（关闭时不删节点的路径）', async () => {
    watch()
    const el = wrap('ant-modal-wrap')
    el.style.display = 'none'
    document.body.appendChild(el)
    await flush()
    expect(reports).toEqual([false])

    el.style.display = ''
    await flush()
    expect(reports).toEqual([false, true])
  })

  it('流式输出的碎片变更不产生推送', async () => {
    watch()
    for (let i = 0; i < 20; i++) {
      const span = document.createElement('span')
      span.textContent = `chunk ${i}`
      document.body.appendChild(span)
    }
    await flush()
    expect(reports).toEqual([false])
  })

  it('disposer 之后不再回调', async () => {
    watch()
    for (const stop of stops.splice(0)) stop()
    document.body.appendChild(mask(0.45))
    await flush()
    expect(reports).toEqual([false])
  })

  it('观察口径要比判定口径宽：祖先容器的显隐也要盯（否则关闭后停在 true）', () => {
    expect(OCCLUSION_WATCH_SELECTOR).toContain('.ant-modal-root')
    expect(OCCLUSION_WATCH_SELECTOR).toContain('.ant-drawer')
    // 判定口径自身不含这两个祖先容器——它们在屏上不等于被遮挡。
    expect(MASKLESS_OCCLUDER_SELECTOR).not.toContain('.ant-modal-root')
  })
})

describe('接线扫描 — store → 推送相与 → 两个窗口都挂', () => {
  it('store 有 occluded（缺省 false）与 setter', () => {
    const src = read('src/renderer/src/stores/browserPaneStore.ts')
    expect(src).toContain('occluded: boolean')
    expect(src).toContain('occluded: false,')
    expect(src).toContain('setOccluded: (occluded) => set({ occluded }),')
  })

  it('折叠条件是「浮层在 + 冻结帧有结论」（方案 ③：先抓后折）', () => {
    const src = read('src/renderer/src/hooks/useBrowserPane.ts')
    expect(src).toContain('const fold = occluded && freezeSettled')
    // 三条 browserActive 推送都吃 fold（沉浸卡 / 浏览器主视图 / 侧栏）
    expect(src).toContain("browserActive: rightPanel === 'browser' && !fold,")
    expect(src).toContain("browserActive: viewKind === 'chat' && !fold,")
    expect(src).toContain("browserActive: viewKind === 'chat' ? browserActive && !fold : false,")
    // 订阅进 deps：少了这一行，浮层开合并不会重新推送。
    expect(src).toContain('    fold,\n')
  })

  it('主窗与弹窗/沉浸窗口都挂测量点', () => {
    expect(read('src/renderer/src/App.tsx')).toContain('useBrowserOcclusion()')
    expect(read('src/renderer/src/popout/PopoutApp.tsx')).toContain('useBrowserOcclusion()')
  })

  it('浮窗让位一行未动（几何让位与折叠各管一类，不互相接管）', () => {
    const src = read('src/renderer/src/hooks/useBrowserPane.ts')
    expect(src).toContain('leftOverlay: floatOverlay.left,')
    expect(src).toContain('rightOverlay: floatOverlay.right,')
  })
})
