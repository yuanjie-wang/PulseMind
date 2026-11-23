import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dropdown, Popover, Tooltip } from 'antd'
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
  AudioOutlined,
  LoadingOutlined,
} from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { ContextRing } from './ContextRing'
import type { CompactionEvent } from '../../../../shared/agent-protocol'
import type { CacheHitRate } from '../../../../shared/agent-session/cache-hit-rate'
import type { SteerOutcome } from '../../types/agent'
import { Composer, useInputHistory, COMPOSER_MAX_WIDTH, ABOVE_CARD_GAP, clampComposerInput } from './Composer'
import type { ComposerHandle } from './Composer'
import { useVoiceInput } from './useVoiceInput'
import { VoiceWaveform } from './VoiceWaveform'
import { VoiceGuideCard } from '../settings/VoiceGuideCard'
import { usePendingMessageStore, type StagedMessage } from '../../stores/pendingMessageStore'
import type { LlmProfile } from '../../types/settings'
import type { ExpertProfile } from '../../../../shared/types/expert'
import type { SandboxApprovalMode } from '../../../../shared/sandbox/policy'
import { DEFAULT_APPROVAL_MODE } from '../../../../shared/sandbox/policy'
import { modelLabel } from '../../../../shared/agent-protocol'
import { voiceShortcutLabel } from '../../utils/shortcut-display'
import { fileUrlToPath, mergeAttachments, isImageFile } from '../../utils/quick-attach'
import { normalizePathInput } from '../../../../shared/path-input'
import { notifyFailure } from '../../utils/notify'
import { CHAT_COMMANDS } from '../../agent/chat-commands'
import { GitBranchButton } from './GitBranchButton'

/** 一次提交的应答：只回答「这条输入有没有被收下」。故意不 import hook 里的
 *  SendResult —— 组件层不该反向依赖 useChatController，结构兼容即可（它的
 *  两个分支都满足 { ok: boolean }）。 */
export type SendAck = { ok: boolean }

/** true = 这条输入已被收下，草稿可以清。`void`（FormAssistColumn 这类宿主没有
 *  reasonCode 可言）视为「宿主管不着」，维持旧行为：调用即视为拿走；只有显式
 *  `{ ok: false }` 才把草稿留在输入框里。 */
const didSend = (ack: void | SendAck): boolean => ack == null || ack.ok

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

/** The composer's trigger popup: `/` commands, `@` experts, `$` skills — one
 *  list, sectioned in this fixed order; the typed trigger only decides which
 *  section the list opens on. */
type TriggerKind = 'command' | 'expert' | 'skill'
type TriggerRow = { key: string; title: string; description?: string; select: () => void }
type TriggerSection = { kind: TriggerKind; rows: TriggerRow[] }
const TRIGGER_SECTION_ORDER: TriggerKind[] = ['command', 'expert', 'skill']

/** The 授权 button's colour: only the unrestricted level is tinted; the rest keep
 *  the muted grey every other text button in the footer uses (which also beats
 *  antd's hover colour, so hovering does not brighten it). The dropdown tints its
 *  own 全部允许 item the same way and leaves the other items on antd's menu colour
 *  — a footer control's grey is not a menu's. */
function approvalButtonColor(mode: SandboxApprovalMode): string {
  return mode === 'auto' ? UNRESTRICTED_COLOR : 'var(--pm-text-secondary)'
}

/** 录音计时：只在 recording 态挂载，秒数 tick 在它自己身上。
 *  单独成组件是关键——秒数若放进 InputAreaImpl 的 state，每秒一次 setState 会把
 *  整棵 1690 行的树重渲一遍（user 2026-11-22 反馈分段识别时按钮抖动）。
 *  固定宽度 + tabular-nums：读数每秒在变，按钮宽度一秒都不变。 */
