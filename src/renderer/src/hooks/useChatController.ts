import { useEffect, useRef, useCallback } from 'react'
import { App as AntdApp } from 'antd'
import { useChatManagers } from './useChatManagers'
import { useConversationEngine } from './useConversationEngine'
import { useConversationPersistence } from './useConversationPersistence'
import { takePendingApprovalMode } from '../stores/pendingApprovalStore'
import { takePendingProfileId } from '../stores/pendingProfileStore'
import { useNewTaskStore } from '../stores/newTaskStore'
import { useWorkbenchStore, conversationPrimaryOf } from '../stores/workbenchStore'
import { useNavigationStore } from '../stores/navigationStore'
import { useTranslation } from '../i18n/useTranslation'
import { TitleAgent } from '../agent/one-shot-agent'
import { extractRoutineFromConversation } from '../components/routine/routine-extract'
import { parseExpertMentions, parseKnowledgeBaseMention, parseSkillMentions, type SummonedExpert } from '../../../shared/expert-context'
import { matchChatCommand, commandArgument, buildInitPrompt, INIT_PROJECT_INSTRUCTIONS_GRANT_MS } from '../agent/chat-commands'
import { conversationKeyOf } from '../../../shared/conversation-key'
import { takeStagedHead, restoreStaged, clearStagedMessages, clearAllStagedMessages } from '../stores/pendingMessageStore'
import { shouldDrainOnStatusChange } from '../utils/staged-drain'
import { isPoppedOut } from '../stores/popoutWatchStore'
import type { ExpertProfile } from '../../../shared/types/expert'
import type { LlmAdapter } from '../llm/adapter'
import type { AgentMessage } from '../types/agent'
import type { CompactionEvent } from '../../../shared/agent-protocol'
import type { HooksConfig } from '../types/hooks'
import type { SandboxApprovalMode } from '../../../shared/sandbox/policy'

// ── Options ──

/** Conversation cap without auto-cleanup — the same number the sidebar's
 *  新建任务 gate (AppLayout canCreateNew) and the eviction use; /new honors it. */
const MAX_SESSIONS = 100

interface UseChatControllerOptions {
  apiKey: string | null
  baseURL: string
  model: string
  maxTokens: number
  contextLength?: number
  profileId?: string
  adapter: LlmAdapter
  myName: string
  soul: string
  yourName: string
  workspaceDir?: string
  autoCleanup?: boolean
  /** 设置 → 经验 master switch: gates the old-conversation experience backfill. */
  experienceEnabled?: boolean
  /** 「新建会话沿用上次选择」的全局变量（settings.json 的 last-used 字段）：
   *  welcome 页没选授权/模型时，第一条消息把它们作为新会话自己的初始值落列
   *  —— 在 startLoop 之前，且与 welcome composer 的显示读同一份快照。 */
  lastUsedApprovalMode?: SandboxApprovalMode
  lastUsedProfileId?: string
  /** Single-writer gate (PLAN-conversation-popout): false in the popout
   *  window — it drives turns but the MAIN window owns every transcript
   *  write (adoption + its own sweep). */
  savesEnabled?: boolean
  hooks?: HooksConfig
  locale?: 'zh' | 'en'
}

// ── Hook ──

