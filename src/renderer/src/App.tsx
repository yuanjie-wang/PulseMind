import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { XProvider } from '@ant-design/x'
import { ConfigProvider, App as AntdApp } from 'antd'
// The base layer first, explicitly: it is `@ant-design/x-markdown`'s own
// `es/XMarkdown/index.css`, which reaches the bundle as a side effect of
// importing `XMarkdown` — and the theme sheets below must land AFTER it.
// Both layers declare `li { margin: … }` at the same specificity (0,1,1), so
// source order decides it, and the theme's `margin: var(--margin-block)` is the
// one the app has always rendered: measured, `li` margin-bottom 14px with the
// base first, 3.5px with the theme first (probe-theme-dark.mjs brackets the two
// orders). Naming the base here is what pins that — before dark mode the order
// came out of the module graph by accident (the base via the chat's `XMarkdown`
// import, light.css via the settings pages), so hoisting the themes into this
// file silently flipped it.
import '@ant-design/x-markdown/es/XMarkdown/index.css'
// Both theme families are loaded once, here: they are disjoint selector sets
// (`.x-markdown-light` / `.x-markdown-dark`) that only define CSS variables, so
// exactly one applies per message — chosen by the container's class
// (theme/mode.ts). They used to arrive as a side effect of the settings pages
// importing light.css, which left the chat's own markdown style dependent on an
// unrelated component being in the bundle (PLAN-dark-mode B4).
import '@ant-design/x-markdown/themes/light.css'
import '@ant-design/x-markdown/themes/dark.css'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import AppLayout from './components/layout/AppLayout'
import ChatView from './components/layout/ChatView'
import { useWorkbenchStore } from './stores/workbenchStore'
import { SubAgentSessionView } from './components/subagent/SubAgentSessionView'
import { resolvePlanNodeTarget } from './agent/plan-node-target'
import { DRAFT_CONVERSATION_KEY } from './stores/previewPaneStore'
import { InstallNotifier } from './components/chat/InstallNotifier'
import ErrorBoundary from './components/ErrorBoundary'
import { useChatController } from './hooks/useChatController'
import { SettingsProvider, useSettings } from './hooks/SettingsContext'
import { MemoryManager } from './memory/MemoryManager'
import { KnowledgeManager } from './knowledge/KnowledgeManager'
import { enqueueStartupCompile } from './components/knowledge/compile-queue'
import { createLlmAdapter } from './llm/index'
import { generateMcpSummaries } from './agent/mcp-summary-service'
import { useGreeting } from './hooks/useGreeting'
import type { HooksConfig } from './types/hooks'
import { TranslationProvider, useTranslation } from './i18n/useTranslation'
import { usePendingApprovalStore } from './stores/pendingApprovalStore'
import { usePendingProfileStore } from './stores/pendingProfileStore'
import { conversationKeyOf } from '../../shared/conversation-key'
import { NotifyBridge } from './utils/notify'
import { reportSilentFailure } from './utils/notify-core'
import { installFileDropGuard } from './utils/file-drop-guard'
import { startTitleBarMaskWatcher } from './utils/title-bar-mask'
import { buildAntdTheme } from './theme/tokens'
import { resolveThemePreference, type ThemePreference } from './theme/palette'
import { applyThemeAttr, readThemeMirror, writeThemeMirror } from './theme/dom'
import { setThemeMode } from './theme/mode'

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

/** What a sub-agent drill-in points at. Two entries into the one session view:
 *  a plan DAG node (PLAN-workbench W12) and a spawn_agent card's 查看子代理会话
 *  icon (a spawn with no plan node — a plain loop, or a single @expert summon —
 *  has no node to click, so the card is the only way in). Only the plan route
 *  knows a node id, and only the card route is a tool call; each is what its own
 *  liveness check reads. */
type SubAgentViewTarget =
  | { kind: 'plan'; nodeId: string; subConvId: string; title: string }
  | { kind: 'spawn'; subConvId: string; title: string }

