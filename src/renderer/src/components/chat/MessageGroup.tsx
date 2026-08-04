import React, { useState, useRef, useEffect } from 'react'
import { XMarkdown } from '@ant-design/x-markdown'
import Latex from '@ant-design/x-markdown/plugins/Latex'
import { Modal } from 'antd'
import {
  CopyOutlined,
  CheckOutlined,
  LikeOutlined,
  LikeFilled,
  StarOutlined,
  StarFilled,
  DownloadOutlined,
  RightOutlined,
  DownOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  HourglassOutlined,
  CloseOutlined,
  SettingOutlined,
  LockOutlined,
  AimOutlined,
  EyeOutlined
} from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import type { AgentMessage, ToolUseBlock, ToolResultBlock, ThinkingBlock, ContentBlock } from '../../types/agent'
import type { SubAgentHandle } from '../../agent/agent-utils'
import type { Conversation, Message } from '../../../../shared/types/conversation'
import CommandCard from '../terminal/CommandCard'
import { CodeBlock } from './CodeBlock'
import { LocalImage } from './LocalImage'
import { ThinkingBlockView } from './ThinkingBlockView'
import { FileRefChip } from './FileRefChip'

// Blinking cursor keyframe for live sub-agent preview
const cursorKeyframe = `@keyframes pulsemind-blink-cursor {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}`
if (typeof document !== 'undefined' && !(window as any).__pulsemind_cursor_injected) {
  const el = document.createElement('style')
  el.textContent = cursorKeyframe
  document.head.appendChild(el)
  ;(window as any).__pulsemind_cursor_injected = true
}

// --- Bubble styles ---

const userBubbleStyle: React.CSSProperties = {
  background: '#f0f2f4',
  color: '#000',
  borderRadius: 12,
  padding: '8px 14px',
  maxWidth: '70%',
  fontSize: 14,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word'
}

const assistantBubbleStyle: React.CSSProperties = {
  borderRadius: 12,
  padding: '4px 0',
  width: '100%',
  fontSize: 14,
  lineHeight: 1.6
}

// --- Helpers ---

