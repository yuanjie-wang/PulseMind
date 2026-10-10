/** The panel transcript's building blocks, each mirroring one renderer
 *  component so a message looks the same on both surfaces:
 *
 *    MarkdownBlock  ← components/chat/SegmentView `StreamingText` +
 *                     MessageGroup's text branch (`x-markdown-light`, paddingLeft 12)
 *    ThinkingBlock  ← components/chat/ThinkingBlockView
 *    ToolBlock      ← components/chat/MessageGroup `CollapsibleToolBlock`
 *    ToolCard       ← components/terminal/CommandCard
 *    AskUserBlock   ← components/terminal/CommandCard `AskUserChoices`
 *    ActionRow      ← components/chat/MessageGroup bottom button row
 *    ErrorCard      ← components/chat/ErrorDisplay
 *    CursorRow      ← components/chat/StreamingCursor
 *
 *  The class names carry the values (ui/styles.css) and the zh strings are the
 *  renderer's own (i18n/locales/zh.ts) — the panel has no i18n layer, so they
 *  are written out here. */

import { memo, useRef, useMemo, useState } from 'react'
import type { ThinkingBlock as ThinkingBlockType, ToolUseBlock } from '../../shared/types/agent'
import { Icon } from './icons'
import { formatDuration, formatTokenCount, thinkingPreview, toolBlockSummary, toolDisplayName, toolObjectSummary } from './format'
import { resultSummary } from '../../shared/tool-display/result-summary'
import { buildEditDiffModel, countChangedLines, type EditDiffLine, type EditDiffModel } from '../../shared/tool-display/edit-diff'
import { renderMarkdown, splitHtmlFences } from './markdown'
import { HtmlArtifactCard } from './HtmlArtifactCard'

/** assistant/api text → the same `.x-markdown-light` wrapper the chat uses.
 *  The rendered HTML comes from our escape-first renderer (plus its sanitized
 *  raw-HTML pass-through), with one dispatch before it: a ```html fence is an
 *  artifact to preview (the desktop's HtmlArtifactCard), so the source splits
 *  into markdown runs and html fences — each md run is its own `.pm-md` root,
 *  which is safe because the trailing-margin reset inside styles.css is
 *  per-root. */
export function MarkdownBlock({ text, className = 'pm-text-block', streaming = false }: { text: string; className?: string; streaming?: boolean }): React.JSX.Element {
  const segments = useMemo(() => splitHtmlFences(text), [text])
  if (segments.length === 1 && segments[0].kind === 'md') {
    return <div className={`pm-md x-markdown-light ${className}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
  }
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === 'html' ? (
          <HtmlArtifactCard key={i} code={seg.text} streaming={streaming && !!seg.partial && i === segments.length - 1} />
        ) : (
          <div key={i} className={`pm-md x-markdown-light ${className}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.text) }} />
        ),
      )}
    </>
  )
}

// ── thinking ─────────────────────────────────────────────────────────

export function ThinkingBlock({ block }: { block: ThinkingBlockType }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="pm-thinking" onClick={() => setExpanded(!expanded)}>
      <div className="pm-thinking-head">
        <span className="pm-thinking-caret">
          <Icon name={expanded ? 'caretDown' : 'caretRight'} />
        </span>
        <span className="pm-thinking-title">Thinking</span>
        {!expanded && <span className="pm-thinking-preview">{thinkingPreview(block.thinking)}</span>}
      </div>
      {expanded && <pre className="pm-thinking-body">{block.thinking}</pre>}
    </div>
  )
}

// ── tool call ────────────────────────────────────────────────────────

/** The tool card's 输入 line: exec shows the command, every other tool the
 *  object half (CommandCard.buildCommandSummary's default → toolObjectSummary);
 *  the raw `toolName(k=v, …)` only survives for tools the family table
 *  doesn't know (MCP / user tools). */
