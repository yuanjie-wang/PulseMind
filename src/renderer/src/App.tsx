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
import { useWorkbenchStore, useWorkbenchWidth, useConversationPrimary, conversationPrimaryOf, autoOpenTab } from './stores/workbenchStore'
import { useBrowserPaneStore } from './stores/browserPaneStore'
import { clampPaneWidth, WORKBENCH_CARD_MARGIN } from '../../shared/browser/pane'
import { IMMERSIVE_CARD_RADIUS } from '../../shared/ui/layout-widths'
import { SubAgentSessionView } from './components/subagent/SubAgentSessionView'
import { resolvePlanNodeTarget, planNodeIdForSession } from './agent/plan-node-target'
import { DRAFT_CONVERSATION_KEY, usePreviewPaneStore } from './stores/previewPaneStore'
import { InstallNotifier } from './components/chat/InstallNotifier'
import ErrorBoundary from './components/ErrorBoundary'
import { useChatController } from './hooks/useChatController'
import { useFloatOverlayShift } from './hooks/useFloatOverlayShift'
import { useNavigationStore } from './stores/navigationStore'
import { SettingsProvider, useSettings } from './hooks/SettingsContext'
import { MemoryManager } from './memory/MemoryManager'
import { KnowledgeManager } from './knowledge/KnowledgeManager'
import { enqueueStartupCompile } from './components/knowledge/compile-queue'
import { createLlmAdapter } from './llm/index'
import { generateMcpSummaries } from './agent/mcp-summary-service'
import { useGreeting } from './hooks/useGreeting'
import { resolveContextWindow, sessionWindowKeyOf, useSessionContextWindowStore } from './utils/context-window'
import type { HooksConfig } from './types/hooks'
import { TranslationProvider, useTranslation } from './i18n/useTranslation'
import { usePendingApprovalStore } from './stores/pendingApprovalStore'
import { usePendingProfileStore } from './stores/pendingProfileStore'
import { usePopoutWatchStore, isPoppedOut, routeToProjectWindow } from './stores/popoutWatchStore'
import { conversationKeyOf } from '../../shared/conversation-key'
import type { PopoutWorkbenchSeed } from '../../shared/types/electron-bridge'
import { resolvePreviewPath } from '../../shared/preview/file-kind'
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
      <TranslationProvider initialLocale="zh">
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
type SubAgentViewTarget = { kind: 'plan'; nodeId: string; subConvId: string; title: string } | { kind: 'spawn'; subConvId: string; title: string }

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
        modelMaxTokens: activeProfile!.maxTokens,
        locale: settings.locale,
      }).catch((err: unknown) => reportSilentFailure('mcp-summary', err))
    }
    // Try immediately (cache may not be populated yet at mount time)
    tryGenerate()
    // Also retry when MCP servers change, so new connections get summaries
    const unsub = window.electronAPI?.onMcpServersChanged(() => {
      setTimeout(tryGenerate, 300) // small delay to let mcp-cache settle
    })
    return () => {
      unsub?.()
    }
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
      try {
        window.electronAPI.systemResumedAck()
      } catch {}
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
  const { greeting, regenerateGreeting } = useGreeting(adapter, apiKey, baseURL, model, maxTokens)

  // Stable refs for memory and knowledge managers (set after useChatController is instantiated)
  const memoryManagerRef = useRef<MemoryManager | null>(null)
  const knowledgeManagerRef = useRef<KnowledgeManager | null>(null)
  const experienceManagerRef = useRef<import('./experiences/ExperienceManager').ExperienceManager | null>(null)

  // Ref for conversationId so the afterSession hook can access it
  // (hooks useMemo runs before useChatController's return values are destructured)
  const conversationIdRef = useRef<string | null>(null)

  const hooks: HooksConfig = useMemo(
    () => ({
      beforeSession: (ctx) => {
        console.log('[Hook] beforeSession:', ctx.userMessage.slice(0, 80))
        return ctx
      },
      afterSession: (ctx) => {
        // 提取已移交定时清扫（PLAN-memory-wiki M2c）：afterSession 不再触发 LLM 提取
        console.log('[Hook] afterSession, status:', ctx.status.status)
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
      },
    }),
    [apiKey, baseURL, adapter, model],
  )

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
    createBrowserTask,
    adoptHandoffTask,
    sendStagedNow,
    abort,
    steer,
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
    convLights,
    togglePin,
    reloadConversations,
    updateConversationExpert,
    updateConversationApproval,
    updateConversationProfile,
    plan,
    stopExecution,
    resumeExecution,
    adoptConversation,
    markConversationRead,
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
    hooks,
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

  // ── Popout lifecycle (PLAN-conversation-popout) ──
  // The MAIN window is the single transcript writer: a conversation a popout
  // opens is ADOPTED here (mirror + save baseline) so the ordinary 10s sweep
  // persists it even though the main window never switched onto it. Opening a
  // popout is also the read receipt for that conversation (watching it there
  // counts as watching it — ruling 2026-10-30), and the popped registry feeds
  // the unread light's isRead judgement + the mirror-eviction exclusion.
  // Popping the ACTIVE conversation also returns this window to the welcome
  // page (user ruling 2026-10-30): the same conversation must not be shown in
  // two windows. The main-hosted session and this window's mirror survive the
  // switch (createNewConversation clears the view, never the engines map), so
  // the popout keeps working and the sweep keeps saving.
  const activeConvKeyRef = useRef<string | undefined>(undefined)
  // eslint-disable-next-line react-hooks/refs -- latest mirror for the mount-only popout subscription below
  activeConvKeyRef.current = conversationKeyOf(activeConversationKey)
  const createNewConversationRef = useRef(createNewConversation)
  // eslint-disable-next-line react-hooks/refs -- latest mirror for the mount-only popout subscription below
  createNewConversationRef.current = createNewConversation
  useEffect(() => {
    const unsub = window.electronAPI.onPopoutEvent(({ type, sessionId }) => {
      if (type === 'opened') {
        usePopoutWatchStore.getState().add(sessionId)
        markConversationRead(sessionId)
        if (activeConvKeyRef.current === sessionId) void createNewConversationRef.current()
        void adoptConversation(sessionId)
      } else {
        usePopoutWatchStore.getState().remove(sessionId)
      }
    })
    return unsub
  }, [adoptConversation, markConversationRead])

  // A renderer reload (HMR, the unresponsive-recovery reload) rebuilds the
  // popout registry EMPTY while the popout windows themselves survive — the
  // guard, the unread semantics and the adoption all hang off it, so re-sync
  // from main on mount. Without this a reloaded main window would re-open a
  // popped conversation in-window and stop saving it.
  useEffect(() => {
    void window.electronAPI
      .popoutList()
      .then((ids) => {
        for (const id of ids) {
          usePopoutWatchStore.getState().add(id)
          void adoptConversation(id)
        }
      })
      .catch((err: unknown) => reportSilentFailure('popout-list-sync', err))
  }, [adoptConversation])

  // Keep conversationId ref in sync for the afterSession hook
  // eslint-disable-next-line react-hooks/refs -- afterSession reads the live conversation id; mirrored fresh each render
  conversationIdRef.current = activeConversationKey ? String(activeConversationKey.toString()) : null

  // The open conversation, resolved once: `activeConversationKey` is `''` while
  // nothing is open (see conversationKeyOf), and `''` is not a conversation — it
  // is why a 授权 click used to write to a row with an empty id instead of being
  // held for the one the first message creates.
  const activeConvKey = conversationKeyOf(activeConversationKey)

  const activeConvTitle = activeConvKey ? conversations.find((c) => c.key === activeConvKey)?.label : undefined

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
  // useCallback 不是风格洁癖：App 随引擎的每个流式 tick 重渲染，这三个回调
  // 一旦每次重建，ChatView → InputArea 的 React.memo 就被整体击穿。
  const changeApprovalMode = useCallback(
    (mode: SandboxApprovalMode): void => {
      // With no conversation yet the click has nothing to write to — hold it for
      // the one the first message will create (useChatController consumes it).
      if (activeConvKey) updateConversationApproval(activeConvKey, mode)
      else usePendingApprovalStore.getState().setMode(mode)
    },
    [activeConvKey, updateConversationApproval],
  )

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
  const activeConvProfileId = activeConvKey ? conversations.find((c: any) => c.key === activeConvKey)?.profileId : undefined
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
  // 溢出重瞄准的活体窗口（2026-10-24 harness review B8）：retrying 状态捎来
  // 的会话实报窗口钉进外部 store（utils/context-window.ts，与
  // pendingProfileStore 同款），分母取 min(profile 解析值, 会话实报值)——
  // 引擎侧的压缩链/刻度节都读重瞄准后的数字，圆环跟它对齐才不至于在模型
  // 实际跑满窗口时显示 45%。pin 键带 profileId（review_20261025 中1）：重
  // 瞄准属于产生它的那个模型，引擎侧换 profile 即丢弃（AgentEngine.
  // updateOptions 的 profileId 分支），这里键失配即回落 profile 解析值；
  // changeProfile/resetProfile 再显式 clearConv，拦住 P1→P2→P1 往返对旧键
  // 的重新命中。换会话不失效——引擎的 reaim 本就随会话存续。
  const pinSessionWindow = useSessionContextWindowStore((s) => s.pin)
  const clearSessionWindow = useSessionContextWindowStore((s) => s.clearConv)
  const sessionWindowKey = activeConvKey && effectiveProfileId ? sessionWindowKeyOf(activeConvKey, effectiveProfileId) : null
  const pinnedSessionWindow = useSessionContextWindowStore((s) => (sessionWindowKey ? s.pinned[sessionWindowKey] : undefined))
  useEffect(() => {
    if (agentStatus.status === 'retrying' && agentStatus.contextWindow != null && activeConvKey && effectiveProfileId) {
      pinSessionWindow(activeConvKey, effectiveProfileId, agentStatus.contextWindow)
    }
  }, [agentStatus, activeConvKey, effectiveProfileId, pinSessionWindow])
  // 上下文刻度（composer 圆环）的分母跟会话实际在用的模型走，解析链镜像
  // 主进程 resolveProfile、回落与引擎一致（utils/context-window.ts）。
  // 上方喂给 useChatController 的 contextLength 是 M1.4 主进程托管后的兼容
  // 形参（渲染端引擎选项不参与行为），那个值仍取默认模型是可接受的；这个
  // 显示值是用户实际看到的刻度，必须按会话解析 —— 旧实现直接画默认模型的
  // 窗口，改默认模型的上下文长度会当场穿透到钉了别的模型的会话上
  // （2026-10-18 用户报告「正在用 A，改了默认 B 的参数，错乱」）。
  const profileContextLength = resolveContextWindow(settings.profiles ?? [], effectiveProfileId, settings.activeProfileId)
  const displayContextLength = pinnedSessionWindow != null ? Math.min(profileContextLength, pinnedSessionWindow) : profileContextLength
  const changeProfile = useCallback(
    (profileId: string): void => {
      if (activeConvKey) {
        // 条件镜像引擎侧的 `opts.profileId !== oldProfileId` 才丢 reaim：重选
        // 同一个模型时引擎保留重瞄准，这里也必须保留 pin。清的时机必须显式
        // （review_20261025 低4）——键失配只拦「当前模型 ≠ pin 时的模型」，
        // 拦不住往返切换对旧键的重新命中。
        if (profileId !== effectiveProfileId) clearSessionWindow(activeConvKey)
        updateConversationProfile(activeConvKey, profileId)
      } else {
        usePendingProfileStore.getState().setProfileId(profileId)
      }
    },
    [activeConvKey, effectiveProfileId, updateConversationProfile, clearSessionWindow],
  )
  const resetProfile = useCallback((): void => {
    if (activeConvKey) {
      // 解除钉选后会话回落到全局默认模型——解析值变化才清（同上，镜像引擎）。
      if (settings.activeProfileId !== effectiveProfileId) clearSessionWindow(activeConvKey)
      updateConversationProfile(activeConvKey, null)
    } else {
      usePendingProfileStore.getState().clearProfileId()
    }
  }, [activeConvKey, effectiveProfileId, settings.activeProfileId, updateConversationProfile, clearSessionWindow])

  // 进入 welcome（没有任何会话打开）时刷新一次设置快照：welcome composer 的
  // 授权/模型回退读 settings.lastUsed*，而插件面板等其他表面的修改只落在主
  // 进程的 settings.json —— 不重读的话，新建会话会沿用一块陈旧的「上次使用」。
  // （useChatController 的 materialization 用同一份快照播种列，显示与运行
  // 因此永远一致；这里收缩的只是「上次使用」本身的新鲜度。）
  useEffect(() => {
    if (!activeConvKey) void reloadSettings()
  }, [activeConvKey, reloadSettings])

  // Set KnowledgeManager config so background tasks can call the API.
  // MemoryManager does NOT get one here: since M1.4 every engine is
  // main-hosted, so the merge runs on session-manager's instance — whose
  // runMemoryMergeSweep seeds its own config. This instance's fields are
  // dead for LLM purposes (the panel CRUD path passes config as arguments),
  // and a renderer-side merge trigger would race the main sweep with a
  // watermark the main process can't see.
  if (apiKey) {
    knowledgeManager.setConfig(apiKey, baseURL, adapter, model, maxTokens)
  }

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
        (b) => b.type === 'tool_use' && b.subConvId === subAgentView.subConvId && (b.status === 'running' || b.status === 'queued' || b.status === 'pending'),
      ),
    )
  }, [subAgentView, plan, messages])
  // 冻结树（awaiting_continue，2026-09-29 停止语义）里的 spawn 块仍标 running、
  // 计划节点仍 pending——那是「可恢复的在途工作」，不是「正在运行」：钻入视图的
  // 闪烁光标与「子代理运行中」徽标若照旧点亮，用户按下停止后它们会永远闪烁
  // （用户报告：子代理在完成任务后，光标还在）。冻结是会话级事实，active
  // conversation 的 agentStatus 就是它；继续执行离开 awaiting_continue 后这里
  // 自动恢复 live。
  const subAgentPaused = subAgentView !== null && agentStatus.status === 'awaiting_continue'
  // The drilled-in plan node, read live off the plan: its report fields drive
  // the drill-in header's 查看报告 entry (B3 前半), so a report that lands
  // while the view is open appears without re-opening the view.
  const subAgentPlanNode = subAgentView?.kind === 'plan' ? plan?.nodes.find((n) => n.id === subAgentView.nodeId) : null
  // The docked workbench's own open state — the drill-in overlay must stop at
  // its left edge instead of covering it (user ruling 2026-09-25: 主对话打开了
  // 侧边窗口，进入子对话也要打开). Same key expression ChatView/WorkbenchPane
  // use, so the reserve (ChatView's paddingRight) and the overlay's right
  // inset can never disagree; reading the same store also means opening or
  // closing the dock FROM the sub-agent session re-cuts the overlay live.
  const wbKey = activeConvKey ?? DRAFT_CONVERSATION_KEY
  const workbenchOpen = useWorkbenchStore((s) => s.openByConversation[wbKey] ?? false)
  const workbenchWidth = useWorkbenchWidth()
  // 视图模式：非 chat 主视图下对话住在右侧工作台卡，drill-in 覆盖层跟着
  // 对话卡走（见下方 overlay 盒的两分支）。模式跟任务走，按会话读。
  const primary = useConversationPrimary(wbKey)
  // 浮窗让位（十三期）：浏览器主视图下原生 view 画在一切 DOM 之上，侧边栏
  // /dock 的下拉浮窗右侵/左侵会被遮挡——量浮窗越缘 px 推给 dock 内收 view。
  const viewKindForOverlay = useNavigationStore((s) => s.view.kind)
  useFloatOverlayShift(primary === 'browser' && viewKindForOverlay === 'chat')
  // 卡片化后的 drill-in 覆盖层要盖住「对话卡」本身：右缘 = clamp 后的 pane 宽
  // + 卡边距 + 列间 gap（ChatView 的 reserve 同一把 clamp 尺——旧代码用 raw
  // workbenchWidth，存储值大于今日 chatArea 时覆盖层会越过对话列压到 pane）。
  // chatAreaWidth 由 ChatView 的 ResizeObserver 实测（browserPaneStore）。
  const chatAreaWidth = useBrowserPaneStore((s) => s.chatAreaWidth)
  // pane 快照订阅：welcome 浏览器任务等「页签绑定到新会话」的那一拍。只订阅
  // conversationId（review_20261104 中2）：整个 update 对象在页面加载期间的
  // 每次 url/title 推送都换新引用，整对象订阅会把 AppContent → AppLayout →
  // ChatView 一路拖进无谓重渲染。
  const browserPaneConversationId = useBrowserPaneStore((s) => s.update.conversationId)
  // ── welcome 浏览器任务（PLAN-layout-modes 二期「模式跟任务走」）──
  // URL 表单回车/点历史项：createBrowserTask 铸容器会话（乐观列表 + 浏览器
  // 主视图绑定），等 pane 快照报到「提交目标」会话名下（绑定推送 →
  // BrowserService 回推）再开页签——navigate 不带 tabId 的契约是「无页签时
  // 开新页签直达」。
  const pendingBrowserUrl = useRef<{ convId: string; url: string } | null>(null)
  const handleBrowserTaskStart = useCallback(
    (url: string) => {
      // 三期裁定：URL 提交零消息——createBrowserTask 只铸容器会话（乐观列
      // 表 + 浏览器主视图绑定），pane 绑定后由下方 effect 开页签直达。
      const convId = createBrowserTask(url)
      pendingBrowserUrl.current = { convId, url }
    },
    [createBrowserTask],
  )
  useEffect(() => {
    const pending = pendingBrowserUrl.current
    if (!pending) return
    // 双匹配（review_20261104 中1）：比对提交目标而非当前活跃会话——回声未
    // 到时用户切走，旧守卫会让别的会话的绑定回声替 URL 导航、留下一个从未
    // 导航的悬空容器。
    if (browserPaneConversationId !== pending.convId) return
    pendingBrowserUrl.current = null
    window.electronAPI.browserPaneAction({ op: 'navigate', url: pending.url }).catch((err: unknown) => reportSilentFailure('browser-task-tab', err))
  }, [browserPaneConversationId])
  // ── 扩展会话移交（PLAN-extension-handoff）──
  // 主窗是唯一消费者（次级窗口用 PopoutApp，不注册本监听）：收养 + 两半激活
  // + 主视图切 browser 档都已在 adoptHandoffTask，这里只把移交 URL 挂进上面
  // 同一条 pane 等待管线——pane 快照报到该会话名下即 navigate。cookie 已由
  // 主进程写进 persist:pane，登录态随页面直达。
  useEffect(() => {
    const unsub = window.electronAPI.onConversationHandoff(({ sessionId, title, url }) => {
      const target = url || title
      if (!sessionId || !target) return
      adoptHandoffTask(sessionId, title || url)
      pendingBrowserUrl.current = { convId: sessionId, url: target }
    })
    return unsub
  }, [adoptHandoffTask])
  /** Nodes that resolve to somewhere — drives the graph's cursor and tooltip, so
   *  a node the model never dispatched does not advertise a click it drops. */
  const openableNodeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const n of plan?.nodes ?? []) if (resolvePlanNodeTarget(n, messages)) ids.add(n.id)
    return ids
  }, [plan, messages])
  const canOpenNode = useCallback((nodeId: string) => openableNodeIds.has(nodeId), [openableNodeIds])
  const onOpenPlanNode = useCallback(
    (nodeId: string) => {
      const node = plan?.nodes.find((n) => n.id === nodeId)
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
    },
    [messages, plan],
  )
  /** 报告契约表达面（PLAN-plan-exchange B3 前半）：节点交付的报告在预览窗格
   *  打开——与产物行 DeliverableRows.openRow 同一通道（previewPaneStore.
   *  openFile），报告的行为与其他交付物完全一致；reportPath 由系统铸造，
   *  resolvePreviewPath 只做 workspace 相对 → 绝对的一步。 */
  const onOpenNodeReport = useCallback(
    (nodeId: string) => {
      const node = plan?.nodes.find((n) => n.id === nodeId)
      if (!node?.reportPath) return
      const wsDir = activeConvKey ? getWorkspaceDir(activeConvKey) : undefined
      usePreviewPaneStore.getState().openFile(activeConvKey ?? null, resolvePreviewPath(node.reportPath, wsDir ?? null))
    },
    [plan, activeConvKey, getWorkspaceDir],
  )
  /** The spawn card's own entry into the same view. The card composes the title
   *  from the tool input it holds; liveness is read back off the card, above. */
  const onOpenSubAgent = useCallback((subConvId: string, title: string) => {
    setSubAgentView({ kind: 'spawn', subConvId, title })
  }, [])
  /** 查看子代理会话时，工作计划面板对应模块的高亮键：plan 路由持有点击的
   *  节点 id（会话打开期间节点重派也不丢高亮）；卡片路由（spawn 卡进入，
   *  无节点可点）按节点点击的同一解析反查——纯循环 spawn 无节点，不高亮。 */
  const highlightPlanNodeId = useMemo(() => {
    if (!subAgentView) return null
    if (subAgentView.kind === 'plan') return subAgentView.nodeId
    return planNodeIdForSession(plan, messages, subAgentView.subConvId)
  }, [subAgentView, plan, messages])
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
      // autoOpenTab（视图模式守卫）：'plan' 在三种模式的侧栏集合里，守卫恒
      // 放行——统一入口只为语义一致。
      autoOpenTab(key, 'plan')
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
  const antdTheme = useMemo(() => buildAntdTheme(resolvedTheme), [resolvedTheme])

  // 弹窗 donor seed（2026-10-31 裁定 + 2026-11-04 追加主视图模式）：工作台开/
  // 前置 tab + 预览文件页签/活动文件 + 本窗该会话的主视图模式。in-memory，只走
  // 这次 IPC + 弹窗启动时的一次取回，两个 store 都不持久化；页签即使在工作台
  // 关着时也携带（弹窗里后开工作台照样复原）。两条入口（新建弹窗/聚焦已弹窗）
  // 共用一份——各写一份必然漂移。
  const popoutSeedFor = (key: string): PopoutWorkbenchSeed => {
    const wb = useWorkbenchStore.getState()
    const pp = usePreviewPaneStore.getState()
    return {
      primary: conversationPrimaryOf(key),
      workbenchTab: wb.openByConversation[key] ? wb.activeTab : undefined,
      previewPaths: pp.tabsByConversation[key]?.map((t) => t.path),
      activePreviewPath: pp.activeByConversation[key] ?? null,
    }
  }

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
                projectId: c.projectId,
              }))}
              activeConversationKey={activeConversationKey}
              // 会话头模式循环钮的 welcome 门控：只在「welcome 正在显示」时
              // 隐藏——chat 优先 + 零消息 + 非流式（对齐 ChatView 的
              // isWelcomeForm && primary === 'chat' 早退条件）。浏览器任务
              // 容器（零消息但 browser 优先）不是 welcome，循环钮照常在——
              // 那是它切回对话视图的唯一头部入口。
              activeConvShowCycle={!!activeConvKey && (primary !== 'chat' || messages.length > 0 || isRequesting)}
              totalSessions={conversations.length}
              autoCleanup={settings.autoCleanup ?? false}
              onCreateNew={() => {
                createNewConversation()
                regenerateGreeting()
              }}
              onDeleteConversation={deleteConversation}
              onRenameConversation={renameConversation}
              onSelectConversation={setActiveConversationKey}
              onTogglePinConversation={togglePin}
              onPopoutConversation={(key, label) => {
                void window.electronAPI.popoutOpen(key, label, popoutSeedFor(key))
              }}
              // Same seed on both entries: normally this only raises an existing
              // popout (the registry already holds its seed, ignored on re-open),
              // but a stale registry would otherwise mint a chat-mode window.
              onFocusPoppedConversation={(key) => {
                void window.electronAPI.popoutOpen(key, undefined, popoutSeedFor(key))
              }}
              // The project's immersive window reuses the popout machinery end to
              // end; `popoutOpen` is also what raises a conversation that window
              // is driving, so no extra focus path is needed here.
              onEnterProjectWindow={(projectId, name) => {
                void window.electronAPI.projectWindowOpen(projectId, name)
              }}
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
              convLights={convLights}
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
                    card
                    messages={messages}
                    isRequesting={isRequesting}
                    isLoadingConversation={isLoadingConversation}
                    lastCompaction={lastCompaction}
                    agentStatus={agentStatus}
                    streamingBlocks={streamingBlocks}
                    hasApiKey={hasApiKey}
                    contextLength={displayContextLength}
                    onOpenPlanNode={onOpenPlanNode}
                    onOpenNodeReport={onOpenNodeReport}
                    onOpenSubAgent={onOpenSubAgent}
                    highlightPlanNodeId={highlightPlanNodeId}
                    hideComposer={!!subAgentView}
                    onExtractRoutine={extractRoutine}
                    canOpenNode={canOpenNode}
                    onSendMessage={handleRequest}
                    onBrowserTaskStart={handleBrowserTaskStart}
                    onSendStaged={sendStagedNow}
                    onSteer={steer}
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
                      expertId: c.expertId,
                    }))}
                    convLights={convLights}
                    onOpenConversation={(key) => {
                      // Welcome quick entries: a popped conversation is raised, never
                      // reopened in this window (ruling 2026-10-30). Same for a
                      // project conversation whose immersive window is running —
                      // raise + switch there.
                      if (isPoppedOut(key)) {
                        void window.electronAPI.popoutOpen(key, undefined, popoutSeedFor(key))
                        return
                      }
                      void routeToProjectWindow(conversations, key).then((taken) => {
                        if (taken) return
                        setActiveConversationKey(key)
                      })
                    }}
                    activeExpertId={activeConvKey ? conversations.find((c: any) => c.key === activeConvKey)?.expertId : undefined}
                    onUnbindExpert={(convId) => updateConversationExpert(convId, null)}
                    approvalMode={approvalMode}
                    onChangeApprovalMode={changeApprovalMode}
                  />
                </div>
                {subAgentView && (
                  <div
                    style={{
                      // 卡片化（2026-11-03）：覆盖层盖住对话卡本身——四周 5px
                      // 卡边距 + 与工作台卡之间 5px gap；盒样式与对话卡同款
                      // （圆角边框 + 裁切），视觉上就是同一张卡换了个内容。
                      // 视图模式分支（PLAN-layout-modes）：文件/浏览器优先下
                      // 对话住在右侧工作台卡，覆盖层锚 dock 卡（宽 = clamp 后
                      // 的 pane 宽）——同一语义「对话卡变成子会话」。
                      position: 'absolute',
                      top: WORKBENCH_CARD_MARGIN,
                      ...(primary === 'chat'
                        ? {
                            left: WORKBENCH_CARD_MARGIN,
                            bottom: WORKBENCH_CARD_MARGIN,
                            right: workbenchOpen ? clampPaneWidth(workbenchWidth, chatAreaWidth) + WORKBENCH_CARD_MARGIN * 2 : WORKBENCH_CARD_MARGIN,
                          }
                        : {
                            right: WORKBENCH_CARD_MARGIN,
                            bottom: WORKBENCH_CARD_MARGIN,
                            width: clampPaneWidth(workbenchWidth, chatAreaWidth),
                          }),
                      boxSizing: 'border-box',
                      background: 'var(--pm-bg)',
                      border: '1px solid var(--pm-separator-faint)',
                      borderRadius: IMMERSIVE_CARD_RADIUS,
                      overflow: 'hidden',
                    }}
                  >
                    <SubAgentSessionView
                      subConvId={subAgentView.subConvId}
                      title={subAgentView.title}
                      live={subAgentLive}
                      paused={subAgentPaused}
                      reportPath={subAgentPlanNode?.reportPath}
                      declaredStatus={subAgentPlanNode?.declaredStatus}
                      onOpenReport={() => {
                        if (subAgentView.kind === 'plan') onOpenNodeReport(subAgentView.nodeId)
                      }}
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