export function useChatController(options: UseChatControllerOptions) {
  const { apiKey, baseURL, autoCleanup } = options
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()

  // ── 1. Managers ──
  const managers = useChatManagers(options)

  // ── 2. Title generation state (shared by handleRequest + auto-title + background) ──
  const titleGeneratedRef = useRef<Set<string>>(new Set())
  const pendingTitleGenRef = useRef<string | null>(null)
  // 3rd-message refinement latches here in handleRequest and is consumed by
  // the completion effect below — at most one refinement per conversation.
  const titleRefinePendingRef = useRef<Set<string>>(new Set())
  const titleAgentRef = useRef(new TitleAgent())

  // ── 3. Engine (with background-complete callback for title gen) ──
  // Forward ref for generateTitle (breaks circular dep: engine ← persistence ← generateTitle ← onBackgroundComplete)
  const generateTitleRef = useRef<typeof generateTitle>(null as any)
  // Ref bridges: the engine hook is constructed below but needs this callback,
  // and the callback needs the engine's session mirror (same pattern as
  // generateTitleRef — breaks the circular dependency).
  const onBackgroundCompleteRef = useRef<(convId: string) => void>(null as any)
  /** Background-exit orchestration (PLAN-background-tasks C) — declared here,
   *  assigned below the engine hook (the callbacks it needs live lower). */
  const onBackgroundTaskExitRef = useRef<((convId: string, pid: number, code: number | null) => void) | null>(null)
  const engineBridgeRef = useRef<{ getOrCreateEngine: (convId: string) => { messages: AgentMessage[] } } | null>(null)
  const onBackgroundComplete = useCallback((convId: string) => {
    if (pendingTitleGenRef.current !== convId) return
    if (titleGeneratedRef.current.has(convId)) return
    pendingTitleGenRef.current = null
    titleGeneratedRef.current.add(convId)

    generateTitleRef.current(convId, engineBridgeRef.current!.getOrCreateEngine(convId).messages, { llmFallback: '', stripFileMarkers: true })
  }, [])

  const engine = useConversationEngine({
    ...options,
    ...managers,
    platformInfo: managers.platformInfo ?? undefined,
    onBackgroundComplete: (convId: string) => onBackgroundCompleteRef.current(convId),
    onBackgroundTaskExit: (convId: string, pid: number, code: number | null) => onBackgroundTaskExitRef.current?.(convId, pid, code),
    onSkillStateChange: managers.refreshSkills,
  })
  /* eslint-disable react-hooks/refs -- latest-instance mirrors: engineBridge is read by child effects, onBackgroundComplete is invoked from engine callbacks */
  engineBridgeRef.current = engine
  onBackgroundCompleteRef.current = onBackgroundComplete
  /* eslint-enable react-hooks/refs */

  // ── 4. Persistence (save/load conversations) ──
  const persistence = useConversationPersistence({
    autoCleanup,
    savesEnabled: options.savesEnabled,
    messages: engine.messages,
    agentStatus: engine.agentStatus,
    enginesRef: engine.enginesRef,
    activeEngineIdRef: engine.activeEngineIdRef,
    getOrCreateEngine: engine.getOrCreateEngine,
    markConversationRead: engine.markConversationRead,
    setMessages: engine.setMessages,
    setAgentStatus: engine.setAgentStatus,
    setStreamingBlocks: engine.setStreamingBlocks,
    setPlan: engine.setPlan,
    // Popout adoption mirrors (seed without touching React state / engine).
    seedSessionSnapshot: engine.seedSessionSnapshot,
    seedSessionHistory: engine.seedSessionHistory,
    // Mirror eviction (MAX_CACHED_CONVERSATIONS): the engine owns the
    // mechanism, the persistence sweep owns the policy (verified-save gate).
    listEvictionCandidates: engine.listEvictionCandidates,
    evictEngine: engine.evictEngine,
  })

  // ── Shared title generation ────────────────────────────────────────
  const stripFileMarkers = (s: string) => s.replace(/\[(?:file|folder):[^\]]+\]/g, '').trim()
  const generateTitle = useCallback(
    async (
      convId: string,
      messages: { role: string; contentBlocks?: { type: string; text?: string }[] }[],
      opts: { llmFallback: string; stripFileMarkers?: boolean; refine?: boolean },
    ): Promise<void> => {
      // A conversation with a popout attached is titled by ITS window (the
      // popout's own controller runs the same effect); the main window writing
      // over it would race the popout's generation with an LLM call. The
      // popout's own store is empty, so this gate is a no-op there.
      if (isPoppedOut(convId)) return
      // Skip if conversation already has a meaningful title stored
      // (prevents re-triggering title generation after app restart).
      // The 3rd-message refinement passes refine:true — its whole point is to
      // RE-title a conversation that already has the first-message title.
      const existingConv = persistence.conversations.find((c: any) => String(c.key) === convId)
      if (!opts.refine && existingConv?.label && existingConv.label !== '新对话') return

      const firstUser = messages.find((m) => m.role === 'user')
      const raw = firstUser?.contentBlocks?.find((b) => b.type === 'text')?.text || ''
      const doStrip = opts.stripFileMarkers !== false
      const userContent = doStrip ? stripFileMarkers(raw) : raw.trim()
      if (!userContent) return

      const userMsgCount = messages.filter((m) => m.role === 'user').length
      if (userMsgCount < 3 && userContent.length < 6) {
        persistence.updateConversationTitleInList(convId, userContent)
        window.electronAPI.updateConversationTitle(convId, userContent)
        return
      }

      const conversationContext =
        userMsgCount >= 3
          ? messages
              .filter((m) => m.role === 'user')
              .map((m) => {
                const text = m.contentBlocks?.find((b) => b.type === 'text')?.text || ''
                return text ? `User: ${text.slice(0, 300)}` : ''
              })
              .filter(Boolean)
              .join('\n')
              .slice(0, 3000)
          : undefined

      const result = await titleAgentRef.current.execute(
        { userMessage: raw, conversationContext, locale: options.locale },
        {
          llmConfig: { adapter: options.adapter, apiKey: apiKey ?? '', baseURL: options.baseURL, model: options.model, modelMaxTokens: options.maxTokens },
          maxOutputTokens: 4096,
        },
      )
      const fallback = doStrip ? stripFileMarkers(opts.llmFallback) : opts.llmFallback
      const finalTitle = result || fallback
      if (!finalTitle) return
      persistence.updateConversationTitleInList(convId, finalTitle)
      window.electronAPI.updateConversationTitle(convId, finalTitle)
    },
    [apiKey, baseURL, options.adapter, options.model, options.locale, persistence],
  )

  // eslint-disable-next-line react-hooks/refs -- latest-title-generator mirror; callers run after commit
  generateTitleRef.current = generateTitle as any

  // ── 存为日常任务 (the chat toolbar's routine entry) ──────────────────
  // Distills the active conversation into a routine draft with the same agent
  // the editor's own 从对话提取 picker runs, then jumps straight to the editor
  // with it: the editor is the review surface (the schedule above all), so the
  // button only distills. The draft rides the one-shot `routineDraft` view
  // param; nothing is created until the user saves there.
  const extractRoutine = useCallback(async (): Promise<void> => {
    const convId = persistence.activeConversationKey ? String(persistence.activeConversationKey) : ''
    if (!convId) return
    if (!apiKey) {
      message.warning(t('chatView.routineExtractNoKey'))
      return
    }
    try {
      const draft = await extractRoutineFromConversation(
        convId,
        { adapter: options.adapter, apiKey, baseURL: options.baseURL, model: options.model, modelMaxTokens: options.maxTokens },
        options.locale === 'en' ? 'en' : 'zh',
      )
      if (!draft) {
        message.warning(t('chatView.routineExtractEmpty'))
        return
      }
      useNavigationStore.getState().navigate({ kind: 'routines', routineEditing: true, routineDraft: draft })
    } catch (err) {
      console.warn('[ChatController] routine extraction failed:', err)
      message.error(t('chatView.routineExtractFailed'))
    }
  }, [apiKey, options.adapter, options.baseURL, options.model, options.locale, persistence.activeConversationKey, message, t])

  // （PLAN-memory-wiki M2c）启动回填退役：提取统一由主进程定时清扫调度器驱动

  // ── 6. Auto-title generation (active engine) ──
  //
  // Generate title when the active engine first completes, and — once per
  // conversation, when the send that made the 3rd user message completes —
  // re-generate from the full thread (userMsgCount ≥ 3 gives generateTitle
  // its conversationContext). Background-engine titles are handled in the
  // onBackgroundComplete callback above.
  useEffect(() => {
    if (!persistence.activeConversationKey || engine.agentStatus.status !== 'completed') return

    const convId = String(persistence.activeConversationKey)

    // 3rd-message refinement: latched by handleRequest, consumed here on the
    // completing edge. Deleting first makes this once-per-conversation even
    // if the call below fails.
    if (titleRefinePendingRef.current.has(convId)) {
      titleRefinePendingRef.current.delete(convId)
      if (engine.messages.some((m) => m.role === 'assistant')) {
        void generateTitle(convId, engine.messages, { llmFallback: '', refine: true })
      }
    }

    // Skip if title was already generated (first-round succeeded)
    if (titleGeneratedRef.current.has(convId)) return
    if (pendingTitleGenRef.current !== convId) return
    pendingTitleGenRef.current = null

    const hasAssistant = engine.messages.some((m) => m.role === 'assistant')
    if (!hasAssistant) return

    titleGeneratedRef.current.add(convId)

    generateTitle(convId, engine.messages, { llmFallback: '' })
  }, [persistence.activeConversationKey, engine.agentStatus, engine.messages, generateTitle, generateTitleRef])

  // ── 7. handleRequest (send message) ──
  const handleRequest = useCallback(
    async (content: string) => {
      if (!apiKey) {
        console.warn('[ChatController] handleRequest blocked: no API key')
        return false
      }

      let convId = persistence.activeConversationKey ? String(persistence.activeConversationKey) : ''

      // ── /compact [指示词]: explicit compaction, never a message ──
      // Intercepted before materialization: it is a command against the CURRENT
      // conversation (or a no-op with a visible warning when none is open), not
      // the first message of a new one.
      const trimmedContent = content.trim()
      if (trimmedContent === '/compact' || trimmedContent.startsWith('/compact ')) {
        const instruction = trimmedContent.slice('/compact'.length).trim() || undefined
        const target = conversationKeyOf(convId)
        if (!target) {
          message.warning(t('chatView.compaction.noConversation'))
          return false
        }
        const status = engine.agentStatus.status
        if (
          status !== 'idle' &&
          status !== 'completed' &&
          status !== 'error' &&
          status !== 'awaiting_user_input' &&
          status !== 'awaiting_extension' &&
          status !== 'awaiting_continue'
        ) {
          message.warning(t('chatView.compaction.busy'))
          return false
        }
        // A rejected engine call must not vanish down the unhandled-rejection
        // hole (the callers swallow rejections to restore staged text): the
        // command was consumed either way, so report it and stop.
        let event: CompactionEvent | null = null
        try {
          event = await engine.getOrCreateEngine(target).compactNow(instruction)
        } catch (err) {
          console.warn('[ChatController] /compact engine call failed:', err)
          message.error(t('chatView.compaction.failed'))
          return true
        }
        if (event) {
          const freed = Math.max(0, event.tokensBefore - event.tokensAfter)
          message.success(t('chatView.compaction.done', { dropped: event.droppedMessages, freed: `${(freed / 1024).toFixed(1)}K` }))
        } else {
          message.info(t('chatView.compaction.nothing'))
        }
        // true = the command was consumed (nothing to restore): /compact is not
        // a send, so no turn will end for the drain to re-deliver it.
        return true
      }

      // ── /new [text]: a fresh conversation of the SAME kind ──
      // The sidebar's 新建任务「与当前模式相同」 rule from the keyboard: a
      // browser task opens the browser welcome (URL form), a project-bound
      // conversation the project form with that project preselected (the
      // project row's own 新建任务 shape), anything else a plain chat. Nothing
      // is created here — the first message does that (M8.4) — so a bare /new
      // just lands on the welcome form; trailing text is sent as that new
      // conversation's first message through the normal materialization below.
      const newCommand = matchChatCommand(content)
      if (newCommand?.name === 'new') {
        // Secondary windows (conversation popout / project window) are bound
        // to one conversation and never write the list — no place to open a
        // new one in.
        if (options.savesEnabled === false) {
          message.warning(t('chatView.command.newUnavailable'))
          return true
        }
        if (!autoCleanup && persistence.conversations.length >= MAX_SESSIONS) {
          message.warning(t('chatView.command.newLimit', { max: MAX_SESSIONS }))
          return true
        }
        const current = conversationKeyOf(convId)
        const currentProjectId = current
          ? persistence.conversations.find((c) => String(c.key) === current)?.projectId
          : undefined
        const task = useNewTaskStore.getState()
        if (current && conversationPrimaryOf(current) === 'browser') {
          task.setMode('browser')
          task.setProjectId(null)
        } else if (currentProjectId) {
          task.setMode('project')
          task.setProjectId(currentProjectId)
        } else if (current) {
          task.setMode('chat')
          task.setProjectId(null)
        }
        // No conversation open (already on the welcome form): keep the form's
        // current kind — it IS the kind being composed.
        // The user is at the composer already: no guidance shake, and cancel
        // any one still pending so it does not replay on the welcome mount.
        task.requestShake(null)
        await persistence.createNewConversation()
        const firstMessage = commandArgument(content, 'new')
        // true = consumed: a bare /new is not a send.
        if (!firstMessage) return true
        // Fall through as the first message of the conversation about to be
        // materialized (no open conversation any more): the materialization
        // reads the kind just set on the new-task form — project binding,
        // browser primary view + dock — exactly as a welcome-page first send.
        convId = ''
        content = firstMessage
      }

      // ── /init [focus]: rewrite into the init turn, then fall through ──
      // Unlike /compact (a command AGAINST the current conversation, never a
      // message), /init IS a turn: the canned prompt below instructs the agent
      // to survey the workspace and write .pulsemind/AGENTS.md. Rewriting the
      // content here lets the whole normal path proceed untouched —
      // materialization (welcome 首发铸会话), title generation, startLoop.
      // A trailing text after the token rides along as the user's focus hint.
      const initCommand = matchChatCommand(content)
      if (initCommand?.name === 'init') {
        content = buildInitPrompt(commandArgument(content, 'init'))
      }

      // ── @-summon: resolve expert mentions before anything else ──
      // Summoning IS delegation (spawn_agent): the mentioned experts run their
      // parts as sub-agents inside this conversation — the conversation itself
      // never switches identity anymore. One name is the single-expert path
      // (the expert's conclusion is delivered verbatim); several are handed to
      // the engine's plan mode, which plans the work and assigns it. The
      // mentions must resolve against enabled experts, and the @ tokens STAY in
      // the outgoing message (user 2026-10-09: the @ text is message content
      // too — transcript, persistence and the model all read what was typed).
      // The empty-task guard still reads the words BESIDE the mentions
      // (`mentions.task`), so a bare roster with no assignment is no summon.
      let experts: ExpertProfile[] = []
      try {
        experts = await window.electronAPI.expertList()
      } catch {
        /* non-critical */
      }
      const mentions = parseExpertMentions(content, experts)
      const mentioned: SummonedExpert[] = mentions.experts.map((e) => ({ id: e.id, name: e.name }))
      if (mentioned.length > 0 && !mentions.task.trim()) {
        message.warning(t('chatView.expert.needTaskWithSummon'))
        return false
      }

      // ── $技能 (2026-11-08): resolve the $-pinned skills ──
      // Runs AFTER the expert parse and skips its claimed spans (既有语义优先:
      // expert > skill > knowledge base), same positional rule as the base
      // parse below. The $ tokens STAY in the text — mention words are message
      // content (the 2026-10-09 @ ruling applies verbatim). The pinned names
      // ride THIS send only; the next message without a $mention runs
      // unpinned. A bare `$office` with no task is a pin with nothing to apply
      // it to — refused like a bare @-summon.
      const enabledSkillNames = managers.skills.filter((s) => s.enabled).map((s) => s.definition.name)
      const skillMentions = parseSkillMentions(content, enabledSkillNames, mentions.spans)
      const forcedSkills = skillMentions.skills
      if (forcedSkills.length > 0 && !skillMentions.task.trim()) {
        message.warning(t('chatView.skill.needTask'))
        return false
      }

      // ── @知识库 (PLAN-knowledge-groups G5): resolve the base scope ──
      // Runs AFTER the expert parse and skips the @ tokens the expert parse
      // claimed (spans) — the tokens stay in the text now, so the claim order
      // (既有语义优先: a name that is both reads as the expert) is positional.
      // The skill parse's spans join the claimed set (a name claimed as a
      // skill is never a base). The scope rides THIS send only — the next
      // message without an @mention searches everything; a matched base token
      // is the one cut from the text.
      let knowledgeBase: { id: string; name: string } | null = null
      try {
        const bases = await window.electronAPI.knowledgeListBases()
        const parsedBase = parseKnowledgeBaseMention(content, bases, [...mentions.spans, ...skillMentions.spans])
        knowledgeBase = parsedBase.base
        if (knowledgeBase) content = parsedBase.text
      } catch {
        /* bases unavailable — unscoped turn */
      }

      if (!convId) {
        // Materialize the conversation row here. Its working directory comes
        // from the welcome page's task form (M8.4): project mode binds the
        // selected project (main resolves the project workspace); chat mode
        // gets a lazily-created timestamped folder under the global workspace.
        const task = useNewTaskStore.getState()
        if (task.mode === 'project' && !task.projectId) {
          message.warning(t('welcome.selectProjectFirst'))
          return false
        }
        const now = new Date()
        const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
        convId = `conv_${ts}`
        // An explicit "new conversation in project X" leaves a pending binding
        // — it wins over the welcome switcher (M3.6).
        const projectId = persistence.takePendingProjectId() ?? (task.mode === 'project' ? task.projectId! : undefined)
        persistence.addConversation({ key: convId, label: '新对话', updatedAt: now.toISOString(), projectId }, 'prepend')
        if (projectId) void window.electronAPI.setConversationProject?.(convId, projectId)
        // A 授权 level picked on the welcome composer has no row to live on yet;
        // it lands on the conversation this message just created, and the write
        // is issued before startLoop so the session's very first ask already runs
        // at that level (main reads the column in doCreateSession).
        // 「新建会话沿用上次选择」：没选就以上次使用值为初始值 —— 同样在
        // startLoop 之前落成自己的列，乐观列表同步更新，按钮显示与引擎实际
        // 档位永不脱节（main 的 doCreateSession 播种只兜不经过这里的路径）。
        const approvalSeed = takePendingApprovalMode() ?? options.lastUsedApprovalMode
        if (approvalSeed) persistence.updateConversationApproval(convId, approvalSeed)
        // Same carry for a 模型 picked on the welcome composer: the write is
        // issued before startLoop, so the first ask already resolves the
        // conversation's own profile instead of the global default.
        const profileSeed = takePendingProfileId() ?? options.lastUsedProfileId
        if (profileSeed) persistence.updateConversationProfile(convId, profileSeed)
        // 浏览器任务（PLAN-layout-modes 二期「模式跟任务走」）：物化即绑定该
        // 会话的浏览器主视图，并打开 dock——侧栏对话 tab 是浏览器主视图下唯一
        // 的转录面。welcome 的 URL 表单/自由输入都走这条物化路径。
        if (task.mode === 'browser') {
          useWorkbenchStore.getState().setConversationPrimary(convId, 'browser')
          useWorkbenchStore.getState().setOpen(convId, true)
          // 首帧确定性：'workspace'/'plan' 在 browser 侧栏集合里是合法成员、
          // 不会被 reconcile，但刚起步的浏览器任务该落在对话 tab（转录面）。
          useWorkbenchStore.getState().setActiveTab(convId, 'chat')
        }
        engine.activateEngine(convId)
        persistence.activateConversation(convId)
      } else {
        window.electronAPI.touchConversation(convId).catch(() => {})
        persistence.bumpConversation(convId)
      }

      if (import.meta.env.DEV) console.log(`[ChatController] handleRequest: model=${options.model} baseURL=${options.baseURL}`)
      pendingTitleGenRef.current = convId

      // First-message title generation. The /init rewrite above makes
      // `content` the canned English prompt — a terrible llmFallback title —
      // so the command branch pins a human phrase instead.
      if (!titleGeneratedRef.current.has(convId)) {
        const titleFallback = initCommand?.name === 'init' ? t('chatView.command.initTitle') : content.trim()
        generateTitleRef.current(convId, [{ role: 'user', contentBlocks: [{ type: 'text', text: content }] }], { llmFallback: titleFallback })
      }

      // The @-summoned experts ride the same conversation materialization and
      // title generation as a normal send — only the turn's entry point
      // differs: main dispatches the deterministic spawn_agent call (one
      // expert) or plans the work first (several), inside this conversation.
      // 发送即激活的兜底（2026-11-04）：回合是发给主进程的，与视图无关；但
      // 事件进 React 要过 activeEngineIdRef 这道门。发起到「引擎活跃会话 ≠
      // 本条会话」上时，消息发得出去、界面什么都不动——这就是浏览器任务容器
      // 报出的「输入消息无响应」。物化分支与已激活路径在此都是 no-op。
      if (engine.activeEngineIdRef.current !== convId) engine.activateEngine(convId)
      const engineHandle = engine.getOrCreateEngine(convId)
      // The /init write window (user 2026-11-11): open it BEFORE the turn
      // starts, or the first write would still raise an approval card. Scoped
      // to .pulsemind/AGENTS.md and time-bounded — see chat-commands. A grant
      // failure must not block the turn: the protected-path hold is just the
      // old behavior, one approval per write.
      if (initCommand?.name === 'init') {
        try {
          await engineHandle.grantProjectInstructionsWrite(INIT_PROJECT_INSTRUCTIONS_GRANT_MS)
          message.info(t('chatView.command.initGrant', { minutes: INIT_PROJECT_INSTRUCTIONS_GRANT_MS / 60_000 }))
        } catch { /* old per-write approval fallback */ }
      }
      // 3rd-user-message refinement latch: the send that makes the count hit
      // 3 marks the conversation; the completion effect re-titles it from the
      // full thread (the first-message title only ever saw message #1).
      const userMsgCountBefore = engineHandle.messages.filter((m) => m.role === 'user').length
      if (userMsgCountBefore + 1 === 3) titleRefinePendingRef.current.add(convId)
      if (mentioned.length > 0) engineHandle.startSummonedLoop(content, mentioned, knowledgeBase, forcedSkills)
      else engineHandle.startLoop(content, knowledgeBase, forcedSkills)
      // true = the turn left. Every early `return false` above is a bail the
      // caller (the staged-queue drain, the strip's 立即发送) must restore its
      // message for — a silent drop there loses the message with only a toast
      // for company.
      return true
    },
    [
      apiKey,
      persistence.activeConversationKey,
      persistence.addConversation,
      persistence.setActiveConversationKey,
      persistence.updateConversationTitleInList,
      persistence.updateConversationApproval,
      persistence.updateConversationProfile,
      persistence.convIdRef,
      engine.getOrCreateEngine,
      engine.activeEngineIdRef,
      engine.activateEngine,
      engine.agentStatus,
      persistence.conversations,
      persistence.createNewConversation,
      autoCleanup,
      options,
      managers.skills,
      t,
      message,
    ],
  )

  // ── 7.4 浏览器任务容器（PLAN-layout-modes 三期裁定）──
  // welcome 的 URL 表单提交 = 直接开页，不发任何消息（无 LLM 回合）：会话只
  // 是浏览器会话的容器（页签归属、侧栏可见）。乐观列表条目即容器——无消息
  // 则无 DB 行，重启随页签一起消失（同「重启无活面板」裁定）。标题即 URL；
  // auto-title 不参与（没有首条消息可提炼）。
  const createBrowserTask = useCallback(
    (url: string): string => {
      const now = new Date()
      const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
      const convId = `conv_${ts}`
      persistence.addConversation({ key: convId, label: url, updatedAt: now.toISOString() }, 'prepend')
      useWorkbenchStore.getState().setConversationPrimary(convId, 'browser')
      useWorkbenchStore.getState().setOpen(convId, true)
      // 首帧确定性：dock 落对话 tab（浏览器主视图下转录面的唯一出口）。
      useWorkbenchStore.getState().setActiveTab(convId, 'chat')
      // 容器也必须是「引擎活跃会话」（2026-11-04 实锤：浏览器模式下输入消息
      // 无响应）。镜像的 React 同步只认 activeEngineIdRef（useConversationEngine
      // 的事件订阅 `if (activeEngineIdRef.current === sessionId)`）——容器不经
      // 侧栏切换，创建时只激活了 persistence 那一半，于是用户在 dock 里发的
      // 消息：回合照常发出、事件照常进镜像，UI 却一片不动（草稿已被 submit 清
      // 空、转录不更新、没有 spinner），看起来正是「输入无响应」。顺序同物化
      // 分支：先 activateEngine 再 activateConversation。
      engine.activateEngine(convId)
      persistence.activateConversation(convId)
      return convId
    },
    [engine.activateEngine, persistence.addConversation, persistence.activateConversation],
  )

  // ── 7.6 扩展会话移交收养（PLAN-extension-handoff）──
  // CONVERSATION_HANDOFF 到达：换客户端驱动同一个会话——主进程引擎本来就活着，
  // 这里做四件事：乐观列表条目、两半激活（先 engine 后 persistence，与容器同
  // 顺序）、adoptConversation 式镜像收养（引擎活着时零 DB 重放，快照直种）、
  // 标记 state block 的移交告知行。主视图切 browser 档 + 开页签由 App 层在调
  // 用后接手（pane 快照报到后 navigate，与 createBrowserTask 同一等待模式）。
  const adoptHandoffTask = useCallback(
    (convId: string, label: string) => {
      persistence.addConversation({ key: convId, label, updatedAt: new Date().toISOString() }, 'prepend')
      useWorkbenchStore.getState().setConversationPrimary(convId, 'browser')
      useWorkbenchStore.getState().setOpen(convId, true)
      useWorkbenchStore.getState().setActiveTab(convId, 'chat')
      engine.activateEngine(convId)
      persistence.activateConversation(convId)
      void persistence.adoptConversation(convId)
      // 移交告知（M3）：下一回合 state block 出现 ## Handoff 行——提示不是工具
      // 下架（G20 禁 availability 门控）。引擎重铸后 flag 丢失是诚实缺口。
      window.electronAPI.agentSessionEngineCall(convId, 'markExtensionHandoff', []).catch(() => {})
    },
    [engine.activateEngine, persistence.addConversation, persistence.activateConversation, persistence.adoptConversation],
  )

  // ── 7.5 Staged-message drain (暂存区) ──
  // A message staged while the loop ran goes out on its OWN turn's completion
  // edge. The rule — busy → completed of the same conversation; switch-into-
  // completed catches a turn that ended while the view was elsewhere; error /
  // pause / loop-limit ends never drain (user decision 2026-09-23) — lives in
  // utils/staged-drain.ts as a pure function so its edge cases are unit tests;
  // what this effect adds is the transition ref, because the effect runs on
  // mount, on conversation switch and on every notify: a value check
  // (`status === 'completed'`) would drain all of those, i.e. send a message
  // whose turn ended long ago, twice, or into a conversation just opened. The
  // take is atomic (takeStagedHead pops), so even a double-fired pass cannot
  // deliver the same message twice.
  const stagedStatusRef = useRef<{ convId: string | null; status: string } | null>(null)
  useEffect(() => {
    // conversationKeyOf answers string | undefined; the drain contract's
    // observation type is string | null (「无会话」的拼写只有一个).
    const convId = conversationKeyOf(persistence.activeConversationKey) ?? null
    const status = engine.agentStatus.status
    const prev = stagedStatusRef.current
    stagedStatusRef.current = { convId, status }
    if (!convId || !shouldDrainOnStatusChange(prev, { convId, status })) return
    const item = takeStagedHead(convId)
    if (!item) return
    const restore = (): void => restoreStaged(convId, item, 0)
    // A failed send (all-@ text, missing key, …) restores the head in place —
    // the message stays visible in the strip instead of evaporating.
    void handleRequest(item.text).then((ok) => {
      if (!ok) restore()
    }, restore)
  }, [engine.agentStatus, persistence.activeConversationKey, handleRequest])

  // ── 7.55 后台任务完成投递（PLAN-background-tasks C）──
  // 三个触发点全部汇聚到 deliverBackground（主进程幂等闸门，busy/nothing 都
  // 是安全答案）：
  //   ① exit 事件 && 本会话正被看 && 窗口有焦点 → 立即投递；
  //   ② 前台忙 → pendingDelivery 标记，status busy→completed 边沿（复用
  //      staged-drain 的 shouldDrainOnStatusChange 口径）→ 投递；
  //   ③ 用户切回本会话 → 投递。
  // popout 窗口 MVP 不参与投递（savesEnabled=false 即次级窗口）——只享受绿点
  // 与系统通知。系统通知只在「本会话非我正在看」时发；开关
  // notifications.backgroundComplete 的门控在主进程（缺省开）。
  const pendingDeliveryRef = useRef<Set<string>>(new Set())
  const deliverBackground = useCallback(async (convId: string): Promise<void> => {
    const result = await window.electronAPI.agentSessionDeliverBackground(convId).catch(() => 'nothing' as const)
    // delivered/nothing 都清标记；busy 保留，等 ②③ 的下一次触发。
    if (result !== 'busy') pendingDeliveryRef.current.delete(convId)
  }, [])

  // ① + 通知编排（经 ref 桥进引擎的 mount-only 订阅，同 onBackgroundComplete）。
  // eslint-disable-next-line react-hooks/refs -- latest-instance mirror bridged into the mount-only engine subscription
  onBackgroundTaskExitRef.current = (convId: string, pid: number, code: number | null): void => {
    // 次级窗口（popout/项目沉浸）不投递也不发通知——主窗的同一订阅会做。
    if (options.savesEnabled === false) return
    const watching = engine.activeEngineIdRef.current === convId
    if (watching && document.hasFocus()) {
      void deliverBackground(convId)
      return
    }
    pendingDeliveryRef.current.add(convId)
    if (!watching) {
      const label = persistence.conversations.find((c) => String(c.key) === convId)?.label ?? ''
      void window.electronAPI.agentSessionNotifyBackgroundComplete?.(
        t('background.notifyTitle'),
        t('background.notifyBody', { title: label, pid, code: code == null ? 'null' : code }),
      ).catch(() => { /* notifications are best-effort */ })
    }
  }

  // ② busy→completed 边沿（same convId 才是边沿；切进已完成的会话由 ③ 接）。
  const deliveryStatusRef = useRef<{ convId: string | null; status: string } | null>(null)
  useEffect(() => {
    const convId = conversationKeyOf(persistence.activeConversationKey) ?? null
    const status = engine.agentStatus.status
    const prev = deliveryStatusRef.current
    deliveryStatusRef.current = { convId, status }
    if (!convId || !shouldDrainOnStatusChange(prev, { convId, status })) return
    if (!pendingDeliveryRef.current.has(convId)) return
    void deliverBackground(convId)
  }, [engine.agentStatus, persistence.activeConversationKey, deliverBackground])

  // ③ 切回会话（activateConversation 的效果面——activeConversationKey 变化）。
  useEffect(() => {
    const convId = conversationKeyOf(persistence.activeConversationKey)
    if (!convId || !pendingDeliveryRef.current.has(convId)) return
    void deliverBackground(convId)
  }, [persistence.activeConversationKey, deliverBackground])

  /** 立即发送: stop-first is load-bearing — prepareTurn only aborts the
   *  in-flight LLM stream; it does NOT settle in-flight tool promises or the
   *  sub-agent tree, so a startLoop straight onto a running engine would leave
   *  a late tool result re-entering continueLoop alongside the new turn (two
   *  loops writing one transcript). stopExecution settles everything to idle
   *  (killing processes, settling the sub-agent tree as aborted), prepareTurn
   *  then clears isCancelled and the new turn opens clean. */
  const sendStagedNow = useCallback(
    async (text: string): Promise<boolean> => {
      engine.stopExecution()
      return handleRequest(text)
    },
    [engine, handleRequest],
  )

  // ── 8. Return ──
  return {
    conversations: persistence.conversations,
    activeConversationKey: persistence.activeConversationKey,
    isLoadingConversation: persistence.isLoadingConversation,
    messages: engine.messages,
    /** Last compaction pass of the active conversation — the composer's 已压缩
     *  chip and the ring's post-compaction projection both read it. */
    lastCompaction: engine.lastCompaction,
    isRequesting:
      engine.agentStatus.status !== 'idle' &&
      engine.agentStatus.status !== 'completed' &&
      engine.agentStatus.status !== 'awaiting_user_input' &&
      engine.agentStatus.status !== 'error' &&
      engine.agentStatus.status !== 'awaiting_extension' &&
      engine.agentStatus.status !== 'awaiting_continue',
    createNewConversation: persistence.createNewConversation,
    reloadConversations: persistence.reloadConversations,
    /** Resolved working directory for a conversation (M8), for UI display. */
    getWorkspaceDir: engine.getWorkspaceDir,
    deleteConversation: async (key: string) => {
      titleGeneratedRef.current.delete(key)
      // Staged rows are runtime-only state; a deleted conversation's queue
      // must go with it, or the strip would resurrect on a id reuse.
      clearStagedMessages(key)
      return persistence.deleteConversation(key)
    },
    clearAllConversations: async () => {
      titleGeneratedRef.current.clear()
      clearAllStagedMessages()
      return persistence.clearAllConversations()
    },
    renameConversation: persistence.renameConversation,
    setActiveConversationKey: persistence.handleSelectConversation,
    handleRequest,
    createBrowserTask,
    adoptHandoffTask,
    sendStagedNow,
    /** composer 的停止按钮（冻结语义，2026-09-29 体验回滚）：中止在飞请求、
     *  整棵专家树一起冻结、回合停进 awaiting_continue，确认条的 继续执行/
     *  停止任务 接手。真正结算旧树的是「停止任务」（stopExecution）和
     *  「输入了新消息」（引擎 prepareTurn，所有客户端的新回合都经过它）。 */
    abort: engine.cancelLoop,
    saveCurrentConversation: persistence.saveCurrentConversation,
    saveConversationSync: persistence.saveConversationSync,
    saveAllConversationsSync: persistence.saveAllConversationsSync,
    agentStatus: engine.agentStatus,
    streamingBlocks: engine.streamingBlocks,
    plan: engine.plan,
    approveTool: engine.approveTool,
    rejectTool: engine.rejectTool,
    killTool: engine.killTool,
    /** 运行中「转入后台」（PLAN-background-tasks A）。 */
    promoteToolToBackground: engine.promoteToolToBackground,
    respondToTool: engine.respondToTool,
    extractRoutine,
    clearError: engine.clearError,
    retryLast: engine.retryLast,
    extendLoop: engine.extendLoop,
    /** Popout adoption (main window): mirror a conversation a popout opened
     *  so the single-writer sweep persists it. */
    adoptConversation: persistence.adoptConversation,
    /** Popout boot primitives (PLAN-conversation-popout): the popout window
     *  binds its fixed conversation directly — create (idempotent), seed the
     *  mirror (snapshot or DB), then activate BOTH sides without the switch
     *  path's flush/cold-open semantics (a live session must not be
     *  hydrated over). The main window's own paths never call these. */
    getOrCreateEngine: engine.getOrCreateEngine,
    activateEngine: engine.activateEngine,
    activateConversation: persistence.activateConversation,
    seedSessionSnapshot: engine.seedSessionSnapshot,
    seedSessionHistory: engine.seedSessionHistory,
    /** 流中转向（PLAN-mid-stream-steer M1，B7 方案 A）：resolve 引擎的结构化
     *  outcome，false = 调用方回落暂存/发送，文本不许丢。 */
    steer: engine.steer,
    stopExecution: engine.stopExecution,
    resumeExecution: engine.resumeExecution,
    tools: managers.tools,
    toggleTool: managers.toggleTool,
    skills: managers.skills,
    toggleSkill: managers.toggleSkill,
    importSkill: managers.importSkill,
    deleteImportedSkill: managers.deleteImportedSkill,
    refreshSkillsFromDisk: managers.refreshSkillsFromDisk,
    importError: managers.importError,
    memoryManager: managers.memoryManager,
    knowledgeManager: managers.knowledgeManager,
    experienceManager: managers.experienceManager,
    convLights: engine.convLights,
    /** 每会话后台运行中计数（PLAN-background-tasks B），侧栏灯槽标记。 */
    bgRunningCounts: engine.bgRunningCounts,
    markConversationRead: engine.markConversationRead,
    togglePin: persistence.togglePin,
    bumpConversation: persistence.bumpConversation,
    updateConversationExpert: persistence.updateConversationExpert,
    updateConversationApproval: persistence.updateConversationApproval,
    updateConversationProfile: persistence.updateConversationProfile,
  }
}
