import { useEffect, useRef, useCallback } from 'react'
import { useChatManagers } from './useChatManagers'
import { useConversationEngine } from './useConversationEngine'
import { useConversationPersistence } from './useConversationPersistence'
import { TitleAgent } from '../agent/one-shot-agent'
import type { LlmAdapter } from '../llm/adapter'
import type { AgentEngine } from '../agent/AgentEngine'
import type { HooksConfig } from '../types/hooks'

// ── Options ──

interface UseChatControllerOptions {
  apiKey: string | null
  baseURL: string
  model: string
  maxTokens: number
  contextLength?: number
  adapter: LlmAdapter
  myName: string
  soul: string
  yourName: string
  workspaceDir?: string
  autoCleanup?: boolean
  yoloMode?: boolean
  hooks?: HooksConfig
  locale?: 'zh' | 'en'
}

// ── Hook ──

export function useChatController(options: UseChatControllerOptions) {
  const { apiKey, baseURL, autoCleanup } = options

  // ── 1. Managers ──
  const managers = useChatManagers(options)

  // ── 2. Title generation state (shared by handleRequest + auto-title + background) ──
  const titleGeneratedRef = useRef<Set<string>>(new Set())
  const pendingTitleGenRef = useRef<string | null>(null)
  const titleAgentRef = useRef(new TitleAgent())

  // ── 3. Engine (with background-complete callback for title gen) ──
  // Forward ref for generateTitle (breaks circular dep: engine ← persistence ← generateTitle ← onBackgroundComplete)
  const generateTitleRef = useRef<(typeof generateTitle)>(null as any)
  const onBackgroundComplete = useCallback((convId: string, engine: AgentEngine) => {
    if (pendingTitleGenRef.current !== convId) return
    if (titleGeneratedRef.current.has(convId)) return
    pendingTitleGenRef.current = null
    titleGeneratedRef.current.add(convId)

    generateTitleRef.current(convId, engine.messages, { llmFallback: '', stripFileMarkers: true })
  }, [])

  const engine = useConversationEngine({
    ...options,
    ...managers,
    platformInfo: managers.platformInfo ?? undefined,
    onBackgroundComplete,
    onSkillStateChange: managers.refreshSkills
  })

  // ── 4. Persistence (save/load conversations) ──
  const persistence = useConversationPersistence({
    autoCleanup,
    messages: engine.messages,
    agentStatus: engine.agentStatus,
    enginesRef: engine.enginesRef,
    activeEngineIdRef: engine.activeEngineIdRef,
    getOrCreateEngine: engine.getOrCreateEngine,
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
      { llmConfig: { adapter: options.adapter, apiKey: apiKey ?? '', baseURL: options.baseURL, model: options.model }, maxTokens: 512 }
    )
    const fallback = doStrip ? stripFileMarkers(opts.llmFallback) : opts.llmFallback
    const finalTitle = result || fallback
    if (!finalTitle) return
    persistence.updateConversationTitleInList(convId, finalTitle)
    window.electronAPI.updateConversationTitle(convId, finalTitle)
  }, [apiKey, baseURL, options.adapter, options.model, options.locale, persistence])

  generateTitleRef.current = generateTitle as any

  // ── 5. Experience auto-extraction (from conversations with 5+ rounds) ──
  const summarizerRunningRef = useRef(false)
  const processedConvRef = useRef<Set<string>>(new Set())
  useEffect(() => {
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
        const candidates = convList.filter(c =>
          c.messageCount >= 5 && !processedConvRef.current.has(c.id)
        )
        if (candidates.length === 0) {
          summarizerRunningRef.current = false
          return
        }

        for (const conv of candidates.slice(0, 10)) {
          try {
            const conversation = await window.electronAPI.getConversation(conv.id)
            if (!conversation) continue

            const processedCount = await window.electronAPI.getConversationExperienceExtractedCount(conv.id)
            if (processedCount >= conversation.messages.length) {
              processedConvRef.current.add(conv.id)
              continue
            }

            const userMessages = conversation.messages.filter(m =>
              m.role === 'user' && m.contentBlocks?.some(b => b.type === 'text')
            )
            const assistantMessages = conversation.messages.filter(m =>
              m.role === 'assistant' && m.contentBlocks?.some(b => b.type === 'text')
            )
            const hasEnoughUser = userMessages.length >= 5
            const hasEnoughAssistant = assistantMessages.length >= 10
            if (!hasEnoughUser && !hasEnoughAssistant) continue

            const relevantMessages = conversation.messages.filter(m => {
              if (m.role === 'user' || m.role === 'assistant') {
                return m.contentBlocks?.some(b => b.type === 'text')
              }
              return false
            })

            const sessionMessages = relevantMessages.map(m => {
              const textBlock = m.contentBlocks?.find((b: any) => b.type === 'text')
              return {
                role: m.role,
                content: textBlock ? (textBlock as { type: 'text'; text: string }).text.slice(0, 1500) : ''
              }
            })

            const result = await managers.memoryManager.extractAndSaveExperiences(
              sessionMessages, apiKey, options.baseURL, options.adapter, options.model,
              conv.id, options.locale
            )

            processedConvRef.current.add(conv.id)
            if (result.content) {
              const kf = await managers.knowledgeManager.saveExperience(result.content, conv.id, result.title ?? undefined)
              if (kf) managers.knowledgeManager.compileFile(kf.id).catch((err: unknown) => console.warn('[experience] Failed to compile:', err))
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
  }, [apiKey])

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
    (content: string) => {
      if (!apiKey) {
        console.warn('[ChatController] handleRequest blocked: no API key')
        return
      }

      let convId = persistence.activeConversationKey ? String(persistence.activeConversationKey) : ''

      if (!convId) {
        const now = new Date()
        const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
        convId = `conv_${ts}`
        persistence.addConversation({ key: convId, label: '新对话' }, 'prepend')
        engine.activeEngineIdRef.current = convId
        persistence.convIdRef.current = convId
        persistence.setActiveConversationKey(convId)
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

      engine.getOrCreateEngine(convId).startLoop(content)
    },
    [apiKey, persistence.activeConversationKey, persistence.addConversation,
     persistence.setActiveConversationKey, persistence.updateConversationTitleInList,
     persistence.convIdRef, engine.getOrCreateEngine, engine.activeEngineIdRef, options]
  )

  // ── 8. Return ──
  return {
    conversations: persistence.conversations,
    activeConversationKey: persistence.activeConversationKey,
    messages: engine.messages,
    isRequesting:
      engine.agentStatus.status !== 'idle' &&
      engine.agentStatus.status !== 'completed' &&
      engine.agentStatus.status !== 'awaiting_user_input' &&
      engine.agentStatus.status !== 'error' &&
      engine.agentStatus.status !== 'awaiting_extension' &&
      engine.agentStatus.status !== 'awaiting_continue',
    createNewConversation: persistence.createNewConversation,
    deleteConversation: async (key: string) => {
      titleGeneratedRef.current.delete(key)
      return persistence.deleteConversation(key)
    },
    clearAllConversations: async () => {
      titleGeneratedRef.current.clear()
      return persistence.clearAllConversations()
    },
    renameConversation: persistence.renameConversation,
    setActiveConversationKey: persistence.handleSelectConversation,
    handleRequest,
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
    clearError: engine.clearError,
    retryLast: engine.retryLast,
    extendLoop: engine.extendLoop,
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
    activeLoopConvIds: engine.activeLoopConvIds,
    retryingConvIds: engine.retryingConvIds,
    togglePin: persistence.togglePin,
    bumpConversation: persistence.bumpConversation
  }
}
