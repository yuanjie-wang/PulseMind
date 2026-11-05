// ── PopoutApp: one conversation — or one PROJECT — in its own window ──
// (PLAN-conversation-popout 2026-10-30, user rulings: full-function popout;
// main-window close closes popouts; watching in the popout counts as read;
// closing a popout never touches the session; the popout carries the full
// right-hand workbench. Project windows 2026-10-30: the SAME component bound
// to a project instead of a fixed conversation — it picks the project's most
// recent conversation, offers an in-window switcher, and puts the file surface
// in its own left-hand explorer column.)
//
// The window loads the SAME renderer entry with ?popout=<convId> or
// ?project=<projectId> (main.tsx branches here). This component is deliberately
// a HAND-ALIGNED subset of AppContent, not a refactor of it: the main window's
// boot surface is full of work the secondary window must not do — greeting and
// MCP-summary LLM calls (the main window owns them; doubling them is real
// spend), the one-time memory migration and the knowledge compile queue (two
// windows racing them), NotifyBridge (double desktop notifications), the
// beforeunload save flush (the secondary window never writes transcripts —
// single-writer lives in the main window via adoptConversation).
//
// What it keeps: the controller (savesEnabled:false — it drives turns, the
// main window writes), the approval/model resolution blocks (copied so the
// composer resolves exactly as the engine does), the full ChatView (which
// brings the workbench pane — workspace tree, preview tabs, plan tab — so
// file chips and HTML artifact cards open the popout's OWN preview), the
// sub-agent drill-in overlay, and the theme/i18n/settings bootstrap.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { XProvider } from '@ant-design/x'
import { ConfigProvider, App as AntdApp, Button, Dropdown, Layout, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import { DownOutlined, FolderOutlined, PlusOutlined } from '@ant-design/icons'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import ChatView from '../components/layout/ChatView'
import { SubAgentSessionView } from '../components/subagent/SubAgentSessionView'
import ErrorBoundary from '../components/ErrorBoundary'
import { InstallNotifier } from '../components/chat/InstallNotifier'
import { useChatController } from '../hooks/useChatController'
import { useFloatOverlayShift } from '../hooks/useFloatOverlayShift'
import { SettingsProvider, useSettings } from '../hooks/SettingsContext'
import { TranslationProvider, useTranslation } from '../i18n/useTranslation'
import { useWorkbenchStore, useConversationPrimary } from '../stores/workbenchStore'
import { useBrowserPaneStore } from '../stores/browserPaneStore'
import { PRIMARY_CYCLE_ICON, PRIMARY_CYCLE_TITLE, cyclePrimaryMode } from '../components/layout/primary-cycle'
import { usePreviewPaneStore, DRAFT_CONVERSATION_KEY } from '../stores/previewPaneStore'
import { useSecondaryLayoutStore } from '../stores/secondaryLayoutStore'
import { useNewTaskStore } from '../stores/newTaskStore'
import { usePendingApprovalStore } from '../stores/pendingApprovalStore'
import { usePendingProfileStore } from '../stores/pendingProfileStore'
import { projectHue, useProjectStore } from '../stores/projectStore'
import { ProjectExplorer } from './ProjectExplorer'
import { ImmersivePanels } from './ImmersivePanels'
import { ConversationLightDot, ConversationLightDotStyle } from '../components/layout/ConversationLightDot'
import { CONVERSATION_PAGE_SIZE } from '../components/layout/ConversationRows'
import { resolvePlanNodeTarget, planNodeIdForSession } from '../agent/plan-node-target'
import { resolveContextWindow, sessionWindowKeyOf, useSessionContextWindowStore } from '../utils/context-window'
import { reportSilentFailure } from '../utils/notify-core'
import { conversationKeyOf } from '../../../shared/conversation-key'
import { resolvePreviewPath } from '../../../shared/preview/file-kind'
import { DEFAULT_APPROVAL_MODE, type SandboxApprovalMode } from '../../../shared/sandbox/policy'
import { TITLE_BAR_HEIGHT, titleBarActionsRight, captionButtonVars } from '../../../shared/window-chrome'
import { WORKBENCH_CARD_MARGIN, clampPaneWidth } from '../../../shared/browser/pane'
import { IMMERSIVE_CARD_RADIUS } from '../../../shared/ui/layout-widths'
import { storedMessagesToAgentMessages } from '../utils/message-utils'
import { installFileDropGuard } from '../utils/file-drop-guard'
import { startTitleBarMaskWatcher } from '../utils/title-bar-mask'
import { buildAntdTheme } from '../theme/tokens'
import { resolveThemePreference, type ThemePreference } from '../theme/palette'
import { applyThemeAttr, readThemeMirror, writeThemeMirror } from '../theme/dom'
import { setThemeMode } from '../theme/mode'
import { createLlmAdapter } from '../llm/index'
import { FONT_SIZE, FONT_WEIGHT } from '../theme/tokens'
import type { Project } from '../../../shared/types/project'
import type { CompactionEvent } from '../../../shared/agent-protocol'
import type { SteerOutcome } from '../types/agent'

/** What a sub-agent drill-in points at — the same shape App.tsx owns; the
 *  popout runs its own instance because its ChatView needs the callbacks. */
type SubAgentViewTarget = { kind: 'plan'; nodeId: string; subConvId: string; title: string } | { kind: 'spawn'; subConvId: string; title: string }

/** Where the OS draws this window's controls (macOS left, Windows/Linux right)
 *  — read once, same call the main window's AppLayout makes. */
const windowControls = window.electronAPI.getWindowControls?.() ?? { side: 'right' as const, inset: 0 }
/** Right offset for the action cluster: OS strip + its own gutter (Windows/Linux
 *  uses the tighter one, matching the caption buttons beside it). */
const TITLE_BAR_ACTIONS_RIGHT = titleBarActionsRight(windowControls)
/** Windows/Linux: the header actions wear the caption-button look (they sit
 *  right beside the native min/max/close). macOS keeps the rounded icon button. */
const CAPTION_STYLE_ACTIONS = windowControls.side === 'right'

/** Hand-mirrored from AppLayout's PanelRightIcon (same tight viewBox — the
 *  padded 0..24 canvas made this glyph render smaller than the antd icons
 *  beside it, measured 2026-10-30). */
function PanelRightIcon({ size = 16, filled = false }: { size?: number; filled?: boolean }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="2 3 20 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="15" y1="4" x2="15" y2="20" />
      {filled && <rect x="16.5" y="6" width="3" height="12" rx="1" fill="currentColor" stroke="none" />}
    </svg>
  )
}

