/**
 * 录音态的实时声波：跟着声音跳动的柱状波形，与停止方块并排出现在麦克风
 * 按钮上——波形表达「正在收音」，方块表达「再点一次就停」，两者缺一不可。
 *
 * 为什么是 canvas + ref 而不是 React state：
 *   电平每 100ms 一到（worklet 的帧率），60fps 的 rAF 又要平滑插值——若电平
 *   进 state，每秒几十次 setState 会把 1690 行的 InputAreaImpl 整个重渲，
 *   正是 2026-11-22 用户反馈「分段识别时按钮抖动」的根因。这里电平通过
 *   MutableRefObject 传入，绘制全在 effect 内自持，React 一次都不重渲。
 *
 * 不撑布局：尺寸固定（默认 32×18，与原 14px 图标同一视觉重量），录音态
 *   一次性替换图标。秒数在它右侧由 VoiceElapsed 定宽自持；这里绝不随时间
 *   改宽度——按钮宽度在整段录音期间恒定。卡片高度也完全不受影响。
 *
 * reduced-motion：不跑 rAF，画一条静态中等波形——保留「麦克风在收音」的
 *   可见信号，与 Composer 边框呼吸的处理一致（停动画但留红边）。
 */
import React, { useEffect, useRef, type MutableRefObject } from 'react'

/** 当前麦克风电平（0..1），由 useVoiceInput 写入、波形读取。 */
export type VoiceLevelRef = MutableRefObject<number>

/** 一帧 PCM → 0..1 的电平，给波形绘制用（不碰转写：帧原样喂 segmenter）。
 *  纯函数，便于单测钉住增益契约：静音落 0、常声铺开、大声截到 1。
 *  正常说话 RMS 约 0.02~0.15，×8 后能铺满 32×18 波形高度。 */
export function frameLevel(frame: Float32Array, gain = 8): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.min(1, Math.sqrt(sum / frame.length) * gain)
}

export interface VoiceWaveformProps {
  levelRef: VoiceLevelRef
  /** CSS 像素尺寸，默认 32×18，与麦克风图标相当。 */
  width?: number
  height?: number
}

/** 柱子数：32px 宽下 9 根 2px 柱 + 2px 间隙，读数清楚又不碎。 */
const BARS = 9
const BAR_W = 2
/** 波形向左滚动的推进间隔，与 worklet 的 100ms 帧对齐（略快一点更跟手）。 */
const STEP_MS = 90
/** 显示值向目标靠拢的系数：越大越跟手、越小越绵软。 */
const SMOOTH = 0.3

export const VoiceWaveform = React.memo(function VoiceWaveform({ levelRef, width = 32, height = 18 }: VoiceWaveformProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // backing store 按 DPR 放大，CSS 尺寸不动——与 PdfPreview 的 1:1 口径一致
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.scale(dpr, dpr)

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // 颜色从 CSS 变量取，明暗主题各有一支 --pm-rec-accent
    const accent = getComputedStyle(canvas).getPropertyValue('--pm-rec-accent').trim() || '#ff4d4f'

    const target = new Array<number>(BARS).fill(0)
    const shown = new Array<number>(BARS).fill(0)
    const gap = (width - BARS * BAR_W) / (BARS - 1)
    const midY = height / 2
    let lastStep = 0
    let raf = 0

    // 钟形包络：中间高两边低，读起来像一段真实语音的轮廓而非一排等高手
    const envelope = (i: number): number => 0.42 + 0.58 * Math.sin((Math.PI * (i + 1)) / (BARS + 1))

    const paint = (): void => {
      ctx.clearRect(0, 0, width, height)
      ctx.shadowColor = accent
      ctx.shadowBlur = 6
      ctx.fillStyle = accent
      for (let i = 0; i < BARS; i++) {
        // 2px 的最小高度：静音时仍是一排短点，不会消失成空白
        const h = Math.max(2, shown[i] * envelope(i) * height)
        const x = i * (BAR_W + gap)
        const y = midY - h / 2
        ctx.beginPath()
        if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, BAR_W, h, BAR_W / 2)
        else ctx.rect(x, y, BAR_W, h)
        ctx.fill()
      }
      ctx.shadowBlur = 0
    }

    if (reduce) {
      // 静态中等波形：不随时间变，也不跑 rAF
      for (let i = 0; i < BARS; i++) shown[i] = 0.55 * envelope(i)
      paint()
      return
    }

    const tick = (t: number): void => {
      if (t - lastStep >= STEP_MS) {
        target.shift()
        target.push(levelRef.current)
        lastStep = t
      }
      for (let i = 0; i < BARS; i++) shown[i] += (target[i] - shown[i]) * SMOOTH
      paint()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [levelRef, width, height])

  return <canvas ref={canvasRef} style={{ width, height, display: 'block' }} aria-hidden="true" />
})