function commandLine(block: ToolUseBlock): string {
  const input = block.input
  if (!input) return block.name
  const command = String(input.command ?? '')
  if (command) return command
  const object = toolObjectSummary(block)
  if (object) return object
  const entries = Object.entries(input)
    .filter(([k]) => k !== 'description')
    .map(([k, v]) => {
      const text = typeof v === 'string' ? (v.length > 60 ? `${v.slice(0, 57)}...` : v) : JSON.stringify(v).slice(0, 60)
      return `${k}=${text}`
    })
  return entries.length ? `${block.name}(${entries.join(', ')})` : block.name
}

/** Which glyph the header shows — the chat's status ladder, in the same order. */
function ToolStatusIcon({ block, completedFromResult }: {
  block: ToolUseBlock
  completedFromResult: boolean
}): React.JSX.Element {
  if (block.status === undefined && completedFromResult) {
    return <Icon name="check" style={{ color: '#4ec9b0' }} />
  }
  if (block.status === undefined) return <Icon name="arrowDown" style={{ color: '#999' }} />
  if (block.status === 'running') return <Icon name="loading" spin />
  if (block.status === 'completed') {
    return block.exitCode === 0 || block.exitCode === undefined
      ? <Icon name="check" style={{ color: '#4ec9b0' }} />
      : <Icon name="close" style={{ color: '#f44747' }} />
  }
  if (block.status === 'rejected') return <Icon name="close" style={{ color: '#f44747' }} />
  // 'pending' (still being generated or held for approval) and 'queued'
  // (waiting its turn in a batch): the hourglass is the chat's glyph for
  // not-yet-executing — the spinner above means actually running.
  return <Icon name="hourglass" style={{ color: '#999' }} />
}

/** The edit diff body — same shared model as the desktop's CommandCard
 *  (P0-4 #19), folded the same way: a long diff shows its first lines plus an
 *  explicit 「展开全部 N 行 · 共 M 行变更」 header, never a silent cut. Styling
 *  mirrors CommandCard's palette inline (no new styles.css rules needed; the
 *  old hand-slice did the same). */
const DIFF_FOLD_PREVIEW_LINES = 6

function EditDiffRow({ line }: { line: EditDiffLine }): React.JSX.Element {
  const row: React.CSSProperties = { display: 'flex', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12 }
  if (line.type === 'meta') return <div style={{ ...row, color: '#c8a04a' }}>{line.text}</div>
  const gutter: React.CSSProperties = {
    flexShrink: 0, width: 68, textAlign: 'right', paddingRight: 8, color: '#6e6e6e', userSelect: 'none', fontSize: 11
  }
  if (line.type === 'ctx') {
    return (
      <div style={{ ...row, color: '#9e9e9e' }}>
        <span style={gutter}>{line.oldNo != null ? `${line.oldNo}\u2002${line.newNo ?? ''}` : ''}</span>
        <span>{line.text}</span>
      </div>
    )
  }
  const isAdd = line.type === 'add'
  return (
    <div style={{
      ...row,
      color: isAdd ? '#4ec9b0' : '#f44747',
      background: isAdd ? 'rgba(78,201,176,0.08)' : 'rgba(244,71,71,0.08)'
    }}>
      <span style={gutter}>{isAdd ? line.newNo : line.oldNo}</span>
      <span>{`${isAdd ? '+' : '-'} ${line.text}`}</span>
    </div>
  )
}

