/**
 * 「定位我的消息」的悬浮按钮组（PLAN-message-navigator，2026-10-04；
 * 交互第二轮用户裁定：第一轮的搜索浮层否决）。
 *
 * 两个悬浮件都只在**对话区离开底部**时出现（用户裁定：滑动之后才出现），
 * 由宿主 ChatView 传 visible：
 *  - 回到底部：向下箭头圆钮，消息输入区水平居中的上方，点击平滑滚回底部；
 *  - 上/下一条用户消息：右侧玻璃药丸里的一对步进钮。到头置灰（用户裁定：
 *    已处于第一条时前一条置灰；下一条到最后一条对称处理），可用性由组件
 *    自挂在视口实测上实时重算（捕获式滚动监听 + rAF 节流，翻面才 setState）。
 *
 * 步进的目标测算（measureStepTarget）在**点击与渲染共用同一份**：以视口为
 * 参照、不维护光标，手滚之后也不会跳错。跳转本身上抛给宿主的统一跳转
 * effect（扩窗 + 平滑滚动机制，无高亮脉冲）。
 *
 * 渲染位置：InputArea 的 topSlot——与 Composer 同容器锚定，autosize 增高时
 * 随卡片上移，永不被遮挡。
 */
import React, { useEffect, useState } from 'react'
import { Tooltip } from 'antd'
import { ArrowDownOutlined, ArrowUpOutlined, CaretDownFilled } from '@ant-design/icons'
import type { UserPromptAnchor } from './message-navigator'
import { COMPOSER_MAX_WIDTH } from './Composer'
import { useTranslation } from '../../i18n/useTranslation'

const ICON_BTN: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--pm-text-secondary)',
  cursor: 'pointer',
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

/**
 * 步进目标测算（视口实测，返回命中下标或 -1）。参照物两种情况：
 * 视口内有可见的用户消息 → 最接近视口中心的那条为「当前」，目标 = 它的
 * 前/后一条（连续点击逐条走；居中那条不会被同方向重复命中——「按同侧
 * 最近选目标」的旧算法在这里会命中当前条自己，点了像没动）；视口内一条
 * 都不可见 → 取刚越过视口边缘最近的那条。窗口化转写未挂载的锚测不到，
 * 按索引步进天然命中它们（宿主的扩窗机制兜底）；一条都没挂载时全部在
 * 窗口之上，up 取最后一条，down 无处可去。
 */
export function measureStepTarget(prompts: UserPromptAnchor[], dir: -1 | 1): number {
  if (prompts.length === 0) return -1
  const center = window.innerHeight / 2
  let currentIdx = -1
  let currentDist = Infinity
  let edgeIdx = -1
  let edgeDist = Infinity
  let mountedSeen = false
  for (let i = 0; i < prompts.length; i++) {
    const el = document.getElementById(`chat-msg-${prompts[i].anchorId}`)
    if (!el) continue
    mountedSeen = true
    const rect = el.getBoundingClientRect()
    if (rect.bottom > 0 && rect.top < window.innerHeight) {
      const d = Math.abs((rect.top + rect.bottom) / 2 - center)
      if (d < currentDist) {
        currentDist = d
        currentIdx = i
      }
    }
    // dir 侧刚越过视口边缘的最近一条：up = 完全在视口顶之上（rect.bottom
    // 越大越近），down = 完全在视口底之下（rect.top 越小越近）。
    const past = dir === -1 ? -rect.bottom : rect.top - window.innerHeight
    if (past >= 0 && past < edgeDist) {
      edgeDist = past
      edgeIdx = i
    }
  }
  let targetIdx = -1
  if (currentIdx >= 0) {
    targetIdx = currentIdx + dir
  } else if (edgeIdx >= 0) {
    targetIdx = edgeIdx
  } else if (dir === -1 && !mountedSeen) {
    targetIdx = prompts.length - 1
  }
  if (targetIdx < 0 || targetIdx >= prompts.length) return -1
  return targetIdx
}

export interface MessageNavControlsProps {
  /** 对话区是否已离开底部（唯一显隐开关）。 */
  visible: boolean
  /** 有序用户消息锚点（listUserPrompts 的产物）。 */
  prompts: UserPromptAnchor[]
  /** 回到底部按钮是否需要为计划条让位（计划条与回到底部都水平居中）。 */
  stripAbove: boolean
  onJumpToBottom: () => void
  /** 步进命中一条用户消息时上抛；到头（置灰方向）不会调用。 */
  onJumpPrompt: (msgId: string) => void
}

