import React, { useEffect, useMemo, useRef, useState } from 'react'
import { XProvider } from '@ant-design/x'
import { ConfigProvider, theme as antdTheme, App as AntdApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import AppLayout from './components/layout/AppLayout'
import ChatView from './components/layout/ChatView'
import { PlanPanel } from './components/layout/PlanPanel'
import { InstallNotifier } from './components/chat/InstallNotifier'
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
import { useNavigationStore } from './stores/navigationStore'
import { usePendingApprovalStore } from './stores/pendingApprovalStore'
import { conversationKeyOf } from '../../shared/conversation-key'

import { DEFAULT_APPROVAL_MODE, type SandboxApprovalMode } from '../../shared/sandbox/policy'

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
      console.log('[App] System resumed from sleep — acknowledging')
      // Ack immediately, NOT inside requestAnimationFrame: rAF never fires
      // while the window is hidden/occluded (the compositor is suspended),
      // so an rAF-gated ack silently times out and the main process falls
      // back to a full reload — resetting app state on every wake that
      // happens while the window is not on screen.
      try { window.electronAPI.systemResumedAck() } catch {}
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
    isLoadingConversation,
    messages,
    isRequesting,
    createNewConversation,
    reloadConversations,
    getWorkspaceDir,
    deleteConversation,
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
    updateConversationExpert,
    updateConversationApproval,
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
    locale: settings.locale,
    experienceEnabled: settings.experienceEnabled,
    hooks
  })

  // Wire refs for hook access
  memoryManagerRef.current = memoryManager
  knowledgeManagerRef.current = knowledgeManager
  experienceManagerRef.current = experienceManager

  // Mirror the 设置 → 记忆/经验 master switches onto the renderer-side managers
  // (session backfill, startup compression). The main-side managers are synced
  // in settings.handler on every save.
  useEffect(() => {
    const memoryOn = settings.memoryEnabled ?? true
    memoryManager.setPreferences({ autoCaptureEnabled: memoryOn, autoInjectEnabled: memoryOn })
    experienceManager.setEnabled(settings.experienceEnabled ?? true)
  }, [memoryManager, experienceManager, settings.memoryEnabled, settings.experienceEnabled])

  // Keep conversationId ref in sync for the afterSession hook
  conversationIdRef.current = activeConversationKey
    ? String(activeConversationKey.toString())
    : null

  // The open conversation, resolved once: `activeConversationKey` is `''` while
  // nothing is open (see conversationKeyOf), and `''` is not a conversation — it
  // is why a 授权 click used to write to a row with an empty id instead of being
  // held for the one the first message creates.
  const activeConvKey = conversationKeyOf(activeConversationKey)

  const activeConvTitle = activeConvKey
    ? conversations.find((c) => c.key === activeConvKey)?.label
    : undefined

  // ── 授权档位 (composer's 授权 button, formerly the sidebar YOLO switch) ──
  // Approval belongs to the conversation, not to its project or to a global
  // setting: each conversation carries its own level (absent = the shared
  // default, 按需确认 — see DEFAULT_APPROVAL_MODE), and the session manager
  // re-reads it on every ask so a change lands on the next message. The button
  // must resolve the fallback exactly as the engine does, or it would label a
  // fresh conversation 全部允许 while the ladder holds calls.
  const pendingApprovalMode = usePendingApprovalStore((s) => s.mode)
  const approvalMode: SandboxApprovalMode = activeConvKey
    ? (conversations.find((c: any) => c.key === activeConvKey)?.approvalMode ?? DEFAULT_APPROVAL_MODE)
    : (pendingApprovalMode ?? DEFAULT_APPROVAL_MODE)
  const changeApprovalMode = (mode: SandboxApprovalMode): void => {
    // With no conversation yet the click has nothing to write to — hold it for
    // the one the first message will create (useChatController consumes it).
    if (activeConvKey) updateConversationApproval(activeConvKey, mode)
    else usePendingApprovalStore.getState().setMode(mode)
  }

  // Set MemoryManager and KnowledgeManager config so background tasks can call the API
  if (apiKey) {
    memoryManager.setConfig(apiKey, baseURL, adapter, model)
    knowledgeManager.setConfig(apiKey, baseURL, adapter, model)
  }

  // Check if memory compression is needed on startup and when API key becomes available.
  // Retry on failure (LLM may return bad JSON) with exponential backoff.
  // Skipped entirely while the 记忆 master switch is off.
  useEffect(() => {
    if (!apiKey || settings.memoryEnabled === false) return
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
  }, [apiKey, settings.memoryEnabled])

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
  // Top-level view lives in the navigation store (PLAN-0.4.0 M1.2); the chat
  // check only decides whether the plan panel floats above the chat.
  const activeView = useNavigationStore((s) => s.view.kind)

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
                pinned: c.pinned,
                updatedAt: c.updatedAt,
                projectId: c.projectId
              }))}
            activeConversationKey={activeConversationKey}
            totalSessions={conversations.length}
            autoCleanup={settings.autoCleanup ?? false}
            onCreateNew={() => { createNewConversation(); regenerateGreeting() }}
            onDeleteConversation={deleteConversation}
            onRenameConversation={renameConversation}
            onSelectConversation={setActiveConversationKey}
            onTogglePinConversation={togglePin}
            skills={skills}
            onToggleSkill={toggleSkill}
            onImportSkill={importSkill}
            onDeleteSkill={deleteImportedSkill}
            onRefreshSkills={refreshSkillsFromDisk}
            importError={importError}
            memoryManager={memoryManager}
            knowledgeManager={knowledgeManager}
            activeLoopConvIds={activeLoopConvIds}
            retryingConvIds={retryingConvIds}
            onReloadConversations={() => reloadConversations()}
          >
            <ChatView
              messages={messages}
              isRequesting={isRequesting}
              isLoadingConversation={isLoadingConversation}
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
              conversationId={activeConvKey}
              conversationTitle={activeConvTitle}
              profiles={settings.profiles}
              activeProfileId={settings.activeProfileId}
              onSelectProfile={(profileId: string) => saveSettings({ ...settings, activeProfileId: profileId })}
              greeting={greeting}
              planScrollToMsgId={planScrollToMsgId}
              onPlanScrollHandled={() => setPlanScrollToMsgId(null)}
              workspaceDir={activeConvKey ? getWorkspaceDir(activeConvKey) : undefined}
              conversations={conversations.map((c: any) => ({
                key: c.key,
                label: c.label,
                pinned: c.pinned,
                updatedAt: c.updatedAt,
                projectId: c.projectId,
                expertId: c.expertId
              }))}
              activeLoopConvIds={activeLoopConvIds}
              onOpenConversation={setActiveConversationKey}
              activeExpertId={
                activeConvKey
                  ? conversations.find((c: any) => c.key === activeConvKey)?.expertId
                  : undefined
              }
              onUnbindExpert={(convId) => updateConversationExpert(convId, null)}
              approvalMode={approvalMode}
              onChangeApprovalMode={changeApprovalMode}
            />
          </AppLayout>
          {activeView === 'chat' && <PlanPanel plan={plan} onJumpToStep={setPlanScrollToMsgId} />}
          <InstallNotifier messages={messages} />
          </AntdApp>
        </ConfigProvider>
      </XProvider>
    </ErrorBoundary>
  )
}

export default App
