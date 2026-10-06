import React, { useState, useRef, useEffect } from 'react'
import { XMarkdown } from '@ant-design/x-markdown'
import Latex from '@ant-design/x-markdown/plugins/Latex'
import {
  CopyOutlined,
  CheckOutlined,
  LikeOutlined,
  LikeFilled,
  BookOutlined,
  BookFilled,
  DownloadOutlined,
  RightOutlined,
  DownOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  HourglassOutlined,
  CloseOutlined,
  LockOutlined,
  AimOutlined,
  EyeOutlined,
  ScheduleOutlined,
  LoadingOutlined
} from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { notify } from '../../utils/notify'
import type { AgentMessage, ToolUseBlock, ToolResultBlock, ThinkingBlock } from '../../types/agent'
import CommandCard, { AskUserBatchCard } from '../terminal/CommandCard'
import { ApprovalArea } from './ApprovalArea'
import { toolBlockSummary, toolDisplayName, subAgentSessionTitle } from './tool-summary'
import { CodeBlock } from './CodeBlock'
import { LocalImage } from './LocalImage'
import { ThinkingBlockView } from './ThinkingBlockView'
import { FileRefChip } from './FileRefChip'
import { openInPreviewPane } from '../../stores/previewPaneStore'
import { enqueueCompileForFile } from '../knowledge/compile-queue'
import { createKnowledgeSaveAction } from './knowledge-save'
import { useMarkdownThemeClass } from '../../theme/mode'
import { CollapseBody, POP_ANIM, SHAKE_ANIM } from './motion'

// --- Bubble styles ---

