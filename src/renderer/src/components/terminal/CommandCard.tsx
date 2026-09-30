import React, { useState, useEffect, useMemo, useRef } from 'react'
import { Button, Typography, Space, Spin, Tag, Input } from 'antd'
import { PlayCircleOutlined, CloseCircleOutlined, StopOutlined, LoadingOutlined, CheckCircleOutlined, SendOutlined, CloseOutlined, CheckOutlined, CommentOutlined, SettingOutlined, HourglassOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import type { ToolUseBlock } from '../../types/agent'
import { toolDisplayName, toolObjectSummary } from '../chat/tool-summary'
import { resultSummary } from '../../../../shared/tool-display/result-summary'
import { buildEditDiffModel, countChangedLines, type EditDiffModel, type EditDiffLine } from '../../../../shared/tool-display/edit-diff'

// Keyframe animation for skeleton pulse effect (injected once)
const pulseKeyframe = `@keyframes pulsemind-skeleton-pulse {
  0% { opacity: 0.4; }
  50% { opacity: 0.8; }
  100% { opacity: 0.4; }
}`
let keyframesInjected = false
if (typeof document !== 'undefined' && !keyframesInjected) {
  const el = document.createElement('style')
  el.textContent = pulseKeyframe
  document.head.appendChild(el)
  keyframesInjected = true
}

const { Text } = Typography

interface CommandCardProps {
  block: ToolUseBlock
  onApprove?: () => void
  onReject?: () => void
  onKill?: () => void
  onToolResponse?: (toolUseId: string, response: string) => void
}

const cardStyle: React.CSSProperties = {
  background: '#1e1e1e',
  borderRadius: 8,
  padding: 12,
  marginTop: 8,
  marginBottom: 4,
  fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
  fontSize: 13,
  lineHeight: 1.5
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 8,
  color: '#e0e0e0'
}

const commandLineStyle: React.CSSProperties = {
  color: '#89d185',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  marginBottom: 8,
  background: '#252526',
  border: '1px solid #333',
  borderRadius: 4,
  padding: '8px 10px'
}

const outputStyle: React.CSSProperties = {
  color: '#d4d4d4',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  maxHeight: 300,
  overflowY: 'auto',
  background: '#252526',
  border: '1px solid #333',
  padding: 8,
  borderRadius: 4,
  fontSize: 12,
  marginBottom: 4
}

const sectionLabelStyle: React.CSSProperties = {
  color: '#8a8a8a',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.5,
  marginBottom: 4,
  userSelect: 'none'
}

// ── ask_user inline interaction ──────────────────────────────────────

function AskUserChoices({
  block,
  onToolResponse
}: {
  block: ToolUseBlock
  onToolResponse?: (toolUseId: string, response: string) => void
}): React.ReactElement {
  const prompt = String(block.input?.prompt || '')
  const choicesStr = String(block.input?.choices || '')
  const multi = block.input?.multi === true
  const choices = choicesStr.split(',').map((c) => c.trim()).filter(Boolean)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [customInput, setCustomInput] = useState('')
  const { t } = useTranslation()

  if (block.status === 'completed') {
    return (
      <>
        {/* Prompt */}
        <div style={{ color: 'var(--pm-ink)', marginBottom: 10, fontSize: 14, lineHeight: 1.6 }}>
          {prompt}
        </div>
        {block.output && (
          <div style={{ color: 'var(--pm-text-muted)', marginBottom: 4, fontSize: 13 }}>
            <CheckCircleOutlined style={{ marginRight: 6 }} />
            {t('commandCard.selected', { value: block.output })}
          </div>
        )}
      </>
    )
  }

  if (block.status === 'rejected') {
    return (
      <>
        <div style={{ color: 'var(--pm-ink)', marginBottom: 10, fontSize: 14, lineHeight: 1.6 }}>
          {prompt}
        </div>
        <Text style={{ color: '#f44747', fontSize: 12 }}><CloseOutlined style={{marginRight:4,fontSize:12}} />{t('commandCard.skippedByUser')}</Text>
      </>
    )
  }

  // Running / awaiting user input
  return (
    <>
      {/* Prompt */}
      <div style={{ color: 'var(--pm-ink)', marginBottom: 12, fontSize: 14, lineHeight: 1.6 }}>
        {prompt}
      </div>

      {/* Choices */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        {choices.map((choice) =>
          multi ? (
            <Tag.CheckableTag
              key={choice}
              checked={selected.has(choice)}
              onChange={(checked) => {
                const next = new Set(selected)
                if (checked) {
                  next.add(choice)
                } else {
                  next.delete(choice)
                }
                setSelected(next)
              }}
              style={{
                padding: '4px 16px',
                fontSize: 13,
                borderRadius: 4,
                border: '1px solid var(--pm-border)',
                cursor: 'pointer',
                color: selected.has(choice) ? 'var(--pm-ink-contrast)' : 'var(--pm-ink)',
                background: selected.has(choice) ? 'var(--pm-link)' : 'var(--pm-elevated)'
              }}
            >
              {choice}
            </Tag.CheckableTag>
          ) : (
            <Button
              key={choice}
              size="small"
              style={{
                color: 'var(--pm-ink)',
                borderColor: 'var(--pm-border)',
                background: 'var(--pm-elevated)'
              }}
              onClick={() => onToolResponse?.(block.id, choice)}
            >
              {choice}
            </Button>
          )
        )}
      </div>

      {/* Confirm button for multi-select */}
      {multi && selected.size > 0 && (
        <Space size="small">
          <Button
            size="small"
            type="primary"
            icon={<CheckCircleOutlined />}
            onClick={() => {
              const result = Array.from(selected).join(', ')
              onToolResponse?.(block.id, result)
            }}
          >
            {t('commandCard.confirm', { count: selected.size })}
          </Button>
        </Space>
      )}

      {/* Custom text input */}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Input
          size="small"
          placeholder={t('commandCard.customInputPlaceholder')}
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onPressEnter={() => {
            const val = customInput.trim()
            if (val) onToolResponse?.(block.id, val)
          }}
          style={{ flex: 1, maxWidth: 300 }}
        />
        <Button
          size="small"
          type="default"
          icon={<SendOutlined />}
          disabled={!customInput.trim()}
          onClick={() => {
            const val = customInput.trim()
            if (val) onToolResponse?.(block.id, val)
          }}
        />
      </div>
    </>
  )
}

// ── Edit diff / write preview (PLAN-tool-ux T3, D3-C; rewritten P0-4) ──
// The edit card renders a REAL diff via shared/tool-display/edit-diff.ts —
// hunks with context and line numbers, both input modes (diff / search-replace) —
// and never silently truncates: long diffs fold behind an explicit
// 「共 N 行变更 (+a / −d)」 header that expands to the full text. Colors reuse
// the card's existing palette (#f44747 / #4ec9b0) — no new skin. The extension
// panel consumes the SAME shared model (ui/MessageBlocks.tsx); only styling
// differs there.

const DIFF_FOLD_PREVIEW_LINES = 6

/** Memoized model computation: the LCS guard bounds worst-case inputs, but the
 *  generator must still not re-run on every parent render. The model is pure —
 *  the raw strings are the only dependency. */
const EditDiffCard = React.memo(function EditDiffCard({ input }: { input: Record<string, unknown> }): React.ReactElement | null {
  const model = useMemo(
    () => buildEditDiffModel(input),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity of the strings is the input
    [input.diff, input.old_str, input.new_str]
  )
  if (model.lines.length === 0 && !model.error) return null
  return <EditDiffView model={model} />
})

function EditDiffView({ model }: { model: EditDiffModel }): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const { added, removed } = countChangedLines(model.lines)
  if (model.error) {
    return (
      <div style={{ marginBottom: 8 }}>
        <div style={sectionLabelStyle}>Diff</div>
        <div style={{ background: '#252526', border: '1px solid #333', borderRadius: 4, padding: '6px 8px', fontSize: 12, color: '#c8a04a' }}>
          {model.error}
        </div>
      </div>
    )
  }
  const total = model.lines.length
  const foldable = total > DIFF_FOLD_PREVIEW_LINES
  const visible = foldable && !expanded ? model.lines.slice(0, DIFF_FOLD_PREVIEW_LINES) : model.lines
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={sectionLabelStyle}>
        Diff{total > 0 && ` · ${added} 增 / ${removed} 删`}
      </div>
      <div style={{ background: '#252526', border: '1px solid #333', borderRadius: 4, padding: '6px 8px', fontSize: 12 }}>
        {visible.map((line, i) => (
          <EditDiffRow key={i} line={line} />
        ))}
        {total === 0 && (
          <div style={{ color: '#8a8a8a', fontSize: 11 }}>（无变化）</div>
        )}
      </div>
      {foldable && (
        <Button
          type="text"
          size="small"
          onClick={() => setExpanded(!expanded)}
          style={{ color: '#8a8a8a', fontSize: 11, padding: '0 4px' }}
        >
          {expanded
            ? '收起'
            : `展开全部 ${total} 行 · 共 ${added + removed} 行变更（+${added} / −${removed}）`}
        </Button>
      )}
    </div>
  )
}

