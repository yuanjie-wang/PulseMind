import React, { useState, useMemo, useRef, useEffect } from 'react'
import { CheckOutlined, RightOutlined } from '@ant-design/icons'
import type { AgentMessage, ContentBlock, ToolUseBlock } from '../../types/agent'
import { MessageGroup } from './MessageGroup'
import { ApprovalArea } from './ApprovalArea'
import { useTranslation } from '../../i18n/useTranslation'
import { toolBlockSummary, toolDisplayName, type ToolTranslator } from './tool-summary'
import { summarizeEditChanges, type EditChangesSummary } from '../../../../shared/tool-display/edit-diff'
import { CollapseBody } from './motion'

// Injected once into <head> to avoid creating a new <style> element on every render
const KEYFRAMES = `@keyframes pulsemind-spin { 100% { transform: rotate(360deg); } } @keyframes pulsemind-fade-in { 0% { opacity: 0; transform: translateY(2px); } 100% { opacity: 1; transform: translateY(0); } }`
let keyframesInjected = false
if (typeof document !== 'undefined' && !keyframesInjected) {
  const el = document.createElement('style')
  el.textContent = KEYFRAMES
  document.head.appendChild(el)
  keyframesInjected = true
}

// The header badge's per-block memo: buildEditDiffModel runs an LCS (bounded by
// the generator's guards, but not free) and this memo re-runs on every commit of
// the segment's messages while the block object itself persists across them —
// the same discipline as CommandCard's string-keyed useMemo (P0-4).
const editChangesCache = new WeakMap<ToolUseBlock, EditChangesSummary | null>()

function editChangesOf(block: ToolUseBlock): EditChangesSummary | null {
  const hit = editChangesCache.get(block)
  if (hit !== undefined) return hit
  const result = summarizeEditChanges([block])
  editChangesCache.set(block, result)
  return result
}

// --- Props ---

interface ExecutionSegmentProps {
  messages: AgentMessage[]
  isLastSegment: boolean
  isRequesting: boolean
  isReceiving?: boolean
  onApproveTool: (toolUseId: string, alwaysAllow?: boolean) => void
  onRejectTool: (toolUseId: string) => void
  onKillTool: (toolUseId: string) => void
  onRespondToTool?: (toolUseId: string, response: string) => void
  conversationId?: string
  conversationTitle?: string
  /** Open a spawn card's sub-conversation in the host's session view (see
   *  MessageGroup). Threaded through unchanged; absent means no drill-in. */
  onOpenSubAgent?: (subConvId: string, title: string) => void
  /** The engine is parked on its held calls (`agentStatus: 'awaiting_approval'`). */
  awaitingApproval?: boolean
}

// --- Extract displayable items from segment messages in LLM order ---

function contentBlocksToTexts(blocks: ContentBlock[], t: ToolTranslator): string[] {
  const texts: string[] = []
  for (const block of blocks) {
    if (block.type === 'thinking') {
      const line = block.thinking.replace(/\n+/g, ' ').trim()
      if (line) texts.push(line)
    } else if (block.type === 'redacted_thinking') {
      texts.push('Thinking redacted')
    } else if (block.type === 'text') {
      const line = block.text.replace(/\n+/g, ' ').trim()
      if (line) texts.push(line)
    } else if (block.type === 'tool_use') {
      // PLAN-tool-ux T5: the same human summary the tool block's header uses —
      // the loop-state line used to splice `name + first input value` itself,
      // which read as `exec npm install…` mid-run while everything else had
      // moved to 运行命令 · …. (D1=C: exec's object stays the raw command.)
      texts.push(toolBlockSummary(block, t))
    }
  }
  return texts
}

// --- Component ---

/** The live reasoning tail's rotation cadence. 700ms: slow enough that the
 *  header reads calm (the user report was flicker at the 80ms coalesced tick),
 *  fast enough that the tail still feels alive. */
const LIVE_TAIL_ROTATE_MS = 700

/** The live reasoning tail's display clock: the stream pushes a new tail every
 *  ~80ms coalesced tick, and re-rendering the header text at that rate reads
 *  as flicker (user report 2026-10-25). `shown` advances at most once per
 *  `minIntervalMs` — trailing-edge, so the final tail still lands after the
 *  stream ends. Pure display clock; holds no stream state. */