function AppContent(): React.ReactElement {
  const { settings, loading, hasApiKey, activeProfile, reloadSettings } = useSettings()
  const { locale, setLocale } = useTranslation()

  // Sync settings.locale -> TranslationProvider on load and when settings change
  useEffect(() => {
    if (settings.locale && settings.locale !== locale) {
      setLocale(settings.locale as 'zh' | 'en')
    }
  }, [settings.locale, locale, setLocale])

  // Tab-focus navigation is ON: the browser only paints a focus ring for
  // :focus-visible (keyboard focus), so mouse clicks stay clean without the
  // old capture-phase Tab preventDefault that disabled keyboard navigation
  // app-wide. The mouse-click ring suppression lives in AppLayout's style
  // block (:focus:not(:focus-visible)).

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
      }).catch((err: unknown) => reportSilentFailure('mcp-summary', err))
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
        // Pass the FULL message list (PLAN-experience-iteration): the old
        // text-only pre-filter made the gate's `(Conversation statistics: …)`
        // line undercount every tool call and error, and extractAndSaveAll
        // flattens to text messages internally anyway (one cursor unit).
        if (ctx.messages.length > 0) {
          // Fire-and-forget — single LLM call extracts memories + experience.
          // minDelta=4 (PLAN-memory-extraction-dedup): a thin turn-end delta
          // generalizes into near-duplicates — it waits and accumulates.
          mm.extractAndSaveAll(ctx.messages, apiKey, baseURL, adapter, model, conversationIdRef.current ?? undefined, settings.locale, undefined, { minDelta: 4 }).then(result => {
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
                sourceConversationId: conversationIdRef.current ?? undefined,
                files: result.experienceFiles,
                // Iteration (PLAN-experience-iteration): update target re-aims the save.
                targetName: result.experienceTarget
              }).then(({ record }) => {
                console.log('[SessionReview] Experience saved to experience skill library')
                experienceManagerRef.current?.ensureTriggers(record.name, {
                  adapter, apiKey: apiKey || '', baseURL, model
                }, Boolean(result.experienceTarget)).catch((err: unknown) => console.warn('[SessionReview] Trigger extraction failed:', err))
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
    lastCompaction,
    isRequesting,
    createNewConversation,
    getWorkspaceDir,
    deleteConversation,
    renameConversation,
    setActiveConversationKey,
    handleRequest,
    sendStagedNow,
    abort,
    saveCurrentConversation,
    saveAllConversationsSync,
    agentStatus,
    streamingBlocks,
    approveTool,
    rejectTool,
    killTool,
    respondToTool,
    extractRoutine,
    clearError,
    retryLast,
    extendLoop,
    skills,
    toggleSkill,
    tools,
    toggleTool,
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
    reloadConversations,
    updateConversationExpert,
    updateConversationApproval,
    updateConversationProfile,
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
    // 「新建会话沿用上次选择」：welcome 页没选授权/模型时，第一条消息把它们
    // 作为新会话自己的初始值落列（useChatController 的 materialization）。
    lastUsedApprovalMode: settings.lastUsedApprovalMode,
    lastUsedProfileId: settings.lastUsedProfileId,
    locale: settings.locale,
    experienceEnabled: settings.experienceEnabled,
    hooks
  })

  // Wire refs for hook access
  /* eslint-disable react-hooks/refs -- latest-instance mirrors for hook access below; consumers run in effects and callbacks, never during render */
  memoryManagerRef.current = memoryManager
  knowledgeManagerRef.current = knowledgeManager
  experienceManagerRef.current = experienceManager
  /* eslint-enable react-hooks/refs */

  // Mirror the 设置 → 记忆/经验 master switches onto the renderer-side managers
  // (session backfill, startup compression). The main-side managers are synced
  // in settings.handler on every save.
  useEffect(() => {
    const memoryOn = settings.memoryEnabled ?? true
    memoryManager.setPreferences({ autoCaptureEnabled: memoryOn, autoInjectEnabled: memoryOn })
    experienceManager.setEnabled(settings.experienceEnabled ?? true)
  }, [memoryManager, experienceManager, settings.memoryEnabled, settings.experienceEnabled])

  // Keep conversationId ref in sync for the afterSession hook
  // eslint-disable-next-line react-hooks/refs -- afterSession reads the live conversation id; mirrored fresh each render
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
  // setting: each conversation carries its own level, and the session manager
  // re-reads it on every ask so a change lands on the next message. A
  // conversation that never chose runs at the sticky last-used value
  // (「新建会话沿用上次选择」: every interactive change lands in
  // settings.lastUsedApprovalMode and the next conversation seeds it) — the
  // shared DEFAULT is only the very first run's fallback. The button must
  // resolve the fallback exactly as the engine does, or it would label a
  // fresh conversation 全部允许 while the ladder holds calls.
  const pendingApprovalMode = usePendingApprovalStore((s) => s.mode)
  const approvalMode: SandboxApprovalMode = activeConvKey
    ? (conversations.find((c: any) => c.key === activeConvKey)?.approvalMode ?? DEFAULT_APPROVAL_MODE)
    : (pendingApprovalMode ?? settings.lastUsedApprovalMode ?? DEFAULT_APPROVAL_MODE)
  const changeApprovalMode = (mode: SandboxApprovalMode): void => {
    // With no conversation yet the click has nothing to write to — hold it for
    // the one the first message will create (useChatController consumes it).
    if (activeConvKey) updateConversationApproval(activeConvKey, mode)
    else usePendingApprovalStore.getState().setMode(mode)
  }

  // ── 模型 (composer's model picker) ──
  // The same per-conversation shape as the 授权 block above: a conversation
  // that picked a model carries its own profileId; one that never chose runs
  // at the sticky last-used value (settings.lastUsedProfileId — a fresh
  // conversation seeds it as its own column), and only a conversation that
  // predates that value entirely follows the global default
  // (`settings.activeProfileId`, the settings panel's 默认模型). The picker
  // resolves the fallback exactly as the engine does — pin > column > last
  // used > default — so the label never shows a model the next message will
  // not use. A welcome-picked model rides pendingProfileStore to the
  // conversation the first message creates.
  const pendingProfileId = usePendingProfileStore((s) => s.profileId)
  const activeConvProfileId = activeConvKey
    ? conversations.find((c: any) => c.key === activeConvKey)?.profileId
    : undefined
  // undefined column = following the default; null pending = none picked yet.
  // The fallbacks are asymmetric ON PURPOSE: an EXISTING conversation with no
  // column resolves to the global default (that is what the engine's
  // effectiveProfileId does for it — new conversations get last-used seeded
  // into their column at creation, so they never fall through), while the
  // welcome composer resolves to last-used because that is what the
  // conversation it creates will actually seed.
  const effectiveProfileId: string | undefined = activeConvKey
    ? (activeConvProfileId ?? settings.activeProfileId)
    : (pendingProfileId ?? settings.lastUsedProfileId ?? settings.activeProfileId)
  const profilePinned = activeConvKey ? activeConvProfileId != null : false
  const changeProfile = (profileId: string): void => {
    if (activeConvKey) updateConversationProfile(activeConvKey, profileId)
    else usePendingProfileStore.getState().setProfileId(profileId)
  }
  const resetProfile = (): void => {
    if (activeConvKey) updateConversationProfile(activeConvKey, null)
    else usePendingProfileStore.getState().clearProfileId()
  }

  // 进入 welcome（没有任何会话打开）时刷新一次设置快照：welcome composer 的
  // 授权/模型回退读 settings.lastUsed*，而插件面板等其他表面的修改只落在主
  // 进程的 settings.json —— 不重读的话，新建会话会沿用一块陈旧的「上次使用」。
  // （useChatController 的 materialization 用同一份快照播种列，显示与运行
  // 因此永远一致；这里收缩的只是「上次使用」本身的新鲜度。）
  useEffect(() => {
    if (!activeConvKey) void reloadSettings()
  }, [activeConvKey, reloadSettings])

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
      memoryManager.ensureMemoryMerged().then((ok) => {
        if (!ok && attempts < 3) {
          attempts++
          const delay = Math.min(10000 * Math.pow(2, attempts), 60000)
          console.log(`[App] Memory compression will retry in ${delay}ms (attempt ${attempts}/3)`)
          timer = setTimeout(attempt, delay)
        }
      }).catch((err: unknown) => reportSilentFailure('memory-compress', err))
    }
    attempt()
    return () => clearTimeout(timer)
  }, [apiKey, settings.memoryEnabled])

  // One-time migration: existing type='experience' memories → knowledge base raw/
  useEffect(() => {
    if (!apiKey) return
    memoryManager.migrateExperienceMemoriesToKnowledge().catch((err: unknown) => reportSilentFailure('memory-migrate', err))
  }, [apiKey])

  // Startup compensation: compile any un-compiled knowledge files
  // Uses enqueueStartupCompile so status icons show correctly in KnowledgePanel
  useEffect(() => {
    if (!apiKey) return
    // D7 (PLAN-knowledge-base): startup auto-compile only when explicitly on.
    if (settings.knowledge?.autoCompile) enqueueStartupCompile()
  }, [apiKey, settings.knowledge?.autoCompile])

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

  // Swallow file drops that reach the window with no composer claiming them —
  // Chromium's default would navigate to file:// and replace the whole app UI.
  // The composer opts in itself (its dragover stopPropagates, so this guard's
  // later dropEffect='none' write never overwrites its 'copy').
  useEffect(() => installFileDropGuard(window), [])

  // ── Caption buttons vs. modal masks ──
  // The OS draws the Windows/Linux window buttons above every web surface, so a
  // global modal's dim layer can never dim them (穿帮 over a dimmed header). The
  // watcher reports the combined mask alpha; main repaints the overlay blended
  // to the same darkness. Mounted once here so every antd Modal/Drawer/image
  // preview in the tree is covered without per-dialog wiring.
  useEffect(() => startTitleBarMaskWatcher(), [])

  // Plan panel scroll-to-message
  const [planScrollToMsgId, setPlanScrollToMsgId] = useState<string | null>(null)
  // PLAN-workbench W12: clicking a DAG module drills into the sub-agent session
  // that implements it (or jumps the transcript to the round that settled it).
  // The resolution — plan-node link → spawn block link → msgId — lives in
  // agent/plan-node-target.ts, where it is unit-tested. The spawn card's eye
  // icon opens the same view (see SubAgentViewTarget). The drill-in is an
  // overlay over the chat pane (ChatView stays mounted, AppLayout-style), so a
  // conversation switch underneath it can never leave the header pointing at
  // one conversation while the pane shows another.
  const [subAgentView, setSubAgentView] = useState<SubAgentViewTarget | null>(null)
  // Any conversation change — picking another thread, 新建任务, or the first
  // message materializing the row — exits the drill-in: the view follows a node
  // of the conversation whose DAG was clicked, and nothing else may show it.
  // Reset during render (the documented adjust-state-on-prop-change pattern):
  // an effect would fire after a paint of the mismatched pairing, and one
  // comparison drives both values so they can never disagree.
  const [subAgentViewConvKey, setSubAgentViewConvKey] = useState(activeConvKey)
  if (subAgentViewConvKey !== activeConvKey) {
    setSubAgentViewConvKey(activeConvKey)
    setSubAgentView(null)
  }
  // `live` is derived from what the parent already holds, never stored: it was a
  // click-time snapshot before, so a run that settled while the view was open
  // kept the 运行中 badge, kept `actions` at viewOnly and polled until the
  // 30-minute hard stop said nothing. The plan route reads the node's status;
  // the card route reads the spawn block's own — its subConvId is minted per
  // spawn, so exactly one card carries it, and a conversation restored from the
  // DB has no running card at all (the view then shows it settled, as it should).
  const subAgentLive = useMemo(() => {
    if (!subAgentView) return false
    if (subAgentView.kind === 'plan') {
      return plan?.nodes.find((n) => n.id === subAgentView.nodeId)?.status === 'pending'
    }
    return messages.some((m) =>
      m.contentBlocks.some(
        (b) =>
          b.type === 'tool_use' &&
          b.subConvId === subAgentView.subConvId &&
          (b.status === 'running' || b.status === 'pending')
      )
    )
  }, [subAgentView, plan, messages])
  // 冻结树（awaiting_continue，2026-09-29 停止语义）里的 spawn 块仍标 running、
  // 计划节点仍 pending——那是「可恢复的在途工作」，不是「正在运行」：钻入视图的
  // 闪烁光标与「子代理运行中」徽标若照旧点亮，用户按下停止后它们会永远闪烁
  // （用户报告：子代理在完成任务后，光标还在）。冻结是会话级事实，active
  // conversation 的 agentStatus 就是它；继续执行离开 awaiting_continue 后这里
  // 自动恢复 live。
  const subAgentPaused = subAgentView !== null && agentStatus.status === 'awaiting_continue'
  // The docked workbench's own open state — the drill-in overlay must stop at
  // its left edge instead of covering it (user ruling 2026-09-25: 主对话打开了
  // 侧边窗口，进入子对话也要打开). Same key expression ChatView/WorkbenchPane
  // use, so the reserve (ChatView's paddingRight) and the overlay's right
  // inset can never disagree; reading the same store also means opening or
  // closing the dock FROM the sub-agent session re-cuts the overlay live.
  const wbKey = activeConvKey ?? DRAFT_CONVERSATION_KEY
  const workbenchOpen = useWorkbenchStore((s) => s.openByConversation[wbKey] ?? false)
  const workbenchWidth = useWorkbenchStore((s) => s.width)
  /** Nodes that resolve to somewhere — drives the graph's cursor and tooltip, so
   *  a node the model never dispatched does not advertise a click it drops. */
  const openableNodeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const n of plan?.nodes ?? []) if (resolvePlanNodeTarget(n, messages)) ids.add(n.id)
    return ids
  }, [plan, messages])
  const canOpenNode = useCallback((nodeId: string) => openableNodeIds.has(nodeId), [openableNodeIds])
  const onOpenPlanNode = useCallback((nodeId: string) => {
    const node = plan?.nodes.find(n => n.id === nodeId)
    const target = resolvePlanNodeTarget(node, messages)
    if (!target) return
    if (target.kind === 'session') {
      setSubAgentView({
        kind: 'plan',
        nodeId,
        subConvId: target.subConvId,
        title: node ? `n${nodeId.slice(1)} · ${node.description}` : '子代理会话',
      })
      return
    }
    setPlanScrollToMsgId(target.msgId)
  }, [messages, plan])
  /** The spawn card's own entry into the same view. The card composes the title
   *  from the tool input it holds; liveness is read back off the card, above. */
  const onOpenSubAgent = useCallback((subConvId: string, title: string) => {
    setSubAgentView({ kind: 'spawn', subConvId, title })
  }, [])
  // PLAN-workbench W5: a freshly created plan opens the workbench on its tab
  // (the write→auto-open-preview precedent). Completing a plan does not close
  // it — the user reads the finished graph. The ref is keyed to the
  // conversation: a single global boolean could not tell "a plan was just
  // created here" from "the user navigated away and came back", and replaying
  // the return trip forced the 计划 tab open with nothing new in it.
  const hadPlanRef = useRef<{ convKey: string; has: boolean } | null>(null)
  useEffect(() => {
    const key = activeConvKey ?? DRAFT_CONVERSATION_KEY
    const has = !!plan && !plan.completed
    const prev = hadPlanRef.current
    if (has && prev !== null && prev.convKey === key && !prev.has) {
      useWorkbenchStore.getState().openTab(key, 'plan')
    }
    hadPlanRef.current = { convKey: key, has }
  }, [plan, activeConvKey])

  // ── Theme (PLAN-dark-mode M1) ──
  // The preference is `light | dark | system`; `system` resolves against
  // prefers-color-scheme HERE, in the renderer — the main process resolves the
  // same setting independently for the window background and the title-bar
  // overlay, so neither side waits on the other. The theme mirror carries the
  // previous session's choice while `loading` is true (main.tsx already applied
  // it before React mounted; this keeps the antd theme dark through the load
  // too). applyThemeAttr flips every var(--pm-*) surface via html[data-theme].
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  const [bootThemePref] = useState<ThemePreference | null>(() => readThemeMirror())
  const themePref: ThemePreference = loading && bootThemePref !== null ? bootThemePref : settings.theme
  const resolvedTheme = resolveThemePreference(themePref, systemDark)
  // Layout effect, not effect: the mode store feeds the markdown class name and
  // the Prism style object, and a dark session must not paint one frame of
  // light-mode markdown. Layout effects run before the browser paints.
  useLayoutEffect(() => {
    setThemeMode(resolvedTheme)
    applyThemeAttr(resolvedTheme)
  }, [resolvedTheme])
  useEffect(() => {
    writeThemeMirror(themePref)
  }, [themePref])

  // The theme is a pure function of the resolved mode; memoizing keeps antd's
  // token recomputation (and the cssinjs style churn that follows it) off every
  // render — and the same-value short-circuit keeps an OS flip while a concrete
  // preference is selected from recomputing anything.
  const antdTheme = useMemo(
    () => buildAntdTheme(resolvedTheme),
    [resolvedTheme]
  )

  return (
    <ErrorBoundary>
      <XProvider>
        <ConfigProvider locale={locale === 'zh' ? zhCN : enUS} theme={antdTheme}>
          <AntdApp>
            <NotifyBridge />
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
            onReloadConversations={reloadConversations}
            skills={skills}
            onToggleSkill={toggleSkill}
            tools={tools}
            onToggleTool={toggleTool}
            onImportSkill={importSkill}
            onDeleteSkill={deleteImportedSkill}
            onRefreshSkills={refreshSkillsFromDisk}
            importError={importError}
            memoryManager={memoryManager}
            knowledgeManager={knowledgeManager}
            activeLoopConvIds={activeLoopConvIds}
            retryingConvIds={retryingConvIds}
          >
            {/* The drill-in is a display layer over the chat pane, not a
                replacement for it (AppLayout's own view swap is the precedent):
                a ternary here unmounted ChatView, so the header could switch
                conversations while the pane kept showing the previous one's
                sub-agent transcript — and the welcome page, drafts, scroll
                position and docked panes all froze with it. ChatView therefore
                stays PAINTED (display:none would hide the docked workbench
                together with the chat): the overlay below covers the chat
                column only, so the side window the main chat had open remains
                visible over the sub-agent session (user ruling 2026-09-25). */}
            <div style={{ position: 'relative', height: '100%' }}>
              <div style={{ height: '100%' }}>
                <ChatView
              messages={messages}
              isRequesting={isRequesting}
              isLoadingConversation={isLoadingConversation}
              lastCompaction={lastCompaction}
              agentStatus={agentStatus}
              streamingBlocks={streamingBlocks}
              hasApiKey={hasApiKey}
              contextLength={contextLength}
              onOpenPlanNode={onOpenPlanNode}
              onOpenSubAgent={onOpenSubAgent}
              hideComposer={!!subAgentView}
              onExtractRoutine={extractRoutine}
              canOpenNode={canOpenNode}
              onSendMessage={handleRequest}
              onSendStaged={sendStagedNow}
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
              activeProfileId={effectiveProfileId}
              profilePinned={profilePinned}
              onSelectProfile={changeProfile}
              onResetProfile={resetProfile}
              greeting={greeting}
              planScrollToMsgId={planScrollToMsgId}
              onPlanScrollHandled={() => setPlanScrollToMsgId(null)}
              plan={plan}
              onPlanJump={setPlanScrollToMsgId}
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
              </div>
              {subAgentView && (
                <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: workbenchOpen ? workbenchWidth : 0 }}>
                  <SubAgentSessionView
                    subConvId={subAgentView.subConvId}
                    title={subAgentView.title}
                    live={subAgentLive}
                    paused={subAgentPaused}
                    onBack={() => setSubAgentView(null)}
                  />
                </div>
              )}
            </div>
          </AppLayout>
          <InstallNotifier messages={messages} />
          </AntdApp>
        </ConfigProvider>
      </XProvider>
    </ErrorBoundary>
  )
}

export default App