function EditDiffRow({ line }: { line: EditDiffLine }): React.ReactElement {
  const rowStyle: React.CSSProperties = { display: 'flex', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }
  if (line.type === 'meta') {
    return <div style={{ ...rowStyle, color: '#c8a04a' }}>{line.text}</div>
  }
  const gutter: React.CSSProperties = {
    flexShrink: 0,
    width: 68,
    textAlign: 'right',
    paddingRight: 8,
    color: '#6e6e6e',
    userSelect: 'none',
    fontSize: 11,
    lineHeight: 'inherit'
  }
  if (line.type === 'ctx') {
    return (
      <div style={{ ...rowStyle, color: '#9e9e9e' }}>
        <span style={gutter}>{line.oldNo != null ? `${line.oldNo}\u2002${line.newNo ?? ''}` : ''}</span>
        <span>{line.text}</span>
      </div>
    )
  }
  const isAdd = line.type === 'add'
  return (
    <div style={{
      ...rowStyle,
      color: isAdd ? '#4ec9b0' : '#f44747',
      background: isAdd ? 'rgba(78,201,176,0.08)' : 'rgba(244,71,71,0.08)'
    }}>
      <span style={gutter}>{isAdd ? line.newNo : line.oldNo}</span>
      <span style={{ whiteSpace: 'pre-wrap' }}>{`${isAdd ? '+' : '-'} ${line.text}`}</span>
    </div>
  )
}

