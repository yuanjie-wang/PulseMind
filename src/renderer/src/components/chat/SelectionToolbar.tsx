/**
 * 选中文字工具栏（2026-11-06）：对话转录里选中一段文字后，浮出「复制 / 提问」。
 *
 * 只认落在对话滚动容器内的选区——侧栏、标题栏里的选中不该弹这个工具条。
 * 监听挂在 document 的 selectionchange 上（选区事件只有 document 一级），
 * 工具条本身 portal 到 body：scroller 是 overflow:auto，留在里面的 fixed
 * 元素虽不受裁剪，但会跟着滚动容器一起被祖先的 transform/contain 改变定位
 * 基准，portal 出去最干净，也不参与转录布局。
 *
 * 两个实现细节，都是这类工具条的经典坑：
 * - 按钮在 onMouseDown 里 preventDefault。mousedown 的默认行为会折叠选区，
 *   等 click 触发时文本已经没了——不仅工具条要收，复制也拿不到内容。
 * - 复制/提问读的是 snapshot 里缓存的文本，不重新读 getSelection()：从点击
 *   到执行之间有一次 re-render，选区可能已被浏览器清掉。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '../../i18n/useTranslation'

/** 选区在视口坐标系里的包围盒（range.getBoundingClientRect 的四条边）。 */
interface SelectionBox {
  top: number
  bottom: number
  left: number
  right: number
}

interface SelectionSnapshot {
  /** 选中文字（原样，保留换行——提问时按行加引用前缀）。 */
  text: string
  box: SelectionBox
}

/** 工具条与选区之间的空隙（px）。 */
const GAP = 8
/** 工具条离视口边缘的最小距离。 */
const EDGE = 8
/** 拖选过程中选区每变一次都重算，停手这么久才算「选完了」，避免工具条追着拖拽跑。 */
const SETTLE_MS = 120
/** 复制后「已复制」保持多久再收起。 */
const COPIED_MS = 1400

export interface SelectionToolbarProps {
  /** 对话转录的滚动容器：落在它外面的选区不归本工具条管。 */
  containerRef: React.RefObject<HTMLElement | null>
  /** 「提问」：把选中文字交给宿主写进 Composer。不传则只显示「复制」（没有输入框的宿主）。 */
  onAsk?: (text: string) => void
}

export function SelectionToolbar({ containerRef, onAsk }: SelectionToolbarProps): React.ReactElement | null {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<SelectionSnapshot | null>(null)
  /** 测量后的视口坐标；null = 还没量（首帧 visibility:hidden，layout effect 里补上）。 */
  const [copied, setCopied] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)
  const copiedTimerRef = useRef(0)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let settleTimer = 0
    let raf = 0

    const hide = (): void => {
      setSnapshot(null)
      setCopied(false)
    }

    /** 当前选区是否属于本容器；属于则返回它的文本与包围盒。 */
    const read = (): SelectionSnapshot | null => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
      const text = sel.toString()
      if (!text.trim()) return null
      const range = sel.getRangeAt(0)
      // 跨出转录的选段（拖到侧栏、标题栏）不算；commonAncestorContainer 落在
      // 容器内才说明整段选区都在转录里。
      if (!container.contains(range.commonAncestorContainer)) return null
      const r = range.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return null
      return { text, box: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } }
    }

    const evaluate = (): void => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = 0
        // 选区没了/折叠了：立刻收起，不等 settle。
        if (!read()) {
          hide()
          return
        }
        window.clearTimeout(settleTimer)
        settleTimer = window.setTimeout(() => setSnapshot(read()), SETTLE_MS)
      })
    }

    // 滚一下就不该再跟着旧位置——工具条是 fixed 的，内容动了它不会动。
    const onScroll = (): void => hide()
    const onResize = (): void => hide()
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide()
    }

    document.addEventListener('selectionchange', evaluate)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('selectionchange', evaluate)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('keydown', onKeyDown)
      window.clearTimeout(settleTimer)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [containerRef])

  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), [])

  // 位置在 layout effect 里直接写 DOM：工具条的真实尺寸只有渲染后才知道，所以
  // 「先渲染（visibility:hidden）→ 量宽高 → 写 style」。写 style 而不是 setState，
  // 是为了不在 effect 里同步 setState 再触发一轮渲染（react-hooks 规则拦这个）。
  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar || !snapshot) return
    const { width, height } = bar.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const mid = (snapshot.box.left + snapshot.box.right) / 2
    const left = Math.min(Math.max(mid - width / 2, EDGE), Math.max(EDGE, vw - width - EDGE))
    let top = snapshot.box.top - height - GAP
    if (top < EDGE) top = Math.min(snapshot.box.bottom + GAP, vh - height - EDGE)
    bar.style.top = `${top}px`
    bar.style.left = `${left}px`
    bar.style.visibility = 'visible'
  }, [snapshot])

  const handleCopy = useCallback(async (): Promise<void> => {
    if (!snapshot) return
    try {
      await navigator.clipboard.writeText(snapshot.text)
      setCopied(true)
      window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => {
        setCopied(false)
        setSnapshot(null)
      }, COPIED_MS)
    } catch (err) {
      console.warn('[SelectionToolbar] Copy failed:', err)
    }
  }, [snapshot])

  const handleAsk = useCallback((): void => {
    if (!snapshot || !onAsk) return
    onAsk(snapshot.text)
    // 提问后工具条收起，选区也清掉：引用已经进了输入框，留着高亮只会挡视线。
    window.getSelection()?.removeAllRanges()
    setSnapshot(null)
  }, [snapshot, onAsk])

  if (!snapshot) return null

  return createPortal(
    <div
      ref={barRef}
      data-pm-selection-toolbar=""
      role="toolbar"
      aria-label={t('chatView.selectionToolbar.label')}
      // 见文件头：不 preventDefault 的话，按下按钮的瞬间选区就没了。
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        // 真实坐标由上面的 layout effect 写进 style；首帧先藏在 0,0。
        top: 0,
        left: 0,
        visibility: 'hidden',
        zIndex: 1200,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: 3,
        borderRadius: 8,
        background: 'var(--pm-tile-bg, #ffffff)',
        border: '1px solid var(--pm-border-soft, rgba(0, 0, 0, 0.08))',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.16)',
        userSelect: 'none',
        fontSize: 12,
        lineHeight: 1,
      }}
    >
      <style>{`
        .pm-selection-toolbar-btn {
          padding: 5px 9px;
          border: 0;
          border-radius: 5px;
          background: transparent;
          color: var(--pm-text-strong, #1f1f1f);
          font: inherit;
          cursor: pointer;
          white-space: nowrap;
        }
        .pm-selection-toolbar-btn:hover { background: var(--pm-border-hairline, rgba(0, 0, 0, 0.06)); }
        .pm-selection-toolbar-btn:active { background: var(--pm-border-soft, rgba(0, 0, 0, 0.1)); }
      `}</style>
      <button type="button" className="pm-selection-toolbar-btn" onClick={() => void handleCopy()}>
        {copied ? t('chatView.selectionToolbar.copied') : t('chatView.selectionToolbar.copy')}
      </button>
      {onAsk && (
        <>
          <span aria-hidden style={{ width: 1, height: 14, background: 'var(--pm-border-soft, rgba(0, 0, 0, 0.1))' }} />
          <button type="button" className="pm-selection-toolbar-btn" onClick={handleAsk}>
            {t('chatView.selectionToolbar.ask')}
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}
