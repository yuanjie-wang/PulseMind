// ── 冻结帧层（2026-11-21，方案 ③）──
// 折叠掉的浏览器原生 view 的那一屏，按主进程给的矩形铺回 DOM。位置是 `fixed`
// 而不是挂在某个卡里：矩形是**窗口内容区坐标**（dock 自己算的、写进 view 的那
// 一个盒子），渲染端不再复算一遍几何——主窗、会话弹窗、项目沉浸窗口的右卡都是
// 同一套坐标，一个组件、每窗挂一次就够。
//
// 层级：DOM 永远在原生 view 之下（这正是需要它的原因），但必须高于卡片底色、
// 低于 antd 的遮罩（1000）。pointer-events:none——它只是底图，点击该落到弹窗或
// 遮罩上，不能在这里被吃掉。
//
// 浮层期间缩放窗口底图不跟随（矩形是抓帧那一刻的）：遮罩盖着，重新抓一帧要再
// 走一次 IPC，且真在拖窗口的用户本来也看不清——不为此挂 resize 监听。

import type { ReactElement } from 'react'
import { useBrowserPaneStore } from '../../stores/browserPaneStore'

export function BrowserFreezeLayer(): ReactElement | null {
  const freeze = useBrowserPaneStore((s) => s.freeze)
  if (!freeze) return null
  const { box, src } = freeze
  return (
    <img
      src={src}
      alt=""
      data-pm-freeze-frame=""
      style={{
        position: 'fixed',
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        display: 'block',
        pointerEvents: 'none',
        zIndex: 20,
      }}
    />
  )
}