// Write preview keeps its own short cap (whole-file writes need no reviewable
// history — the file itself is the artifact).
const MAX_WRITE_PREVIEW_LINES = 8

function WritePreview({ content }: { content: string }): React.ReactElement {
  const lines = content.split('\n')
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ ...sectionLabelStyle, color: '#4ec9b0' }}>{`+${lines.length} 行`}</div>
      <div style={{ background: '#252526', border: '1px solid #333', borderRadius: 4, padding: '6px 8px', fontSize: 12 }}>
        {lines.slice(0, MAX_WRITE_PREVIEW_LINES).map((l, i) => (
          <div key={i} style={{ color: '#4ec9b0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {`+ ${l}`}
          </div>
        ))}
        {lines.length > MAX_WRITE_PREVIEW_LINES && (
          <div style={{ color: '#8a8a8a', fontSize: 11 }}>… {lines.length - MAX_WRITE_PREVIEW_LINES} more</div>
        )}
      </div>
    </div>
  )
}

// ── Command summary helper ────────────────────────────────────────────

function buildCommandSummary(t: (key: string, params?: any) => string, block: ToolUseBlock): string {
  const input = block.input
  if (!input) return ''
  switch (block.name) {
    case 'exec':
      return String(input.command || '')
    case 'write': {
      const filePath = String(input.file_path || '')
      const content = String(input.content || '')
      if (filePath && content) {
        return `${t('commandCard.writeTo')}${filePath} (${(content.length / 1024).toFixed(1)} KB)`
      }
      if (filePath) {
        return `${t('commandCard.writeTo')}${filePath} (content truncated)`
      }
      return 'write (truncated \u2014 empty input)'
    }
    default:
      // The object half — path / query / host, the same string the 对象行 shows —
      // not `toolName(k=v, …)`; the raw k=v form only survives for tools the
      // family table doesn't know (MCP / user tools).
      return toolObjectSummary(block) || (() => {
        const entries = Object.entries(input)
          .filter(([k]) => k !== 'description')
          .map(([k, v]) => `${k}=${formatParam(v)}`)
        return entries.length ? `${block.name}(${entries.join(', ')})` : block.name
      })()
  }
}