function hasDisplayableContent(msg: AgentMessage): boolean {
  return msg.contentBlocks.some(
    (b) => b.type === 'text' || b.type === 'tool_use' || b.type === 'thinking' || b.type === 'redacted_thinking' || (b.type === 'tool_result' && b.imageData)
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTokenCount(n: number): string {
  if (n >= 10_000) {
    return `${(n / 1000).toFixed(1)}k`
  }
  return n.toLocaleString()
}

// ── Collapsible tool_use block ────────────────────────────────────────

function toolBlockSummary(block: ToolUseBlock): string {
  const input = block.input
  if (!input) return block.name
  switch (block.name) {
    case 'exec': return (input.command as string || '').slice(0, 80)
    case 'read': return input.file_path as string || ''
    case 'write': return `${input.file_path || ''} (${((input.content as string) || '').length > 0 ? `${((input.content as string).length / 1024).toFixed(1)} KB` : '0 KB'})`
    case 'edit': return input.file_path as string || ''
    case 'search': return input.query as string || ''
    case 'list_dir': return input.dir_path as string || ''
    case 'ask_user': return (input.prompt as string || '').slice(0, 80)
    default: {
      const entries = Object.entries(input).filter(([k]) => k !== 'description')
      if (entries.length === 0) return block.name
      const [k, v] = entries[0]
      const val = typeof v === 'string' ? (v.length > 40 ? v.slice(0, 37) + '...' : v) : JSON.stringify(v).slice(0, 40)
      return `${k}=${val}`
    }
  }
}

/**
 * Content signature for a sub-agent message list. Captures per-message id/role and per-block
 * state so the live preview can refresh on tool_use status transitions (pending → running →
 * completed) and text/tool_result growth, not just when the message count changes.
 */
function msgSignature(msgs: AgentMessage[]): string {
  return msgs.map((m) => {
    const blocks = (m.contentBlocks ?? []).map((b) => {
      switch (b.type) {
        case 'tool_use': {
          const tb = b as ToolUseBlock
          return `tu:${tb.id}:${tb.name}:${tb.status ?? ''}`
        }
        case 'tool_result': {
          const tr = b as ToolResultBlock
          return `tr:${tr.tool_use_id}:${(tr.content ?? '').length}:${tr.is_error ? 'e' : ''}`
        }
        case 'text':
          return `tx:${(b.text ?? '').length}`
        default:
          return b.type
      }
    }).join('|')
    return `${m.id}:${m.role}:${blocks}`
  }).join(';')
}

function CollapsibleToolBlock({
  block,
  onApproveTool,
  onRejectTool,
  onKillTool,
  onRespondToTool,
  completedFromResult = false
}: {
  block: ToolUseBlock
  onApproveTool?: (toolUseId: string) => void
  onRejectTool?: (toolUseId: string) => void
  onKillTool?: (toolUseId: string) => void
  onRespondToTool?: (toolUseId: string, response: string) => void
  completedFromResult?: boolean
}): React.ReactElement {
  const [collapsed, setCollapsed] = useState(block.name !== 'ask_user')
  const { t } = useTranslation()
  const summary = toolBlockSummary(block)
  const needsAction = block.status === 'pending' && !!onApproveTool

  // ── Sub-agent preview ──
  const subConvId = (block as any)._subConvId
  const subAgentHandle = (block as any)._subAgentHandle as SubAgentHandle | undefined
  const isSpawnAgent = block.name === 'spawn_agent' && !!subConvId
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewConv, setPreviewConv] = useState<Conversation | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval>>()
  const pollSigRef = useRef('')

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  const handlePreview = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!subConvId) return

    // Try live handle first: poll messages in real-time while engine is active
    if (subAgentHandle && subAgentHandle.agentStatus.status !== 'idle') {
      setPreviewLoading(false)
      setPreviewOpen(true)
      // Seed with current messages
      const toMessages = (msgs: AgentMessage[]): Message[] =>
        msgs.map(m => ({ id: m.id, role: m.role, content: '', contentBlocks: m.contentBlocks, createdAt: m.createdAt || new Date().toISOString() }))
      setPreviewConv({
        id: subConvId,
        title: '子代理对话',
        messages: toMessages(subAgentHandle.messages),
        createdAt: '',
        updatedAt: ''
      })
      pollSigRef.current = msgSignature(subAgentHandle.messages)
      // Poll every 1.5s for live updates; refresh on content-signature change so
      // tool_use status transitions and growing text/output show up live
      pollRef.current = setInterval(() => {
        const msgs = subAgentHandle.messages
        const sig = msgSignature(msgs)
        if (sig !== pollSigRef.current) {
          pollSigRef.current = sig
          setPreviewConv({
            id: subConvId,
            title: '子代理对话',
            messages: toMessages(msgs),
            createdAt: '',
            updatedAt: ''
          })
        }
        // Stop polling when engine goes idle
        if (subAgentHandle.agentStatus.status === 'idle') {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = undefined }
        }
      }, 1500)
      return
    }

    // Fallback: load from DB (completed or restarted session)
    setPreviewLoading(true)
    try {
      const conv = await window.electronAPI.hydrateConversation(subConvId)
      if (conv) setPreviewConv(conv)
      setPreviewOpen(true)
    } catch (err) { console.error('Failed to load sub-agent conversation:', err) }
    setPreviewLoading(false)
  }

  return (
    <div style={{ margin: '4px 0' }}>
      {/* Collapsible header bar */}
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          background: needsAction ? '#fff7e6' : '#f5f5f5',
          borderRadius: 6,
          cursor: 'pointer',
          fontSize: 13,
          color: '#555',
          userSelect: 'none',
          border: needsAction ? '1px solid #ffd591' : '1px solid transparent',
          transition: 'background 0.15s'
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = needsAction ? '#ffe7ba' : '#ebebeb' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = needsAction ? '#fff7e6' : '#f5f5f5' }}
      >
        {/* Status indicator */}
        <span style={{ fontSize: 14, flexShrink: 0, width: 18, textAlign: 'center' }}>
          {block.status === undefined && completedFromResult ? <CheckOutlined style={{color:'#4ec9b0'}} /> : block.status === undefined ? <ArrowDownOutlined style={{color:'#999'}} /> : block.status === 'running' ? <HourglassOutlined /> : block.status === 'completed' ? (block.exitCode === 0 ? <CheckOutlined style={{color:'#4ec9b0'}} /> : <CloseOutlined style={{color:'#f44747'}} />) : block.status === 'rejected' ? <CloseOutlined style={{color:'#f44747'}} /> : <SettingOutlined />}
        </span>
        {/* Tool name */}
        <span style={{ fontWeight: 600, color: '#333', flexShrink: 0, fontSize: 12 }}>{block.name}</span>
        {/* Summary */}
        {summary && (
          <span style={{
            color: '#999',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            fontSize: 12
          }}>
            {summary}
          </span>
        )}
        {/* Action hint for pending tools */}
        {needsAction && (
          <span style={{ color: '#d46b08', fontSize: 11, flexShrink: 0, fontWeight: 500 }}>
            {t('commandCard.awaitingApproval')}
          </span>
        )}
        {/* Receiving hint for streaming tool blocks */}
        {block.status === undefined && !completedFromResult && (
          <span style={{ color: '#999', fontSize: 11, flexShrink: 0, fontWeight: 500 }}>
            指令生成中...
          </span>
        )}
        {/* Sub-agent preview button */}
        {isSpawnAgent && (
          <span onClick={handlePreview} style={{ flexShrink: 0, lineHeight: 1, cursor: 'pointer' }}>
            {previewLoading ? (
              <span style={{ color: '#888', fontSize: 12 }}>加载中...</span>
            ) : (
              <EyeOutlined style={{ color: '#888', fontSize: 14 }} title="查看子代理对话" />
            )}
          </span>
        )}
        {/* Expand/collapse icon */}
        <span style={{ color: '#bbb', fontSize: 11, flexShrink: 0 }}>
          {collapsed ? <RightOutlined /> : <DownOutlined />}
        </span>
      </div>

      {/* Full CommandCard when expanded. In read-only previews (sub-agent dialog)
          the handlers are absent, so render the plain card with no action buttons. */}
      {!collapsed && (
        block.status === 'pending' && onApproveTool && onRejectTool ? (
          <CommandCard
            block={block}
            onApprove={() => onApproveTool(block.id)}
            onReject={() => onRejectTool(block.id)}
            onToolResponse={onRespondToTool}
          />
        ) : block.status === 'running' && onKillTool ? (
          <CommandCard
            block={block}
            onKill={() => onKillTool(block.id)}
            onToolResponse={onRespondToTool}
          />
        ) : (
          <CommandCard block={block} />
        )
      )}

      {/* Sub-agent preview modal */}
      {isSpawnAgent && (
        <Modal
          title="子代理对话"
          open={previewOpen}
          onCancel={() => { setPreviewOpen(false); if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = undefined } }}
          width="80%"
          style={{ top: 20 }}
          footer={null}
          styles={{ body: { maxHeight: '75vh', overflow: 'auto', padding: 16 } }}
        >
          <style>{'.ant-modal-close:focus-visible { outline: none }'}</style>
          {(() => {
            const isLivePreview = subAgentHandle != null && subAgentHandle.agentStatus.status !== 'idle'
            const filteredMessages = (previewConv?.messages ?? []).filter((msg: Message) =>
              msg.contentBlocks?.some((b: ContentBlock) => b.type === 'text' || b.type === 'tool_use') || msg.content
            )
            // Tool_use blocks loaded from DB have status stripped on save; a matching
            // tool_result proves the tool finished, so the card can show a green check.
            const completedToolIds = new Set<string>()
            for (const m of previewConv?.messages ?? []) {
              for (const b of m.contentBlocks ?? []) {
                if (b.type === 'tool_result') completedToolIds.add((b as ToolResultBlock).tool_use_id)
              }
            }
            return filteredMessages.map((msg: Message, idx: number) => (
              <div key={msg.id} style={{
                display: 'flex', marginBottom: 12,
                justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start'
              }}>
                {msg.role === 'user' ? (
                  <div style={{
                    ...userBubbleStyle,
                    maxWidth: '80%'
                  }}>
                    {msg.contentBlocks?.filter((b: ContentBlock) => b.type === 'text').map((b: ContentBlock, i: number) => (
                      <FileRefChip key={i} text={(b as any).text} />
                    ))}
                    {(!msg.contentBlocks || !msg.contentBlocks.some((b: ContentBlock) => b.type === 'text')) && msg.content && (
                      <FileRefChip text={msg.content} />
                    )}
                  </div>
                ) : (
                    <div style={{ width: '100%' }}>
                      {msg.contentBlocks?.filter((b: ContentBlock) => b.type === 'text').map((b: ContentBlock, i: number) => (
                        <div key={i} className="x-markdown-light" style={{ paddingLeft: 12 }}>
                          <XMarkdown content={(b as any).text} components={{ code: CodeBlock, img: LocalImage }} config={{ extensions: Latex() }} />
                        </div>
                      ))}
                      {(!msg.contentBlocks || !msg.contentBlocks.some((b: ContentBlock) => b.type === 'text')) && msg.content && (
                        <div className="x-markdown-light" style={{ paddingLeft: 12 }}>
                          <XMarkdown content={msg.content} components={{ code: CodeBlock, img: LocalImage }} config={{ extensions: Latex() }} />
                        </div>
                      )}
                      {msg.contentBlocks?.filter((b: ContentBlock) => b.type === 'tool_use').map((b: ContentBlock, i: number) => {
                        const tb = b as ToolUseBlock
                        return (
                          <div key={`tu-${i}`} style={{ paddingLeft: 4, marginTop: 4 }}>
                            <CollapsibleToolBlock block={tb} completedFromResult={completedToolIds.has(tb.id)} />
                          </div>
                        )
                      })}
                      {/* Blinking cursor on the last assistant message when streaming */}
                      {isLivePreview && idx === filteredMessages.length - 1 && (
                        <span style={{
                          display: 'inline-block',
                          width: 2,
                          height: 16,
                          background: '#333',
                          marginLeft: 2,
                          verticalAlign: 'text-bottom',
                          animation: 'pulsemind-blink-cursor 1s step-end infinite'
                        }} />
                      )}
                    </div>
                  )}
                </div>
              )
            )
          })()}
          {(!previewConv || previewConv.messages.length === 0) && !previewLoading && (
            <div style={{ textAlign: 'center', color: '#999', padding: 40 }}>暂无对话内容</div>
          )}
        </Modal>
      )}
    </div>
  )
}

