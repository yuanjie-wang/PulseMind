import React, { useEffect, useMemo, useRef, useState } from 'react'
import { XProvider } from '@ant-design/x'
import { ConfigProvider, theme as antdTheme, App as AntdApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import AppLayout from './components/layout/AppLayout'
import ChatView from './components/layout/ChatView'
import { PlanPanel } from './components/layout/PlanPanel'
import ErrorBoundary from './components/ErrorBoundary'
import { useChatController } from './hooks/useChatController'
import { SettingsProvider, useSettings } from './hooks/SettingsContext'
import { MemoryManager } from './memory/MemoryManager'
import { KnowledgeManager } from './knowledge/KnowledgeManager'
import { enqueueStartupCompile } from './components/knowledge/KnowledgePanel'
import { createLlmAdapter } from './llm/index'
import { generateMcpSummaries } from './agent/mcp-summary-service'
import { useGreeting } from './hooks/useGreeting'
import type { HooksConfig } from './types/hooks'
import { TranslationProvider, useTranslation } from './i18n/useTranslation'

function App(): React.ReactElement {
  return (
    <SettingsProvider>
      <TranslationProvider initialLocale='zh'>
        <AppContent />
      </TranslationProvider>
    </SettingsProvider>
  )
}

function AppContent(): React.ReactElement {
  const { settings, hasApiKey, activeProfile, saveSettings, reloadSettings } = useSettings()
  const { locale, setLocale } = useTranslation()

  // Sync settings.locale -> TranslationProvider on load and when settings change
  useEffect(() => {
    if (settings.locale && settings.locale !== locale) {
      setLocale(settings.locale as 'zh' | 'en')
    }
  }, [settings.locale, locale, setLocale])

  // Disable Tab key focus navigation across the app
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Tab') e.preventDefault()
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [])

  // ── Hooks completed: reload settings ──
  useEffect(() => {
    const unsub = window.electronAPI?.onHooksCompleted(() => {
      console.log('[App] appStart hooks completed — reloading settings')
      reloadSettings()
    })
    return unsub
  }, [reloadSettings])

  // ── Startup MCP summary compensation ──
  // Calls generateMcpSummaries on mount AND whenever MCP servers change,
  // so that summaries are generated even if servers connect after mount.
  useEffect(() => {
    if (!hasApiKey || !activeProfile?.provider) return
    const tryGenerate = () => {
      generateMcpSummaries({
        adapter: createLlmAdapter(activeProfile!.provider!),
        apiKey: activeProfile!.apiKey!,
        baseURL: activeProfile!.baseURL || '',
        model: activeProfile!.model || '',
        locale: settings.locale,
      }).catch(() => {})
    }
    // Try immediately (cache may not be populated yet at mount time)
    tryGenerate()
    // Also retry when MCP servers change, so new connections get summaries
    const unsub = window.electronAPI?.onMcpServersChanged(() => {
      setTimeout(tryGenerate, 300) // small delay to let mcp-cache settle
    })
    return () => { unsub?.() }
  }, [hasApiKey, activeProfile?.provider, activeProfile?.apiKey, activeProfile?.baseURL, activeProfile?.model, settings.locale])

  // ── Sleep/resume recovery ──
  useEffect(() => {
    const unsub = window.electronAPI?.onSystemResumed(() => {
      console.log('[App] System resumed from sleep — attempting recovery')

      // Give the renderer a moment to settle (timers, GPU context)
      requestAnimationFrame(() => {
        // Send ack to main so it doesn't fall back to a full reload
        try { window.electronAPI.systemResumedAck() } catch {}

        // If WebGL/Canvas contexts are truly unrecoverable, the error will
        // surface naturally through the rendering pipeline. The user can
        // manually refresh if needed.
      })
    })
    return unsub
  }, [])

  // API key is now stored in the profile (settings.json), so it is
  // available synchronously from activeProfile.apiKey — no async loading.
  const apiKey = activeProfile?.apiKey ?? null
  const baseURL = activeProfile?.baseURL ?? settings.profiles[0]?.baseURL ?? ''
  const model = activeProfile?.model ?? settings.profiles[0]?.model ?? ''
  const maxTokens = activeProfile?.maxTokens ?? settings.profiles[0]?.maxTokens ?? 8192
const contextLength = activeProfile?.contextLength ?? settings.profiles[0]?.contextLength ?? 128000
  const adapter = useMemo(() => createLlmAdapter(activeProfile?.provider ?? 'anthropic'), [activeProfile?.provider])

  // ── Greeting (regenerated on each new conversation) ──
  const { greeting, regenerateGreeting } = useGreeting(adapter, apiKey, baseURL, model)

  // Stable refs for memory and knowledge managers (set after useChatController is instantiated)
  const memoryManagerRef = useRef<MemoryManager | null>(null)
  const knowledgeManagerRef = useRef<KnowledgeManager | null>(null)
  const experienceManagerRef = useRef<import('./experiences/ExperienceManager').ExperienceManager | null>(null)

  // Ref for conversationId so the afterSession hook can access it
  // (hooks useMemo runs before useChatController's return values are destructured)
  const conversationIdRef = useRef<string | null>(null)

  const hooks: HooksConfig = useMemo(() => ({
    beforeSession: (ctx) => {
      console.log('[Hook] beforeSession:', ctx.userMessage.slice(0, 80))
      return ctx
    },
    afterSession: (ctx) => {
      console.log('[Hook] afterSession, status:', ctx.status.status)

      // Auto-capture memories/summary when session ends (completed, error, or cancelled)
      if (memoryManagerRef.current && apiKey) {
        const mm = memoryManagerRef.current
        const messages = ctx.messages.filter(m => m.contentBlocks?.some(b => b.type === 'text'))

        if (messages.length > 0) {
          // Fire-and-forget — single LLM call extracts memories + experience.
          // MemoryManager flattens contentBlocks to text-only messages and
          // applies the incremental cursor internally.
          mm.extractAndSaveAll(messages, apiKey, baseURL, adapter, model, conversationIdRef.current ?? undefined, settings.locale).then(result => {
            if (result.memories > 0) {
              console.log(`[SessionReview] Saved ${result.memories} memory/ies`)
            }
            // Save extracted experience as a standalone SKILL (not into the wiki)
            if (result.experienceContent && experienceManagerRef.current) {
              experienceManagerRef.current.save({
                title: result.experienceTitle ?? 'Untitled experience',
                description: result.experienceContent.slice(0, 120),
                content: result.experienceContent,
                category: result.experienceCategory ?? 'general',
                sourceConversationId: conversationIdRef.current ?? undefined
              }).then(({ record }) => {
                console.log('[SessionReview] Experience saved to experience skill library')
                experienceManagerRef.current?.ensureTriggers(record.name, {
                  adapter, apiKey: apiKey || '', baseURL, model
                }).catch((err: unknown) => console.warn('[SessionReview] Trigger extraction failed:', err))
              }).catch((err: unknown) => console.warn('[SessionReview] Failed to save experience:', err))
            }
          })
        }
      }
    },
    beforeTool: (ctx) => {
      console.log('[Hook] beforeTool:', ctx.toolName, ctx.command.slice(0, 80))
      return ctx
    },
    afterTool: (ctx) => {
      console.log('[Hook] afterTool:', ctx.toolName, 'error:', ctx.isError)
    },
    beforeLlmCall: (ctx) => {
      console.log('[Hook] beforeLlmCall, messages:', ctx.messages.length, 'tools:', (ctx.body.tools as Array<unknown>)?.length ?? 0)
      return ctx
    },
    afterLlmCall: (ctx) => {
      console.log('[Hook] afterLlmCall, stopReason:', ctx.stopReason)
    }
  }), [apiKey, baseURL, adapter, model])

  const {
    conversations,
    activeConversationKey,
    messages,
    isRequesting,
    createNewConversation,
    deleteConversation,
    clearAllConversations,
    renameConversation,
    setActiveConversationKey,
    handleRequest,
    abort,
    saveCurrentConversation,
    saveAllConversationsSync,
    agentStatus,
    streamingBlocks,
    approveTool,
    rejectTool,
    killTool,
    respondToTool,
    clearError,
    retryLast,
    extendLoop,
    tools,
    toggleTool,
    skills,
    toggleSkill,
    importSkill,
    deleteImportedSkill,
    importError,
    refreshSkillsFromDisk,
    memoryManager,
    knowledgeManager,
    experienceManager,
    activeLoopConvIds,
    retryingConvIds,
    togglePin,
    plan,
    stopExecution,
    resumeExecution
  } = useChatController({
    apiKey,
    baseURL,
    model,
    maxTokens,
    contextLength,
    profileId: settings.activeProfileId,
    adapter,
    myName: settings.myName,
    soul: settings.soul,
    yourName: settings.yourName,
    workspaceDir: settings.workspaceDir,
    autoCleanup: settings.autoCleanup,
    yoloMode: settings.yoloMode,
    locale: settings.locale,
    hooks
  })

  // Wire refs for hook access
  memoryManagerRef.current = memoryManager
  knowledgeManagerRef.current = knowledgeManager
  experienceManagerRef.current = experienceManager

  // Keep conversationId ref in sync for the afterSession hook
  conversationIdRef.current = activeConversationKey
    ? String(activeConversationKey.toString())
    : null

  const activeConvTitle = typeof activeConversationKey === 'string'
    ? conversations.find((c) => c.key === activeConversationKey)?.label
    : undefined

  // Set MemoryManager and KnowledgeManager config so background tasks can call the API
  if (apiKey) {
    memoryManager.setConfig(apiKey, baseURL, adapter, model)
    knowledgeManager.setConfig(apiKey, baseURL, adapter, model)
  }

  // Check if memory compression is needed on startup and when API key becomes available.
  // Retry on failure (LLM may return bad JSON) with exponential backoff.
  useEffect(() => {
    if (!apiKey) return
    let attempts = 0
    let timer: ReturnType<typeof setTimeout>
    const attempt = () => {
      memoryManager.ensureMemoryCompressed().then((ok) => {
        if (!ok && attempts < 3) {
          attempts++
          const delay = Math.min(10000 * Math.pow(2, attempts), 60000)
          console.log(`[App] Memory compression will retry in ${delay}ms (attempt ${attempts}/3)`)
          timer = setTimeout(attempt, delay)
        }
      }).catch(() => {})
    }
    attempt()
    return () => clearTimeout(timer)
  }, [apiKey])

  // One-time migration: existing type='experience' memories → knowledge base raw/
  useEffect(() => {
    if (!apiKey) return
    memoryManager.migrateExperienceMemoriesToKnowledge().catch(() => {})
  }, [apiKey])

  // Startup compensation: compile any un-compiled knowledge files
  // Uses enqueueStartupCompile so status icons show correctly in KnowledgePanel
  useEffect(() => {
    if (!apiKey) return
    enqueueStartupCompile()
  }, [apiKey])

  // Open external links in system browser (not Electron webview)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a[href^="http://"], a[href^="https://"]')
      if (anchor) {
        e.preventDefault()
        window.electronAPI.openExternal((anchor as HTMLAnchorElement).href)
      }
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  // Save on close — use synchronous IPC to ensure data reaches DB
  useEffect(() => {
    const handleBeforeUnload = () => {
      saveAllConversationsSync()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [saveAllConversationsSync])

  // Plan panel scroll-to-message
  const [planScrollToMsgId, setPlanScrollToMsgId] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<'chat' | 'canvas' | 'knowledge'>('chat')

  return (
    <ErrorBoundary>
      <XProvider>
        <ConfigProvider
          locale={locale === 'zh' ? zhCN : enUS}
          theme={{
            algorithm:
              settings.theme === 'dark'
                ? antdTheme.darkAlgorithm
                : antdTheme.defaultAlgorithm,
            token: {
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'"
            }
          }}
        >
          <AntdApp>
            <AppLayout
            conversations={conversations.map((c: any) => ({
                key: c.key,
                label: c.label,
                pinned: c.pinned
              }))}
            activeConversationKey={activeConversationKey}
            totalSessions={conversations.length}
            autoCleanup={settings.autoCleanup ?? false}
            onClearAllConversations={clearAllConversations}
            onToggleAutoCleanup={(checked) => saveSettings({ ...settings, autoCleanup: checked })}
            messages={messages}
            onCreateNew={() => { createNewConversation(); regenerateGreeting() }}
            onDeleteConversation={deleteConversation}
            onRenameConversation={renameConversation}
            onSelectConversation={setActiveConversationKey}
            onTogglePinConversation={togglePin}
            tools={tools}
            onToggleTool={toggleTool}
            skills={skills}
            onToggleSkill={toggleSkill}
            onImportSkill={importSkill}
            onDeleteSkill={deleteImportedSkill}
            onRefreshSkills={refreshSkillsFromDisk}
            importError={importError}
            memoryManager={memoryManager}
            knowledgeManager={knowledgeManager}
            yoloMode={settings.yoloMode ?? true}
            onToggleYoloMode={(checked: boolean) => saveSettings({ ...settings, yoloMode: checked })}
            activeLoopConvIds={activeLoopConvIds}
            retryingConvIds={retryingConvIds}
            contextLength={contextLength}
            onViewChange={setActiveView}
          >
            <ChatView
              messages={messages}
              isRequesting={isRequesting}
              agentStatus={agentStatus}
              streamingBlocks={streamingBlocks}
              hasApiKey={hasApiKey}
              contextLength={contextLength}
              onSendMessage={handleRequest}
              onCancel={abort}
              onApproveTool={approveTool}
              onRejectTool={rejectTool}
              onKillTool={killTool}
              onRespondToTool={respondToTool}
              onClearError={clearError}
              onRetryLast={retryLast}
              onExtendLoop={extendLoop}
              onResumeExecution={resumeExecution}
              onStopExecution={stopExecution}
              onSaveConversation={saveCurrentConversation}
              conversationId={typeof activeConversationKey === 'string' ? activeConversationKey : undefined}
              conversationTitle={activeConvTitle}
              profiles={settings.profiles}
              activeProfileId={settings.activeProfileId}
              onSelectProfile={(profileId: string) => saveSettings({ ...settings, activeProfileId: profileId })}
              greeting={greeting}
              planScrollToMsgId={planScrollToMsgId}
              onPlanScrollHandled={() => setPlanScrollToMsgId(null)}
            />
          </AppLayout>
          {activeView === 'chat' && <PlanPanel plan={plan} onJumpToStep={setPlanScrollToMsgId} />}
          </AntdApp>
        </ConfigProvider>
      </XProvider>
    </ErrorBoundary>
  )
}

export default App