function useRotatingTail(text: string, minIntervalMs = 700): string {
  const [shown, setShown] = useState(text)
  const lastAtRef = useRef(0)
  const textRef = useRef(text)
  useEffect(() => {
    textRef.current = text
    const now = performance.now()
    const elapsed = now - lastAtRef.current
    if (elapsed >= minIntervalMs) {
      lastAtRef.current = now
      setShown(text)
      return
    }
    const timer = setTimeout(() => {
      lastAtRef.current = performance.now()
      setShown(textRef.current)
    }, minIntervalMs - elapsed)
    return () => clearTimeout(timer)
  }, [text, minIntervalMs])
  return shown
}

export const ExecutionSegment = React.memo(function ExecutionSegment(props: ExecutionSegmentProps): React.ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  // Single traversal for all derived state — replaces 4 separate useMemo calls
  const { texts, initial, done, toolCount, activityText, receivingText, liveOutput, heldCalls, pureThinking, thinkingCount, receivingThinking } = useMemo(() => {
    let hasTools = false
    let hasThinking = false
    let thinkingCount = 0
    let anyNonPending = false // any tool has a status beyond 'pending' (queued, running, completed, rejected)
    let anyInFlight = false // 'running' or 'queued' — the batch is not settled yet
    let hasToolResults = false // presence of tool_result indicates completion (used when status stripped on save)
    const heldCalls: ToolUseBlock[] = [] // calls this segment holds for the user's approval
    const texts: string[] = []
    let toolCount = 0
    const toolNames = new Set<string>()
    // Activity narrative (PLAN-tool-ux T4): completed calls by family —
    // files read / files modified / commands run. The 修改 family also carries
    // the edit-diff badge (user ruling 2026-09-29): 「修改 N 个文件（+a/−d）」,
    // so a collapsed header gives the change magnitude without opening the
    // two collapsed layers the real diffs live behind.
    let reads = 0
    let writes = 0
    let execs = 0
    let rejections = 0
    let diffAdded = 0
    let diffRemoved = 0
    // Last output line from any currently-running tool (e.g. sub-agent progress),
    // surfaced in the collapsed header so the user sees it move without expanding.
    let liveOutput: string | null = null

    for (const msg of props.messages) {
      if (msg.role !== 'user') {
        texts.push(...contentBlocksToTexts(msg.contentBlocks, t))
      }
      for (const block of msg.contentBlocks) {
        if (block.type === 'thinking' || block.type === 'redacted_thinking') { hasThinking = true; thinkingCount++ }
        if (block.type === 'tool_use') {
          toolCount++
          hasTools = true
          if (block.name) toolNames.add(block.name)
          if (block.status === 'running' || block.status === 'queued') {
            // 'queued' too: a slot-waiting expert's last output line is the
            // 「排队中：本会话已有 N 个专家在运行…」 note — exactly the live
            // progress a collapsed header should surface.
            anyInFlight = true
            const out = (block as ToolUseBlock).output
            if (out) {
              const line = out.split('\n').filter(Boolean).pop() ?? ''
              liveOutput = line.length > 80 ? line.slice(0, 77) + '...' : line
            }
          }
          // `pending` + the parked engine: a call the ladder is holding. The parked
          // half is what keeps a still-generating tool from counting as one.
          if (block.status === 'pending' && props.awaitingApproval) heldCalls.push(block)
          if (block.status === undefined) continue
          if (block.status !== 'pending') anyNonPending = true
          // Only SETTLED calls count toward the narrative — a running exec is
          // not yet "跑了一条命令". M5 (review 2026-09-18): a REJECTED call
          // touched nothing — counting it as "修改 1 个文件" lied about what
          // the agent did to the user's files, so rejections are narrated in
          // their own part instead.
          if (block.status === 'rejected') rejections++
          else if (block.status === 'completed') {
            if (block.name === 'read') reads++
            else if (block.name === 'write' || block.name === 'edit') writes++
            else if (block.name === 'exec') execs++
            // Badge input: completed edits only (rejected calls touched
            // nothing — the rule the counts above already live by); write has
            // no old side to diff against and rides the file count alone.
            if (block.name === 'edit') {
              const changes = editChangesOf(block)
              if (changes) {
                diffAdded += changes.added
                diffRemoved += changes.removed
              }
            }
          }
        }
        if (block.type === 'tool_result') hasToolResults = true
      }
    }

    const activityParts: string[] = []
    if (reads > 0) activityParts.push(`已读取 ${reads} 个文件`)
    // The badge rides the 修改 family: only edits with a countable diff move
    // it off zero, so an all-write segment reads exactly as before.
    const diffBadge = diffAdded > 0 || diffRemoved > 0 ? `（+${diffAdded}/−${diffRemoved}）` : ''
    if (writes > 0) activityParts.push(`修改 ${writes} 个文件${diffBadge}`)
    if (execs > 0) activityParts.push(`运行 ${execs} 条命令`)
    if (rejections > 0) activityParts.push(`拒绝 ${rejections} 次`)

    // The live reasoning tail (the old streaming strip's visibility, now carried
    // by the open group's header): the LAST 'streaming-think' slice's newest
    // bytes + a total char count. Rendered as [稳定「深度思考」标签][轮动尾巴] —
    // the label must never remount; only the tail rotates (see the header).
    let liveThinkingTail = ''
    for (const msg of props.messages) {
      if (msg.id !== 'streaming-think') continue
      const thinkBlocks = msg.contentBlocks.filter((b) => b.type === 'thinking') as { thinking: string }[]
      const all = thinkBlocks.map((b) => b.thinking).join('')
      if (all) {
        const tail = all.slice(-40).replace(/\s+/g, ' ').trim()
        liveThinkingTail = `…${tail} (${all.length} chars)`
      }
    }

    return {
      texts,
      initial: !anyNonPending && !hasToolResults,
      done: hasTools && !anyInFlight && (anyNonPending || hasToolResults),
      toolCount,
      activityText: activityParts.join(' · '),
      anyNonPending,
      liveOutput,
      heldCalls,
      // A group with reasoning but no tool calls (a degenerate round the engine
      // committed, e.g. the max_tokens shape): none of the tool states below
      // apply — settled it reads like a tool family count (已完成 · 深度思考N次,
      // 2026-10-25 ruling); while the engine is still working it carries the
      // reasoning's own first line as the live identity.
      pureThinking: !hasTools && hasThinking,
      thinkingCount,
      receivingThinking: props.isReceiving && toolNames.size === 0 && !!liveThinkingTail,
      receivingText: props.isReceiving && toolNames.size > 0
        ? Array.from(toolNames).map((name) => toolDisplayName(name, t)).join('、') + ' 指令生成中...'
        : props.isReceiving && liveThinkingTail
          ? liveThinkingTail
          : ''
    }
  }, [props.messages, props.isReceiving, props.awaitingApproval, t])

  const anyHeld = heldCalls.length > 0

  // - Receiving (streaming blocks not yet committed): show "写入文件 指令生成中..."
  // - Initial state (all tools still pending): show "开始执行"
  // - Done state (tools all done AND segment no longer last / engine idle): show "已完成（工具调用X次）"
  // - Held for approval: show 待批准 (the engine cannot move until it is answered)
  // - Executing: show the last extracted text
  const isPending = props.isLastSegment && props.isRequesting
  const showDone = done && !isPending
  const showInitialActive = initial && props.isRequesting
  // The raw slice flag only says a live slice still exists in the group
  // (think deltas merged in, then the round's text started streaming).
  // RECEIVING means the group is still the ACTIVE tail — once segments exist
  // after it, a lingering slice must not hold the header in its 生成中 state:
  // done rules (user report 2026-10-25: the group spun until the message
  // committed, though its tools had settled and the text was already streaming
  // after it).
  const isReceiving = !!props.isReceiving && isPending
  // 接收中的组一律转圈（含纯思考直播组——组头已承载活尾巴，旋转补上"活着"的另一半）
  const showSpinner = !showDone && props.isRequesting && (!pureThinking || isReceiving)
  // 完成态的组头亮绿勾（2026-10-25 统一裁定）。纯思考组的"完成"是它自己提交
  // 的那一刻（isReceiving 落空 = 直播切片已换成本消息 id）——与引擎是否还在
  // 流式后续内容无关（用户报告：正文流式时前方的思考组仍无成功标记；工具组
  // 没这个问题，因为它的 done 只看工具落定）。
  const pureThinkingComplete = pureThinking && !isReceiving
  const showSettledCheck = showDone || pureThinkingComplete
  // Done state carries the activity narrative when any family counts up
  // (PLAN-tool-ux T4); families that don't map (MCP, git, page tools) keep
  // the plain call-count form.
  const doneText = activityText || `工具调用${toolCount}次`
  // 纯思考组提交后即读工具家族口径：已完成 · 深度思考N次（直播接收态走
  // receivingText 的活尾巴分支，到不了这里）。
  const pureThinkingText = `已完成 · 深度思考${thinkingCount}次`
  const displayText = isReceiving ? receivingText : anyHeld ? t('commandCard.awaitingApproval') : pureThinking ? pureThinkingText : (showDone ? `已完成 · ${doneText}` : showInitialActive ? '开始执行' : (liveOutput || (texts.length > 0 ? texts[texts.length - 1] : 'Processing...')))
  // The rotating tail's display clock: the raw receivingText changes every
  // 80ms tick; `shown` advances at most every ~700ms (useRotatingTail).
  const rotatingTail = useRotatingTail(isReceiving && receivingThinking ? receivingText : '', LIVE_TAIL_ROTATE_MS)

  return (
    <div style={{ margin: '8px 0', borderRadius: 8, overflow: 'hidden' }}>
      {/* Collapsed header */}
      <div
        data-segment-head=""
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 34,
          padding: '0 10px',
          background: 'transparent',
          cursor: 'pointer',
          userSelect: 'none',
          overflow: 'hidden'
        }}
      >
        {showSpinner && (
          <div style={{
            width: 14,
            height: 14,
            border: '2px solid var(--pm-border-soft)',
            borderTopColor: 'var(--pm-ink)',
            borderRadius: '50%',
            animation: 'pulsemind-spin 1s linear infinite',
            flexShrink: 0,
            marginRight: 6,
            willChange: 'transform'
          }} />
        )}
        {!showSpinner && showSettledCheck && (
          <CheckOutlined style={{ color: '#4ec9b0', fontSize: 14, width: 14, textAlign: 'center', flexShrink: 0, marginRight: 6 }} />
        )}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', alignItems: 'center', minWidth: 0 }}>
          {isReceiving && receivingThinking ? (
            // 直播思考头 = [稳定「深度思考」标签][轮动尾巴]。标签永不重挂
            // （用户报告：长推理快速输出时组头逐帧闪烁——旧实现整条文本共用
            // key={displayText}，每个 tick 重放淡入）；尾巴单独一根 span，
            // useRotatingTail 限频换文本，key 只在轮动落地时变、轻淡入切换。
            <>
              <span style={{ flexShrink: 0, fontSize: 13, lineHeight: '22px', color: 'var(--pm-text-muted)' }}>
                深度思考
              </span>
              <span
                key={rotatingTail}
                style={{
                  marginLeft: 8,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                  flex: 1,
                  fontSize: 13,
                  color: 'var(--pm-text-muted)',
                  lineHeight: '22px',
                  animation: 'pulsemind-fade-in 0.25s ease-out'
                }}
              >
                {rotatingTail}
              </span>
            </>
          ) : (
            <div
              key={displayText}
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
                flexShrink: 1,
                fontSize: 13,
                color: anyHeld ? 'var(--pm-warn)' : 'var(--pm-text-muted)',
                fontWeight: anyHeld ? 500 : undefined,
                lineHeight: '22px',
                animation: 'pulsemind-fade-in 0.25s ease-out'
              }}
            >
              {displayText}
            </div>
          )}
          <RightOutlined
            style={{
              color: 'var(--pm-text-faint)',
              fontSize: 11,
              flexShrink: 0,
              marginLeft: 4,
              transform: expanded ? 'rotate(90deg)' : undefined,
              transition: 'transform 0.2s'
            }}
          />
        </div>
      </div>

      {/* The decision, below the collapsed header. This segment is the outermost
          thing hiding a held call, so the buttons have to appear here or answering
          means expanding twice (this, then the tool block). Expanding moves them
          down to the tool blocks — never both at once. */}
      {!expanded && anyHeld && (
        <div style={{ padding: '0 10px 4px' }}>
          <ApprovalArea
            blocks={heldCalls}
            onApproveTool={props.onApproveTool}
            onRejectTool={props.onRejectTool}
            identity
          />
        </div>
      )}

      {/* Expanded body — grows open through CollapseBody (@starting-style, see
          motion.tsx); closing is the plain unmount it always was. */}
      <CollapseBody open={expanded}>
        <div style={{ padding: '8px 12px 4px', border: '1px solid var(--pm-border-soft)', borderRadius: 8 }}>
          {props.messages.map((msg) => (
            <MessageGroup
              key={msg.id}
              msg={msg}
              actions="none"
              onApproveTool={props.onApproveTool}
              onRejectTool={props.onRejectTool}
              onKillTool={props.onKillTool}
              onRespondToTool={props.onRespondToTool}
              conversationId={props.conversationId}
              conversationTitle={props.conversationTitle}
              onOpenSubAgent={props.onOpenSubAgent}
              awaitingApproval={props.awaitingApproval}
            />
          ))}
        </div>
      </CollapseBody>
    </div>
  )
})