/**
 * 后台任务悬浮条（PLAN-background-tasks D）。
 *
 * 有后台进程在跑时，悬浮 Composer 上方（navTopSlot，计划条同槽）出一条
 * 「后台任务 N」药丸：列表读 useBackgroundTasksStore（useConversationEngine
 * 的 event fold 写入——tool_status diff 带 backgroundPid 时 upsert、exit 事件
 * remove），悬停向上展开输出卡：每个任务一行，执行过程 = execLogs(pid) 的
 * 输出尾 4KB，展开期间 1.2s 轮询。任务退出（exit 事件）行即消失——结果汇报
 * 走转录的系统行 + 模型回复，条子只管「还在跑的」。
 *
 * 只列**本会话**的任务（2026-11-09 用户实锤「后台任务跨会话了」）：store 按
 * conversationId 键控，读侧同键取行——别的会话在跑什么不进本对话的条子。
 *
 * 组件自订阅 store，不占 navTopSlot 的 memo 依赖（「topSlot 引用稳定」契约，
 * ChatView 注释）——store 变化只重渲染本组件，InputArea 的 memo 不被击穿。
 */
import { useEffect, useRef, useState } from 'react'
import { LoadingOutlined } from '@ant-design/icons'
import { useBackgroundTasksStore, type BackgroundTaskRow } from '../../stores/backgroundTasksStore'
import { COMPOSER_MAX_WIDTH } from './Composer'

const OUTPUT_TAIL_BYTES = 4096
const POLL_MS = 1200
/** 悬停展开的防抖：进入 120ms 才展开（扫过的指针不弹卡）、离开 250ms 才收
 *  （指针移进展开卡的路程不收卡）。 */
const OPEN_DELAY_MS = 120
const CLOSE_DELAY_MS = 250

/** One task row inside the expanded card: the label plus its live output
 *  tail. Polls while mounted — the parent only mounts rows while expanded. */
function TaskRow({ row }: { row: BackgroundTaskRow }) {
  const [output, setOutput] = useState<string>('')
  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const tail = await window.electronAPI.execLogs(row.pid, OUTPUT_TAIL_BYTES)
        if (alive) setOutput(tail ?? '')
      } catch {
        /* 进程已退/旧宿主没有该 API — 保留上次读到的一半 */
      }
    }
    void pull()
    const timer = setInterval(pull, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [row.pid])
  return (
    <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--pm-separator-faint)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <LoadingOutlined spin style={{ fontSize: 11, color: 'var(--pm-link)', flexShrink: 0 }} />
        <span
          title={row.label}
          style={{ fontSize: 12, color: 'var(--pm-text-strong)', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {row.label}
        </span>
      </div>
      {output ? (
        <pre
          style={{
            margin: '6px 0 0',
            padding: 0,
            fontSize: 11,
            lineHeight: 1.5,
            fontFamily: 'monospace',
            color: 'var(--pm-text-muted)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 160,
            overflowY: 'auto',
          }}
        >
          {output}
        </pre>
      ) : (
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--pm-text-faint)' }}>(尚无输出)</div>
      )}
    </div>
  )
}

/** 无任务时的稳定空引用：selector 查无此键时不能现造 `[]`——zustand 的快照
 *  比较按引用，每次新数组等于永远「变了」。 */
const EMPTY_ROWS: BackgroundTaskRow[] = []

export function BackgroundTasksStrip({ conversationId }: { conversationId?: string }) {
  // 本会话的行（store 按 conversationId 键控，读侧同键——2026-11-09 用户实锤
  // 「后台任务跨会话了」：全量摊平曾把别的会话的任务搬进本对话）。selector
  // 返回 store 里的数组引用，别会话的增删换的是别的键，本组件不随之重渲染。
  const ownRows = useBackgroundTasksStore((s) => (conversationId ? s.byConversation[conversationId] : undefined))
  const rows = ownRows ?? EMPTY_ROWS
  const [expanded, setExpanded] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout>>()
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(
    () => () => {
      clearTimeout(openTimer.current)
      clearTimeout(closeTimer.current)
    },
    [],
  )
  // 最后一个任务退出时展开态一并复位（React 认可的「渲染期调整派生态」模式，
  // 非 effect）：条子空了返回 null，但挂载仍在——不复位的话下一个任务出现时
  // 会带着上一轮的展开态凭空弹卡。emptyLatch 防住复位 setState 在空态上的
  // 逐帧重放。
  const [emptyLatch, setEmptyLatch] = useState(true)
  if (rows.length === 0) {
    if (!emptyLatch) {
      setEmptyLatch(true)
      setExpanded(false)
    }
    return null
  }
  if (emptyLatch) setEmptyLatch(false)

  const arm = (fn: () => void, ms: number) => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
    return setTimeout(fn, ms)
  }

  return (
    <div
      data-pm-background-tasks=""
      // 左对齐 = 输入卡左缘（2026-11-08 用户裁定「和消息输入区的左侧对齐」）：
      // navTopSlot 槽横跨 Composer 根（floating 1000px 居中），卡本身帽宽
      // COMPOSER_MAX_WIDTH=952 再居中——条子盒收到同一帽宽再 margin auto，
      // 盒左缘即卡左缘（MessageNavControls 的卡框同一套数学）；圆钮留在
      // 中位互不占位。
      style={{
        display: 'flex',
        justifyContent: 'flex-start',
        maxWidth: COMPOSER_MAX_WIDTH,
        margin: '6px auto 0',
        position: 'relative',
        zIndex: 100,
      }}
      onMouseEnter={() => {
        clearTimeout(closeTimer.current)
        openTimer.current = arm(() => setExpanded(true), OPEN_DELAY_MS)
      }}
      onMouseLeave={() => {
        clearTimeout(openTimer.current)
        closeTimer.current = arm(() => setExpanded(false), CLOSE_DELAY_MS)
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 26,
          padding: '0 12px',
          borderRadius: 13,
          background: 'var(--pm-elevated)',
          border: '1px solid var(--pm-pop-border)',
          boxShadow: 'var(--pm-shadow-soft)',
          fontSize: 11,
          color: 'var(--pm-text-body)',
          cursor: 'default',
          userSelect: 'none',
        }}
      >
        <LoadingOutlined spin style={{ fontSize: 11, color: 'var(--pm-link)', flexShrink: 0 }} />
        <span>后台任务 · {rows.length}</span>
      </div>
      {expanded && (
        <div
          data-pm-background-tasks-card=""
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: 0,
            width: 420,
            maxWidth: 'calc(100vw - 48px)',
            maxHeight: 300,
            overflowY: 'auto',
            background: 'var(--pm-elevated)',
            border: '1px solid var(--pm-pop-border)',
            borderRadius: 10,
            boxShadow: 'var(--pm-shadow-pop)',
          }}
        >
          {rows.map((row) => (
            <TaskRow key={row.pid} row={row} />
          ))}
        </div>
      )}
    </div>
  )
}

export default BackgroundTasksStrip