// --- Component ---

export const MessageGroup = React.memo(function MessageGroup({
  msg,
  showActions,
  onApproveTool,
  onRejectTool,
  onRespondToTool,
  onKillTool,
  conversationId,
  conversationTitle
}: {
  msg: AgentMessage
  showActions?: boolean
  onApproveTool: (toolUseId: string) => void
  onRejectTool: (toolUseId: string) => void
  onRespondToTool?: (toolUseId: string, response: string) => void
  onKillTool: (toolUseId: string) => void
  conversationId?: string
  conversationTitle?: string
}): React.ReactElement | null {
  const [liked, setLiked] = useState(msg.liked ?? false)
  const [favorited, setFavorited] = useState(msg.favorited ?? false)
  const [copied, setCopied] = useState(false)
  const { t } = useTranslation()

  if (!hasDisplayableContent(msg)) return null

  const isUser = msg.role === 'user'

  const assistantText = isUser
    ? ''
    : msg.contentBlocks
        .filter((b) => b.type === 'text')
        .map((b) => (b as any).text)
        .join('\n')

  const handleCopy = async () => {
    if (!assistantText) return
    try {
      await navigator.clipboard.writeText(assistantText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.warn('[MessageGroup] Copy failed:', err)
    }
  }

  const handleDownload = async () => {
    if (!assistantText) return
    const title = conversationTitle || 'message'
    const safeName = title.replace(/[<>:"/\\|?*]/g, '_')
    try {
      const { filePath, canceled } = await window.electronAPI.showSaveDialog({
        defaultName: `${safeName}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (canceled || !filePath) return
      await window.electronAPI.writeFile({
        filePath,
        content: assistantText
      })
    } catch (err) {
      console.warn('[MessageGroup] Download failed:', err)
    }
  }

  const btnBase: React.CSSProperties = {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontSize: 14,
    padding: '4px 8px',
    borderRadius: 6,
    lineHeight: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'color 0.2s, background 0.15s'
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isUser ? 'row' : 'column',
        alignItems: isUser ? undefined : 'flex-start',
        justifyContent: isUser ? 'flex-end' : undefined,
        marginBottom: isUser ? 16 : 0
      }}
    >
      <div style={isUser ? userBubbleStyle : assistantBubbleStyle}>
        {msg.contentBlocks.map((block, i) => {
          if (isUser && block.type === 'text') {
            // display:flex on XMarkdown root hides whitespace-only text nodes
            // (including the trailing \n the Parser adds after </p>), eliminating
            // the ~22px gap without changing content or breaking markdown
            const flexCol = { display: 'flex' as const, flexDirection: 'column' as const }
            return (
              <div key={i} className="x-markdown-light" style={{ padding: 0 }}>
                {msg.autoSummary && (
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 4, fontWeight: 500 }}>
                    {t('autoSummary.label') || 'Auto Summary'}
                  </div>
                )}
                <FileRefChip text={block.text} xmarkdownStyle={flexCol} textRenderer={(t) => <XMarkdown content={t} style={flexCol} components={{ code: CodeBlock, img: LocalImage }} config={{ extensions: Latex() }} />} />
              </div>
            )
          }
          if (isUser && block.type === 'tool_result') {
            const tr = block as ToolResultBlock
            if (tr.imageData) {
              return (
                <div key={i} style={{ margin: '8px 0', maxWidth: '100%' }}>
                  <img
                    src={`data:image/png;base64,${tr.imageData}`}
                    alt="Screenshot"
                    style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid #e8e8e8' }}
                  />
                </div>
              )
            }
            if (tr.content) {
              return (
                <div key={i} style={{
                  margin: '8px 0',
                  padding: '8px 10px',
                  background: '#f6f8fa',
                  borderRadius: 6,
                  border: '1px solid #e8e8e8',
                  fontSize: 12,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  maxHeight: 400,
                  overflowY: 'auto'
                }}>
                  {tr.content}
                </div>
              )
            }
          }
          if (!isUser) {
            if (block.type === 'text') {
              return (
                <div key={i} className="x-markdown-light" style={{ paddingLeft: 12 }}>
                  <FileRefChip
                    text={block.text}
                    textRenderer={(t) => <XMarkdown content={t} components={{ code: CodeBlock, img: LocalImage }} config={{ extensions: Latex() }} />}
                  />
                </div>
              )
            }
            if (block.type === 'tool_use') {
              const tb = block as ToolUseBlock
              if (tb.name === 'ask_user') {
                return (
                  <div key={i}>
                    <CommandCard block={tb} onToolResponse={onRespondToTool} />
                  </div>
                )
              }
              return (
                <CollapsibleToolBlock
                  key={i}
                  block={tb}
                  onApproveTool={onApproveTool}
                  onRejectTool={onRejectTool}
                  onKillTool={onKillTool}
                  onRespondToTool={onRespondToTool}
                />
              )
            }
            if (block.type === 'thinking') {
              return <ThinkingBlockView key={i} block={block as ThinkingBlock} />
            }
            if (block.type === 'redacted_thinking') {
              return (
                <div key={i} style={{ margin: '6px 0', borderLeft: '2px solid #d0d0d0', paddingLeft: 10 }}>
                  <div style={{ color: '#888', fontSize: 13, lineHeight: 1.6 }}>
                    <LockOutlined style={{marginRight:4,fontSize:11}} />Thinking redacted
                  </div>
                </div>
              )
            }
          }
          return null
        })}
      </div>

      {/* Action buttons — only on the last assistant message of each loop, hidden for ask_user-only messages */}
      {!isUser && showActions && !msg.contentBlocks.every(b => b.type === 'tool_use' && (b as ToolUseBlock).name === 'ask_user') && (
        <div
          style={{
            display: 'flex',
            gap: 2,
            marginTop: 6,
            marginBottom: 16,
            paddingLeft: 0,
          }}
        >
          <button
            style={{ ...btnBase, color: copied ? '#bbb' : '#bbb' }}
            onClick={handleCopy}
            title={t('chatView.copy')}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#f0f0f0' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            {copied ? <CheckOutlined /> : <CopyOutlined />}
          </button>
          <button
            style={{ ...btnBase, color: '#bbb' }}
            onClick={handleDownload}
            title={t('chatView.download')}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#f0f0f0' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            <DownloadOutlined />
          </button>
          <button
            style={{ ...btnBase, color: liked ? '#aaa' : '#bbb' }}
            onClick={() => {
              const next = !liked
              setLiked(next)
              msg.liked = next
              window.electronAPI.updateMessageMetadata(msg.id, { liked: next })
            }}
            title={t('chatView.like')}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#f0f0f0' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            {liked ? <LikeFilled /> : <LikeOutlined />}
          </button>
          <button
            style={{ ...btnBase, color: favorited ? '#aaa' : '#bbb' }}
            onClick={() => {
              const next = !favorited
              setFavorited(next)
              msg.favorited = next
              window.electronAPI.updateMessageMetadata(msg.id, { favorited: next })
              if (next && conversationId && msg.id) {
                const text = msg.contentBlocks
                  .filter((b) => b.type === 'text')
                  .map((b) => (b as any).text)
                  .join('\n')
                window.electronAPI.addFavorite({
                  id: `fav_${conversationId}_${msg.id}`,
                  messageId: msg.id,
                  conversationId,
                  conversationTitle: conversationTitle || '',
                  role: msg.role,
                  content: text || (msg as any).content || ''
                })
              } else if (!next) {
                window.electronAPI.removeFavorite(msg.id)
              }
            }}
            title={t('chatView.favorite')}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#f0f0f0' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            {favorited ? <StarFilled /> : <StarOutlined />}
          </button>

          {(msg.processingMs != null || msg.inputTokens != null || msg.outputTokens != null || msg.promptCacheHitTokens != null) && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 12,
                marginLeft: 6,
                color: '#bbb',
                fontSize: 12,
                lineHeight: 1
              }}
            >
              <span style={{ color: '#ddd' }}>|</span>
              {msg.processingMs != null && (
                <span title={t('chatView.processingTime')}>{formatDuration(msg.processingMs)}</span>
              )}
              {msg.inputTokens != null && (
                <span title={t('chatView.inputTokens')}><ArrowUpOutlined style={{fontSize:10,marginRight:2}} />{formatTokenCount(msg.inputTokens)}</span>
              )}
              {msg.outputTokens != null && (
                <span title={t('chatView.outputTokens')}><ArrowDownOutlined style={{fontSize:10,marginRight:2}} />{formatTokenCount(msg.outputTokens)}</span>
              )}
              {msg.promptCacheHitTokens != null && (
                <span title={t('chatView.promptCacheHit')}><AimOutlined style={{fontSize:10,marginRight:2}} />{formatTokenCount(msg.promptCacheHitTokens)}</span>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  )
})
