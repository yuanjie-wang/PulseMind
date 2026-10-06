import { useEffect, useRef, useCallback } from 'react'
import { App as AntdApp } from 'antd'
import { useChatManagers } from './useChatManagers'
import { useConversationEngine } from './useConversationEngine'
import { useConversationPersistence } from './useConversationPersistence'
import { takePendingApprovalMode } from '../stores/pendingApprovalStore'
import { takePendingProfileId } from '../stores/pendingProfileStore'
import { useNewTaskStore } from '../stores/newTaskStore'
import { useNavigationStore } from '../stores/navigationStore'
import { useTranslation } from '../i18n/useTranslation'
import { TitleAgent } from '../agent/one-shot-agent'
import { extractRoutineFromConversation } from '../components/routine/routine-extract'
import { parseExpertMentions, parseKnowledgeBaseMention, type SummonedExpert } from '../../../shared/expert-context'
import { conversationKeyOf } from '../../../shared/conversation-key'
import { takeStagedHead, restoreStaged, clearStagedMessages, clearAllStagedMessages } from '../stores/pendingMessageStore'
import { shouldDrainOnStatusChange } from '../utils/staged-drain'
import type { ExpertProfile } from '../../../shared/types/expert'
import type { LlmAdapter } from '../llm/adapter'
import type { AgentMessage } from '../types/agent'
import type { HooksConfig } from '../types/hooks'
import type { SandboxApprovalMode } from '../../../shared/sandbox/policy'