const VoiceElapsed = React.memo(function VoiceElapsed(): React.ReactElement {
  const [sec, setSec] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setSec((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <span
      style={{
        marginLeft: 6,
        minWidth: 32,
        display: 'inline-block',
        textAlign: 'right',
        fontSize: 12,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {Math.floor(sec / 60)}:{String(sec % 60).padStart(2, '0')}
    </span>
  )
})

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
  inputBudget,
  cacheHit,
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
  gitProjectId,
  workspaceDir,
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
  /** 返回 `{ ok: false }` = 这次提交没被收下，草稿（文本+附件+引用）留在输入框，
   *  不再像从前那样无条件 clear。返回 `void` 的宿主按旧语义处理。 */
  onSendMessage: (content: string) => void | Promise<SendAck>
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
  /** 环上的输入预算刻度位置（总窗口扣掉输出预留），由宿主用
   *  `effectiveInputWindow` 算好传入。可选：拿不到模型 maxTokens 的宿主不传，
   *  环只画填充、不画刻度线 —— 宁缺，不画一根与引擎不符的线。 */
  inputBudget?: number
  /** The session's prompt-cache hit rate, priced over the whole history — the
   *  context ring's tooltip carries it beside the fill percentage. Optional on
   *  purpose: a caller with no history (welcome view) omits it, and the ring
   *  then shows only the fill line. */
  cacheHit?: CacheHitRate
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
  /** Git branch picker. `gitProjectId` is the project binding — the picker
   *  resolves the project's own directory from it and stays hidden for plain
   *  conversations. `workspaceDir` is the fallback cwd when the project list
   *  has not loaded yet. */
  gitProjectId?: string
  workspaceDir?: string
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
    /** Git 分支按钮。只有宿主传了 gitProjectId（绑定项目的会话）才显示；
     *  复用宿主不传 features 时默认开，但仍需 gitProjectId 才落地。 */
    gitBranch?: boolean
    /** `$`-skill mention popup. Full chat only — the reuse sites' sends bypass
     *  useChatController, where the $ tokens are resolved. */
    skills?: boolean
    /** `/`-command popup (init/compact). Same rule: commands execute in
     *  useChatController's send path. */
    commands?: boolean
    /** 语音输入麦克风按钮（PLAN-voice-input M1）。缺省只在完整聊天形态出现：
     *  传了 features 对象的复用宿主（routine run / form assist / tool studio）
     *  不带它就维持原样，要开得显式 voice: true。 */
    voice?: boolean
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
  const showSkills = features?.skills ?? features === undefined
  const showCommands = features?.commands ?? features === undefined
  // Hoisted: the trigger popup's command rows read their descriptions through t.
  const { t } = useTranslation()
  const showAuthorization = (features?.authorization ?? features === undefined) && onChangeApprovalMode !== undefined
  // Only project-bound conversations have a git repo to speak for; the plain
  // timestamped workspace deliberately shows nothing.
  const showGitBranch = (features?.gitBranch ?? features === undefined) && !!gitProjectId
  const showVoice = features?.voice ?? features === undefined
  // 麦克风 hover 提示里的快捷键展示（⌥V mac / Alt+V 其余平台）。
  const voiceShortcut = voiceShortcutLabel()
  const [inputValue, setInputValue] = useState('')
  /** The composer's textarea, driven by the autoFocus rule below. */
  const composerRef = useRef<ComposerHandle>(null)
  // 插入与回滚都要读「当下」的草稿（回调经 hook 的 ref 转发，闭包会旧），镜像一份。
  const inputValueRef = useRef(inputValue)
  inputValueRef.current = inputValue

  /** 取消听写时把草稿整体写回快照。走与插入同一条受控路径（setInputValue），
   *  光标落到末尾——用户按 Esc 的预期是「当这次没发生」，不该留下半截文字。 */
  const writeVoiceDraft = useCallback((text: string): void => {
    const next = clampComposerInput(text)
    setInputValue(next)
    requestAnimationFrame(() => {
      const el = composerRef.current?.nativeElement?.querySelector('textarea') as HTMLTextAreaElement | null
      if (el) {
        el.focus()
        const caret = Math.min(next.length, el.value.length)
        el.setSelectionRange(caret, caret)
      }
    })
  }, [])

  // ── 语音输入（PLAN-voice-input §3.5）──
  // 录音态机与转写走 useVoiceInput；转写结果插回光标处（不自动发送，可编辑）。
  // readDraft/writeDraft 供取消回滚，见 useVoiceInput 的 cancel()。
  const voice = useVoiceInput({ t, readDraft: () => inputValueRef.current, writeDraft: writeVoiceDraft })

  // 语音插入锚点：进入录音那一刻定下插入位置，之后只往后推进。
  // 不能每段都读实时选区——readOnly 只禁编辑、不禁移动选区，而听写中光标是
  // 不显示的（Chromium 对 readonly textarea 不绘制 caret），用户随手点一下
  // 文本中间根本不知道点中了哪，下一段就会插错位置；更糟的是若点成「选中一段」
  // 想复制，slice(0,start)+text+slice(end) 会把选中内容整段替换掉——用户没编辑，
  // 自己写的字却消失了（user 2026-11-22 反馈「光标不显示却能改变位置」）。
  const voiceAnchorRef = useRef<number | null>(null)
  // 点麦克风那一刻的光标位置。必须在 pointerdown 阶段抓：按钮一按下 textarea
  // 就失焦，而失焦后的 selectionStart 读出来是 0——整段语音会被塞到最前面
  // （user 2026-11-23 反馈「分段向前追加」）。null = 点的时候没焦点 → 落到末尾。
  const voiceCaretRef = useRef<number | null>(null)
  useEffect(() => {
    if (voice.state.phase === 'recording') {
      // 只在进入录音的那一刻取一次。transcribing 不清：最后一段还要用它落位。
      if (voiceAnchorRef.current === null) {
        const len = inputValueRef.current.length
        const at = voiceCaretRef.current
        // 点麦克风那一刻的光标决定整段语音的起点；没有焦点就接在末尾
        voiceAnchorRef.current = at === null ? len : Math.min(at, len)
      }
    } else if (voice.state.phase === 'idle') {
      voiceAnchorRef.current = null
      voiceCaretRef.current = null
    }
  }, [voice.state.phase])

  const insertVoiceText = useCallback((text: string): void => {
    const prev = inputValueRef.current
    // 插入点取自冻结锚点，不读实时选区。end 恒等于 start，所以只会插入、
    // 永不替换——听写中选中的文字只用于复制，不会被吃掉。
    const start = Math.min(voiceAnchorRef.current ?? prev.length, prev.length)
    const end = start
    // 只在两侧都是 ASCII 字母数字时补空格（英文词不能粘连）；中文逐段追加本来
    // 就不需要空格——无条件补会把「你好」+「世界」变成「你好 世界」。
    const before = prev.slice(0, start)
    const needsSpace = start > 0 && !/\s$/.test(before) && /[A-Za-z0-9]$/.test(before) && /^[A-Za-z0-9]/.test(text)
    const joiner = needsSpace ? ' ' : ''
    const next = clampComposerInput(`${prev.slice(0, start)}${joiner}${text}${prev.slice(end)}`)
    const caret = Math.min(next.length, start + joiner.length + text.length)
    setInputValue(next)
    // 锚点必须自己往前推。它是我们记的落点，不是 DOM 选区——不推进的话每段都
    // 插在同一处，后说的反而排在前面，整段语音变成倒序
    // （user 2026-11-23 反馈「AAAAAA 第三段 第二段 第一段 AAAAAA」）。
    voiceAnchorRef.current = caret
    // 顺带把真实光标放到插入末尾：听写结束后接着打字才不会落进语音文字中间。
    // 但不去抢焦点（focus 会把焦点从麦克风按钮上夺走），也不覆盖用户已有的选区
    // ——听写中选中文字是为了复制，不能被下一段清掉。
    requestAnimationFrame(() => {
      const el = composerRef.current?.nativeElement?.querySelector('textarea') as HTMLTextAreaElement | null
      if (!el || el.selectionStart !== el.selectionEnd) return
      el.setSelectionRange(caret, caret)
    })
  }, [])
  useEffect(() => {
    voice.onTranscribed(insertVoiceText)
  }, [voice, insertVoiceText])

  // ⌥V（Alt+V）：仅当本输入框持有焦点时拦截——「聚焦输入框即可用」（裁定 #9），
  // 不碰 globalShortcut。同一窗口可能有多个 InputArea 宿主，焦点判据天然消歧。
  useEffect(() => {
    if (!showVoice) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.code !== 'KeyV') return
      const ta = composerRef.current?.nativeElement?.querySelector('textarea')
      if (!ta || document.activeElement !== ta) return
      e.preventDefault()
      // 快捷键路径不走 pointerdown，但此刻焦点就在 textarea 上，直接读即可
      voiceCaretRef.current = typeof ta.selectionStart === 'number' ? ta.selectionStart : null
      if (voice.state.phase === 'idle') voice.start()
      else if (voice.state.phase === 'recording') voice.stop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showVoice, voice])

  // ── 引导卡的消失契约（user 2026-11-20：「没有消失的契机，不导入就一直在」）──
  // 受控 Popover（trigger=[]）不会自己收，「装好模型广播」只是成功路径——
  // 不想导入的用户此前没有任何关闭手段，浮窗就永远挂在麦克风旁边。三个
  // 消失契机：点卡外任意处、Esc、再按一次麦克风（toggle）。受控 open 的
  // antd Popover 不吃 onOpenChange 的外部点击语义（trigger=[] 时根本没有
  // 内部机制），只能自己装 document 监听——pointerdown 走捕获相：先于
  // 卡内按钮的 click，也不受任何 stopPropagation 影响。
  const micBtnRef = useRef<HTMLButtonElement>(null)
  const { dismissGuide: dismissVoiceGuide } = voice
  useEffect(() => {
    if (!voice.state.guideVisible) return
    const onDocPointerDown = (e: PointerEvent): void => {
      const target = e.target
      if (!(target instanceof Node)) return
      // 麦克风本体与卡内（含卡上的按钮/链接）都不算「外面」——点卡内的
      // 导入按钮开文件对话框时卡不能塌。
      if (micBtnRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('.pm-voice-guide')) return
      dismissVoiceGuide()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      dismissVoiceGuide()
    }
    document.addEventListener('pointerdown', onDocPointerDown, true)
    document.addEventListener('keydown', onEsc, true)
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true)
      document.removeEventListener('keydown', onEsc, true)
    }
  }, [voice.state.guideVisible, dismissVoiceGuide])

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

  // ── Skill list ($-popup) ──
  // Loaded once per mount like the experts above: the disk list (built-ins are
  // seeded there too) minus the authoritative 显式关闭名单 — 2026-11-04 缺省开
  // 启裁定, so absence from disabledSkills means enabled.
  const [skills, setSkills] = useState<Array<{ name: string; description: string }>>([])
  useEffect(() => {
    if (!showSkills) return
    Promise.all([window.electronAPI.listImportedSkills(), window.electronAPI.getSkillPreferences()])
      .then(([defs, prefs]) => {
        const disabled = new Set(prefs?.disabledSkills ?? [])
        setSkills(
          defs
            .filter((d) => d.name && !disabled.has(d.name))
            .map((d) => ({ name: d.name, description: d.description ?? '' }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        )
      })
      .catch(() => {})
  }, [showSkills])

  // ── Trigger popup: `/` commands · `@` experts · `$` skills ──
  // ONE list, three sections (用户 2026-11-08: 三类合并为一个列表分类展示，定位
  // 于用户输入的那一类). `/` only arms at the very start of the box and only
  // while the command token is still being typed (no whitespace yet); `@` and
  // `$` arm at a word start, the query running to the end of the text. When
  // several are armed the RIGHTMOST trigger wins — it is the one the caret is
  // in, and it decides which section the list opens on. An empty query lists
  // every section (so a `/` can still pick an expert — each row writes its OWN
  // token); once the user types further, only the triggered section remains,
  // filtered by exact name PREFIX. Selecting writes the token; sending the raw
  // text works too — useChatController resolves `/init` `/compact` `@name`
  // `$name` on submit, so the popup is pure assistance.
  const [mentionNavIdx, setMentionNavIdx] = useState(0)
  const mentionPopupRef = useRef<HTMLDivElement | null>(null)
  // The popup is derived from the text, so the token a selection just wrote
  // (`@写作专家 `) would re-arm it — its query exactly matches the inserted
  // name. Selection and Escape park the current text here to keep the popup
  // shut; any further edit produces a different string and re-arms normally.
  const [mentionDismissedValue, setMentionDismissedValue] = useState<string | null>(null)
  const notDismissed = inputValue !== mentionDismissedValue
  const wordStartIdx = (ch: string): number => {
    const idx = inputValue.lastIndexOf(ch)
    return idx >= 0 && (idx === 0 || /\s/.test(inputValue[idx - 1])) ? idx : -1
  }
  const slashIdx = showCommands && notDismissed && inputValue.startsWith('/') && !/\s/.test(inputValue) ? 0 : -1
  const atIdx = showExperts && notDismissed ? wordStartIdx('@') : -1
  const dollarIdx = showSkills && notDismissed ? wordStartIdx('$') : -1
  const triggerIdx = Math.max(slashIdx, atIdx, dollarIdx)
  const triggerKind: TriggerKind | null =
    triggerIdx < 0 ? null : triggerIdx === atIdx ? 'expert' : triggerIdx === dollarIdx ? 'skill' : 'command'
  const triggerQuery = triggerIdx >= 0 ? inputValue.slice(triggerIdx + 1).trim().toLowerCase() : ''

  /** Insert a mention token in place of the trigger tail and park the result
   *  (so the popup does not re-arm on its own exact match). */
  const insertTriggerToken = (token: string): void => {
    const next = `${inputValue.slice(0, triggerIdx)}${token} `
    setInputValue(next)
    setMentionDismissedValue(next)
  }

  const triggerSections = useMemo((): TriggerSection[] => {
    if (!triggerKind) return []
    const q = triggerQuery
    const byPrefix = (name: string): boolean => name.toLowerCase().startsWith(q)
    // A command only executes at the very start of a message, so its section
    // is offered only when nothing precedes the trigger.
    const atStart = inputValue.slice(0, triggerIdx).trim() === ''
    const rowsOf = (kind: TriggerKind): TriggerRow[] => {
      if (kind === 'command') {
        if (!showCommands || !atStart) return []
        return CHAT_COMMANDS.filter((c) => byPrefix(c.name)).map((c) => ({
          key: `command:${c.name}`,
          title: `/${c.name}`,
          description: t(c.descKey),
          select: () => insertTriggerToken(`/${c.name}`),
        }))
      }
      if (kind === 'expert') {
        if (!showExperts) return []
        return summonableExperts
          .filter((e) => byPrefix(e.name))
          .map((e) => ({ key: `expert:${e.id}`, title: `@${e.name}`, description: e.description || undefined, select: () => insertTriggerToken(`@${e.name}`) }))
      }
      if (!showSkills) return []
      return skills
        .filter((s) => byPrefix(s.name))
        .map((s) => ({ key: `skill:${s.name}`, title: `$${s.name}`, description: s.description || undefined, select: () => insertTriggerToken(`$${s.name}`) }))
    }
    const kinds: TriggerKind[] = q ? [triggerKind] : TRIGGER_SECTION_ORDER
    return kinds.map((kind) => ({ kind, rows: rowsOf(kind) })).filter((s) => s.rows.length > 0)
    // insertTriggerToken closes over inputValue/triggerIdx, both covered by
    // the explicit inputValue dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerKind, triggerQuery, skills, summonableExperts, inputValue, showCommands, showExperts, showSkills, t])
  const triggerRows = useMemo(() => triggerSections.flatMap((s) => s.rows), [triggerSections])
  const popupOpen = triggerRows.length > 0
  // Flat index of the triggered section's first row — where the highlight
  // lands when the list opens. 0 when that section is empty (nothing of the
  // typed kind exists): the list still offers the other sections.
  let triggerFocusIdx = 0
  for (let i = 0, offset = 0; i < triggerSections.length; offset += triggerSections[i].rows.length, i += 1) {
    if (triggerSections[i].kind === triggerKind) {
      triggerFocusIdx = offset
      break
    }
  }

  const handleInputChange = (v: string): void => {
    setInputValue(v)
  }

  // Arrow keys move the highlight, and the popup is a maxHeight+overflow box,
  // so the highlighted row can leave the visible rows. Reveal it by writing the
  // popup's own scrollTop — scrollIntoView is not scoped to the popup and would
  // also drag the chat pane's scroller sitting behind it.
  useEffect(() => {
    const popup = mentionPopupRef.current
    if (!popup || !popupOpen) return
    const item = popup.querySelector<HTMLElement>(`[data-mention-idx="${mentionNavIdx}"]`)
    if (!item) return
    const top = item.offsetTop
    const bottom = top + item.offsetHeight
    if (top < popup.scrollTop) popup.scrollTop = top
    else if (bottom > popup.scrollTop + popup.clientHeight) popup.scrollTop = bottom - popup.clientHeight
  }, [mentionNavIdx, popupOpen, triggerRows])

  // 定位：whenever the trigger, its query or the section layout changes, put
  // the highlight on the triggered section's first row (state adjusted during
  // render — React's pattern for "reset state when an input changes", no
  // effect round trip) and scroll that section's header to the top of the
  // list. The scroll effect is declared AFTER the reveal effect on purpose —
  // effects run in order, so this header placement is the one that sticks for
  // the commit (the reveal of the new highlight is a no-op: the row sits
  // right under its header). popupOpen is part of the key so a list that
  // closes and reopens in the same shape still re-lands.
  const triggerFocusKey = `${popupOpen}|${triggerKind}|${triggerIdx}|${triggerQuery}|${triggerFocusIdx}`
  const [lastTriggerFocusKey, setLastTriggerFocusKey] = useState(triggerFocusKey)
  if (triggerFocusKey !== lastTriggerFocusKey) {
    setLastTriggerFocusKey(triggerFocusKey)
    if (popupOpen) setMentionNavIdx(triggerFocusIdx)
  }
  useEffect(() => {
    if (!popupOpen) return
    const popup = mentionPopupRef.current
    if (!popup) return
    const header = popup.querySelector<HTMLElement>(`[data-trigger-section="${triggerKind}"]`)
    popup.scrollTop = header ? header.offsetTop : 0
    // Keyed on the whole focus key: the trigger, query and section layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerFocusKey])

  // 一次性草稿通道已退役（2026-11-04 用户裁定）：welcome 的试试 chips 现在
  // 点一下即发送，不再把文字塞进输入框等第二次确认——composerDraftStore 因此
  // 没有生产者，整条通道连同订阅一起删除（留着就是邀请下一个人照旧路回去）。

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

  // 已压缩 chip 已退役（user 2026-11-21：压缩信息只在 ContextRing 浮窗里展示，
  // 外层不再占一行宽度）—— lastCompaction 仍透传给 ContextRing，那里出
  // 「压缩策略」结构化行（计数 + pending 分档 + 每策略一行效果描述）。

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
   *  入口（选文件/选文件夹/拖拽/剪贴板）都从这一处过。
   *
   *  `file:` / `local-file:` URI 也在这里落成普通文件系统路径：选择器与拖拽
   *  在部分文件管理器（GNOME/UOS）下给出的是 `file:/home/…` 这种 URI，原样进
   *  chip 就会以 `[file:file:/home/…]` 拼进 prompt，主进程把非绝对拼写当相对
   *  路径挂到 workspace 上 → `<ws>/file:/home/…` 的 ENOENT（2026-11-10 UOS）。 */
  const mergeAttachmentsNotified = (prev: string[], paths: string[]): string[] => {
    const normalized = paths.map((p) => normalizePathInput(p))
    const unsafe = normalized.filter((p) => /\]|\|/.test(p))
    if (unsafe.length > 0) {
      notifyFailure('attach', new Error(unsafe.join(', ')), t('chat.attachNameUnsafe', { names: unsafe.map(getFileName).join(', ') }))
    }
    return mergeAttachments(
      prev,
      normalized.filter((p) => !/\]|\|/.test(p)),
    )
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
   *  each list, so the same path can never produce two chips.
   *
   *  Normalize BEFORE the stat: a `file:` URI must be stat'd at the path it
   *  names, not at the URI spelling (main's FILE_STAT stats the string
   *  verbatim), otherwise the file is silently dropped as "vanished". */
  const addAttachments = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return
    const targets = paths.map((p) => normalizePathInput(p))
    const stats = await Promise.all(targets.map((p) => window.electronAPI.getFileStat(p)))
    const files: string[] = []
    const folders: string[] = []
    targets.forEach((p, i) => {
      const stat = stats[i]
      if (!stat) return
      if (stat.isDirectory) folders.push(p)
      else files.push(p)
    })
    if (files.length > 0) setSelectedFiles((prev) => mergeAttachmentsNotified(prev, files))
    if (folders.length > 0) setSelectedFolders((prev) => mergeAttachmentsNotified(prev, folders))
  }

  /** The ONE attachment button. Electron's chooser accepts openFile AND
   *  openDirectory together (RoutineForm's file trigger already relies on it),
   *  so a single dialog can pick both in one pass. addAttachments stats each
   *  returned path and routes it to the file or folder chip — the same exit
   *  paste and drag use. No `filters`: the old "All Files /*" was a no-op
   *  filter and could hide directories on some platforms. */
  const handlePickAttachment = async () => {
    const result = await window.electronAPI.showOpenDialog({
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    })
    if (!result.canceled && result.filePaths.length > 0) {
      await addAttachments(result.filePaths)
    }
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
    // 连最后一道门也没收下：草稿留着，别把刚打的字连同附件一起清掉。
    if (!didSend(await onSendMessage(outgoing))) return
    clear()
  }

  const handleComposerKeyDown = (e: React.KeyboardEvent<Element>): false | void => {
    // The trigger popup owns the navigation keys while it's open — including
    // Enter, which picks the highlighted row instead of sending — and the
    // input-history hook must not eat ArrowUp/Down then. IME composition keys
    // (candidate navigation, the Enter that confirms pinyin) belong to the
    // IME, not the popup. Returning false is Sender's own veto contract for
    // "don't submit": preventDefault alone never reaches its internal handler.
    if (popupOpen && !e.nativeEvent.isComposing) {
      const picked = triggerRows[mentionNavIdx]
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault()
          setMentionNavIdx((i) => (i - 1 + triggerRows.length) % triggerRows.length)
          return false
        case 'ArrowDown':
          e.preventDefault()
          setMentionNavIdx((i) => (i + 1) % triggerRows.length)
          return false
        case 'Tab':
        case 'Enter':
          // Shift/modified Enter is a newline or an editor shortcut, not a pick.
          // A command typed out in full (`/compact` + Enter) is the user
          // sending it, not asking for completion: fall through to submit
          // rather than spending the Enter on inserting what is already there.
          if (
            picked &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey &&
            !(e.key === 'Enter' && triggerKind === 'command' && inputValue.trim() === picked.title)
          ) {
            e.preventDefault()
            picked.select()
            return false
          }
          break
        case 'Escape':
          e.preventDefault()
          // Dismiss rather than select — the hatch for a token typed by hand:
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

  const submit = async (raw: string): Promise<void> => {
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
    // 未收下就保留草稿。这里从前是无条件 clear：一次 bail 就静默吃掉了用户的
    // 消息（只剩一个 toast 陪跑），正是 B3 要根除的那类丢消息。
    if (!didSend(await onSendMessage(outgoing))) return
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
        readOnly={voice.state.phase !== 'idle'}
        sendBlocked={sendBlocked}
        onSendBlocked={onSendBlocked}
        sendAccentHue={sendAccentHue}
        loading={isRequesting && !isInputDisabled}
        layout={layout}
        onPaste={handlePaste}
        dropActive={dragActive}
        voicePhase={voice.state.phase}
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
          (topSlot || hasStagedStrip || popupOpen || dragActive) && (
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
                        {/* A restored head outranks the busy/settled split: it never
                        drains whatever the status is, and the rows behind it do not
                        move either, so "sends when this turn ends" would be a false
                        promise. Judged on the head alone — a restored row further
                        back does not stop the ones ahead of it. */}
                        {t(
                          stagedQueue?.[0]?.restored
                            ? 'chatView.staged.hintRestored'
                            : isRequesting || isAwaitingInput
                              ? 'chatView.staged.hintBusy'
                              : 'chatView.staged.hintSettled',
                          { count: stagedCount },
                        )}
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
              {popupOpen && (
                <div
                  ref={mentionPopupRef}
                  data-mention-popup
                  data-trigger-kind={triggerKind ?? undefined}
                  style={{
                    // Mirror the visible .ant-sender box (COMPOSER_MAX_WIDTH,
                    // centered): the column is wider, so plain width would let
                    // the selector outgrow the input box it belongs to.
                    // position:relative makes the rows' offsetTop popup-relative,
                    // which the keyboard-scroll effect below reads.
                    position: 'relative',
                    maxWidth: COMPOSER_MAX_WIDTH,
                    margin: '0 auto',
                    // Three sections share the box now — a little more room
                    // before it scrolls, still well short of the transcript.
                    maxHeight: 320,
                    overflow: 'auto',
                    background: 'var(--pm-elevated)',
                    border: '1px solid var(--pm-border-veil)',
                    borderRadius: 10,
                    boxShadow: 'var(--pm-shadow-pop)',
                    padding: 4,
                  }}
                >
                  {(() => {
                    // Flat row index across sections: keyboard nav, the
                    // reveal effect and data-mention-idx all address rows by
                    // this one number.
                    let flatIdx = 0
                    return triggerSections.map((section, sectionIdx) => (
                      <React.Fragment key={section.kind}>
                        {/* Section header: title + what a pick of this kind
                            DOES, ABOVE its rows — the 定位 effect scrolls this
                            header to the top, so the legend is in view the
                            moment the trigger opens the list. Experts: one
                            answers in their own words, several become a plan.
                            Skills: pinned for this message only. */}
                        <div
                          data-trigger-section={section.kind}
                          style={{
                            padding: '6px 8px 4px',
                            marginTop: sectionIdx === 0 ? 0 : 4,
                            borderTop: sectionIdx === 0 ? undefined : '1px solid var(--pm-separator-faint)',
                          }}
                        >
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--pm-text-secondary)' }}>
                            {t(
                              section.kind === 'command'
                                ? 'chatView.command.title'
                                : section.kind === 'skill'
                                  ? 'chatView.skill.title'
                                  : 'chatView.expert.summonTitle',
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', lineHeight: 1.6 }}>
                            {section.kind === 'expert' ? (
                              <>
                                <div>{t('chatView.expert.summonHintOne')}</div>
                                <div>{t('chatView.expert.summonHintMany')}</div>
                              </>
                            ) : (
                              <div>{t(section.kind === 'command' ? 'chatView.command.hint' : 'chatView.skill.hint')}</div>
                            )}
                          </div>
                        </div>
                        {section.rows.map((row) => {
                          const i = flatIdx++
                          return (
                            <div
                              key={row.key}
                              data-mention-idx={i}
                              onClick={row.select}
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
                                <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.title}</div>
                                {row.description && (
                                  <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {row.description}
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </React.Fragment>
                    ))
                  })()}
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
              <Button
                size="small"
                type="text"
                icon={<PlusOutlined style={{ fontSize: 14 }} />}
                title={t('chatView.attachFile')}
                aria-label={t('chatView.attachFile')}
                onClick={handlePickAttachment}
                style={{ fontSize: 12, color: 'var(--pm-text-secondary)' }}
              />
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
            {showGitBranch && gitProjectId && (
              <GitBranchButton
                gitProjectId={gitProjectId}
                workspaceDir={workspaceDir}
                isRequesting={isRequesting}
              />
            )}
          </>
        }
        trailing={
          <>
            {/* Right cluster order: context ring (压缩信息只在它的浮窗里 ——
                外层已压缩 chip 已于 2026-11-21 退役), model picker, mic, send button. */}
            {hasMessages && contextLength != null && contextLength > 0 && (
              <span style={{ display: 'flex', alignItems: 'center', lineHeight: 0 }}>
                <ContextRing
                  used={contextUsed ?? 0}
                  total={contextLength}
                  diameter={16}
                  cacheHit={cacheHit}
                  inputBudget={inputBudget}
                  lastCompaction={lastCompaction}
                />
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
            {showVoice && (
              <Popover
                // 引导卡挂在麦克风按钮旁（场景 A：首按无模型）——不是全屏向导。
                // 麦克风在右侧簇（2026-11-20 user：「语音输入按钮放到发送消息的
                // 左侧，模型选择的右侧」），卡片贴按钮右缘向左展开。open 完全
                // 受控：guideVisible 由 hook 置位（无模型首按 / 转写失败）；消失
                // 契约在上方 effect（点外部/Esc/再按麦克风），「装好模型广播」是
                // 唯一成功路径。overlayClassName 是外部点击判定的锚点——受控
                // Popover 的内容挂在 body portal，靠 DOM 位置判内外必须给它命名。
                open={voice.state.guideVisible}
                placement="topRight"
                trigger={[]}
                overlayClassName="pm-voice-guide"
                content={
                  <VoiceGuideCard
                    models={undefined}
                    onChanged={() => voice.dismissGuide()}
                  />
                }
              >
                <Button
                  ref={micBtnRef}
                  size="small"
                  type="text"
                  // hover 提示带触发快捷键（aria-label 不动——图标钮的可访问名
                  // 是探针的定位锚；原生 title 在可访问名计算中被 aria-label 压住）。
                  title={
                    voice.state.phase === 'recording'
                      ? t('voiceInput.micStopTip', { shortcut: voiceShortcut })
                      : voice.state.phase === 'transcribing'
                        ? t('voiceInput.micTranscribing')
                        : t('voiceInput.micStartTip', { shortcut: voiceShortcut })
                  }
                  aria-label={
                    voice.state.phase === 'recording'
                      ? t('voiceInput.micStop')
                      : voice.state.phase === 'transcribing'
                        ? t('voiceInput.micTranscribing')
                        : t('voiceInput.micStart')
                  }
                  icon={
                    voice.state.phase === 'recording'
                      ? (
                        // 停止方块（■）+ 实时声波：波形只表达「正在收音」，读不出
                        // 「再点一次就停」。补一个通用停止符号让这个可供性一眼可见。
                        // 方块与波形尺寸都固定，录音期间按钮宽度恒定（秒数由
                        // VoiceElapsed 定宽自持）；idle→recording 变宽一次，与原先把
                        // 音频图标换成波形同一性质，不是读数抖动。
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span
                            className="pm-voice-stop-square"
                            aria-hidden="true"
                            style={{ width: 10, height: 10, borderRadius: 2, background: 'currentColor', flex: 'none' }}
                          />
                          <VoiceWaveform levelRef={voice.state.levelRef} />
                        </span>
                      )
                      : voice.state.phase === 'transcribing'
                        ? <LoadingOutlined style={{ fontSize: 14 }} spin />
                        : <AudioOutlined style={{ fontSize: 14 }} />
                  }
                  onPointerDown={() => {
                    const ta = composerRef.current?.nativeElement?.querySelector('textarea') as HTMLTextAreaElement | null
                    // pointerdown 先于 blur：此刻 textarea 若还持有焦点，selectionStart
                    // 就是用户看到的那根光标。未聚焦时它是 0，不能当起点用——那就落到末尾。
                    voiceCaretRef.current = ta && document.activeElement === ta ? ta.selectionStart : null
                  }}
                  onClick={() => {
                    if (voice.state.phase === 'recording') voice.stop()
                    // 转写态此前没有退出路径（Esc 只挂在 recording），一旦卡住
                    // 只能等或刷新——补上取消
                    else if (voice.state.phase === 'transcribing') voice.cancel()
                    else if (voice.state.guideVisible) voice.dismissGuide()
                    else if (voice.state.phase === 'idle') voice.start()
                  }}
                  style={{
                    fontSize: 12,
                    // 录音中变红是「停止」的信号色（与发送态同源），不是装饰
                    color: voice.state.phase === 'recording' ? 'var(--pm-error, #cf1322)' : 'var(--pm-text-secondary)'
                  }}
                >
                  {/* 录音期间按钮宽度必须恒定：秒数交给固定宽度的 VoiceElapsed 自计时，
                      读数变、宽度不变（user 2026-11-22 反馈分段识别时按钮抖动）。 */}
                  {voice.state.phase === 'recording' && <VoiceElapsed />}
                  {/* 形态只在用户点停之后才换：spinner + 文案 */}
                  {voice.state.phase === 'transcribing' && (
                    <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--pm-text-secondary)' }}>{t('voiceInput.micTranscribing')}</span>
                  )}
                </Button>
              </Popover>
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