export function PopoutApp({ convId, projectId }: { convId?: string; projectId?: string }): React.ReactElement {
  // The secondary-window entry renders PopoutApp directly (main.tsx), so the
  // providers the full App() supplies around its own AppContent must be
  // supplied here — useSettings/useTranslation both throw without them.
  return (
    <SettingsProvider>
      <TranslationProvider initialLocale="zh">
        <PopoutContent fixedConvId={convId} projectId={projectId} />
      </TranslationProvider>
    </SettingsProvider>
  )
}

function PopoutContent({ fixedConvId, projectId }: { fixedConvId?: string; projectId?: string }): React.ReactElement {
  const { settings, loading, hasApiKey, activeProfile } = useSettings()
  const { t, locale, setLocale } = useTranslation()

  // ── Which conversation this window carries ──
  // A conversation popout is fixed at ?popout=<convId>; a project window
  // resolves its own (the project's most recent conversation) and follows the
  // in-window switcher. ONE state variable drives the boot effect below, so
  // 「switch」 is just a new value — and the boot below is snapshot-first, the
  // same re-attach a mid-run popout does.
  const isProjectWindow = projectId != null
  const [convId, setConvId] = useState<string | null>(fixedConvId ?? null)
  const [project, setProject] = useState<Project | null>(null)
  const [booted, setBooted] = useState(false)
  // Latest-value mirror for the project boot effect (it must not re-run when
  // createNewConversation's identity changes).
  const createNewConversationRef = useRef<((projectId?: string) => void) | null>(null)

  // Sync settings.locale -> TranslationProvider on load and when settings change
  // (same contract as AppContent — fixes the zh flash for en users).
  useEffect(() => {
    if (settings.locale && settings.locale !== locale) {
      setLocale(settings.locale as 'zh' | 'en')
    }
  }, [settings.locale, locale, setLocale])

  // Sleep/resume ack: per-window correct, cheap — keep.
  useEffect(() => {
    const unsub = window.electronAPI?.onSystemResumed(() => {
      try {
        window.electronAPI.systemResumedAck()
      } catch {}
    })
    return unsub
  }, [])

  const apiKey = activeProfile?.apiKey ?? null
  const baseURL = activeProfile?.baseURL ?? settings.profiles[0]?.baseURL ?? ''
  const model = activeProfile?.model ?? settings.profiles[0]?.model ?? ''
  const maxTokens = activeProfile?.maxTokens ?? settings.profiles[0]?.maxTokens ?? 8192
  const contextLength = activeProfile?.contextLength ?? settings.profiles[0]?.contextLength ?? 128000
  const adapter = useMemo(() => createLlmAdapter(activeProfile?.provider ?? 'anthropic'), [activeProfile?.provider])

  const {
    conversations,
    activeConversationKey,
    isLoadingConversation,
    messages,
    lastCompaction,
    isRequesting,
    getWorkspaceDir,
    handleRequest,
    sendStagedNow,
    abort,
    steer,
    agentStatus,
    streamingBlocks,
    approveTool,
    rejectTool,
    killTool,
    respondToTool,
    clearError,
    retryLast,
    extendLoop,
    convLights,
    updateConversationExpert,
    updateConversationApproval,
    updateConversationProfile,
    plan,
    stopExecution,
    resumeExecution,
    getOrCreateEngine,
    activateEngine,
    activateConversation,
    seedSessionSnapshot,
    createNewConversation,
    createBrowserTask,
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
    locale: settings.locale,
    // Single-writer: this window drives turns; the MAIN window owns every
    // transcript write (it adopts the conversation the moment this window
    // claims it — see App.tsx's onPopoutEvent wiring and the watch effect
    // below for project windows).
    savesEnabled: false,
  })
  // Latest-value mirror for the project boot effect: createNewConversation is
  // NOT referentially stable (it closes over the conversation list), so naming
  // it in that effect's deps would re-run the boot on every list change.
  // eslint-disable-next-line react-hooks/refs -- latest mirror; the boot effect is project-mount-only
  createNewConversationRef.current = createNewConversation

  // ── 发送按钮的项目色（2026-10-30 用户反馈「发送按钮还是需要使用项目配色」）──
  // ChatView 的 composerProjectHue 走 useProjectHue → useProjectStore，而这个
  // 窗口是直接 projectGet 的，store 从未加载 → hue 恒 undefined，按钮永远是
  // 中性色。挂载即补一次 reload；此后草稿态（钉住的项目）与已 materialize 的
  // 会话（列表上的 projectId）都会拿到自己的色。
  useEffect(() => {
    if (!isProjectWindow) return
    void useProjectStore.getState().reload()
    // ── 三面板入口默认（2026-10-31 用户裁定「进入沉浸模式后，左侧默认选中
    // 文件，右侧默认选中对话」）──：面板选择只在窗口内存里活（store 已不持久
    // 化），挂载即置默认顺带压掉旧持久化 JSON 里的残留字段。
    useSecondaryLayoutStore.getState().setLeftPanel('tree')
    useSecondaryLayoutStore.getState().setRightPanel('chat')
  }, [isProjectWindow])

  const activeConvKey = conversationKeyOf(activeConversationKey) ?? convId ?? undefined

  /** The project's conversations, for the header switcher — most recently
   *  updated first, the same recency order the boot effect picks from, so the
   *  switcher's first page always leads with what the window booted on. */
  const projectConvs = useMemo(
    () =>
      isProjectWindow && projectId
        ? (conversations as unknown as Array<{ key: string; label?: string; projectId?: string; updatedAt?: string }>)
            .filter((c) => c.projectId === projectId)
            .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        : [],
    [conversations, isProjectWindow, projectId],
  )

  // ── Switcher paging (2026-11-01 用户裁定)：默认展示最近的 10 个会话，显示更多
  //    每次追加 10 个，依次类推。计数与开合都留在组件内存里——窗口生命期与项目
  //    绑定，无需重置；antd 会在任意菜单项点击后关闭下拉，所以 open 受控，「显示
  //    更多」的那一次 menu 来源关闭被吞掉，列表原地增长（switcherClickRef 记录
  //    最近一次点击的 key，menu.onClick 先于注入的关闭回调触发——顺序由 antd 的
  //    MenuItem.onInternalClick 保证：item onClick → menu onClick → close）。
  const [switcherLimit, setSwitcherLimit] = useState(CONVERSATION_PAGE_SIZE)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const switcherClickRef = useRef<string | null>(null)

  /** 新建会话 in the project window: bind the project and hand the composer an
   *  empty draft (the row materializes on the first message, M3.6). */
  const startProjectDraft = useCallback((): void => {
    if (!projectId) return
    useNewTaskStore.getState().setMode('project')
    useNewTaskStore.getState().setProjectId(projectId)
    setConvId(null)
    createNewConversationRef.current?.(projectId)
  }, [projectId])

  /** Switch the project window onto another of its conversations. Only convId
   *  changes — the boot effect re-attaches snapshot-first, and nothing here
   *  writes the transcript, so no flush-then-swap is needed. booted drops so
   *  the old transcript cannot flash while the new one loads. */
  const switchProjectConversation = useCallback(
    (next: string): void => {
      if (next === convId) return
      setBooted(false)
      setConvId(next)
    },
    [convId],
  )
  // Latest-value mirror: the remote-switch subscription below is mount-only
  // (same idiom as createNewConversationRef — the callback closes over convId,
  // so subscribing with it directly would re-subscribe on every switch).
  // eslint-disable-next-line react-hooks/refs -- latest mirror for the mount-only subscription below
  const switchProjectConversationRef = useRef(switchProjectConversation)
  // eslint-disable-next-line react-hooks/refs -- latest mirror for the mount-only subscription below
  switchProjectConversationRef.current = switchProjectConversation

  // ── Remote switch (main-window click on one of this project's conversations)
  // The main window resolves the holding project window and focuses it; this
  // event is the switch order. Main routes by projectId and sends TARGETED
  // (POPOUT_SWITCH is never broadcast — the main window's POPOUT_EVENT handler
  // must not see it), so no project check is needed here. Same id early-return
  // inside switchProjectConversation keeps 「focus only」 clicks from re-booting.
  useEffect(() => {
    if (!isProjectWindow) return
    return window.electronAPI.onPopoutSwitch(({ sessionId }) => {
      switchProjectConversationRef.current(sessionId)
    })
  }, [isProjectWindow])

  // ── Project boot: pick the project's most recent conversation, or start a
  //    project-bound draft when it has none ──
  // Read straight off listConversations (not the controller's list) so the
  // 「empty project vs list still in flight」 distinction is deterministic: the
  // controller's list has no loading flag, and an empty project would then be
  // indistinguishable from a pending fetch. The draft path reuses the M3.6
  // project binding — createNewConversation(projectId) stashes the project for
  // the first message to materialize the row with, so nothing is created until
  // something is actually sent.
  useEffect(() => {
    if (!isProjectWindow || !projectId) return
    let cancelled = false
    void (async () => {
      const [proj, list] = await Promise.all([
        window.electronAPI.projectGet(projectId).catch(() => null),
        window.electronAPI.listConversations().catch(() => []),
      ])
      if (cancelled) return
      setProject(proj ?? null)
      const mine = (list as Array<{ id: string; projectId?: string; updatedAt?: string }>)
        .filter((c) => c.projectId === projectId)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      if (mine.length > 0) {
        setConvId(mine[0].id)
      } else {
        startProjectDraft()
        setBooted(true)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once per project; startProjectDraft is stable
  }, [isProjectWindow, projectId])

  // ── Boot: attach to the current conversation ──
  // NOT persistence.handleSelectConversation: that switch path's cold arm
  // hydrates the ENGINE from DB unguarded, which would clobber a live
  // transcript when the window attaches mid-run. The boot reads the
  // snapshot FIRST — live content mirrors in (the engine is never written),
  // and only a genuinely cold session takes the DB hydrate path. Seeding
  // precedes activation: activateEngine rehydrates React state FROM the
  // mirror, so seeding after it would push nothing into the view until the
  // next event.
  //
  // Re-running on a switch is the same contract: the in-window switcher only
  // sets convId, and nothing here writes the transcript (savesEnabled:false),
  // so a switch needs no flush-then-swap.
  useEffect(() => {
    if (!convId) return
    let cancelled = false
    void (async () => {
      const handle = getOrCreateEngine(convId) // idempotent createSession
      const snap = await window.electronAPI.agentSessionSnapshot(convId).catch(() => null)
      if (cancelled) return
      const liveMsgs = snap && Array.isArray(snap.messages) ? (snap.messages as unknown[]).length : 0
      if (liveMsgs > 0) {
        // Live session (the main window may even be streaming into it):
        // mirror only — NEVER hydrate the engine over live content.
        seedSessionSnapshot(convId, snap!)
        activateEngine(convId)
        activateConversation(convId)
      } else {
        const conv = await window.electronAPI.hydrateConversation(convId).catch(() => null)
        if (cancelled) return
        if (conv && conv.messages.length > 0) {
          const msgs = storedMessagesToAgentMessages(conv.messages)
          // Cold engine: nobody holds live content — the ordinary cold open
          // (loadConversation also fills the local mirror).
          handle.loadConversation(msgs)
          handle.seedHistorySummary(conv.historySummary, conv.historySummaryFrontier)
          handle.loadPlan(convId)
        }
        activateEngine(convId)
        activateConversation(convId)
      }
      if (!cancelled) setBooted(true)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot per conversation; the primitives are stable
  }, [convId])

  // ── Project window: claim the conversation for the single-writer chain ──
  // Main owns the broadcast, so this is the ONLY place the project window
  // speaks: whatever conversation it is driving becomes 「popped out」 for the
  // main window, which then adopts it (mirror + save baseline), clears its
  // unread light and retreats its own view if it was showing it.
  //
  // Keyed on the EFFECTIVE active conversation, not on convId: a draft has no
  // id until the first message materializes the row, at which point
  // activeConversationKey becomes the real id and this effect claims it.
  const watchedKey = conversationKeyOf(activeConversationKey) ?? null
  useEffect(() => {
    if (!isProjectWindow) return
    void window.electronAPI.secondaryWatch(watchedKey)
  }, [isProjectWindow, watchedKey])

  // ── Project window: keep the new-task binding pinned to THIS project ──
  // The draft arm above shows ChatView's welcome form, whose project picker
  // writes useNewTaskStore.projectId directly (ProjectCards) — one click there
  // would send the task into a different project's workspace. The switcher band
  // is hidden (hideTaskSwitcher) but the picker belongs to the welcome content,
  // so the binding is re-asserted instead: any divergence is corrected before
  // the next render sees it. Idempotent (writes only on divergence), so the
  // subscription cannot loop.
  useEffect(() => {
    if (!isProjectWindow || !projectId) return
    const pin = (): void => {
      const s = useNewTaskStore.getState()
      if (s.mode !== 'project' || s.projectId !== projectId) {
        s.setMode('project')
        s.setProjectId(projectId)
      }
    }
    pin()
    return useNewTaskStore.subscribe(pin)
  }, [isProjectWindow, projectId])

  // ── 授权档位 — copied from AppContent: the composer must resolve the
  // fallback exactly as the engine does (pin > column > default), or the
  // button would label a level the next message will not use. The no-open-
  // conversation arm matters in the PROJECT window only (a brand-new empty
  // project starts on a draft) — a popout always carries a real id.
  const pendingApprovalMode = usePendingApprovalStore((s) => s.mode)
  const approvalMode: SandboxApprovalMode = activeConvKey
    ? (conversations.find((c: any) => c.key === activeConvKey)?.approvalMode ?? DEFAULT_APPROVAL_MODE)
    : (pendingApprovalMode ?? settings.lastUsedApprovalMode ?? DEFAULT_APPROVAL_MODE)
  const changeApprovalMode = useCallback(
    (mode: SandboxApprovalMode): void => {
      // With no conversation yet the click has nothing to write to — hold it for
      // the one the first message will create (useChatController consumes it).
      if (activeConvKey) updateConversationApproval(activeConvKey, mode)
      else usePendingApprovalStore.getState().setMode(mode)
    },
    [activeConvKey, updateConversationApproval],
  )

  // ── 模型 — same per-conversation shape as AppContent (pin > column >
  // default), including the overflow re-aim pin bookkeeping. The draft arm
  // rides pendingProfileStore, exactly as the main window's welcome composer
  // does, so a model picked before the first message is the one it is created
  // with rather than a dead control.
  const pendingProfileId = usePendingProfileStore((s) => s.profileId)
  const activeConvProfileId = activeConvKey ? conversations.find((c: any) => c.key === activeConvKey)?.profileId : undefined
  const effectiveProfileId: string | undefined = activeConvKey
    ? (activeConvProfileId ?? settings.activeProfileId)
    : (pendingProfileId ?? settings.lastUsedProfileId ?? settings.activeProfileId)
  const profilePinned = activeConvKey ? activeConvProfileId != null : false
  const clearSessionWindow = useSessionContextWindowStore((s) => s.clearConv)
  const pinSessionWindow = useSessionContextWindowStore((s) => s.pin)
  const sessionWindowKey = activeConvKey && effectiveProfileId ? sessionWindowKeyOf(activeConvKey, effectiveProfileId) : null
  const pinnedSessionWindow = useSessionContextWindowStore((s) => (sessionWindowKey ? s.pinned[sessionWindowKey] : undefined))
  useEffect(() => {
    if (agentStatus.status === 'retrying' && agentStatus.contextWindow != null && activeConvKey && effectiveProfileId) {
      pinSessionWindow(activeConvKey, effectiveProfileId, agentStatus.contextWindow)
    }
  }, [agentStatus, activeConvKey, effectiveProfileId, pinSessionWindow])
  const profileContextLength = resolveContextWindow(settings.profiles ?? [], effectiveProfileId, settings.activeProfileId)
  const displayContextLength = pinnedSessionWindow != null ? Math.min(profileContextLength, pinnedSessionWindow) : profileContextLength
  const changeProfile = useCallback(
    (profileId: string): void => {
      if (activeConvKey) {
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
      if (settings.activeProfileId !== effectiveProfileId) clearSessionWindow(activeConvKey)
      updateConversationProfile(activeConvKey, null)
    } else {
      usePendingProfileStore.getState().clearProfileId()
    }
  }, [activeConvKey, effectiveProfileId, settings.activeProfileId, updateConversationProfile, clearSessionWindow])

  // Open external links in system browser (same global click handler as App).
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

  // No beforeunload save here: the popout never writes transcripts (its own
  // save machinery is gated off), and the MAIN window's flush covers the
  // conversation through the adopted mirror. A popout closing mid-stream is
  // the main window's 10s sweep's business.

  // Swallow file drops with no composer claiming them (file:// navigation).
  useEffect(() => installFileDropGuard(window), [])

  // Windows/Linux caption-button dimming over modal masks.
  useEffect(() => startTitleBarMaskWatcher(), [])

  // ── Sub-agent drill-in — the same state machine AppContent runs (plan DAG
  // node / spawn card entries, overlay over the chat pane). Conversation is
  // fixed here, so the conv-change reset never fires.
  const [planScrollToMsgId, setPlanScrollToMsgId] = useState<string | null>(null)
  const [subAgentView, setSubAgentView] = useState<SubAgentViewTarget | null>(null)
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
  const subAgentPaused = subAgentView !== null && agentStatus.status === 'awaiting_continue'
  const subAgentPlanNode = subAgentView?.kind === 'plan' ? plan?.nodes.find((n) => n.id === subAgentView.nodeId) : null
  const wbKey = activeConvKey ?? DRAFT_CONVERSATION_KEY
  const workbenchOpen = useWorkbenchStore((s) => s.openByConversation[wbKey] ?? false)
  const workbenchWidth = useWorkbenchStore((s) => s.width)
  // 卡片形态（2026-11-04 用户裁定「弹出独立弹窗应该和主窗统一，用圆角矩形包裹
  // 主交互区和右侧边窗口」）：会话弹出窗口与主窗同一套卡片语言——card 直通
  // ChatView（对话卡 + 工作台卡）+ Layout 灰底做窗口底衬，与主窗
  // AppLayout 的 Header(token.colorBgContainer)/Content(colorBgLayout) 分层同构。
  // 项目沉浸窗口不套（它已经在 ProjectExplorer/ImmersivePanels 里自带三列卡）。
  const card = !isProjectWindow
  // chatAreaWidth：pane 宽的 clamp 依据（ChatView 的 browserPaneBinding 观测
  // 自己的根宽写进同一个 store——每个窗口是独立渲染进程，store 天然不跨窗）。
  const chatAreaWidth = useBrowserPaneStore((s) => s.chatAreaWidth)
  // 本窗的主视图模式（2026-11-04 裁定：弹出窗口也要循环钮）。项目沉浸窗口
  // 由 PRIMARY_MODE_CLAMPED 钳在 'chat'，这里的读法对它恒返回 'chat'。
  const primary = useConversationPrimary(wbKey)
  // 浮窗让位（review_20261105 中3）：弹窗自 2026-11-04 起也有 browser 主视图
  // （循环钮 + 种子组 D），dock 下拉浮窗左/右侵进原生 view 的遮挡在弹窗同样
  // 发生——本窗补挂同一测量点。弹窗无换页视图（viewKind 恒 chat），主窗那道
  // viewKind 门在这里没有对应物；项目沉浸窗口被钳位恒 false，零开销。
  useFloatOverlayShift(primary === 'browser')
  // ── welcome 浏览器任务（review_20261105 中1）：与主窗 App 同一条通道 ──
  // URL 表单回车/点历史项 → createBrowserTask 铸容器会话（乐观列表 + browser
  // 主视图绑定）→ pane 快照报到「提交目标」会话名下再开页签。此前 prop 缺省
  // 落到 `?? (() => {})` 的静默 noop——弹窗 welcome 切到浏览器档后提交什么都
  // 不发生。handlePaneAction 按 event.sender 解析窗口，弹窗内调用落弹窗自己
  // 的 pane，通道与主窗完全同构。
  const pendingBrowserUrl = useRef<{ convId: string; url: string } | null>(null)
  const handleBrowserTaskStart = useCallback(
    (url: string) => {
      const convId = createBrowserTask(url)
      pendingBrowserUrl.current = { convId, url }
    },
    [createBrowserTask],
  )
  const browserPaneConversationId = useBrowserPaneStore((s) => s.update.conversationId)
  useEffect(() => {
    const pending = pendingBrowserUrl.current
    if (!pending) return
    // 双匹配（review_20261104 中1）：比对提交目标而非当前活跃会话，回声未到
    // 时切走不误导航。
    if (browserPaneConversationId !== pending.convId) return
    pendingBrowserUrl.current = null
    window.electronAPI.browserPaneAction({ op: 'navigate', url: pending.url }).catch((err: unknown) => reportSilentFailure('browser-task-tab', err))
  }, [browserPaneConversationId])
  // welcome 门控与主窗同款：零消息的 chat 优先态不出现（那里没有可换的视图，
  // 头部只留侧栏开关）。流式中 messages 仍可能为空，isRequesting 兜住。
  const showPrimaryCycle = !isProjectWindow && (primary !== 'chat' || messages.length > 0 || isRequesting)
  const CycleIcon = PRIMARY_CYCLE_ICON[primary]
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
  const onOpenNodeReport = useCallback(
    (nodeId: string) => {
      const node = plan?.nodes.find((n) => n.id === nodeId)
      if (!node?.reportPath) return
      const wsDir = activeConvKey ? getWorkspaceDir(activeConvKey) : undefined
      usePreviewPaneStore.getState().openFile(activeConvKey ?? null, resolvePreviewPath(node.reportPath, wsDir ?? null))
    },
    [plan, activeConvKey, getWorkspaceDir],
  )
  const onOpenSubAgent = useCallback((subConvId: string, title: string) => {
    setSubAgentView({ kind: 'spawn', subConvId, title })
  }, [])
  const highlightPlanNodeId = useMemo(() => {
    if (!subAgentView) return null
    if (subAgentView.kind === 'plan') return subAgentView.nodeId
    return planNodeIdForSession(plan, messages, subAgentView.subConvId)
  }, [subAgentView, plan, messages])
  // Fresh plan opens the workbench on its tab (same funnel as AppContent —
  // the popout's own workbench, its own store).
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

  // ── Theme — same resolution as AppContent (mirror carries the previous
  // session's preference until settings load; per-window because every
  // window runs this block against the shared localStorage mirror).
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
  useLayoutEffect(() => {
    setThemeMode(resolvedTheme)
    applyThemeAttr(resolvedTheme)
  }, [resolvedTheme])
  useEffect(() => {
    writeThemeMirror(themePref)
  }, [themePref])
  const antdTheme = useMemo(() => buildAntdTheme(resolvedTheme), [resolvedTheme])

  const activeConvTitle = conversations.find((c) => c.key === activeConvKey)?.label
  // 头部标题行左侧的状态灯（2026-11-01 用户裁定「附加 icon」）：与切换器菜单行
  // 同一张 convLights 表；槽位恒占位，亮不亮都不动文字轴。
  const headerLight = activeConvKey ? (convLights[String(activeConvKey)] ?? null) : null

  // ── 项目窗口的草稿面（2026-10-30 用户裁定「新建会话不需要 welcome 页面，干净
  //    点就行」）：输入框上方的空区只放一段居中的提示——项目名 + 一句话。完整
  //    欢迎页的 logo/问候/建议/项目卡在钉死的项目里都没有意义；welcomeHint 一给，
  //    ChatView 就不挂 WelcomeContent。空项目才走这条面（有会话时直接接最新）。
  const draftHint: React.ReactNode =
    isProjectWindow && project ? (
      <div
        data-pm-draft-hint
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: 24,
          textAlign: 'center',
        }}
      >
        <FolderOutlined style={{ fontSize: 26, color: `hsl(${projectHue(project)} 60% 47%)` }} />
        <div style={{ fontSize: 15, fontWeight: FONT_WEIGHT.semibold, color: 'var(--pm-text-strong)' }}>
          {t('projectWindow.draftTitle', { name: project.name })}
        </div>
        <div style={{ fontSize: 12, color: 'var(--pm-text-muted)' }}>{t('projectWindow.draftSubtitle')}</div>
      </div>
    ) : undefined

  // ── Header (project window): two lines (2026-11-01 用户裁定) — the PROJECT
  //    name is the small identity line, the CONVERSATION title is the big
  //    second line and carries the switcher (▾ + title, same line). The
  //    dropdown trigger must be no-drag: the band it sits on is the OS drag
  //    region. Rows carry the same task-status dot as the sidebar
  //    (statusToLight via convLights — a status light exists only for sessions
  //    this window has mirrored, i.e. ones it booted on or switched to; a
  //    conversation driven elsewhere without ever being visited here stays
  //    unlit, the same per-window semantics the main sidebar has).
  const visibleConvs = projectConvs.slice(0, switcherLimit)
  const hiddenConvCount = projectConvs.length - visibleConvs.length
  const projectMenu: MenuProps = {
    items: [
      ...visibleConvs.map((c) => {
        const light = convLights[String(c.key)] ?? null
        return {
          key: String(c.key),
          label: (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              {/* Reserved gutter keeps every title aligned whether or not the
                  conversation is lit — same recipe as the sidebar rows. */}
              <span data-pm-switcher-light={light ?? undefined} style={{ width: 10, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
                {light ? <ConversationLightDot light={light} /> : null}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label || '新对话'}</span>
            </span>
          ),
        }
      }),
      // 显示更多 stays a menu item: antd closes the dropdown on ANY menu-item
      // click, but the controlled open below swallows exactly that one close,
      // so each click appends the next page in place.
      ...(hiddenConvCount > 0
        ? [
            {
              key: '__more__',
              label: <span style={{ fontSize: 12, color: 'var(--pm-text-muted)' }}>{t('conversationSidebar.showMore', { count: hiddenConvCount })}</span>,
            },
          ]
        : []),
      ...(projectConvs.length > 0 ? [{ type: 'divider' as const }] : []),
      { key: '__new__', label: t('projectWindow.newConversation'), icon: <PlusOutlined /> },
    ],
    selectable: true,
    selectedKeys: activeConvKey ? [String(activeConvKey)] : [],
    onClick: ({ key }) => {
      switcherClickRef.current = key
      if (key === '__more__') setSwitcherLimit((v) => v + CONVERSATION_PAGE_SIZE)
      else if (key === '__new__') startProjectDraft()
      else switchProjectConversation(key)
    },
  }
  const projectHeader = project ? (
    <div
      style={
        {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 1,
          maxWidth: '60%',
          minWidth: 0,
        } as React.CSSProperties
      }
    >
      {/* 两行共用同一 16|1fr|16 网格模板（2026-11-01 用户裁定「上下两行的文字
          居中对齐」）：行首/行尾附件（图标/状态灯/▾）各占等宽端槽，文字列中心
          = 盒中心 = 列轴——附件挂在文字两侧，不把文字挤偏（旧 flex 版里图标
          把上行文字挤右 8px、▾ 把下行挤左 8px，两条文字轴差 16px）。 */}
      <span
        data-pm-project-name
        style={{
          display: 'grid',
          gridTemplateColumns: '16px minmax(0, 1fr) 16px',
          columnGap: 4,
          alignItems: 'center',
          maxWidth: '100%',
          minWidth: 0,
          fontSize: FONT_SIZE.sm,
          fontWeight: FONT_WEIGHT.medium,
          color: 'var(--pm-text-muted)',
          lineHeight: 1.2,
        }}
      >
        <FolderOutlined style={{ fontSize: 12, color: `hsl(${projectHue(project)} 60% 47%)`, justifySelf: 'end' }} />
        <span data-pm-project-name-text style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>
          {project.name}
        </span>
      </span>
      <Dropdown
        menu={projectMenu}
        trigger={['click']}
        placement="bottomLeft"
        open={switcherOpen}
        // Probe/scoping anchor: the switcher's popup is the only antd dropdown
        // this window keeps mounted, so the probe can address it unambiguously.
        classNames={{ root: 'pm-switcher-dropdown' }}
        onOpenChange={(next, info) => {
          // The switcher must close on a real switch (menu item), the trigger and
          // outside clicks — everything EXCEPT the 显示更多 item's own close
          // request (source 'menu'), which is swallowed so the next page renders
          // in place. switcherClickRef only ever names __more__ when that item
          // was the last thing clicked, so no other close is affected.
          if (!next && info.source === 'menu' && switcherClickRef.current === '__more__') return
          setSwitcherOpen(next)
        }}
      >
        <div
          data-pm-project-switcher
          style={
            {
              display: 'grid',
              gridTemplateColumns: '16px minmax(0, 1fr) 16px',
              columnGap: 4,
              alignItems: 'center',
              maxWidth: '100%',
              minWidth: 0,
              padding: '0 8px',
              borderRadius: 6,
              cursor: 'pointer',
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties
          }
        >
          {/* 状态灯槽位恒占位（切换器菜单行同一配方）：亮不亮都不动文字轴。 */}
          <span data-pm-header-light={headerLight ?? undefined} style={{ display: 'flex', justifyContent: 'center' }}>
            {headerLight ? <ConversationLightDot light={headerLight} /> : null}
          </span>
          <span
            data-pm-switcher-title
            style={{
              fontSize: FONT_SIZE.lg,
              fontWeight: FONT_WEIGHT.semibold,
              color: 'var(--pm-text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              lineHeight: 1.3,
              textAlign: 'center',
            }}
          >
            {activeConvTitle || t('projectWindow.draftConversation')}
          </span>
          <DownOutlined style={{ fontSize: 10, color: 'var(--pm-text-quiet)', justifySelf: 'end' }} />
        </div>
      </Dropdown>
    </div>
  ) : null

  const chatView = (
    <ChatView
      card={card}
      messages={messages}
      isRequesting={isRequesting}
      isLoadingConversation={isLoadingConversation || !booted}
      lastCompaction={lastCompaction as CompactionEvent | null}
      agentStatus={agentStatus}
      streamingBlocks={streamingBlocks}
      hasApiKey={hasApiKey}
      contextLength={displayContextLength}
      onOpenPlanNode={onOpenPlanNode}
      onOpenNodeReport={onOpenNodeReport}
      onOpenSubAgent={onOpenSubAgent}
      highlightPlanNodeId={highlightPlanNodeId}
      hideComposer={!!subAgentView}
      // The project window renders the file surface itself (ProjectExplorer)
      // and pins the project — so this column must not dock a second copy of
      // it, and the welcome form must not offer a way out of the project.
      hideWorkbench={isProjectWindow}
      hideTaskSwitcher={isProjectWindow}
      // 草稿态不引入 welcome 页（2026-10-30 用户裁定「干净点就行」）：一段居中
      // 的提示替代整个欢迎页，composer 照常在底部。
      welcomeHint={draftHint}
      canOpenNode={canOpenNode}
      onSendMessage={handleRequest}
      onBrowserTaskStart={handleBrowserTaskStart}
      onSendStaged={sendStagedNow}
      onSteer={(text: string) => steer(text) as Promise<SteerOutcome>}
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
      conversationId={activeConvKey}
      conversationTitle={activeConvTitle}
      profiles={settings.profiles}
      activeProfileId={effectiveProfileId}
      profilePinned={profilePinned}
      onSelectProfile={changeProfile}
      onResetProfile={resetProfile}
      planScrollToMsgId={planScrollToMsgId}
      onPlanScrollHandled={() => setPlanScrollToMsgId(null)}
      plan={plan}
      onPlanJump={setPlanScrollToMsgId}
      workspaceDir={(activeConvKey ? getWorkspaceDir(activeConvKey) : undefined) ?? (isProjectWindow ? project?.workspaceDir : undefined)}
      conversations={conversations.map((c: any) => ({
        key: c.key,
        label: c.label,
        pinned: c.pinned,
        updatedAt: c.updatedAt,
        projectId: c.projectId,
        expertId: c.expertId,
      }))}
      convLights={convLights}
      // The window is bound to one conversation (popout) or one project
      // (project window): a welcome-page quick entry must not silently rebind
      // it. In the project window they switch WITHIN the project.
      onOpenConversation={(key: string) => {
        if (isProjectWindow) {
          if (projectConvs.some((c) => String(c.key) === key)) switchProjectConversation(key)
          return
        }
      }}
      activeExpertId={conversations.find((c: any) => c.key === activeConvKey)?.expertId}
      onUnbindExpert={(id) => updateConversationExpert(id, null)}
      approvalMode={approvalMode}
      onChangeApprovalMode={changeApprovalMode}
    />
  )

  return (
    <ErrorBoundary>
      {/* The switcher's status dots animate in THIS window (the main sidebar's
          copy never mounts here) — mount the shared keyframes at the root. */}
      <ConversationLightDotStyle />
      <XProvider>
        <ConfigProvider locale={locale === 'zh' ? zhCN : enUS} theme={antdTheme}>
          <AntdApp>
            <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--pm-bg)', overflow: 'hidden' }}>
              <div
                style={
                  {
                    // 与主窗 Header 同色：antd Header 的 background =
                    // token.colorBgContainer（浅 #ffffff / 深 #141414），也就是
                    // --pm-bg。（旧值 --pm-bg-container 全仓从未定义——它一直是
                    // 无效值→透明，只是恰好露出根节点的 --pm-bg 才没露馅。）
                    background: 'var(--pm-bg)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '0 24px',
                    height: TITLE_BAR_HEIGHT,
                    flexShrink: 0,
                    position: 'relative',
                    zIndex: 1,
                    WebkitAppRegion: 'drag',
                  } as React.CSSProperties
                }
              >
                {isProjectWindow ? (
                  projectHeader
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, maxWidth: '60%', minWidth: 0 }}>
                    <span
                      style={{
                        fontSize: FONT_SIZE.lg,
                        fontWeight: FONT_WEIGHT.semibold,
                        color: 'var(--pm-text)',
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {activeConvTitle || ''}
                    </span>
                  </div>
                )}
                {/* Side-pane toggle at the TOP-RIGHT, clear of the OS caption
                    buttons on Windows/Linux (same rule as the main window's
                    header cluster — the OS draws those over the web content).
                    Absent in the project window: its workbench is suppressed,
                    so there is nothing to toggle. */}
                <div
                  data-pm-header-actions
                  style={
                    {
                      position: 'absolute',
                      right: TITLE_BAR_ACTIONS_RIGHT,
                      top: 0,
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: CAPTION_STYLE_ACTIONS ? 0 : 8,
                      WebkitAppRegion: 'no-drag',
                      ...(CAPTION_STYLE_ACTIONS ? captionButtonVars(resolvedTheme) : {}),
                    } as React.CSSProperties
                  }
                >
                  {/* 主视图模式循环（chat → files → browser → chat）：与主窗
                      标题栏同一颗钮、同一份表（primary-cycle.ts）。图标即当前
                      状态；换到 files/browser 时补开 dock，对话列在 dock 可达
                      （chatSlot 只在 dock 渲染）。项目窗口不出现——它没有 dock、
                      hideWorkbench 常开。 */}
                  {showPrimaryCycle && (
                    <Tooltip title={t(PRIMARY_CYCLE_TITLE[primary])}>
                      <Button
                        type="text"
                        data-pm-primary-cycle
                        className={CAPTION_STYLE_ACTIONS ? 'pm-caption-btn' : 'header-pane-btn'}
                        aria-label={t(PRIMARY_CYCLE_TITLE[primary])}
                        icon={<CycleIcon style={{ fontSize: 14 }} />}
                        onClick={() => cyclePrimaryMode(wbKey, primary)}
                      />
                    </Tooltip>
                  )}
                  {!isProjectWindow && (
                    <Tooltip title={workbenchOpen ? t('appLayout.hideWorkbench') : t('appLayout.showWorkbench')}>
                      <Button
                        type="text"
                        className={`${CAPTION_STYLE_ACTIONS ? 'pm-caption-btn' : 'header-pane-btn'}${workbenchOpen ? ' on' : ''}`}
                        aria-label={workbenchOpen ? t('appLayout.hideWorkbench') : t('appLayout.showWorkbench')}
                        icon={<PanelRightIcon size={14} filled={workbenchOpen} />}
                        onClick={() =>
                          workbenchOpen ? useWorkbenchStore.getState().setOpen(wbKey, false) : useWorkbenchStore.getState().openTab(wbKey, 'workspace')
                        }
                      />
                    </Tooltip>
                  )}
                  {/* 项目窗口：频用的「新建会话」从切换器菜单提为直钮（项目侧栏
                      悬停簇同款先例——新建任务 stays a direct button）。 */}
                  {isProjectWindow && (
                    <Tooltip title={t('projectWindow.newConversation')}>
                      <Button
                        type="text"
                        className={CAPTION_STYLE_ACTIONS ? 'pm-caption-btn' : 'header-pane-btn'}
                        aria-label={t('projectWindow.newConversation')}
                        icon={<PlusOutlined />}
                        onClick={startProjectDraft}
                      />
                    </Tooltip>
                  )}
                </div>
              </div>
              {/* 内容区底衬（2026-11-04 卡片统一）：与主窗 AppLayout 的
                  Content 同一机制——antd Layout 自带 colorBgLayout
                  （浅色 #f7f7f8 / 深色算法默认黑）。卡片是白/深灰的
                  var(--pm-bg)，只有落在灰底上才读成一张卡；此前弹窗的内容区
                  直接铺 --pm-bg，套卡就是白上白。项目沉浸窗口同样受益——
                  它的三列卡本来就该浮在这层底衬上。 */}
              <Layout style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                {isProjectWindow ? (
                  <ProjectExplorer conversationId={activeConvKey}>
                    {/* 右卡三面板（2026-10-31 用户裁定「对话 | 浏览器 | 工作计划」）：
                        对话保活 display 切换，浏览器/工作计划按需挂载；plan 与全部
                        回调本组件早已持有（ChatView 只是用它们的一员）。 */}
                    <ImmersivePanels
                      plan={plan}
                      onPlanJump={setPlanScrollToMsgId}
                      onOpenPlanNode={onOpenPlanNode}
                      canOpenNode={canOpenNode}
                      onOpenNodeReport={onOpenNodeReport}
                      highlightPlanNodeId={highlightPlanNodeId}
                    >
                      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
                        {chatView}
                        {subAgentView && (
                          <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: 0 }}>
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
                    </ImmersivePanels>
                  </ProjectExplorer>
                ) : (
                  <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
                    <div style={{ height: '100%' }}>{chatView}</div>
                    {subAgentView && (
                      <div
                        style={{
                          // 与主窗 App.tsx 的 drill-in 覆盖层同款（卡片化
                          // 2026-11-03 / 弹窗统一 2026-11-04）：覆盖层盖住对话卡
                          // 本身——四周 5px 卡边距 + 与工作台卡之间 5px gap，
                          // 盒样式与对话卡同款，视觉上就是同一张卡换了内容。
                          // 视图模式分支同主窗：files/browser 优先下对话住在右侧
                          // 工作台卡，覆盖层锚 dock 卡（宽 = clamp 后的 pane 宽）。
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
                )}
              </Layout>
              <InstallNotifier messages={messages} />
            </div>
          </AntdApp>
        </ConfigProvider>
      </XProvider>
    </ErrorBoundary>
  )
}