// ── Options ──

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
  const titleAgentRef = useRef(new TitleAgent())

  // ── 3. Engine (with background-complete callback for title gen) ──
  // Forward ref for generateTitle (breaks circular dep: engine ← persistence ← generateTitle ← onBackgroundComplete)
  const generateTitleRef = useRef<(typeof generateTitle)>(null as any)
  // Ref bridges: the engine hook is constructed below but needs this callback,
  // and the callback needs the engine's session mirror (same pattern as
  // generateTitleRef — breaks the circular dependency).
  const onBackgroundCompleteRef = useRef<(convId: string) => void>(null as any)
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
    onSkillStateChange: managers.refreshSkills
  })
  /* eslint-disable react-hooks/refs -- latest-instance mirrors: engineBridge is read by child effects, onBackgroundComplete is invoked from engine callbacks */
  engineBridgeRef.current = engine
  onBackgroundCompleteRef.current = onBackgroundComplete
  /* eslint-enable react-hooks/refs */

  // ── 4. Persistence (save/load conversations) ──
  const persistence = useConversationPersistence({
    autoCleanup,
    messages: engine.messages,
    agentStatus: engine.agentStatus,
    enginesRef: engine.enginesRef,
    activeEngineIdRef: engine.activeEngineIdRef,
    getOrCreateEngine: engine.getOrCreateEngine,
    markConversationRead: engine.markConversationRead,
    setMessages: engine.setMessages,
    setAgentStatus: engine.setAgentStatus,
    setStreamingBlocks: engine.setStreamingBlocks,
    setPlan: engine.setPlan
  })

  // ── Shared title generation ────────────────────────────────────────
  const stripFileMarkers = (s: string) => s.replace(/\[(?:file|folder):[^\]]+\]/g, '').trim()
  const generateTitle = useCallback(async (
    convId: string,
    messages: { role: string; contentBlocks?: { type: string; text?: string }[] }[],
    opts: { llmFallback: string; stripFileMarkers?: boolean }
  ): Promise<void> => {
    // Skip if conversation already has a meaningful title stored
    // (prevents re-triggering title generation after app restart)
    const existingConv = persistence.conversations.find((c: any) => String(c.key) === convId)
    if (existingConv?.label && existingConv.label !== '新对话') return

    const firstUser = messages.find(m => m.role === 'user')
    const raw = firstUser?.contentBlocks?.find(b => b.type === 'text')?.text || ''
    const doStrip = opts.stripFileMarkers !== false
    const userContent = doStrip ? stripFileMarkers(raw) : raw.trim()
    if (!userContent) return

    const userMsgCount = messages.filter(m => m.role === 'user').length
    if (userMsgCount < 3 && userContent.length < 6) {
      persistence.updateConversationTitleInList(convId, userContent)
      window.electronAPI.updateConversationTitle(convId, userContent)
      return
    }

    const conversationContext = userMsgCount >= 3
      ? messages.filter(m => m.role === 'user')
          .map(m => {
            const text = m.contentBlocks?.find(b => b.type === 'text')?.text || ''
            return text ? `User: ${text.slice(0, 300)}` : ''
          })
          .filter(Boolean)
          .join('\n')
          .slice(0, 3000)
      : undefined

    const result = await titleAgentRef.current.execute(
      { userMessage: raw, conversationContext, locale: options.locale },
      { llmConfig: { adapter: options.adapter, apiKey: apiKey ?? '', baseURL: options.baseURL, model: options.model, modelMaxTokens: options.maxTokens }, maxTokens: 4096 }
    )
    const fallback = doStrip ? stripFileMarkers(opts.llmFallback) : opts.llmFallback
    const finalTitle = result || fallback
    if (!finalTitle) return
    persistence.updateConversationTitleInList(convId, finalTitle)
    window.electronAPI.updateConversationTitle(convId, finalTitle)
  }, [apiKey, baseURL, options.adapter, options.model, options.locale, persistence])

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

  // ── 5. Experience auto-extraction (from conversations with 5+ rounds) ──
  const summarizerRunningRef = useRef(false)
  const processedConvRef = useRef<Set<string>>(new Set())
  const experienceEnabled = options.experienceEnabled
  useEffect(() => {
    // 设置 → 经验 master switch: off means no experience distillation at all.
    if (experienceEnabled === false) return
    if (!apiKey) return
    if (!managers.prefsLoadedRef.current) return
    if (summarizerRunningRef.current) return

    const run = async (): Promise<void> => {
      for (let attempt = 0; attempt < 10; attempt++) {
        if (managers.skillsReadyRef.current) break
        await new Promise(r => setTimeout(r, 200))
      }
      if (!managers.skillsReadyRef.current) return
      if (summarizerRunningRef.current) return
      summarizerRunningRef.current = true

      try {
        const convList = await window.electronAPI.listConversations()
        // P1 (PLAN-memory-extraction-dedup) 回填三改:
        //  (a) 只碰 updated_at 距今 >30min 的会话——正在聊的会话由回合末的
        //      afterSession 提取，回填与它抢同一批尾巴就是重复提取的又一源；
        //  (b) 跳过当前打开的会话（消与 afterSession 的同会话并发窗）；
        //  (c) minDelta 传 1——回填每会话一次性、有界，是尾巴的兜底而非节奏项。
        const thirtyMinAgo = Date.now() - 30 * 60 * 1000
        const activeKey = persistence.activeConversationKey ? String(persistence.activeConversationKey) : ''
        const candidates = convList.filter(c =>
          c.messageCount >= 5
          && !processedConvRef.current.has(c.id)
          && (!c.updatedAt || new Date(c.updatedAt).getTime() <= thirtyMinAgo)
          && c.id !== activeKey
        )
        if (candidates.length === 0) {
          summarizerRunningRef.current = false
          return
        }

        for (const conv of candidates.slice(0, 10)) {
          try {
            // Cheap coarse pre-check (fast path only): messageCount counts ALL
            // message rows, so processedCount >= messageCount implies the
            // conversation is fully extracted. The authoritative incremental
            // The authoritative incremental cursor check happens inside
            // MemoryManager.extractAndSaveAll.
            const processedCount = await window.electronAPI.getConversationExperienceExtractedCount(conv.id)
            if (processedCount >= conv.messageCount) {
              processedConvRef.current.add(conv.id)
              continue
            }

            const conversation = await window.electronAPI.getConversation(conv.id)
            if (!conversation) continue

            // 与 extractAndSaveAll 同一扁平化（toTextMessages 的形状）——旧代码
            // 只取每条消息首个 text block，两套管线对「第几条」算出不同数，
            // 尾部因此被反复重提取（plan 诊断 #4 的单位差）。
            const hasText = conversation.messages.filter(m =>
              (m.role === 'user' || m.role === 'assistant') && m.contentBlocks?.some(b => b.type === 'text')
            )
            if (hasText.length < 5) continue

            // P1 #8: 回填统一走 extractAndSaveAll（memory 关、experience 开），
            // extractAndSaveExperiences 及 ExperienceAgent 独立路径已删除。
            // 桥接的 Message.contentBlocks 可选，引擎的 AgentMessage 必填 ——
            // 一个浅拷贝补齐空数组（toTextMessages 只读 text blocks）。
            const result = await managers.memoryManager.extractAndSaveAll(
              conversation.messages.map((m) => ({ ...m, contentBlocks: m.contentBlocks ?? [] })),
              apiKey, options.baseURL, options.adapter, options.model,
              conv.id, options.locale, { memory: false, experience: true }, { minDelta: 1 },
            )

            processedConvRef.current.add(conv.id)
            if (result.experienceContent) {
              const { record, rejectedFiles } = await managers.experienceManager.save({
                title: result.experienceTitle ?? 'Untitled experience',
                description: result.experienceContent.slice(0, 120),
                content: result.experienceContent,
                category: result.experienceCategory ?? 'general',
                sourceConversationId: conv.id,
                files: result.experienceFiles,
                // Iteration (PLAN-experience-iteration): update target re-aims the save.
                targetName: result.experienceTarget
              })
              if (rejectedFiles?.length) console.warn('[experience] rejected script files:', rejectedFiles.join(', '))
              managers.experienceManager.ensureTriggers(record.name, {
                adapter: options.adapter, apiKey: apiKey || '', baseURL: options.baseURL, model: options.model, modelMaxTokens: options.maxTokens
              }, Boolean(result.experienceTarget)).catch((e: unknown) => console.warn('[experience] Trigger extraction failed:', e))
            }
          } catch (convErr) {
            console.warn('[experience] Failed to process conversation ' + conv.id + ':', convErr)
          }
        }
      } catch (err) {
        console.warn('[experience] Failed to auto-generate experiences (non-critical):', err)
      }
      summarizerRunningRef.current = false
    }
    run()
  }, [apiKey, experienceEnabled])

  // ── 6. Auto-title generation (active engine) ──
  //
  // Generate title when the active engine first completes, and re-generate
  // on the 3rd user message. Background-engine titles are handled in the
  // onBackgroundComplete callback above.
  useEffect(() => {
    if (!persistence.activeConversationKey || engine.agentStatus.status !== 'completed') return

    const convId = String(persistence.activeConversationKey)
    // Skip if title was already generated (first-round succeeded)
    if (titleGeneratedRef.current.has(convId)) return
    if (pendingTitleGenRef.current !== convId) return
    pendingTitleGenRef.current = null

    const hasAssistant = engine.messages.some((m) => m.role === 'assistant')
    if (!hasAssistant) return

    titleGeneratedRef.current.add(convId)

    generateTitle(convId, engine.messages, { llmFallback: '' })
  }, [
    persistence.activeConversationKey,
    engine.agentStatus,
    engine.messages,
    generateTitle,
    generateTitleRef
  ])

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
        if (status !== 'idle' && status !== 'completed' && status !== 'error' && status !== 'awaiting_user_input' && status !== 'awaiting_extension' && status !== 'awaiting_continue') {
          message.warning(t('chatView.compaction.busy'))
          return false
        }
        const event = await engine.getOrCreateEngine(target).compactNow(instruction)
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

      // ── @-summon: resolve expert mentions before anything else ──
      // Summoning IS delegation (spawn_agent): the mentioned experts run their
      // parts as sub-agents inside this conversation — the conversation itself
      // never switches identity anymore. One name is the single-expert path
      // (the expert's conclusion is delivered verbatim); several are handed to
      // the engine's plan mode, which plans the work and assigns it. The
      // mentions must resolve against enabled experts and are stripped from the
      // outgoing text; with nothing left to delegate (an empty task) there is
      // no summon at all.
      let experts: ExpertProfile[] = []
      try { experts = await window.electronAPI.expertList() } catch { /* non-critical */ }
      const mentions = parseExpertMentions(content, experts)
      const mentioned: SummonedExpert[] = mentions.experts.map((e) => ({ id: e.id, name: e.name }))
      if (mentioned.length > 0) {
        content = mentions.text
        if (!content.trim()) {
          message.warning(t('chatView.expert.needTaskWithSummon'))
          return false
        }
      }

      // ── @知识库 (PLAN-knowledge-groups G5): resolve the base scope ──
      // Runs AFTER the expert parse on the remaining text, so a name that is
      // both reads as the expert (既有语义优先). The scope rides THIS send
      // only — the next message without an @mention searches everything.
      let knowledgeBase: { id: string; name: string } | null = null
      try {
        const bases = await window.electronAPI.knowledgeListBases()
        const parsedBase = parseKnowledgeBaseMention(content, bases)
        knowledgeBase = parsedBase.base
        if (knowledgeBase) content = parsedBase.text
      } catch { /* bases unavailable — unscoped turn */ }

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
        engine.activateEngine(convId)
        persistence.activateConversation(convId)
      } else {
        window.electronAPI.touchConversation(convId).catch(() => {})
        persistence.bumpConversation(convId)
      }

      if (import.meta.env.DEV) console.log(`[ChatController] handleRequest: model=${options.model} baseURL=${options.baseURL}`)
      pendingTitleGenRef.current = convId

      // First-message title generation
      if (!titleGeneratedRef.current.has(convId)) {
        generateTitleRef.current(
          convId,
          [{ role: 'user', contentBlocks: [{ type: 'text', text: content }] }],
          { llmFallback: content.trim() }
        )
      }

      // The @-summoned experts ride the same conversation materialization and
      // title generation as a normal send — only the turn's entry point
      // differs: main dispatches the deterministic spawn_agent call (one
      // expert) or plans the work first (several), inside this conversation.
      const engineHandle = engine.getOrCreateEngine(convId)
      if (mentioned.length > 0) engineHandle.startSummonedLoop(content, mentioned, knowledgeBase)
      else engineHandle.startLoop(content, knowledgeBase)
      // true = the turn left. Every early `return false` above is a bail the
      // caller (the staged-queue drain, the strip's 立即发送) must restore its
      // message for — a silent drop there loses the message with only a toast
      // for company.
      return true
    },
    [apiKey, persistence.activeConversationKey, persistence.addConversation,
     persistence.setActiveConversationKey, persistence.updateConversationTitleInList,
     persistence.updateConversationApproval, persistence.updateConversationProfile,
     persistence.convIdRef, engine.getOrCreateEngine, engine.activeEngineIdRef, engine.agentStatus, options, t, message]
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
    void handleRequest(item.text).then(
      (ok) => { if (!ok) restore() },
      restore
    )
  }, [engine.agentStatus, persistence.activeConversationKey, handleRequest])

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
    [engine, handleRequest]
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
    respondToTool: engine.respondToTool,
    extractRoutine,
    clearError: engine.clearError,
    retryLast: engine.retryLast,
    extendLoop: engine.extendLoop,
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
    togglePin: persistence.togglePin,
    bumpConversation: persistence.bumpConversation,
    updateConversationExpert: persistence.updateConversationExpert,
    updateConversationApproval: persistence.updateConversationApproval,
    updateConversationProfile: persistence.updateConversationProfile
  }
}