const userBubbleStyle: React.CSSProperties = {
  background: 'var(--pm-sunk)',
  color: 'var(--pm-ink)',
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

/** User-bubble markdown config. The bubble's `whiteSpace: pre-wrap` inherits into
 *  the markdown tree, and the x-markdown Parser emits \n between block elements
 *  (inside <ul>, around <blockquote>…), which pre-wrap renders as a phantom blank
 *  line each (a 3-item list measured 198px vs 110px under normal). The md wrapper
 *  resets to `normal` and `breaks` re-encodes the newlines the user actually typed
 *  as <br>, so soft breaks keep rendering as line breaks while the parser's own
 *  block separators collapse away. */
const USER_MD_CONFIG: React.ComponentProps<typeof XMarkdown>['config'] = { breaks: true, extensions: Latex() }

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

function CollapsibleToolBlock({
  block,
  onApproveTool,
  onRejectTool,
  onKillTool,
  onRespondToTool,
  onOpenSubAgent,
  completedFromResult = false,
  receiving = false,
  awaitingApproval = true
}: {
  block: ToolUseBlock
  onApproveTool?: (toolUseId: string, alwaysAllow?: boolean) => void
  onRejectTool?: (toolUseId: string) => void
  onKillTool?: (toolUseId: string) => void
  onRespondToTool?: (toolUseId: string, response: string) => void
  /** Open a spawn card's sub-conversation in the host's session view. Absent
   *  means the host has no drill-in (a nested transcript), so no icon shows. */
  onOpenSubAgent?: (subConvId: string, title: string) => void
  completedFromResult?: boolean
  receiving?: boolean
  /** The engine is parked on its held calls (`agentStatus: 'awaiting_approval'`).
   *  Defaults to true so a caller that predates this prop keeps the old rule —
   *  a pending call carrying approve handlers is one the user must answer. */
  awaitingApproval?: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const summary = toolBlockSummary(block, t)
  // A call the ladder is holding: `pending` *and* the engine parked on it. The
  // parked half matters — a tool still being generated is 'pending' too, and it
  // has nothing to approve yet.
  const needsAction = block.status === 'pending' && !!onApproveTool && awaitingApproval
  const [collapsed, setCollapsed] = useState(block.name !== 'ask_user')

  // Status-settlement feedback: the header glyph pops when a LIVE call completes
  // and shakes when one fails/rejected. A history load mounts the glyph already
  // settled — the effect only fires on a status CHANGE after mount, so opening
  // an old conversation never replays the pop.
  const [settleFx, setSettleFx] = useState<'pop' | 'shake' | null>(null)
  const prevStatusRef = useRef(block.status)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = block.status
    if (prev === block.status) return
    const failed = block.status === 'rejected' || (block.status === 'completed' && block.exitCode !== undefined && block.exitCode !== 0)
    setSettleFx(block.status === 'completed' && !failed ? 'pop' : failed ? 'shake' : null)
  }, [block.status, block.exitCode])

  // File preview button (PLAN-preview-pane): completed write/edit calls with
  // a file path open the file in the chat's right preview pane.
  const inputFilePath = typeof block.input?.file_path === 'string' ? (block.input.file_path as string) : ''
  const toolSucceeded = (block.status === 'completed' || (block.status === undefined && completedFromResult)) && block.exitCode === undefined
  const previewableFile = (block.name === 'write' || block.name === 'edit') && inputFilePath && toolSucceeded ? inputFilePath : null

  // ── Sub-agent session link ──
  // The link is a wire field (ToolUseBlock.subConvId): spawn_agent runs in the
  // main-hosted engine, so the card holds an ID and nothing else. The session
  // itself is rendered by components/subagent/SubAgentSessionView — the same
  // chat/TranscriptView the main conversation uses — so the card only hands the
  // ID up; it deliberately reads no transcript of its own. That is what the
  // hand-rolled preview Modal here used to do (a second, worse message
  // renderer), and it never could go deeper than one level: a sub-conversation
  // is read back from the DB without the wire fields, so a nested spawn card
  // has no subConvId to offer.
  const subConvId = block.subConvId
  const canOpenSession = block.name === 'spawn_agent' && !!subConvId && !!onOpenSubAgent

  return (
    <div style={{ margin: '4px 0' }}>
      {/* Collapsible header bar */}
      <div
        data-tool-head={block.id}
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          background: needsAction ? 'var(--pm-warn-bg)' : 'var(--pm-fill)',
          borderRadius: 6,
          cursor: 'pointer',
          fontSize: 13,
          color: 'var(--pm-text-body)',
          userSelect: 'none',
          border: needsAction ? '1px solid var(--pm-warn-border)' : '1px solid transparent',
          transition: 'background 0.15s'
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = needsAction ? 'var(--pm-warn-bg-hover)' : 'var(--pm-fill-hover)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = needsAction ? 'var(--pm-warn-bg)' : 'var(--pm-fill)' }}
      >
        {/* Status indicator. Glyph ladder (user 2026-09-30): hourglass = not
            yet executing ('pending' — generating or held — and 'queued'),
            spinner = actually executing, check/close = settled. The pair is
            the terminal family's own status
            palette (#4ec9b0 / #f44747, CommandCard's skin) and stays literal on
            purpose — that family is dark in both modes and is not part of the
            theme migration; both values already read on a light or dark fill. */}
        <span
          style={{
            fontSize: 14,
            flexShrink: 0,
            width: 18,
            textAlign: 'center',
            animation: settleFx === 'pop' ? POP_ANIM : settleFx === 'shake' ? SHAKE_ANIM : undefined
          }}
        >
          {block.status === undefined && completedFromResult ? <CheckOutlined style={{color:'#4ec9b0'}} /> : block.status === undefined ? <ArrowDownOutlined style={{color:'var(--pm-text-muted)'}} /> : block.status === 'running' ? <LoadingOutlined spin /> : block.status === 'completed' ? (block.exitCode === 0 ? <CheckOutlined style={{color:'#4ec9b0'}} /> : <CloseOutlined style={{color:'#f44747'}} />) : block.status === 'rejected' ? <CloseOutlined style={{color:'#f44747'}} /> : <HourglassOutlined />}
        </span>
        {/* Tool name — the human verb (PLAN-tool-ux T1); the object stays in the summary */}
        <span style={{ fontWeight: 600, color: 'var(--pm-text-strong)', flexShrink: 0, fontSize: 12 }}>{toolDisplayName(block.name, t)}</span>
        {/* Summary */}
        {summary && (
          <span style={{
            color: 'var(--pm-text-muted)',
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
          <span style={{ color: 'var(--pm-warn)', fontSize: 11, flexShrink: 0, fontWeight: 500 }}>
            {t('commandCard.awaitingApproval')}
          </span>
        )}
        {/* Receiving hint for streaming tool blocks */}
        {block.status === undefined && !completedFromResult && (
          <span style={{ color: 'var(--pm-text-muted)', fontSize: 11, flexShrink: 0, fontWeight: 500 }}>
            {receiving ? '指令生成中...' : '执行状态未知'}
          </span>
        )}
        {/* File preview button */}
        {previewableFile && (
          <span
            onClick={(e) => {
              e.stopPropagation()
              openInPreviewPane(previewableFile)
            }}
            style={{ flexShrink: 0, lineHeight: 1, cursor: 'pointer' }}
          >
            <EyeOutlined style={{ color: 'var(--pm-text-quiet)', fontSize: 14 }} title="预览文件" />
          </span>
        )}
        {/* Sub-agent session link — hands the ID to the host, which opens the
            one session view. Never a second transcript renderer here. */}
        {canOpenSession && (
          <span
            data-open-subagent={subConvId}
            onClick={(e) => {
              e.stopPropagation()
              onOpenSubAgent!(subConvId!, subAgentSessionTitle(block))
            }}
            style={{ flexShrink: 0, lineHeight: 1, cursor: 'pointer' }}
          >
            <EyeOutlined style={{ color: 'var(--pm-text-quiet)', fontSize: 14 }} title="查看子代理会话" />
          </span>
        )}
        {/* Expand/collapse icon */}
        <span style={{ color: 'var(--pm-text-faint)', fontSize: 11, flexShrink: 0 }}>
          {collapsed ? <RightOutlined /> : <DownOutlined />}
        </span>
      </div>

      {/* The decision, below the collapsed header: 运行/跳过 for a held call without
          opening the card (which is where they otherwise live, one layer down).
          While the card is open it carries them itself, so the two never stack. */}
      {collapsed && needsAction && onRejectTool && (
        <ApprovalArea
          blocks={[block]}
          onApproveTool={onApproveTool}
          onRejectTool={onRejectTool}
        />
      )}

      {/* Full CommandCard when expanded. A read-only host (the sub-agent session
          view, the expert editor's preview) passes no approve/kill handlers, so
          the card renders without its action buttons. The body grows open
          through CollapseBody (@starting-style, see motion.tsx); closing is the
          plain unmount it always was. */}
      <CollapseBody open={!collapsed}>
        {needsAction && onRejectTool ? (
          <CommandCard
            block={block}
            onApprove={() => onApproveTool(block.id)}
            onReject={() => onRejectTool(block.id)}
            onToolResponse={onRespondToTool}
          />
        ) : (block.status === 'running' || block.backgroundPid != null) && onKillTool ? (
          // A background block carries its own kill: killTool routes
          // backgroundPid blocks through execKill (P0-3), not the foreground
          // scalar — that is why the button survives past 'completed'.
          <CommandCard
            block={block}
            onKill={() => onKillTool(block.id)}
            onToolResponse={onRespondToTool}
          />
        ) : (
          <CommandCard block={block} />
        )}
      </CollapseBody>

    </div>
  )
}

// --- Component ---

/** Which buttons the assistant action row offers. 'viewOnly' is for transcripts
 *  whose messages are not stored: liking and the knowledge entry write message
 *  metadata (and, for the entry, a `raw/favorite_<hash>.md` knowledge file)
 *  keyed by the conversation, so those two have nothing to write to. Copy,
 *  download and the token/time stats work on the message itself. */
export type MessageActions = 'full' | 'viewOnly' | 'none'

export const MessageGroup = React.memo(function MessageGroup({
  msg,
  actions = 'full',
  aboveActions,
  onApproveTool,
  onRejectTool,
  onRespondToTool,
  onKillTool,
  conversationId,
  conversationTitle,
  onOpenSubAgent,
  onExtractRoutine,
  awaitingApproval = true
}: {
  msg: AgentMessage
  actions?: MessageActions
  /** A node rendered between the bubble and the action toolbar — the turn
   *  deliverables card mounts here (2026-09-19), so a turn that ends with text
   *  shows 「本轮产物」 ABOVE its 对话工具条. Optional; a host passing nothing
   *  renders exactly as before. */
  aboveActions?: React.ReactNode
  onApproveTool: (toolUseId: string, alwaysAllow?: boolean) => void
  onRejectTool: (toolUseId: string) => void
  onRespondToTool?: (toolUseId: string, response: string) => void
  onKillTool: (toolUseId: string) => void
  conversationId?: string
  conversationTitle?: string
  /** Open a spawn_agent card's sub-conversation in the host's session view
   *  (`components/subagent/SubAgentSessionView`). Optional: a host with no
   *  drill-in renders the card without the icon, exactly as before. */
  onOpenSubAgent?: (subConvId: string, title: string) => void
  /** 存为日常任务: distill this conversation into a routine draft and open the
   *  routine editor with it. Conversation-scoped, so only the chat's LAST
   *  action row carries it (ChatView's routine-entry gating). Optional: hosts
   *  without the entry — the sub-agent preview, the extension panel's mirror —
   *  render the row without the button, exactly as before. */
  onExtractRoutine?: () => void | Promise<void>
  /** The engine is parked awaiting approval (see CollapsibleToolBlock). */
  awaitingApproval?: boolean
}): React.ReactElement | null {
  const [liked, setLiked] = useState(msg.liked ?? false)
  const [favorited, setFavorited] = useState(msg.favorited ?? false)
  const [copied, setCopied] = useState(false)
  // Pop flags for the glyphs a user action turns "on" (like / favorite / copy).
  // Hydration can mount the message already liked or favorited — the flag, not
  // the state, decides whether the glyph pops, so opening an old conversation
  // doesn't replay a burst of pops; only a click does.
  const [likedPop, setLikedPop] = useState(false)
  const [favoritedPop, setFavoritedPop] = useState(false)
  // One-way knowledge entry (PLAN-settings-restructure P2): the save is not
  // reversible from here — delete only via the Knowledge Center. A visible
  // failure must allow a retry, so the saved state is only flipped after the
  // backend resolves (an in-flight save is latched against double clicks).
  const [savingFavorite, setSavingFavorite] = useState(false)
  const favoriteLatch = useRef({ pending: false, saved: false })
  // 存为日常任务's latch — up with the other hooks, above the early return:
  // a streaming message can gain displayable content mid-flight, and a hook
  // below that gate would change the hook count between renders.
  const [extractingRoutine, setExtractingRoutine] = useState(false)
  const { t } = useTranslation()
  // The markdown theme family is a class, not a variable (theme/mode.ts).
  const mdClass = useMarkdownThemeClass()

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

  // ── Star = one-way entry into the knowledge base ────────────────────────
  // Toasts go through the shared notify outlet: inside the app root it is the
  // App-scoped antd instance; in hosts without an antd App ancestor
  // (sub-agent previews, probes) it falls back to antd's static methods.
  const handleSaveToKnowledge = createKnowledgeSaveAction({
    save: (input) => window.electronAPI.knowledgeWriteFavorite(input),
    // Backend owns the marker; always enqueue even before the panel mounts.
    enqueue: (file) => { if (file.status === 'raw') enqueueCompileForFile(file.id) },
    pending: setSavingFavorite,
    success: () => { setFavorited(true); setFavoritedPop(true); notify.success(t('chatView.favorited')) },
    error: (err) => {
      console.warn('[MessageGroup] Knowledge save failed:', err)
      notify.error(`${t('chatView.error')}: ${err instanceof Error ? err.message : String(err)}`)
    }
  // eslint-disable-next-line react-hooks/refs -- the in-flight click latch handed to the action factory; a latch is not UI state
  }, favoriteLatch.current)

  // 存为日常任务 runs once per click: while the await is in flight the latch
  // keeps the button inert (same contract as the knowledge save above), the
  // spinner standing in for the LLM round-trip. The routine editor is the
  // review surface — this button only distills and jumps.
  const handleExtractRoutine = async (): Promise<void> => {
    if (!onExtractRoutine || extractingRoutine) return
    setExtractingRoutine(true)
    try {
      await onExtractRoutine()
    } finally {
      setExtractingRoutine(false)
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

  // ask_user batch merge (2026-10-06): several asks dispatched in ONE turn all
  // land in this message, and N separate cards bury the guidance. When there
  // are 2+, they render as ONE AskUserBatchCard at the first ask block's
  // position (the map returns null for the rest); a single ask keeps the plain
  // CommandCard.
  const askBlocks = isUser
    ? []
    : (msg.contentBlocks.filter((b) => b.type === 'tool_use' && (b as ToolUseBlock).name === 'ask_user') as ToolUseBlock[])
  const firstAskIdx = askBlocks.length > 1
    ? msg.contentBlocks.findIndex((b) => b.type === 'tool_use' && (b as ToolUseBlock).name === 'ask_user')
    : -1

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
              <div key={i} className={mdClass} style={{ padding: 0, whiteSpace: 'normal' }}>
                {msg.autoSummary && (
                  <div style={{ fontSize: 11, color: 'var(--pm-text-quiet)', marginBottom: 4, fontWeight: 500 }}>
                    {t('autoSummary.label') || 'Auto Summary'}
                  </div>
                )}
                <FileRefChip text={block.text} xmarkdownStyle={flexCol} config={USER_MD_CONFIG} textRenderer={(t) => <XMarkdown content={t} style={flexCol} components={{ code: CodeBlock, img: LocalImage }} config={USER_MD_CONFIG} />} />
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
                    style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--pm-border-soft)' }}
                  />
                </div>
              )
            }
            if (tr.content) {
              return (
                <div key={i} style={{
                  margin: '8px 0',
                  padding: '8px 10px',
                  background: 'var(--pm-well)',
                  borderRadius: 6,
                  border: '1px solid var(--pm-border-soft)',
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
                <div key={i} className={mdClass} style={{ paddingLeft: 12 }}>
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
                if (firstAskIdx >= 0 && i !== firstAskIdx) return null
                return (
                  <div key={i}>
                    {askBlocks.length > 1
                      ? <AskUserBatchCard blocks={askBlocks} onToolResponse={onRespondToTool} />
                      : <CommandCard block={tb} onToolResponse={onRespondToTool} />}
                  </div>
                )
              }
              return (
                <CollapsibleToolBlock
                  key={i}
                  block={tb}
                  receiving={msg.id === 'streaming-exec'}
                  onApproveTool={onApproveTool}
                  onRejectTool={onRejectTool}
                  onKillTool={onKillTool}
                  onRespondToTool={onRespondToTool}
                  onOpenSubAgent={onOpenSubAgent}
                  awaitingApproval={awaitingApproval}
                />
              )
            }
            if (block.type === 'thinking') {
              return <ThinkingBlockView key={i} block={block as ThinkingBlock} />
            }
            if (block.type === 'redacted_thinking') {
              return (
                <div key={i} style={{ margin: '6px 0', borderLeft: '2px solid var(--pm-border-strong)', paddingLeft: 10 }}>
                  <div style={{ color: 'var(--pm-text-quiet)', fontSize: 13, lineHeight: 1.6 }}>
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
      {aboveActions}
      {!isUser && actions !== 'none' && !msg.contentBlocks.every(b => b.type === 'tool_use' && (b as ToolUseBlock).name === 'ask_user') && (
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
            style={{ ...btnBase, color: 'var(--pm-text-faint)' }}
            onClick={handleCopy}
            title={t('chatView.copy')}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--pm-hover)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            {copied ? <CheckOutlined style={{ animation: POP_ANIM }} /> : <CopyOutlined />}
          </button>
          <button
            style={{ ...btnBase, color: 'var(--pm-text-faint)' }}
            onClick={handleDownload}
            title={t('chatView.download')}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--pm-hover)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            <DownloadOutlined />
          </button>
          {actions === 'full' && (
            <>
              <button
                style={{ ...btnBase, color: liked ? 'var(--pm-text-soft)' : 'var(--pm-text-faint)' }}
                onClick={() => {
                  const next = !liked
                  setLiked(next)
                  setLikedPop(true)
                  window.electronAPI.updateMessageMetadata(msg.id, { liked: next })
                }}
                title={t('chatView.like')}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--pm-hover)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                {liked ? <LikeFilled style={likedPop ? { animation: POP_ANIM } : undefined} /> : <LikeOutlined />}
              </button>
              <button
                data-testid="knowledge-save"
                aria-label={favorited ? t('chatView.favorited') : t('chatView.favorite')}
                style={{ ...btnBase, color: favorited ? 'var(--pm-text-soft)' : 'var(--pm-text-faint)', cursor: savingFavorite ? 'wait' : 'pointer', opacity: savingFavorite ? 0.6 : 1 }}
                onClick={() => {
                  // One-way: already saved → nothing to do. While a save is in
                  // flight the action is latched (no double click can issue a
                  // second write). viewOnly/none hosts never reach here.
                  if (favorited || savingFavorite) return
                  void handleSaveToKnowledge({
                    content: assistantText,
                    messageId: msg.id,
                    conversationId,
                    title: conversationTitle,
                    writable: actions === 'full',
                    favorited
                  })
                }}
                title={favorited ? t('chatView.favorited') : t('chatView.favorite')}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--pm-hover)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                {favorited ? <BookFilled style={favoritedPop ? { animation: POP_ANIM } : undefined} /> : <BookOutlined />}
              </button>
              {onExtractRoutine && (
                <button
                  data-testid="routine-extract"
                  aria-label={extractingRoutine ? t('chatView.routineExtracting') : t('chatView.saveAsRoutine')}
                  style={{ ...btnBase, color: 'var(--pm-text-faint)', cursor: extractingRoutine ? 'wait' : 'pointer', opacity: extractingRoutine ? 0.6 : 1 }}
                  onClick={() => { void handleExtractRoutine() }}
                  title={extractingRoutine ? t('chatView.routineExtracting') : t('chatView.saveAsRoutine')}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--pm-hover)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                >
                  {extractingRoutine ? <LoadingOutlined /> : <ScheduleOutlined />}
                </button>
              )}
            </>
          )}

          {(msg.processingMs != null || msg.inputTokens != null || msg.outputTokens != null || msg.promptCacheHitTokens != null) && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 12,
                marginLeft: 6,
                color: 'var(--pm-text-faint)',
                fontSize: 12,
                lineHeight: 1,
                // Durations and token counts align their digit columns across
                // neighboring messages instead of jittering with each render.
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              <span style={{ color: 'var(--pm-separator)' }}>|</span>
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