function formatParam(v: unknown): string {
  if (typeof v === 'string') {
    if (v.length > 60) return v.slice(0, 57) + '...'
    return v
  }
  if (typeof v === 'object' && v !== null) return JSON.stringify(v).slice(0, 60)
  return String(v)
}

// ── Main component ────────────────────────────────────────────────────

const CommandCard = React.memo(function CommandCard({ block, onApprove, onReject, onKill, onToolResponse }: CommandCardProps): React.ReactElement {
  const { t } = useTranslation()
  const command = String(block.input?.command || '')
  const description = String(block.input?.description || '')

  // For non-exec tools, derive a human-readable summary from the input fields
  const commandLabel = command || buildCommandSummary(t, block)

  // Determine if we're still streaming this tool_use block (pending but no buttons yet)
  const isStreaming = block.status === 'pending' && !onApprove

  // Check if input has partial content (still being streamed)
  const hasPartialInput = block.input && Object.keys(block.input).length > 0 && !command

  // Detect truncated write tools (content was lost during SSE streaming or max_tokens hit)
  const isTruncatedWrite = block.name === 'write' && !isStreaming && (
    (block as any)._jsonTruncated === true ||
    (commandLabel === 'write (truncated \u2014 empty input)') ||
    (commandLabel.includes('content truncated'))
  )

  const isAskUser = block.name === 'ask_user'
  // ask_user waits for the user's choices, not for a process — 'queued' (its
  // dispatch-time state since the 排队中/执行中 split) must count as live here,
  // or the empty action row renders an 8px gap under the waiting card.
  const isAskUserRunning = isAskUser && (block.status === 'running' || block.status === 'queued' || block.status === 'pending' && onApprove)

  // 对象行（T3）: the parsed object half of the input, one mono line.
  const objectLine = toolObjectSummary(block)

  // 结果摘要（T3/D3-B）+ 折叠状态。流式/运行中永远展开（跟随滚动就是进度）。
  const summaryLine = resultSummary(block.name, block.output)?.line ?? null
  const [showFullOutput, setShowFullOutput] = useState(false)

  // ── Auto-scroll output container when output changes (streaming) ──
  const outputRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [block.output])

  return (
    // ask_user is not a terminal card: it asks a question in the chat's own
    // voice, so it takes the message layer's surfaces while every other tool
    // keeps the terminal skin (PLAN-dark-mode M2/T2 — the terminal body does
    // not follow the theme).
    <div style={isAskUser ? { ...cardStyle, background: 'var(--pm-fill)', color: 'var(--pm-ink)' } : cardStyle}>

      {/* Header */}
      <div style={headerStyle}>
        <span style={{ fontSize: 16 }}>
          {isStreaming ? (
            <LoadingOutlined style={{ color: '#1677ff' }} />
          ) : block.status === 'running' && !isAskUser ? (
            <Spin indicator={<LoadingOutlined style={{ fontSize: 16, color: '#1677ff' }} />} />
          ) : block.status === 'queued' && !isAskUser ? (
            // Queued behind batch-mates — hourglass, not the executing spinner
            // (user 2026-09-30: hourglass 明确为排队中). Same grey as the gear.
            <HourglassOutlined style={{ color: '#999' }} />
          ) : isAskUser ? (
            <CommentOutlined style={{color:'var(--pm-text-secondary)'}} />
          ) : (
            <SettingOutlined style={{color:'#999'}} />
          )}
        </span>
        <Text strong style={{ color: isAskUser ? 'var(--pm-ink)' : '#e0e0e0', fontSize: 13 }}>
          {isStreaming
            ? t('commandCard.generating')
            : block.status === 'running' && !isAskUser
              ? t('commandCard.running')
              : isAskUser
                ? t('commandCard.question')
                : toolDisplayName(block.name, t)}
        </Text>
      </div>

      {/* Command — show skeleton pulse while streaming (hidden for ask_user) */}
      {!isAskUser && (
        <>
          <div style={sectionLabelStyle}>{t('commandCard.input')}</div>
          <div style={{ ...commandLineStyle, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: '#6a9955', userSelect: 'none' }}>$ </Text>
              <Text style={{ color: isTruncatedWrite ? '#f44747' : '#89d185' }}>
                {isStreaming ? (
                  <span
                    style={{
                      color: '#aaa',
                      fontStyle: 'italic',
                      animation: 'pulsemind-skeleton-pulse 1.5s ease-in-out infinite'
                    }}
                  >
                    {t('commandCard.receiving')}
                  </span>
                ) : isTruncatedWrite ? (
                  <span style={{ color: '#f44747' }}>
                    {t('commandCard.writeTruncated')}
                  </span>
                ) : commandLabel || (
                  <Text style={{ color: '#888', fontStyle: 'italic' }}>
                    {t('commandCard.preparing')}
                  </Text>
                )}
              </Text>
            </div>
          </div>
        </>
      )}

      {/* Object line for non-exec tools (PLAN-tool-ux T3, D3 content layer): the
          parsed object — path / query / host — instead of the raw JSON dump.
          While streaming it still shows (animated), because the dump's growth IS
          the live progress; once settled, one mono line. */}
      {!isAskUser && hasPartialInput && (
        <pre style={{
          color: '#d4d4d4',
          fontSize: 12,
          margin: '0 0 8px 0',
          padding: '6px 8px',
          background: '#252526',
          border: '1px solid #333',
          borderRadius: 4,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          maxHeight: isStreaming ? 200 : undefined,
          overflowY: isStreaming ? 'auto' as const : 'visible' as const,
          animation: isStreaming ? 'pulsemind-skeleton-pulse 1.5s ease-in-out infinite' : undefined
        }}>
          {isStreaming
            ? JSON.stringify(block.input, null, 2)
            : (objectLine || JSON.stringify(block.input, null, 2))}
        </pre>
      )}

      {/* Streaming progress hint */}
      {isStreaming && (
        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Spin indicator={<LoadingOutlined style={{ fontSize: 12, color: '#1677ff' }} />} />
          <Text style={{ color: '#888', fontSize: 11, fontStyle: 'italic' }}>
            {hasPartialInput
              ? t('commandCard.contentStreaming')
              : t('commandCard.waitingModel')}
          </Text>
        </div>
      )}

      {/* Running progress hint (non-ask_user, no output yet) */}
      {!isAskUser && block.status === 'running' && !block.output && (
        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Spin indicator={<LoadingOutlined style={{ fontSize: 12, color: '#1677ff' }} />} />
          <Text style={{ color: '#888', fontSize: 11, fontStyle: 'italic' }}>
            {t('commandCard.executing')}
          </Text>
        </div>
      )}

      {/* Show error description for truncated writes */}
      {isTruncatedWrite && (
        <Text style={{ color: '#f44747', fontSize: 12, display: 'block', marginBottom: 8 }}>
          {t('commandCard.writeTruncatedDesc')}
        </Text>
      )}

      {/* Edit diff / write preview (T3/D3-C, P0-4): a REAL diff — both edit
          modes (unified diff / search-replace) produce hunks with context and
          line numbers; long diffs fold behind an explicit header instead of the
          old silent 8-line cut. Computed off the raw input strings, memoized:
          the generator's LCS guard keeps inputs sane, and this must not re-run
          per render. */}
      {!isAskUser && !isStreaming && !isTruncatedWrite && block.name === 'edit' && (
        <EditDiffCard input={block.input || {}} />
      )}
      {!isAskUser && !isStreaming && !isTruncatedWrite && block.name === 'write' &&
        typeof block.input?.content === 'string' && (block.input.content as string).length > 0 && (
          <WritePreview content={String(block.input.content)} />
        )}

      {/* Description */}
      {description && !isTruncatedWrite && (
        <Text style={{ color: '#a0a0a0', fontSize: 12, display: 'block', marginBottom: 8 }}>
          {description}
        </Text>
      )}

      {/* ── ask_user inline choices (hidden while streaming) ── */}
      {isAskUser && !isStreaming && (
        <AskUserChoices block={block} onToolResponse={onToolResponse} />
      )}

      {/* Output (hidden for ask_user — shown inline in AskUserChoices). A
          confident family count (T3/D3-B) collapses the raw text behind
          查看完整输出; no parse → the raw output as before. While the tool is
          still streaming, the full output stays visible — the auto-scroll
          follow IS the live progress. */}
      {!isAskUser && block.output && (
        <>
          <div style={{ ...sectionLabelStyle, marginTop: 8 }}>
            {t('commandCard.output')}{summaryLine ? ` · ${summaryLine}` : ''}
          </div>
          {summaryLine && block.status === 'completed' && !showFullOutput ? (
            <Button
              type="text"
              size="small"
              onClick={() => setShowFullOutput(true)}
              style={{ color: '#8a8a8a', fontSize: 11, padding: '0 4px', marginBottom: 4 }}
            >
              {t('commandCard.viewFullOutput')}
            </Button>
          ) : (
            <div style={outputStyle} ref={outputRef}>
              {block.output}
            </div>
          )}
        </>
      )}

      {/* Background strip (PLAN-coding-contract P0-3 #16): the result settled at
          spawn, so this is a STATIC status — whether the process is still alive
          is discovered via exec_logs, not pushed here. kill routes through the
          pid channel, never the foreground-process scalar. */}
      {!isAskUser && block.backgroundPid != null && block.status === 'completed' && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: '#4ec9b0', fontSize: 12 }}>
            <CheckOutlined style={{ marginRight: 4 }} />
            {t('commandCard.backgroundRunning', { pid: block.backgroundPid })}
          </Text>
          {onKill && (
            <Button size="small" danger icon={<StopOutlined />} onClick={onKill}>
              {t('commandCard.kill')}
            </Button>
          )}
        </div>
      )}

      {/* Result badge (hidden for ask_user). Success shows no number (T3/D3-A);
          the exit code value is only exposed on failure, where it means something.
          A background block's exit code is the SPAWN's, not the process's end —
          the strip above speaks for it instead. */}
      {!isAskUser && block.backgroundPid == null && block.exitCode !== undefined && block.exitCode !== null && (
        <div style={{ marginTop: 4 }}>
          <Text
            style={{
              color: block.exitCode === 0 ? '#4ec9b0' : '#f44747',
              fontSize: 12
            }}
          >
            {block.exitCode === 0
              ? <><CheckOutlined style={{ color: '#4ec9b0' }} /> {t('commandCard.success')}</>
              : <><CloseOutlined style={{ color: '#f44747' }} /> {t('commandCard.failed')} · exit {block.exitCode}</>}
          </Text>
        </div>
      )}

      {/* Action buttons (hidden for ask_user running state — choices replace them) */}
      {!isAskUserRunning && (
        <div style={{ marginTop: 8 }}>
          {block.status === 'pending' && onApprove && onReject && !isTruncatedWrite && (
            <Space size="small">
              <Button
                size="small"
                icon={<CloseCircleOutlined />}
                onClick={onReject}
                style={{ color: '#e0e0e0', borderColor: '#555', background: 'transparent' }}
              >
                {t('commandCard.skip')}
              </Button>
              <Button
                size="small"
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={onApprove}
              >
                {t('commandCard.run')}
              </Button>
            </Space>
          )}
          {isTruncatedWrite && block.status !== 'completed' && (
            <Text style={{ color: '#f44747', fontSize: 12 }}>
              <CloseOutlined style={{marginRight:4,fontSize:12}} />{t('commandCard.writeCannotRun')}
            </Text>
          )}
          {block.status === 'running' && onKill && (
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              onClick={onKill}
            >
              {t('commandCard.kill')}
            </Button>
          )}
          {block.status === 'rejected' && (
            <Text style={{ color: '#f44747', fontSize: 12 }}><CloseOutlined style={{marginRight:4,fontSize:12}} />{t('commandCard.skippedByUser')}</Text>
          )}
          {block.status === 'completed' && !isAskUser && block.backgroundPid == null && (
            <Text style={{ color: '#4ec9b0', fontSize: 12 }}>
              {(block.exitCode === 0 || block.exitCode == null) ? <><CheckOutlined style={{marginRight:4}} />{t('commandCard.completed')}</> : <><CloseOutlined style={{marginRight:4,fontSize:12}} />{t('commandCard.failed')}</>}
            </Text>
          )}
        </div>
      )}
    </div>
  )
})

export default CommandCard