export const MessageNavControls = React.memo(function MessageNavControls({
  visible,
  prompts,
  stripAbove,
  onJumpToBottom,
  onJumpPrompt,
}: MessageNavControlsProps): React.ReactElement | null {
  const { t } = useTranslation()
  // ↑/↓ 可用性：与点击共用 measureStepTarget，滚动时实时重算（容器在宿主
  // 手里，capture 监听收得到任何内层滚动，跳转的平滑滚动事件也不例外——
  // 落点之后置灰态自然刷新）。rAF 节流 + 翻面才 setState：滚动洪流里只有
  // 跨过提示边界的那几帧会 re-render 这个小组件。
  const [canStep, setCanStep] = useState({ up: false, down: false })
  useEffect(() => {
    if (!visible) return
    let raf = 0
    const update = () => {
      raf = 0
      const up = measureStepTarget(prompts, -1) >= 0
      const down = measureStepTarget(prompts, 1) >= 0
      setCanStep((prev) => (prev.up === up && prev.down === down ? prev : { up, down }))
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [visible, prompts])

  if (!visible) return null

  const stepBtnStyle = (ok: boolean): React.CSSProperties => ({
    ...ICON_BTN,
    width: 32,
    height: 30,
    fontSize: 12,
    color: ok ? 'var(--pm-text-secondary)' : 'var(--pm-text-disabled)',
    cursor: ok ? 'pointer' : 'default',
  })

  // 与 .ant-sender 同宽同心的「卡框」：卡片在 1000px 列内 max-width 952 +
  // margin auto 居中，距列缘的内缩量 = (列宽-952)/2，随窗宽变化——静态
  // right 值对不齐卡片右缘，必须用同一套定位数学。根框只做对齐（透明于
  // 指针），两簇按钮各自恢复可点。
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        margin: '0 auto',
        maxWidth: COMPOSER_MAX_WIDTH,
        pointerEvents: 'none',
      }}
    >
      <Tooltip title={t('chatView.navigator.toBottom')}>
        <button
          type="button"
          aria-label={t('chatView.navigator.toBottom')}
          onClick={onJumpToBottom}
          style={{
            // ICON_BTN 必须先展开：它自带 background: transparent（步进钮
            // 需要透出药丸底色），放在后面会把这里的 elevated 底色覆盖掉。
            ...ICON_BTN,
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: stripAbove ? 30 : 0,
            width: 36,
            height: 36,
            borderRadius: '50%',
            fontSize: 14,
            background: 'var(--pm-elevated)',
            border: '1px solid var(--pm-border-veil)',
            boxShadow: 'var(--pm-shadow-pop)',
            pointerEvents: 'auto',
          }}
        >
          {/* 实心三角：与步进对的空心长箭头区分（那也是 ↓），字形干净不歧义 */}
          <CaretDownFilled />
        </button>
      </Tooltip>

      {prompts.length > 0 && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            height: 32,
            display: 'flex',
            alignItems: 'center',
            borderRadius: 999,
            background: 'var(--pm-elevated)',
            border: '1px solid var(--pm-border-veil)',
            boxShadow: 'var(--pm-shadow-pop)',
            overflow: 'hidden',
            pointerEvents: 'auto',
          }}
        >
          <Tooltip title={t('chatView.navigator.prev')}>
            <button
              type="button"
              aria-label={t('chatView.navigator.prev')}
              disabled={!canStep.up}
              onClick={() => {
                const idx = measureStepTarget(prompts, -1)
                if (idx >= 0) onJumpPrompt(prompts[idx].id)
              }}
              style={stepBtnStyle(canStep.up)}
            >
              <ArrowUpOutlined />
            </button>
          </Tooltip>
          <div style={{ width: 1, height: 16, background: 'var(--pm-border-veil)' }} />
          <Tooltip title={t('chatView.navigator.next')}>
            <button
              type="button"
              aria-label={t('chatView.navigator.next')}
              disabled={!canStep.down}
              onClick={() => {
                const idx = measureStepTarget(prompts, 1)
                if (idx >= 0) onJumpPrompt(prompts[idx].id)
              }}
              style={stepBtnStyle(canStep.down)}
            >
              <ArrowDownOutlined />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  )
})