function EditDiffBody({ model }: { model: EditDiffModel }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const { added, removed } = countChangedLines(model.lines)
  const total = model.lines.length
  const foldable = total > DIFF_FOLD_PREVIEW_LINES
  const visible = foldable && !expanded ? model.lines.slice(0, DIFF_FOLD_PREVIEW_LINES) : model.lines
  return (
    <div className="pm-cmd-params">
      {model.error ? (
        <div style={{ color: '#c8a04a', fontSize: 12 }}>{model.error}</div>
      ) : (
        <>
          {visible.map((line, i) => <EditDiffRow key={i} line={line} />)}
          {total === 0 && <div style={{ color: '#8a8a8a', fontSize: 11 }}>（无变化）</div>}
          {foldable && (
            <button
              className="pm-cmd-btn"
              style={{ alignSelf: 'flex-start', fontSize: 11, color: '#8a8a8a', background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 4px' }}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? '收起' : `展开全部 ${total} 行 · 共 ${added + removed} 行变更（+${added} / −${removed}）`}
            </button>
          )}
        </>
      )}
    </div>
  )
}

/** The dark card the chat shows when a tool block is expanded (CommandCard). */
/** Memoized model computation — the panel mirror of the desktop's EditDiffCard
 *  (CommandCard.tsx): the LCS guard bounds worst-case inputs, but the generator
 *  must still not re-run on every parent render (mirror tool_status patches,
 *  stream chunks). The model is pure — the raw strings are the only dependency. */
const EditDiffSection = memo(function EditDiffSection({ input }: { input: Record<string, unknown> }): React.JSX.Element | null {
  const model = useMemo(
    () => buildEditDiffModel(input),
    // The raw strings are the input — same deps as the desktop's EditDiffCard.
    // (No exhaustive-deps lint here: the extension lint setup has no hooks rule.)
    [input.diff, input.old_str, input.new_str]
  )
  if (model.lines.length === 0 && !model.error) return null
  return <EditDiffBody model={model} />
})

function ToolCard({ block, awaitingApproval, streaming, onApprovalResponse }: {
  block: ToolUseBlock
  awaitingApproval: boolean
  streaming: boolean
  onApprovalResponse: (toolUseId: string, approved: boolean) => void
}): React.JSX.Element {
  const input = block.input
  const hasParams = !!input && Object.keys(input).length > 0 && !String(input.command ?? '')
  const title = streaming ? '正在生成命令...' : block.status === 'running' ? '运行中...' : toolDisplayName(block.name)
  // 对象行（T3/D3）与结果摘要（D3-B）、diff/write 预览（D3-C）—— 桌面 CommandCard 的手工镜像。
  const objectLine = hasParams ? toolObjectSummary(block) : ''
  const summaryLine = resultSummary(block.name, block.output)?.line ?? null
  const [showFullOutput, setShowFullOutput] = useState(false)
  return (
    <div className="pm-cmd">
      <div className="pm-cmd-head">
        <span className="pm-cmd-head-icon">
          {streaming ? (
            <Icon name="loading" spin style={{ color: '#1677ff' }} />
          ) : block.status === 'running' ? (
            <Icon name="loading" spin style={{ color: '#1677ff' }} />
          ) : block.status === 'queued' ? (
            // Queued behind batch-mates — hourglass, not the executing spinner
            // (mirrors the chat CommandCard's queued branch).
            <Icon name="hourglass" style={{ color: '#999' }} />
          ) : (
            <Icon name="setting" style={{ color: '#999' }} />
          )}
        </span>
        <span className="pm-cmd-title">{title}</span>
      </div>

      <div className="pm-cmd-label">【输入】</div>
      <div className="pm-cmd-line">
        <span className="pm-cmd-prompt">$ </span>
        {commandLine(block)}
      </div>

      {hasParams && (
        <pre className="pm-cmd-params">
          {streaming ? JSON.stringify(input, null, 2) : (objectLine || JSON.stringify(input, null, 2))}
        </pre>
      )}

      {!streaming && block.name === 'edit' && (
        // P0-4: the SAME shared model the desktop renders — both input modes
        // (unified diff / search-replace), context lines, line numbers, and the
        // explicit fold instead of the old silent 8-line slice.
        <EditDiffSection input={input || {}} />
      )}
      {!streaming && block.name === 'write' && typeof input?.content === 'string' && input.content && (
        <div className="pm-cmd-params">
          <div style={{ color: '#4ec9b0' }}>{`+${String(input.content).split('\n').length} 行`}</div>
          {String(input.content).split('\n').slice(0, 8).map((l, i) => (
            <div key={i} style={{ color: '#4ec9b0' }}>{`+ ${l}`}</div>
          ))}
        </div>
      )}

      {block.status === 'running' && !block.output && (
        <div className="pm-cmd-label" style={{ color: '#8a8a8a' }}>正在执行，等待输出...</div>
      )}

      {block.output && (
        <>
          <div className="pm-cmd-label" style={{ marginTop: 8 }}>
            【输出】{summaryLine ? ` · ${summaryLine}` : ''}
          </div>
          {summaryLine && block.status === 'completed' && !showFullOutput ? (
            <button
              className="pm-cmd-btn"
              style={{ alignSelf: 'flex-start', fontSize: 11, color: '#8a8a8a', background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 4px' }}
              onClick={() => setShowFullOutput(true)}
            >
              查看完整输出
            </button>
          ) : (
            <div className="pm-cmd-out">{block.output}</div>
          )}
        </>
      )}

      {block.exitCode !== undefined && block.exitCode !== null && (
        <div className={`pm-cmd-note ${block.exitCode === 0 ? 'pm-cmd-note-ok' : 'pm-cmd-note-err'}`}>
          <Icon name={block.exitCode === 0 ? 'check' : 'close'} style={{ marginRight: 4 }} />
          {block.exitCode === 0 ? '成功' : `失败 · exit ${block.exitCode}`}
        </div>
      )}

      {block.status === 'rejected' && (
        <div className="pm-cmd-note pm-cmd-note-err">
          <Icon name="close" style={{ marginRight: 4, fontSize: 12 }} />
          已由用户跳过
        </div>
      )}
      {block.status === 'completed' && (
        <div className={`pm-cmd-note ${block.exitCode === 0 || block.exitCode === undefined ? 'pm-cmd-note-ok' : 'pm-cmd-note-err'}`}>
          {block.exitCode === 0 || block.exitCode === undefined ? (
            <>
              <Icon name="check" style={{ marginRight: 4 }} />
              已完成
            </>
          ) : (
            <>
              <Icon name="close" style={{ marginRight: 4, fontSize: 12 }} />
              失败
            </>
          )}
        </div>
      )}

      {awaitingApproval && (
        <div className="pm-cmd-actions">
          <button className="pm-cmd-btn" onClick={() => onApprovalResponse(block.id, false)}>
            <Icon name="closeCircle" style={{ marginRight: 4 }} />
            跳过
          </button>
          <button className="pm-cmd-btn pm-cmd-btn-primary" onClick={() => onApprovalResponse(block.id, true)}>
            <Icon name="playCircle" style={{ marginRight: 4 }} />
            运行
          </button>
        </div>
      )}
    </div>
  )
}

// ── ask_user ─────────────────────────────────────────────────────────

/** The interactive half of one question: choice rows + custom answer. Owns the
 *  answeredRef latch — until the engine's tool_status patch lands the mirror,
 *  the choices stayed live, and a second click (nothing seemed to happen) sent
 *  a duplicate answer — which the engine's old duplicate guard turned into a
 *  phantom concurrent round. The ref catches a same-tick double-fire the state
 *  read cannot; the batch card keys this component per question, so one latch
 *  instance rides one question. */
function AskUserChoices({ block, onAnswer }: {
  block: ToolUseBlock
  onAnswer?: (toolUseId: string, response: string) => void
}): React.JSX.Element {
  const choices = String(block.input?.choices ?? '').split(',').map((c) => c.trim()).filter(Boolean)
  const multi = block.input?.multi === true
  const [selected, setSelected] = useState<string[]>([])
  const [custom, setCustom] = useState('')
  const answeredRef = useRef<string | null>(null)
  const [answered, setAnswered] = useState<string | null>(null)
  const answer = (response: string): void => {
    if (answeredRef.current !== null) return
    answeredRef.current = response
    setAnswered(response)
    onAnswer?.(block.id, response)
  }

  return (
    <>
      {answered !== null ? (
        <div className="pm-ask-note">
          <Icon name="checkCircle" style={{ marginRight: 6, color: '#389e0d' }} />
          已选择：{answered}
        </div>
      ) : (
        <>
          {multi && <div className="pm-ask-multi-hint">可多选</div>}
          <div className={`pm-ask-choices${multi ? ' pm-ask-multi' : ''}`}>
            {choices.map((choice) =>
              multi ? (
                <button
                  key={choice}
                  className={`pm-chip-choice ${selected.includes(choice) ? 'pm-chip-choice-on' : ''}`}
                  onClick={() =>
                    setSelected((prev) => (prev.includes(choice) ? prev.filter((c) => c !== choice) : [...prev, choice]))
                  }
                >
                  {choice}
                </button>
              ) : (
                <button key={choice} className="pm-chip-choice" onClick={() => answer(choice)}>
                  {choice}
                </button>
              ),
            )}
          </div>
          {/* 确认常驻（桌面 2026-10-06：选前禁用；计数已从标签上去掉——勾选
              的行本身就是计数） */}
          {multi && (
            <button
              className="pm-cmd-btn pm-cmd-btn-primary"
              disabled={selected.length === 0}
              onClick={() => answer(selected.join(', '))}
            >
              <Icon name="checkCircle" style={{ marginRight: 4 }} />
              确认
            </button>
          )}
          <div className="pm-ask-custom">
            <Icon name="edit" style={{ fontSize: 13, color: '#bfbfbf', flexShrink: 0 }} />
            <input
              className="pm-ask-input"
              placeholder="输入自定义回答..."
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && custom.trim()) answer(custom.trim())
              }}
            />
            <button
              className="pm-cmd-btn"
              disabled={!custom.trim()}
              onClick={() => answer(custom.trim())}
            >
              <Icon name="arrowUp" />
            </button>
          </div>
        </>
      )}
    </>
  )
}

/** A question settles when its answer landed (the engine's tool_status patch).
 *  Generating = the stream is still building this call's input (`pending`, or
 *  nothing at all) and its rows must not render — an answerable question with
 *  half-generated choices is exactly the 「有点问题」 of several asks arriving
 *  together. EVERYTHING else is live: the dispatch-time state is 'queued' (the
 *  排队中/执行中 split marks every non-held call 'queued' and the ask PARKS
 *  there awaiting_user_input — 'running' is the approval path's mark and a
 *  question never rides it), which is why the desktop's own rule reads
 *  「'queued' must count as live」. Gating on !== 'running' here hid every real
 *  question's rows behind 整理中 forever (user report 2026-10-10: 看不到选项了). */
function askSettled(block: ToolUseBlock): boolean {
  return block.status === 'completed' || block.status === 'rejected'
}

function askGenerating(block: ToolUseBlock): boolean {
  return block.status === 'pending' || block.status === undefined
}

/** The model's question (a SINGLE ask; 2+ render as AskUserBatchBlock). */
export function AskUserBlock({ block, onAnswer }: {
  block: ToolUseBlock
  onAnswer?: (toolUseId: string, response: string) => void
}): React.JSX.Element {
  const prompt = String(block.input?.prompt ?? '')
  return (
    <div className="pm-ask">
      <div className="pm-ask-prompt">{prompt}</div>
      {askSettled(block) ? (
        block.status === 'completed' ? (
          <div className="pm-ask-note">
            <Icon name="checkCircle" style={{ marginRight: 6, color: '#389e0d' }} />
            已选择：{block.output ?? ''}
          </div>
        ) : (
          <div className="pm-ask-note pm-ask-note-err">
            <Icon name="close" style={{ marginRight: 4, fontSize: 12 }} />
            已由用户跳过
          </div>
        )
      ) : askGenerating(block) ? (
        <div className="pm-ask-note pm-ask-generating">正在整理问题…</div>
      ) : (
        <AskUserChoices block={block} onAnswer={onAnswer} />
      )}
    </div>
  )
}

/** Several asks dispatched in ONE turn (the desktop's AskUserBatchCard,
 *  2026-10-06): they render as ONE card that walks the questions in dispatch
 *  order — settled ones collapse to a summary line each, only the first
 *  unsettled carries rows. Answering out of order would work engine-side (each
 *  ask settles by its own callId), but N simultaneously-live cards bury the
 *  guidance and let a half-generated question take answers, so the panel now
 *  mirrors the batch. The advance latches LOCALLY (`localAnswers` — the
 *  engine's tool_status patch lands a beat later) and the card swallows clicks
 *  for 350ms after each answer: auto-advance re-renders under the pointer, and
 *  a second click of a double click would land on the NEXT question's rows. */
export function AskUserBatchBlock({ blocks, onAnswer }: {
  blocks: ToolUseBlock[]
  onAnswer?: (toolUseId: string, response: string) => void
}): React.JSX.Element {
  const [localAnswers, setLocalAnswers] = useState<Record<string, string>>({})
  const lockUntilRef = useRef(0)

  const settled = (b: ToolUseBlock): boolean => askSettled(b) || localAnswers[b.id] != null
  const firstUnsettled = blocks.findIndex((b) => !settled(b))
  const allSettled = firstUnsettled === -1
  const current = allSettled ? null : blocks[firstUnsettled]
  const currentStreaming = current != null && askGenerating(current)

  const answer = (id: string, response: string): void => {
    if (localAnswers[id] != null) return
    lockUntilRef.current = Date.now() + 350
    setLocalAnswers((prev) => ({ ...prev, [id]: response }))
    onAnswer?.(id, response)
  }

  return (
    <div
      className="pm-ask pm-ask-batch"
      data-ask-batch=""
      onClickCapture={(e) => {
        if (Date.now() < lockUntilRef.current) {
          e.stopPropagation()
          e.preventDefault()
        }
      }}
    >
      <div className="pm-ask-prompt">
        问题
        {blocks.length > 1 && <span className="pm-ask-badge">{allSettled ? `第 ${blocks.length}/${blocks.length} 题` : `第 ${firstUnsettled + 1}/${blocks.length} 题`}</span>}
        {current?.input?.multi === true && <span className="pm-ask-badge">可多选</span>}
      </div>
      {blocks.filter(settled).map((b) => (
        <div key={b.id} className="pm-ask-settled">
          <div className="pm-ask-settled-row">
            {b.status === 'rejected' ? (
              <Icon name="close" style={{ color: '#f44747', fontSize: 12 }} />
            ) : (
              <Icon name="checkCircle" style={{ color: '#389e0d', fontSize: 13 }} />
            )}
            <span>{String(b.input?.prompt || '')}</span>
          </div>
          <div className={`pm-ask-settled-answer${b.status === 'rejected' ? ' pm-ask-settled-answer-err' : ''}`}>
            {b.status === 'rejected' ? '已由用户跳过' : `已选择：${b.output || localAnswers[b.id] || ''}`}
          </div>
        </div>
      ))}
      {current && (
        currentStreaming ? (
          <div className="pm-ask-note pm-ask-generating">正在整理问题…</div>
        ) : (
          <AskUserChoices key={current.id} block={current} onAnswer={answer} />
        )
      )}
    </div>
  )
}

// ── tool block (header + body) ───────────────────────────────────────

export function ToolBlock({ block, completedFromResult, awaiting, onApprovalResponse, onAnswer }: {
  block: ToolUseBlock
  completedFromResult: boolean
  /** The engine is holding this call for approval (session status +
   *  `status === 'pending'` — see Transcript). */
  awaiting: boolean
  onApprovalResponse: (toolUseId: string, approved: boolean) => void
  onAnswer: (toolUseId: string, response: string) => void
}): React.JSX.Element {
  // The chat's rule: everything starts collapsed except ask_user. A held call is
  // *not* an exception anymore — nothing expands itself; the approval area below
  // the header carries 跳过/运行 while it is collapsed (see ApprovalArea in
  // components/chat), and the card's own pair takes over once the user opens it.
  const [collapsed, setCollapsed] = useState(block.name !== 'ask_user')
  const summary = toolBlockSummary(block)
  const streaming = block.status === 'pending' && !awaiting
  const isAskUser = block.name === 'ask_user'

  return (
    <div className="pm-tool">
      <div
        className={`pm-tool-head ${awaiting ? 'pm-tool-head-pending' : ''}`}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="pm-tool-icon">
          <ToolStatusIcon block={block} completedFromResult={completedFromResult} />
        </span>
        <span className="pm-tool-name">{toolDisplayName(block.name)}</span>
        {summary && <span className="pm-tool-summary">{summary}</span>}
        {awaiting && <span className="pm-tool-hint">待批准</span>}
        {streaming && <span className="pm-tool-hint" style={{ color: '#999' }}>指令生成中...</span>}
        <span className="pm-tool-caret">
          <Icon name={collapsed ? 'caretRight' : 'caretDown'} />
        </span>
      </div>
      {/* The decision, below the collapsed header — the chat's ApprovalArea. The
          head already names the call and summarises it, so this is the buttons
          only (the chat's `identity: false` variant). The icons carry no inline
          margin: .pm-approve-btn has antd's own iconGap, as the antd Button the
          chat uses there does. */}
      {collapsed && awaiting && !isAskUser && (
        <div className="pm-approve-area">
          <div className="pm-approve-row">
            <button className="pm-approve-btn" onClick={() => onApprovalResponse(block.id, false)}>
              <Icon name="closeCircle" />
              跳过
            </button>
            <button className="pm-approve-btn pm-approve-btn-primary" onClick={() => onApprovalResponse(block.id, true)}>
              <Icon name="playCircle" />
              运行
            </button>
          </div>
        </div>
      )}
      {!collapsed &&
        (isAskUser ? (
          <AskUserBlock block={block} onAnswer={onAnswer} />
        ) : (
          <ToolCard
            block={block}
            awaitingApproval={awaiting}
            streaming={streaming}
            onApprovalResponse={onApprovalResponse}
          />
        ))}
    </div>
  )
}

// ── action row ───────────────────────────────────────────────────────

/** 复制 / 下载 + 耗时 / Token — the chat's row minus like & favorite, which
 *  write message metadata and have no conversation to write to from the panel
 *  (the same reason the renderer's `actions="viewOnly"` exists). */
export function ActionRow({ text, msg }: { text: string; msg: ActionMeta }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void copyText(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="pm-actions">
      <button className="pm-action-btn" title="复制" onClick={copy}>
        <Icon name={copied ? 'check' : 'copy'} />
      </button>
      <button className="pm-action-btn" title="下载" onClick={() => downloadText(text, 'message.md')}>
        <Icon name="download" />
      </button>
      {(msg.processingMs != null || msg.inputTokens != null || msg.outputTokens != null || msg.promptCacheHitTokens != null) && (
        <span className="pm-stats">
          <span className="pm-stats-divider">|</span>
          {msg.processingMs != null && <span className="pm-stats-item" title="处理时间">{formatDuration(msg.processingMs)}</span>}
          {msg.inputTokens != null && (
            <span className="pm-stats-item" title="上行 Token">
              <Icon name="arrowUp" />
              {formatTokenCount(msg.inputTokens)}
            </span>
          )}
          {msg.outputTokens != null && (
            <span className="pm-stats-item" title="下行 Token">
              <Icon name="arrowDown" />
              {formatTokenCount(msg.outputTokens)}
            </span>
          )}
          {msg.promptCacheHitTokens != null && (
            <span className="pm-stats-item" title="缓存命中">
              <Icon name="aim" />
              {formatTokenCount(msg.promptCacheHitTokens)}
            </span>
          )}
        </span>
      )}
    </div>
  )
}

export interface ActionMeta {
  processingMs?: number
  inputTokens?: number
  outputTokens?: number
  promptCacheHitTokens?: number
}

/** Clipboard write with a fallback for pages that deny the async API (a content
 *  script without user-gesture focus can be refused). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      ;(document.body ?? document.documentElement).appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

/** The chat writes through the desktop's save dialog; the panel has no fs, so
 *  the browser's own download takes over. */
function downloadText(text: string, filename: string): void {
  try {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch {
    /* nothing to fall back to */
  }
}

// ── error / cursor ───────────────────────────────────────────────────

export function ErrorCard({ message, onDismiss }: { message: string; onDismiss: () => void }): React.JSX.Element {
  return (
    <div className="pm-error">
      <div className="pm-error-title">错误</div>
      <div>{message}</div>
      <div className="pm-error-actions">
        <button className="pm-error-btn" onClick={onDismiss}>关闭</button>
      </div>
    </div>
  )
}

export function CursorRow(): React.JSX.Element {
  return (
    <div className="pm-cursor-row">
      <span className="pm-cursor" />
    </div>
  )
}
