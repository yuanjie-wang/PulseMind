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

import { useState } from 'react'
import type { ThinkingBlock as ThinkingBlockType, ToolUseBlock } from '../../shared/types/agent'
import { Icon } from './icons'
import { formatDuration, formatTokenCount, thinkingPreview, toolBlockSummary, toolDisplayName, toolObjectSummary } from './format'
import { resultSummary } from '../../shared/tool-display/result-summary'
import { renderMarkdown } from './markdown'

/** assistant/api text → the same `.x-markdown-light` wrapper the chat uses.
 *  The rendered HTML comes from our escape-first renderer, never raw input. */
export function MarkdownBlock({ text, className = 'pm-text-block' }: { text: string; className?: string }): React.JSX.Element {
  return <div className={`pm-md x-markdown-light ${className}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
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
  if (block.status === 'running') return <Icon name="hourglass" spin />
  if (block.status === 'completed') {
    return block.exitCode === 0 || block.exitCode === undefined
      ? <Icon name="check" style={{ color: '#4ec9b0' }} />
      : <Icon name="close" style={{ color: '#f44747' }} />
  }
  if (block.status === 'rejected') return <Icon name="close" style={{ color: '#f44747' }} />
  // 'pending': either still being generated or held for approval — the header
  // gear is the chat's glyph for both.
  return <Icon name="setting" style={{ color: '#999' }} />
}

/** The dark card the chat shows when a tool block is expanded (CommandCard). */
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

      {!streaming && block.name === 'edit' && typeof input?.old_str === 'string' && typeof input?.new_str === 'string' && (
        <div className="pm-cmd-params">
          {String(input.old_str).split('\n').slice(0, 8).map((l, i) => (
            <div key={`o${i}`} style={{ color: '#f44747', background: 'rgba(244,71,71,0.08)' }}>{`- ${l}`}</div>
          ))}
          {String(input.new_str).split('\n').slice(0, 8).map((l, i) => (
            <div key={`n${i}`} style={{ color: '#4ec9b0', background: 'rgba(78,201,176,0.08)' }}>{`+ ${l}`}</div>
          ))}
        </div>
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

/** The model's question. Choices come from the tool input (the same source the
 *  desktop reads), and the answer goes back as an `ask_user.response`. */
export function AskUserBlock({ block, onAnswer }: {
  block: ToolUseBlock
  onAnswer?: (toolUseId: string, response: string) => void
}): React.JSX.Element {
  const prompt = String(block.input?.prompt ?? '')
  const choices = String(block.input?.choices ?? '').split(',').map((c) => c.trim()).filter(Boolean)
  const multi = block.input?.multi === true
  const [selected, setSelected] = useState<string[]>([])
  const [custom, setCustom] = useState('')
  const done = block.status === 'completed' || block.status === 'rejected'

  return (
    <div className="pm-ask">
      <div className="pm-ask-prompt">{prompt}</div>
      {done ? (
        block.status === 'completed' ? (
          <div className="pm-ask-note">
            <Icon name="checkCircle" style={{ marginRight: 6 }} />
            已选择：{block.output ?? ''}
          </div>
        ) : (
          <div className="pm-ask-note pm-ask-note-err">
            <Icon name="close" style={{ marginRight: 4, fontSize: 12 }} />
            已由用户跳过
          </div>
        )
      ) : (
        <>
          <div className="pm-ask-choices">
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
                <button key={choice} className="pm-chip-choice" onClick={() => onAnswer?.(block.id, choice)}>
                  {choice}
                </button>
              ),
            )}
          </div>
          {multi && selected.length > 0 && (
            <button className="pm-cmd-btn pm-cmd-btn-primary" onClick={() => onAnswer?.(block.id, selected.join(', '))}>
              <Icon name="checkCircle" style={{ marginRight: 4 }} />
              确认（{selected.length} 项已选）
            </button>
          )}
          <div className="pm-ask-custom">
            <input
              className="pm-ask-input"
              placeholder="输入自定义回答..."
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && custom.trim()) onAnswer?.(block.id, custom.trim())
              }}
            />
            <button
              className="pm-cmd-btn"
              disabled={!custom.trim()}
              onClick={() => onAnswer?.(block.id, custom.trim())}
            >
              <Icon name="arrowUp" />
            </button>
          </div>
        </>
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
