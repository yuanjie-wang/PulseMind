import React, { useState, useEffect, useRef } from 'react'
import { Button, Typography, Space, Spin, Tag, Input } from 'antd'
import { PlayCircleOutlined, CloseCircleOutlined, StopOutlined, LoadingOutlined, CheckCircleOutlined, SendOutlined, CloseOutlined, CheckOutlined, CommentOutlined, SettingOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import type { ToolUseBlock } from '../../types/agent'

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
        <div style={{ color: '#000', marginBottom: 10, fontSize: 14, lineHeight: 1.6 }}>
          {prompt}
        </div>
        {block.output && (
          <div style={{ color: '#999', marginBottom: 4, fontSize: 13 }}>
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
        <div style={{ color: '#000', marginBottom: 10, fontSize: 14, lineHeight: 1.6 }}>
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
      <div style={{ color: '#000', marginBottom: 12, fontSize: 14, lineHeight: 1.6 }}>
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
                border: '1px solid #d9d9d9',
                cursor: 'pointer',
                color: selected.has(choice) ? '#fff' : '#000',
                background: selected.has(choice) ? '#1677ff' : '#fff'
              }}
            >
              {choice}
            </Tag.CheckableTag>
          ) : (
            <Button
              key={choice}
              size="small"
              style={{
                color: '#000',
                borderColor: '#d9d9d9',
                background: '#fff'
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

// ── Command summary helper ────────────────────────────────────────────

function buildCommandSummary(t: (key: string, params?: any) => string, toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  switch (toolName) {
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
      // For non-exec tools, show the tool name with a brief summary
      const entries = Object.entries(input)
        .filter(([k]) => k !== 'description')
        .map(([k, v]) => `${k}=${formatParam(v)}`)
      return entries.length ? `${toolName}(${entries.join(', ')})` : toolName
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
  const commandLabel = command || buildCommandSummary(t, block.name, block.input)

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
  const isAskUserRunning = isAskUser && (block.status === 'running' || block.status === 'pending' && onApprove)

  // ── Auto-scroll output container when output changes (streaming) ──
  const outputRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [block.output])

  return (
    <div style={isAskUser ? { ...cardStyle, background: '#f5f5f5', color: '#000' } : cardStyle}>

      {/* Header */}
      <div style={headerStyle}>
        <span style={{ fontSize: 16 }}>
          {isStreaming ? (
            <LoadingOutlined style={{ color: '#1677ff' }} />
          ) : block.status === 'running' && !isAskUser ? (
            <Spin indicator={<LoadingOutlined style={{ fontSize: 16, color: '#1677ff' }} />} />
          ) : isAskUser ? (
            <CommentOutlined style={{color:'#666'}} />
          ) : (
            <SettingOutlined style={{color:'#999'}} />
          )}
        </span>
        <Text strong style={{ color: isAskUser ? '#000' : '#e0e0e0', fontSize: 13 }}>
          {isStreaming
            ? t('commandCard.generating')
            : block.status === 'running' && !isAskUser
              ? t('commandCard.running')
              : isAskUser
                ? t('commandCard.question')
                : t('commandCard.executeCommand')}
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

      {/* Tool input parameters (for non-exec tools, hidden for ask_user) */}
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
          maxHeight: 200,
          overflowY: 'auto',
          animation: isStreaming ? 'pulsemind-skeleton-pulse 1.5s ease-in-out infinite' : undefined
        }}>
          {JSON.stringify(block.input, null, 2)}
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

      {/* Output (hidden for ask_user — shown inline in AskUserChoices) */}
      {!isAskUser && block.output && (
        <>
          <div style={{ ...sectionLabelStyle, marginTop: 8 }}>{t('commandCard.output')}</div>
          <div style={outputStyle} ref={outputRef}>
            {block.output}
          </div>
        </>
      )}

      {/* Exit code (hidden for ask_user) */}
      {!isAskUser && block.exitCode !== undefined && block.exitCode !== null && (
        <div style={{ marginTop: 4 }}>
          <Text
            style={{
              color: block.exitCode === 0 ? '#4ec9b0' : '#f44747',
              fontSize: 12
            }}
          >
            {block.exitCode === 0 ? <><CheckOutlined style={{color:'#4ec9b0'}} />{' '}</> : <><CloseOutlined style={{color:'#f44747'}} />{' '}</>}Exit code: {block.exitCode}
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
          {block.status === 'completed' && !isAskUser && (
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