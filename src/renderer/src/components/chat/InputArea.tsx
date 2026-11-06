import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dropdown, Tooltip } from 'antd'
import {
  PlusOutlined,
  FolderOutlined,
  FileOutlined,
  DownOutlined,
  CloseOutlined,
  UserOutlined,
  LockOutlined,
  SafetyOutlined,
  ThunderboltOutlined,
  RobotOutlined,
} from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { ContextRing } from './ContextRing'
import type { CompactionEvent } from '../../../../shared/agent-protocol'
import type { SteerOutcome } from '../../types/agent'
import { Composer, useInputHistory, COMPOSER_MAX_WIDTH, ABOVE_CARD_GAP } from './Composer'
import type { ComposerHandle } from './Composer'
import { usePendingMessageStore, type StagedMessage } from '../../stores/pendingMessageStore'
import type { LlmProfile } from '../../types/settings'
import type { ExpertProfile } from '../../../../shared/types/expert'
import type { SandboxApprovalMode } from '../../../../shared/sandbox/policy'
import { DEFAULT_APPROVAL_MODE } from '../../../../shared/sandbox/policy'
import { modelLabel } from '../../../../shared/agent-protocol'
import { fileUrlToPath, mergeAttachments, isImageFile } from '../../utils/quick-attach'
import { notifyFailure } from '../../utils/notify'

/** Approval levels, most restrictive first — the order the dropdown lists them
 *  in. The icons are chosen for distinct silhouettes, not for a family: antd's
 *  safety / safety-certificate pair is two shields that read as one glyph at
 *  14px, so the loosest level uses a bolt (goes straight through) instead. */
const APPROVAL_LEVELS: Array<{ mode: SandboxApprovalMode; icon: React.ReactNode }> = [
  { mode: 'always-ask', icon: <LockOutlined style={{ fontSize: 14 }} /> },
  { mode: 'outside-ask', icon: <SafetyOutlined style={{ fontSize: 14 }} /> },
  { mode: 'auto', icon: <ThunderboltOutlined style={{ fontSize: 14 }} /> },
]

/** 全部允许 (the 'auto' level) drops the approval ladder entirely: tool calls
 *  run unannounced, which is the one setting here that cannot be undone after
 *  the fact. So its icon and its wording are tinted amber — the same role the
 *  待批准 tint plays in the transcript: this is the state to notice, not a
 *  neutral choice. The value is the sheet's `--pm-warn`, which the extension
 *  panel mirrors by hand (it cannot import a TS value) — keep both in step. */
export const UNRESTRICTED_COLOR = 'var(--pm-warn)'

/** The 授权 button's colour: only the unrestricted level is tinted; the rest keep
 *  the muted grey every other text button in the footer uses (which also beats
 *  antd's hover colour, so hovering does not brighten it). The dropdown tints its
 *  own 全部允许 item the same way and leaves the other items on antd's menu colour
 *  — a footer control's grey is not a menu's. */
function approvalButtonColor(mode: SandboxApprovalMode): string {
  return mode === 'auto' ? UNRESTRICTED_COLOR : 'var(--pm-text-secondary)'
}

function InputAreaImpl({
  isRequesting,
  isStreaming,
  isAwaitingApproval,
  isAwaitingInput,
  hasMessages,
  topSlot,
  hidden,
  onSendMessage,
  onSteer,
  onCancel,
  profiles,
  activeProfileId,
  onSelectProfile,
  contextUsed,
  contextLength,
  layout,
  placeholder,
  autoFocus,
  focusToken,
  sendBlocked,
  onSendBlocked,
  sendAccentHue,
  boundExpertId,
  onUnbindExpert,
  approvalMode,
  onChangeApprovalMode,
  profilePinned,
  onResetProfile,
  features,
  lastCompaction,
  staging,
  onAboveCardReserve,
  onCardBand,
  quoteRequest,
  onQuoteConsumed,
}: {
  isRequesting: boolean
  isStreaming: boolean
  isAwaitingApproval: boolean
  isAwaitingInput: boolean
  hasMessages: boolean
  /** Optional strip rendered just above the composer (plan status, etc.).
   *  Absent = nothing rendered — non-chat reuse stays untouched. */
  topSlot?: React.ReactNode
  /** Suppress the whole surface (root goes display:none — the component stays
   *  MOUNTED, so the draft inside survives). The host uses this while it
   *  paints something over this column: the floating Composer is absolute
   *  with zIndex 10, which would otherwise draw ABOVE the host's overlay and
   *  cover its tail (the sub-agent drill-in's streaming cursor). */
  hidden?: boolean
  onSendMessage: (content: string) => void
  /** 流中转向（PLAN-mid-stream-steer M1，B7 方案 A）：streaming 相位下提交
   *  语义改为转向——Enter 承担（antd-x Sender 在 loading 态吞 Enter，但
   *  onKeyDown 会透传进 textarea），提交钮保持停止钮（2026-09-29 单停止按钮
   *  裁定不破）。resolve false = 引擎拒绝（回合恰好收尾/相位已变），文本
   *  回落暂存/发送，不丢字。 */
  onSteer?: (text: string) => Promise<SteerOutcome>
  onCancel: () => void
  profiles?: LlmProfile[]
  activeProfileId?: string
  onSelectProfile?: (profileId: string) => void
  contextUsed?: number
  contextLength?: number
  /** The conversation's last compaction pass — renders the 已压缩 chip in the
   *  footer. Compaction is otherwise invisible, which reads to the user as
   *  "the model suddenly got worse and nothing told me why". */
  lastCompaction?: CompactionEvent | null
  /** Composer layout: 'floating' (default) pins it to the bottom of the view;
   *  'inline' lays it out in place (welcome view's flex column). */
  layout?: 'floating' | 'inline'
  /** Overrides the status-derived placeholder (reuse sites whose input is not
   *  a chat turn, e.g. the expert editor's form filler). */
  placeholder?: string
  /** Focus the composer on mount. Defaults to the chat rule (only while the
   *  conversation is empty); pass false when the view has a form to work in. */
  autoFocus?: boolean
  /** Dims the send button (and drops Enter) while the view's form still owes a
   *  choice — the welcome page's project mode with no project picked. The input
   *  stays usable: the user writes first, picks the project, then sends. */
  sendBlocked?: boolean
  /** Fired when the user tries to send while sendBlocked (button or Enter) —
   *  the host's hook to answer the silent refusal. Forwarded to Composer. */
  onSendBlocked?: () => void
  /** Identity hue of the project the view belongs to: the send button then takes
   *  that project's color (see Composer). Absent for a plain conversation. */
  sendAccentHue?: number
  /** Re-runs the autoFocus rule whenever the value changes. The underlying
   *  Sender only honors autoFocus on mount, so a surface that re-enters the
   *  auto-focus state without remounting — the welcome composer still up while
   *  the chat view is reshown, or a fresh project preselected into the
   *  new-task state — signals through this token instead. */
  focusToken?: string | number
  /** Expert bound to the active conversation (legacy @-summon binding; new
   *  summons delegate via spawn_agent and never bind); shows the chip. */
  boundExpertId?: string
  /** Clear the bound expert (chip ×). */
  onUnbindExpert?: () => void
  /** How tool calls are approved for this conversation — the effective mode,
   *  i.e. the project's policy when the conversation belongs to one. */
  approvalMode?: SandboxApprovalMode
  /** Pick a different level. */
  onChangeApprovalMode?: (mode: SandboxApprovalMode) => void
  /** The active conversation carries its own model choice — the picker then
   *  also offers 跟随默认模型, so the pin is reversible. */
  profilePinned?: boolean
  /** Drop the conversation's own model choice (follow the global default). */
  onResetProfile?: () => void
  /** Feature chrome subset for reuse outside the main chat (e.g. the routine
   *  run workspace). Omit for the full chat; a partial object exposes only the
   *  listed features. */
  features?: {
    attachments?: boolean
    modelPicker?: boolean
    experts?: boolean
    authorization?: boolean
  }
  /** Staged-message queue (暂存区). Absent = feature off and the reuse sites
   *  keep today's behavior: Enter mid-run does nothing (Sender's loading
   *  suppresses the submit) and a send at rest goes straight out. With it,
   *  Enter while a turn runs stages the text above the card instead — it is
   *  auto-sent when the turn completes (controller's drain edge) or sent
   *  immediately from the strip, which stops the running turn first. */
  staging?: {
    /** The conversation this queue is keyed by. */
    convId: string
    /** Stop the running turn (if any) and send this text as a new turn.
     *  Resolves false when the send never left — the row restores in place. */
    onSendNow: (text: string) => Promise<boolean>
  }
  /** Reports how much bottom padding the transcript must reserve for the
   *  above-card slot's PERSISTENT content (topSlot + staged strip), already
   *  including ABOVE_CARD_GAP; 0 when that content is gone. The slot is
   *  absolutely positioned, so without this the last message is painted over
   *  by the strip (user report 2026-11-04: 暂存消息会遮挡底部的最新消息).
   *  Transient overlays (the @-mention popup, the file-drop hint) are
   *  deliberately NOT measured: they come and go while typing/dragging, and
   *  reserving for them would pump the transcript up and down mid-gesture. */
  onAboveCardReserve?: (height: number) => void
  /** Forwards Composer's card-band measurement (root bottom → card top) to the
   *  host's transcript reserve. The band is what the 160px constant used to
   *  stand in for, and the card autosizes (a multi-row draft is ~90px taller),
   *  so the host must reserve the MEASURED value or the newest message slides
   *  under the card — and under the staged strip above it. */
  onCardBand?: (height: number) => void
  /** 「提问」通道（选中文字工具栏，2026-11-06）：宿主把一段选中文字按 token
   *  递进来，Composer 把它写成引用块并交还焦点。token 幂等——同一个对象重传
   *  不重复插入，只有 token 变了才算新的一次请求。 */
  quoteRequest?: { token: number; text: string } | null
  /** 引用请求被吃下之后的回调，宿主在这里把它清成 null。这不是可选项：
   *  「是否已消费」只靠本组件内部的 ref 记，而本组件带 key={conversationId}
   *  会被换会话重建，ref 随之归零——宿主那边残留的旧请求就会被当成新请求
   *  再消费一次，A 会话的引用跑到 B 会话里去（2026-11-06 实测）。请求消费
   *  完就收回，重建后便无物可重放。 */
  onQuoteConsumed?: () => void
}): React.ReactElement {
  // Everything on when the prop is absent (the chat); a reuse site lists only
  // what it exposes.
  const showAttachments = features?.attachments ?? features === undefined
  const showModelPicker = features?.modelPicker ?? features === undefined
  const showExperts = features?.experts ?? features === undefined
  const showAuthorization = (features?.authorization ?? features === undefined) && onChangeApprovalMode !== undefined
  const [inputValue, setInputValue] = useState('')
  /** The composer's textarea, driven by the autoFocus rule below. */
  const composerRef = useRef<ComposerHandle>(null)

  // ── 选中文字引用（2026-11-06）──
  // 工具栏的「提问」不把选中文字塞进草稿：草稿里一段 markdown 引用块既看不出
  // 边界、也删不干净。改成输入框上沿的一枚引用 chip —— 与文件/文件夹引用同一
  // 套形态：悬停读全文，点 × 摘掉，发送时才落成引用块交出去。所以「输入框里
  // 看到什么」和「模型收到什么」分开了，和 [file:…] chip 完全同构。
  // token 幂等：宿主重渲染会原样重传同一个对象，只有 token 变了才算新的一次，
  // 否则同一段引用会被叠进来两遍。
  const consumedQuoteRef = useRef(0)
  const quoteIdRef = useRef(0)
  const [quotes, setQuotes] = useState<Array<{ id: number; text: string }>>([])
  useEffect(() => {
    if (!quoteRequest || quoteRequest.token === consumedQuoteRef.current) return
    consumedQuoteRef.current = quoteRequest.token
    quoteIdRef.current += 1
    const id = quoteIdRef.current
    setQuotes((prev) => [...prev, { id, text: quoteRequest.text }])
    // 吃下就收回：宿主清掉请求后，本组件被 key 换会话重建时无物可重放。
    // 顺序不能反——先记 token 再回调，否则回调引起的重渲染会让守卫失效。
    onQuoteConsumed?.()
    // 焦点交还输入框：用户下一步就是写问题，不该再点一次。
    requestAnimationFrame(() => composerRef.current?.focus())
  }, [quoteRequest, onQuoteConsumed])

  const removeQuote = useCallback((id: number): void => {
    setQuotes((prev) => prev.filter((q) => q.id !== id))
  }, [])

  // The autoFocus rule, made re-runnable: on mount (Sender's own autoFocus
  // covers that, this is idempotent) and again on every focusToken change.
  // No-op while the rule is off (hasMessages / explicit autoFocus={false}).
  const shouldAutoFocus = autoFocus ?? !hasMessages
  useEffect(() => {
    if (shouldAutoFocus) composerRef.current?.focus()
  }, [focusToken, shouldAutoFocus])

  // ── Expert config pack state ──
  // Enabled experts power both the @-selector and the bound-expert chip.
  // Loaded once per mount; the list only changes in the capability center.
  const [experts, setExperts] = useState<ExpertProfile[]>([])
  useEffect(() => {
    window.electronAPI
      .expertList?.()
      .then(setExperts)
      .catch(() => {})
  }, [])
  const summonableExperts = useMemo(() => experts.filter((e) => e.enabled ?? true), [experts])
  const boundExpert = experts.find((e) => e.id === boundExpertId)

  // ── @-mention popup ──
  // Active while the caret-text ends with an @token (@ at word start). Selecting
  // an expert rewrites the token; sending the raw text also works — the
  // controller parses `@<name>` on submit, so the popup is pure assistance.
  const [mentionNavIdx, setMentionNavIdx] = useState(0)
  const mentionPopupRef = useRef<HTMLDivElement | null>(null)
  // The popup is derived from the text, so the token a selection just wrote
  // (`@写作专家 `) would re-arm it — its query exactly matches the inserted
  // name. Selection and Escape park the current text here to keep the popup
  // shut; any further edit produces a different string and re-arms normally.
  const [mentionDismissedValue, setMentionDismissedValue] = useState<string | null>(null)
  const atIdx = inputValue.lastIndexOf('@')
  const mentionActive = showExperts && atIdx >= 0 && (atIdx === 0 || /\s/.test(inputValue[atIdx - 1])) && inputValue !== mentionDismissedValue
  const mentionQuery = mentionActive ? inputValue.slice(atIdx + 1) : ''
  const mentionMatches = useMemo((): ExpertProfile[] => {
    if (!mentionActive) return []
    const q = mentionQuery.trim().toLowerCase()
    return (q ? summonableExperts.filter((e) => e.name.toLowerCase().includes(q) || (e.description || '').toLowerCase().includes(q)) : summonableExperts).slice(
      0,
      8,
    )
  }, [mentionActive, mentionQuery, summonableExperts])

  const handleInputChange = (v: string): void => {
    setInputValue(v)
    setMentionNavIdx(0)
  }

  const selectMention = (expert: ExpertProfile): void => {
    const next = `${inputValue.slice(0, atIdx)}@${expert.name} `
    setInputValue(next)
    setMentionDismissedValue(next)
  }

  // Arrow keys move the highlight, and the popup is a maxHeight+overflow box,
  // so the highlighted row can leave the visible rows. Reveal it by writing the
  // popup's own scrollTop — scrollIntoView is not scoped to the popup and would
  // also drag the chat pane's scroller sitting behind it.
  useEffect(() => {
    const popup = mentionPopupRef.current
    if (!popup || !mentionActive) return
    const item = popup.querySelector<HTMLElement>(`[data-mention-idx="${mentionNavIdx}"]`)
    if (!item) return
    const top = item.offsetTop
    const bottom = top + item.offsetHeight
    if (top < popup.scrollTop) popup.scrollTop = top
    else if (bottom > popup.scrollTop + popup.clientHeight) popup.scrollTop = bottom - popup.clientHeight
  }, [mentionNavIdx, mentionActive, mentionMatches])

  // 一次性草稿通道已退役（2026-11-04 用户裁定）：welcome 的试试 chips 现在
  // 点一下即发送，不再把文字塞进输入框等第二次确认——composerDraftStore 因此
  // 没有生产者，整条通道连同订阅一起删除（留着就是邀请下一个人照旧路回去）。
  const { t } = useTranslation()

  const history = useInputHistory()

  // ── Staged-message queue (暂存区) ──
  // Subscribe only to THIS conversation's slice; the actions are read through
  // getState() inside handlers, so they carry no stale closures and other
  // conversations' queue traffic never re-renders this box.
  const stagedQueue = usePendingMessageStore((s) => (staging ? s.queues[staging.convId] : undefined))
  const stagedCount = staging && stagedQueue ? stagedQueue.length : 0
  const hasStagedStrip = stagedCount > 0 && !!staging
  // The above-card slot's persistent content (caller's topSlot + the staged
  // strip) — see onAboveCardReserve. Height is re-reported on every resize
  // (rows staged/removed, plan strip appearing, width-driven reflow).
  const aboveCardReserveRef = useRef<HTMLDivElement | null>(null)
  const hasPersistentAboveCard = !!topSlot || hasStagedStrip
  useEffect(() => {
    if (!onAboveCardReserve) return
    const node = aboveCardReserveRef.current
    if (!node) {
      // Persistent content unmounted (strip emptied, plan strip gone): release
      // the reserve this slot was holding.
      onAboveCardReserve(0)
      return
    }
    const report = () => onAboveCardReserve(node.offsetHeight + ABOVE_CARD_GAP)
    report()
    const ro = new ResizeObserver(report)
    ro.observe(node)
    return () => {
      ro.disconnect()
      // Component itself unmounts with the reserve pinned — the next mount
      // reports its own height, but the host must not keep a stale number.
      onAboveCardReserve(0)
    }
  }, [onAboveCardReserve, hasPersistentAboveCard])

  const isInputDisabled = isAwaitingApproval || isAwaitingInput

  const activeProfile = profiles?.find((p) => p.id === activeProfileId)
  // Through the shared helper (the extension panel's 模型下拉 uses it too): one
  // function decides how a profile is labelled, so the two surfaces cannot
  // drift. The placeholder is for "no profile at all", not for "a profile with
  // an empty name" — the helper falls back to provider:model for that.
  const activeModelLabel = activeProfile ? modelLabel(activeProfile) : t('chatView.selectModel')

  // 授权 button: the conversation's level drives the icon, the label and the
  // tooltip; the label repeats in the dropdown next to the same icon. An absent
  // level is the shared default (按需确认), resolved the way the engine resolves
  // it — never a hardcoded 'auto', or a fresh conversation would read as
  // unrestricted while its calls are actually held.
  const approvalLabel = approvalMode ?? DEFAULT_APPROVAL_MODE
  const approvalHint = t('chatView.approval.tooltip', { level: t(`chatView.approval.${approvalLabel}`) })

  // 已压缩 chip: last compaction pass of this conversation. 已生效 (request)
  // vs 下次请求生效 (post-turn prewarm / manual) — the drop rides the next
  // request build in both non-request sources, so the ring's projected
  // drop and the copy the model sees agree with what the label claims.
  const compactionFreedK = lastCompaction ? (Math.max(0, lastCompaction.tokensBefore - lastCompaction.tokensAfter) / 1024).toFixed(1) : '0'
  const compactionLabel = !lastCompaction
    ? ''
    : lastCompaction.source === 'request'
      ? t('chatView.compaction.chip', { dropped: lastCompaction.droppedMessages, freed: compactionFreedK })
      : t('chatView.compaction.chipPending', { dropped: lastCompaction.droppedMessages, freed: compactionFreedK })
  // The replay count covers ONLY this pass's dropped region, and
  // collectUserReplays replays at least the head of every dropped user text,
  // so 0 ⇔ the dropped region held no user-typed message at all — the zero
  // branch can truthfully promise the user's words were untouched. Never fold
  // the two wordings into one template: 「0 条用户消息原文保留」 reads as data
  // loss (user report 2026-10-15).
  const compactionHint = lastCompaction
    ? lastCompaction.replayedUserMessages > 0
      ? t('chatView.compaction.tooltip', {
          strategies: lastCompaction.strategies.join(' · '),
          replayed: lastCompaction.replayedUserMessages,
        })
      : t('chatView.compaction.tooltipZeroReplays', {
          strategies: lastCompaction.strategies.join(' · '),
        })
    : ''

  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [selectedFolders, setSelectedFolders] = useState<string[]>([])

  const getFileName = (path: string) => path.replace(/^.*[\\/]/, '')

  /** 引用 chip 的一行摘要：换行与连续空白压成单空格，过长截断——完整内容在
   *  Tooltip 里。多行选中若原样铺开，一条 chip 会长到把输入框挤变形。 */
  const quoteSummary = (text: string): string => {
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat
  }

  /** [file:…] 标记把路径原样拼进 prompt、解析侧把 `]` 当结束符 `|` 当分隔符
   *  （full_20261011 M1-P1-2）——名字里带这两个字符的合法文件名曾让 chip 解析
   *  错位、附件丢失、残余文本混进 prompt。这类路径拒绝附件化并明说；四个
   *  入口（选文件/选文件夹/拖拽/剪贴板）都从这一处过。 */
  const mergeAttachmentsNotified = (prev: string[], paths: string[]): string[] => {
    const unsafe = paths.filter((p) => /\]|\|/.test(p))
    if (unsafe.length > 0) {
      notifyFailure('attach', new Error(unsafe.join(', ')), t('chat.attachNameUnsafe', { names: unsafe.map(getFileName).join(', ') }))
    }
    return mergeAttachments(
      prev,
      paths.filter((p) => !/\]|\|/.test(p)),
    )
  }

  const handlePickFile = async () => {
    const result = await window.electronAPI.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'All Files', extensions: ['*'] }],
    })
    if (!result.canceled && result.filePaths.length > 0) {
      setSelectedFiles((prev) => mergeAttachmentsNotified(prev, result.filePaths))
    }
  }

  const handlePickFolder = async () => {
    const result = await window.electronAPI.showOpenDialog({
      properties: ['openDirectory'],
    })
    if (!result.canceled && result.filePaths.length > 0) {
      setSelectedFolders((prev) => mergeAttachmentsNotified(prev, result.filePaths))
    }
  }

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const removeFolder = (index: number) => {
    setSelectedFolders((prev) => prev.filter((_, i) => i !== index))
  }

  // ── Quick-attach: paste / drag-drop files into the SAME chips the picker
  // buttons fill, so `[file:]` / `[folder:]` routing in buildMessage is the
  // single exit. All three entry points below are gated on showAttachments —
  // the reuse sites (routine run, form assist, tool studio) pass a features
  // object without `attachments` and must keep their paste/drag behaviour.
  /** A file drag is tracked by a DEPTH counter, not a relatedTarget test:
   *  dragenter/dragleave fire once per child crossed, so a bare boolean would
   *  flicker off every time the pointer passes a chip or a button. */
  const dragDepthRef = useRef(0)
  const [dragActive, setDragActive] = useState(false)

  const dragHasFiles = (e: React.DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')

  const readAsDataURL = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })

  /** Stat each path and file it or folder it — a path whose stat fails (it
   *  vanished) is dropped rather than attached blind. De-dup happens inside
   *  each list, so the same path can never produce two chips. */
  const addAttachments = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return
    const stats = await Promise.all(paths.map((p) => window.electronAPI.getFileStat(p)))
    const files: string[] = []
    const folders: string[] = []
    paths.forEach((p, i) => {
      const stat = stats[i]
      if (!stat) return
      if (stat.isDirectory) folders.push(p)
      else files.push(p)
    })
    if (files.length > 0) setSelectedFiles((prev) => mergeAttachmentsNotified(prev, files))
    if (folders.length > 0) setSelectedFolders((prev) => mergeAttachmentsNotified(prev, folders))
  }

  /** Clipboard / drag files → attachments — the same chips the file-picker
   *  buttons fill, for ANY file type: the disk path comes from the preload's
   *  `webUtils.getPathForFile` bridge. Electron 33 removed the runtime
   *  `File.path` (the ambient d.ts still declares one, so that read
   *  typechecks and evaluates `undefined`), which is why the old
   *  `if (file.path)` silently dropped every real pasted/dropped file — the
   *  `.path` fallback below exists only for fixtures/older Electron.
   *  Pathless blobs (a clipboard screenshot, a JS-built File) fall through:
   *  images are saved through `saveBase64Image` into tmp first — that IPC
   *  takes raw base64, so the dataURL prefix goes — non-images are skipped. */
  const addQuickFiles = async (files: File[]): Promise<void> => {
    const paths: string[] = []
    for (const file of files) {
      // `path` is Electron's addition to the DOM File — never in the lib types.
      const resolved = window.electronAPI.getPathForFile(file) || (file as File & { path?: string }).path
      if (resolved) {
        paths.push(resolved)
        continue
      }
      if (!isImageFile(file)) continue
      try {
        const dataUrl = await readAsDataURL(file)
        const saved = await window.electronAPI.saveBase64Image(dataUrl.slice(dataUrl.indexOf(',') + 1))
        if (saved.success && saved.path) paths.push(saved.path)
        else console.log('[quick-attach] saveBase64Image rejected image', saved)
      } catch (err) {
        console.log('[quick-attach] clipboard image save failed', err)
      }
    }
    await addAttachments(paths)
  }

  /** Quick-attach paste: file clipboard content and a bare `file://` URL
   *  become chips; anything else is left alone (the plain-text paste of
   *  today). Sender's non-slot TextArea does NOT preventDefault for us, so
   *  each intercepting branch must — otherwise the text still lands at the
   *  caret next to the chip it was meant to become. */
  const handlePaste = (e: React.ClipboardEvent<HTMLElement>): void => {
    if (!showAttachments) return
    const cd = e.clipboardData
    const files = Array.from(cd?.files ?? [])
    if (files.length > 0) {
      e.preventDefault()
      void addQuickFiles(files)
      return
    }
    const path = fileUrlToPath(cd?.getData('text/plain') ?? '')
    if (path) {
      e.preventDefault()
      void addAttachments([path])
    }
  }

  // File drags only — a text/plain drag (the sidebar's) falls through and the
  // window guard above us ignores it too. dragenter/dragover must ALSO
  // stopPropagation: the window's file-drop guard sits higher in the bubble
  // and would write dropEffect='none' over our 'copy' a moment later, which
  // is what turns the cursor into the forbidden sign mid-drag.
  const handleDragEnter = (e: React.DragEvent): void => {
    if (!showAttachments || !dragHasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current += 1
    setDragActive(true)
  }

  const handleDragOver = (e: React.DragEvent): void => {
    if (!showAttachments || !dragHasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    // A drag can reach this element without a dragenter the counter saw — arm
    // it here so the matching dragleave still balances instead of pinning the
    // highlight on forever.
    if (dragDepthRef.current === 0) dragDepthRef.current = 1
    setDragActive(true)
  }

  const handleDragLeave = (e: React.DragEvent): void => {
    if (!showAttachments || !dragHasFiles(e)) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragActive(false)
  }

  const handleDrop = (e: React.DragEvent): void => {
    if (!showAttachments || !dragHasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current = 0
    setDragActive(false)
    void addQuickFiles(Array.from(e.dataTransfer?.files ?? []))
    // The drop took focus to wherever the pointer came from — hand it straight
    // back so the next keystroke reaches the composer.
    composerRef.current?.focus()
  }

  // Grouped by 供应商 (providerName) when more than one provider is in play —
  // a flat list of model ids no longer says whose they are once a provider
  // carries several models. One provider stays flat: a lone group header is
  // noise. A pinned conversation's reset item rides below every group, only
  // shown while pinned (or it offers to undo nothing).
  const modelItems = (() => {
    const flat = (profiles ?? []).map((p) => ({
      key: p.id,
      label: modelLabel(p),
      provider: p.providerName ?? '',
    }))
    const resetItem = profilePinned && onResetProfile ? [{ key: '__follow_default__', label: t('chatView.model.followDefault'), onClick: onResetProfile }] : []
    const toMenuItem = ({ key, label }: { key: string; label: string }) => ({
      key,
      label,
      onClick: () => onSelectProfile?.(key),
    })
    const providerNames: string[] = []
    for (const item of flat) {
      if (!providerNames.includes(item.provider)) providerNames.push(item.provider)
    }
    if (providerNames.length <= 1) {
      return [...flat.map(toMenuItem), ...resetItem]
    }
    return [
      ...providerNames.map((name) => ({
        key: `provider_group_${name}`,
        label: name,
        type: 'group' as const,
        children: flat.filter((item) => item.provider === name).map(toMenuItem),
      })),
      ...resetItem,
    ]
  })()

  const hasAttachments = selectedFiles.length + selectedFolders.length > 0

  // ── 流中转向（PLAN-mid-stream-steer M1，B7 方案 A）── streaming 相位下提交
  // 语义改为转向。触发面是 Enter 而不是提交钮：antd-x Sender 在 loading 态把
  // 提交钮换成停止钮（2026-09-29 单停止按钮裁定保持），其内部 Enter-submit 有
  // `!loading` 门（Enter 此刻被吞）；但 onKeyDown 的 veto（return false）在
  // Sender 自己的 Enter 路径之前——暂存条分支正是靠它在 loading 态工作的——
  // 转向分支走同一扇门（见 handleComposerKeyDown）。引擎拒绝时文本回落
  // 暂存/发送，不丢字。
  const canSteer = Boolean(onSteer) && isStreaming
  const submitSteer = async (text: string): Promise<void> => {
    const outgoing = buildMessage(text)
    history.push(outgoing)
    const clear = (): void => {
      setInputValue('')
      setSelectedFiles([])
      setSelectedFolders([])
      setQuotes([])
    }
    const outcome = onSteer ? await onSteer(outgoing) : { ok: false as const, reason: 'not_streaming' as const }
    if (outcome?.ok) {
      clear()
      return
    }
    // 竞态回落：按键与引擎调用之间回合恰好收尾（或相位已变）——文本不许丢，
    // 走今天的中途提交路径（暂存条在场进暂存，否则作为新消息发送）。
    if (staging) {
      usePendingMessageStore.getState().stage(staging.convId, outgoing)
      clear()
      return
    }
    onSendMessage(outgoing)
    clear()
  }

  const handleComposerKeyDown = (e: React.KeyboardEvent<Element>): false | void => {
    // @-popup owns the navigation keys while it's open — including Enter, which
    // picks the highlighted expert instead of sending — and the input-history
    // hook must not eat ArrowUp/Down then. IME composition keys (candidate
    // navigation, the Enter that confirms pinyin) belong to the IME, not the
    // popup. Returning false is Sender's own veto contract for "don't submit":
    // preventDefault alone never reaches its internal handler.
    if (mentionActive && mentionMatches.length > 0 && !e.nativeEvent.isComposing) {
      const picked = mentionMatches[mentionNavIdx]
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault()
          setMentionNavIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length)
          return false
        case 'ArrowDown':
          e.preventDefault()
          setMentionNavIdx((i) => (i + 1) % mentionMatches.length)
          return false
        case 'Enter':
          // Shift/modified Enter is a newline or an editor shortcut, not a pick.
          if (picked && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault()
            selectMention(picked)
            return false
          }
          break
        case 'Escape':
          e.preventDefault()
          // Dismiss rather than select — the hatch for an @name typed by hand:
          // the next Enter sends the text instead.
          setMentionDismissedValue(inputValue)
          return false
      }
    }
    // Enter while the loop runs = STAGE (user decision 2026-09-23): the box
    // keeps accepting the next message while the turn owns the transport. The
    // veto (return false) is what makes it fire at all — Sender's Enter path
    // checks our result first, and without it the loading flag would just
    // swallow the key (today's silent no-op). The footer button remains the
    // pause affordance; an empty box falls through and the loading flag
    // suppresses the submit — same no-op as before. IME-confirm Enter belongs
    // to the composition, never to staging.
    if (
      staging &&
      isRequesting &&
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.nativeEvent.isComposing &&
      inputValue.trim()
    ) {
      e.preventDefault()
      const outgoing = buildMessage(inputValue.trim())
      history.push(outgoing)
      usePendingMessageStore.getState().stage(staging.convId, outgoing)
      setInputValue('')
      setSelectedFiles([])
      setSelectedFolders([])
      setQuotes([])
      return false
    }
    // 流中转向（B7 方案 A，PLAN-mid-stream-steer M1）：veto（return false）让
    // 分支在 Sender 自己的 !loading 门之前生效——与暂存分支同一扇门，暂存分支
    // 在前（staging 行为不变）。IME 确认的 Enter 属于输入法，不是转向意图。
    if (canSteer && e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing && inputValue.trim()) {
      e.preventDefault()
      void submitSteer(inputValue.trim())
      return false
    }
    history.onKeyDown(e, inputValue, setInputValue)
  } /** Compose the outgoing message: attachment refs, then the quoted excerpts,
   *  then the typed text. The chips are a UI layer only — what the model gets
   *  is still plain markdown, exactly as if the refs had been typed out. */
  const buildMessage = (text: string): string => {
    const parts = [...selectedFiles.map((p) => `[file:${p}]`), ...selectedFolders.map((p) => `[folder:${p}]`)]
    const refs = parts.join('\n')
    const quoted = quotes
      .map((q) =>
        q.text
          .split('\n')
          .map((line) => (line.trim() ? `> ${line}` : '>'))
          .join('\n'),
      )
      .join('\n\n')
    const head = [refs, quoted].filter(Boolean).join('\n\n')
    return head ? (text ? `${head}\n\n${text}` : head) : text
  }

  /** Send one staged row now. The take IS the commit — the row leaves the
   *  queue before the send — and a send that never left (all-@ text, no API
   *  key) restores it at its original index rather than dropping the message. */
  const sendStagedRow = (item: StagedMessage, index: number): void => {
    if (!staging) return
    const restore = (): void => usePendingMessageStore.getState().restore(staging.convId, item, index)
    void staging.onSendNow(item.text).then((ok) => {
      if (!ok) restore()
    }, restore)
  }

  const sendStagedRowById = (id: string): void => {
    if (!staging) return
    const taken = usePendingMessageStore.getState().takeById(staging.convId, id)
    if (taken) sendStagedRow(taken.item, taken.index)
  }

  /** At rest with rows already staged: the HEAD goes now and the fresh text
   *  joins the back of the queue. Sending the fresh text directly would jump
   *  the queue — the older staged messages would then arrive after it. */
  const sendStagedHead = (): void => {
    if (!staging) return
    const head = usePendingMessageStore.getState().takeHead(staging.convId)
    if (head) sendStagedRow(head, 0)
  }

  const submit = (raw: string): void => {
    const text = raw.trim()
    if (!text && !hasAttachments) return
    const outgoing = buildMessage(text)
    history.push(outgoing)
    const clear = (): void => {
      setInputValue('')
      setSelectedFiles([])
      setSelectedFolders([])
      setQuotes([])
    }
    // Belt: the Sender routes submits through its loading flag, so this branch
    // is unreachable in practice — but a submit during a run must stage, never
    // race the in-flight turn.
    if (staging && isRequesting) {
      usePendingMessageStore.getState().stage(staging.convId, outgoing)
      clear()
      return
    }
    if (staging && stagedCount > 0) {
      usePendingMessageStore.getState().stage(staging.convId, outgoing)
      clear()
      sendStagedHead()
      return
    }
    onSendMessage(outgoing)
    clear()
  }

  return (
    <div
      style={{ position: 'relative', display: hidden ? 'none' : undefined }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Composer
        ref={composerRef}
        value={inputValue}
        onChange={handleInputChange}
        onSubmit={submit}
        onCancel={onCancel}
        isRequesting={isRequesting}
        disabled={isInputDisabled}
        sendBlocked={sendBlocked}
        onSendBlocked={onSendBlocked}
        sendAccentHue={sendAccentHue}
        loading={isRequesting && !isInputDisabled}
        layout={layout}
        onPaste={handlePaste}
        dropActive={dragActive}
        onCardBand={onCardBand}
        autoFocus={autoFocus ?? !hasMessages}
        placeholder={
          placeholder ??
          (isAwaitingApproval
            ? t('chatView.sender.approving')
            : isAwaitingInput
              ? t('chatView.sender.awaitingInput')
              : canSteer
                ? t('chatView.sender.steer')
                : isStreaming
                  ? t('chatView.sender.streaming')
                  : t('chatView.sender.default'))
        }
        aboveCard={
          // The @-mention selector, the staged-message strip and the caller's
          // topSlot (plan strip) float just above the input card. The slot must
          // anchor to the card's own box, not to this wrapper: in the floating
          // layout the composer is absolute and out of flow, which collapses
          // the wrapper to zero height — an anchor there landed on the pane
          // bottom and painted both overlays on top of the input card.
          // Composer.aboveCard owns the correct anchor (see its doc); here the
          // children stack in document order, popup closest to the card.
          //
          // The PERSISTENT group (topSlot + staged strip) sits in its own
          // wrapper because it is what the transcript reserves space for
          // (onAboveCardReserve) — the transient overlays must stay outside it
          // or the reserve would pump on every `@` keystroke / drag.
          (topSlot || hasStagedStrip || (mentionActive && mentionMatches.length > 0) || dragActive) && (
            <>
              {hasPersistentAboveCard && (
                <div ref={aboveCardReserveRef} data-above-card-reserve style={{ display: 'flex', flexDirection: 'column', gap: ABOVE_CARD_GAP }}>
                  {topSlot && <div style={{ display: 'flex', justifyContent: 'center' }}>{topSlot}</div>}
                  {hasStagedStrip && staging && (
                    <div
                      data-staged-strip
                      style={{
                        // The popup's glass recipe — the above-card layer is one
                        // surface family, and a second recipe would drift from it.
                        maxWidth: COMPOSER_MAX_WIDTH,
                        // width:100% is load-bearing: the wrapper above is a flex
                        // COLUMN, and `margin: 0 auto` on a flex item beats
                        // `align-self: stretch` — without an explicit width the
                        // strip shrink-to-fits its rows (measured 245 vs the
                        // card's 952; user report 「还把暂存区宽度缩小了」). Both
                        // must read as the same centred content column.
                        width: '100%',
                        // …and border-box so the 952 cap includes this box's own
                        // 8px paddings + 1px border (content-box measured 970,
                        // overflowing the card's 952 column).
                        boxSizing: 'border-box',
                        // Vertical spacing comes from the wrapper's gap, which is
                        // exactly what the reserve measures; a margin here would
                        // be height the transcript never sees.
                        margin: '0 auto',
                        maxHeight: 200,
                        overflow: 'auto',
                        background: 'var(--pm-elevated)',
                        border: '1px solid var(--pm-border-veil)',
                        borderRadius: 10,
                        boxShadow: 'var(--pm-shadow-pop)',
                        padding: '6px 8px 8px',
                      }}
                    >
                      {/* The hint is per-state on purpose, and the branch key is
                      the drain rule itself (staged-drain.ts
                      ACTIVE_TURN_STATUSES): isRequesting covers
                      streaming/executing/retrying/awaiting_approval and
                      isAwaitingInput the last park — together exactly the
                      statuses whose path to `completed` drains this queue.
                      Keying on isRequesting alone read "won't auto-send" to a
                      user parked on ask_user, and the drain then sent anyway
                      (review0924 M3). At a settled non-completed end (error,
                      pause, loop-limit) it does NOT auto-send — saying "auto-
                      send" there would be a promise the code keeps only
                      sometimes. */}
                      <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', padding: '0 4px 4px' }}>
                        {t(isRequesting || isAwaitingInput ? 'chatView.staged.hintBusy' : 'chatView.staged.hintSettled', { count: stagedCount })}
                      </div>
                      {(stagedQueue ?? []).map((item) => (
                        <div key={item.id} data-staged-item style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 4px' }}>
                          <div
                            title={item.text}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              fontSize: 12,
                              color: 'var(--pm-text-secondary)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {item.text}
                          </div>
                          <Button
                            size="small"
                            type="link"
                            data-staged-sendnow
                            onClick={() => sendStagedRowById(item.id)}
                            style={{ fontSize: 12, height: 'auto', padding: 0, color: 'var(--pm-text-secondary)' }}
                          >
                            {t('chatView.staged.sendNow')}
                          </Button>
                          <Button
                            size="small"
                            type="text"
                            data-staged-remove
                            aria-label={t('chatView.staged.remove')}
                            icon={<CloseOutlined style={{ fontSize: 12 }} />}
                            onClick={() => usePendingMessageStore.getState().remove(staging.convId, item.id)}
                            style={{ color: 'var(--pm-text-muted)' }}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {mentionActive && mentionMatches.length > 0 && (
                <div
                  ref={mentionPopupRef}
                  data-mention-popup
                  style={{
                    // Mirror the visible .ant-sender box (COMPOSER_MAX_WIDTH,
                    // centered): the column is wider, so plain width would let
                    // the selector outgrow the input box it belongs to.
                    // position:relative makes the rows' offsetTop popup-relative,
                    // which the keyboard-scroll effect below reads.
                    position: 'relative',
                    maxWidth: COMPOSER_MAX_WIDTH,
                    margin: '0 auto',
                    maxHeight: 264,
                    overflow: 'auto',
                    background: 'var(--pm-elevated)',
                    border: '1px solid var(--pm-border-veil)',
                    borderRadius: 10,
                    boxShadow: 'var(--pm-shadow-pop)',
                    padding: 4,
                  }}
                >
                  <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', padding: '4px 8px 2px' }}>{t('chatView.expert.summonTitle')}</div>
                  {/* What a summon will DO, because the two shapes differ: one
                      expert answers in their own words, several become a plan.
                      Without it a second name reads as a second answer rather
                      than a different mode. ABOVE the list on purpose: this box
                      is the scroll container (maxHeight + overflow), so a
                      footnote below eight rows is only reachable by scrolling —
                      the legend has to be there the moment `@` opens it. */}
                  <div style={{ padding: '2px 8px 4px', fontSize: 11, color: 'var(--pm-text-muted)', lineHeight: 1.6 }}>
                    <div>{t('chatView.expert.summonHintOne')}</div>
                    <div>{t('chatView.expert.summonHintMany')}</div>
                  </div>
                  {mentionMatches.map((expert, i) => (
                    <div
                      key={expert.id}
                      data-mention-idx={i}
                      onClick={() => selectMention(expert)}
                      onMouseEnter={() => setMentionNavIdx(i)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 8px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        background: i === mentionNavIdx ? 'var(--pm-hover-weak)' : 'transparent',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{expert.name}</div>
                        {expert.description && (
                          <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {expert.description}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {/* Quick-attach: the LAST child, so it stacks closest to the
                  card — the affordance sits where the files will land. Same
                  glass family as the two overlays above it, dashed like the
                  card's own drag highlight. */}
              {dragActive && (
                <div
                  data-drop-hint
                  style={{
                    maxWidth: COMPOSER_MAX_WIDTH,
                    margin: '8px auto 0',
                    textAlign: 'center',
                    fontSize: 12,
                    color: 'var(--pm-text-secondary)',
                    background: 'var(--pm-elevated)',
                    border: '1px dashed var(--pm-border-veil)',
                    borderRadius: 10,
                    boxShadow: 'var(--pm-shadow-pop)',
                    padding: '6px 10px',
                  }}
                >
                  {t('chatView.sender.dropHint')}
                </div>
              )}
            </>
          )
        }
        header={
          boundExpert || hasAttachments || quotes.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4, padding: '5px 0 0 5px' }}>
              {/* Bound-expert chip: the conversation's summoned expert config pack. */}
              {boundExpert && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    background: 'var(--pm-pill)',
                    border: '1px solid var(--pm-border-veil-weak)',
                    borderRadius: 12,
                    padding: '2px 6px',
                    fontSize: 12,
                    maxWidth: 220,
                  }}
                  title={boundExpert.description || boundExpert.name}
                >
                  <span style={{ fontSize: 13, lineHeight: 1 }}>
                    <UserOutlined style={{ fontSize: 11, color: 'var(--pm-text-secondary)' }} />
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{boundExpert.name}</span>
                  <span
                    onClick={onUnbindExpert}
                    style={{ cursor: 'pointer', color: 'var(--pm-text-muted)', padding: '0 2px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}
                    title={t('chatView.expert.unbind')}
                  >
                    <CloseOutlined style={{ fontSize: 12 }} />
                  </span>
                </span>
              )}
              {selectedFolders.map((fp, i) => (
                <span
                  key={`f-${i}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    background: 'var(--pm-pill-strong)',
                    borderRadius: 12,
                    padding: '2px 6px',
                    fontSize: 12,
                  }}
                >
                  <FolderOutlined style={{ fontSize: 12, color: 'var(--pm-text-secondary)' }} />
                  <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>
                    {getFileName(fp)}
                  </span>
                  <span
                    onClick={() => removeFolder(i)}
                    style={{ cursor: 'pointer', color: 'var(--pm-text-muted)', padding: '0 2px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}
                  >
                    <CloseOutlined style={{ fontSize: 12 }} />
                  </span>
                </span>
              ))}
              {selectedFiles.map((fp, i) => (
                <span
                  key={`fi-${i}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    background: 'var(--pm-pill-strong)',
                    borderRadius: 12,
                    padding: '2px 6px',
                    fontSize: 12,
                  }}
                >
                  <FileOutlined style={{ fontSize: 12, color: 'var(--pm-text-secondary)' }} />
                  <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>
                    {getFileName(fp)}
                  </span>
                  <span
                    onClick={() => removeFile(i)}
                    style={{ cursor: 'pointer', color: 'var(--pm-text-muted)', padding: '0 2px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}
                  >
                    <CloseOutlined style={{ fontSize: 12 }} />
                  </span>
                </span>
              ))}
              {/* 选中文字引用：与文件引用同一排、同一套形态。落在这排末尾，
                  因为它是「关于对话本身」的上下文，和附加的文件是两回事——
                  悬停读全文，点 × 摘掉；发送时才在 buildMessage 里落成
                  markdown 引用块。 */}
              {quotes.map((q) => (
                <Tooltip
                  key={`q-${q.id}`}
                  title={
                    <div style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto', fontSize: 12, lineHeight: 1.55 }}>
                      {q.text}
                    </div>
                  }
                >
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 3,
                      background: 'var(--pm-pill-strong)',
                      borderRadius: 12,
                      padding: '2px 6px',
                      fontSize: 12,
                      maxWidth: 240,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'Georgia, "Times New Roman", serif',
                        fontSize: 15,
                        lineHeight: 1,
                        color: 'var(--pm-text-secondary)',
                        flexShrink: 0,
                      }}
                    >
                      &rdquo;
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: 170 }}>
                      {quoteSummary(q.text)}
                    </span>
                    <span
                      onClick={() => removeQuote(q.id)}
                      style={{ cursor: 'pointer', color: 'var(--pm-text-muted)', padding: '0 2px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}
                      title={t('chatView.selectionToolbar.removeQuote')}
                    >
                      <CloseOutlined style={{ fontSize: 12 }} />
                    </span>
                  </span>
                </Tooltip>
              ))}
            </div>
          ) : undefined
        }
        footerLeft={
          <>
            {showAttachments && (
              <>
                <Button
                  size="small"
                  type="text"
                  icon={<PlusOutlined style={{ fontSize: 14 }} />}
                  onClick={handlePickFile}
                  style={{ fontSize: 12, color: 'var(--pm-text-secondary)' }}
                />
                <Button
                  size="small"
                  type="text"
                  icon={<FolderOutlined style={{ fontSize: 14 }} />}
                  onClick={handlePickFolder}
                  style={{ fontSize: 12, color: 'var(--pm-text-secondary)' }}
                />
              </>
            )}
            {showAuthorization && (
              <Dropdown
                trigger={['click']}
                // selectable + selectedKeys is what marks the active level; the
                // level itself is the item key.
                menu={{
                  items: APPROVAL_LEVELS.map(({ mode, icon }) => ({
                    key: mode,
                    icon,
                    label: t(`chatView.approval.${mode}`),
                    // Tinted on the item, so icon and label inherit one colour in
                    // the open list — 全部允许 is recognisable before it is picked,
                    // not only once it is in force. The other two keep antd's menu
                    // colour: the tint marks one level, it is not a menu theme.
                    style: mode === 'auto' ? { color: UNRESTRICTED_COLOR } : undefined,
                  })),
                  selectable: true,
                  selectedKeys: [approvalLabel],
                  onClick: ({ key }) => onChangeApprovalMode?.(key as SandboxApprovalMode),
                }}
              >
                <Button
                  size="small"
                  type="text"
                  className="pm-chat-approval"
                  icon={APPROVAL_LEVELS.find((l) => l.mode === approvalLabel)?.icon}
                  title={approvalHint}
                  aria-label={approvalHint}
                  style={{ fontSize: 12, color: approvalButtonColor(approvalLabel) }}
                >
                  {/* The level icon stays at every width — it is the compact
                      form: Composer's container query (pm-collapse-compact)
                      hides the label and caret once the card narrows past its
                      breakpoint, leaving an icon-only button whose colour (the
                      全部允许 amber) and tooltip still name the level. */}
                  <span className="pm-collapse-compact">{t(`chatView.approval.${approvalLabel}`)}</span>
                  <DownOutlined className="pm-collapse-compact" style={{ fontSize: 10, color: 'var(--pm-text-faint)', marginLeft: 4 }} />
                </Button>
              </Dropdown>
            )}
          </>
        }
        trailing={
          <>
            {/* Right cluster order: compaction chip, context ring, model picker, send button. */}
            {hasMessages && !!lastCompaction && (
              <Tooltip title={compactionHint}>
                {/* pm-collapse-chip: Composer's first responsive stage — the
                    chip is the row's widest piece (~200px pending) and purely
                    informational, so it hides below the 700px container width
                    while every control keeps its label; this tooltip still
                    carries the full accounting. */}
                <span className="pm-collapse-chip" style={{ fontSize: 12, color: 'var(--pm-text-faint)', whiteSpace: 'nowrap' }}>
                  {compactionLabel}
                </span>
              </Tooltip>
            )}
            {hasMessages && contextLength != null && contextLength > 0 && (
              <span style={{ display: 'flex', alignItems: 'center', lineHeight: 0 }}>
                <ContextRing used={contextUsed ?? 0} total={contextLength} diameter={16} />
              </span>
            )}
            {showModelPicker && (
              <Dropdown
                trigger={['click']}
                // selectable + selectedKeys，与上面的授权下拉同一套机制：打开的
                // 列表标出下一条消息真正会用的模型（activeProfileId 就是
                // effectiveProfileId 的解析结果——pin > column > 上次使用 >
                // 默认），当前位置先于第一次点击可见。跟随默认项是动作不是
                // 状态，永远不落选中。
                menu={{
                  items: modelItems,
                  selectable: true,
                  selectedKeys: activeProfileId ? [activeProfileId] : [],
                }}
              >
                <Button
                  size="small"
                  type="text"
                  className="pm-chat-model"
                  title={activeModelLabel}
                  aria-label={activeModelLabel}
                  style={{ fontSize: 12, color: 'var(--pm-text-secondary)' }}
                >
                  {/* Two width guards on the label: the 160px ellipsis cap keeps
                      an unusually long model name from overflowing the row even
                      above the collapse breakpoint (the full name rides the
                      tooltip), and past the breakpoint the container query hides
                      it with the caret — the robot glyph (pm-collapse-only)
                      becomes the picker: a bare down-caret would not say
                      "model". antd 6 owns the inter-item spacing (gap on the
                      button root), so the margins here are only the ones the
                      old markup measured: none. */}
                  <span
                    className="pm-collapse-compact"
                    style={{ maxWidth: 160, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {activeModelLabel}
                  </span>
                  <DownOutlined className="pm-collapse-compact" style={{ fontSize: 10, color: 'var(--pm-text-faint)' }} />
                  <RobotOutlined className="pm-collapse-only" style={{ fontSize: 14 }} />
                </Button>
              </Dropdown>
            )}
          </>
        }
        onKeyDown={handleComposerKeyDown}
      />
    </div>
  )
}

// 流式期 ChatView 每 tick 重渲染，输入框（1000+ 行的 antd 树）没有必要跟一次：
// memo 生效的前提是宿主侧所有 props 引用稳定 —— ChatView 的 staging/planStrip/
// 发送包装与 App 的三个 change* 回调都已 useCallback/useMemo（2026-09-29 perf）。
export const InputArea = React.memo(InputAreaImpl)
