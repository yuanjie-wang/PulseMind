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
import { ConfigProvider, App as AntdApp, Button, Dropdown, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import { DownOutlined, FolderOutlined, PlusOutlined } from '@ant-design/icons'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import ChatView from '../components/layout/ChatView'
import { SubAgentSessionView } from '../components/subagent/SubAgentSessionView'
import ErrorBoundary from '../components/ErrorBoundary'
import { InstallNotifier } from '../components/chat/InstallNotifier'
import { useChatController } from '../hooks/useChatController'
import { SettingsProvider, useSettings } from '../hooks/SettingsContext'
import { TranslationProvider, useTranslation } from '../i18n/useTranslation'
import { useWorkbenchStore } from '../stores/workbenchStore'
import { usePreviewPaneStore, DRAFT_CONVERSATION_KEY } from '../stores/previewPaneStore'
import { useNewTaskStore } from '../stores/newTaskStore'
import { usePendingApprovalStore } from '../stores/pendingApprovalStore'
import { usePendingProfileStore } from '../stores/pendingProfileStore'
import { projectHue } from '../stores/projectStore'
import { ProjectExplorer } from './ProjectExplorer'
import { resolvePlanNodeTarget, planNodeIdForSession } from '../agent/plan-node-target'
import { resolveContextWindow, sessionWindowKeyOf, useSessionContextWindowStore } from '../utils/context-window'
import { conversationKeyOf } from '../../../shared/conversation-key'
import { resolvePreviewPath } from '../../../shared/preview/file-kind'
import { DEFAULT_APPROVAL_MODE, type SandboxApprovalMode } from '../../../shared/sandbox/policy'
import { TITLE_BAR_HEIGHT, titleBarRightInset, captionButtonVars } from '../../../shared/window-chrome'
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
type SubAgentViewTarget =
  | { kind: 'plan'; nodeId: string; subConvId: string; title: string }
  | { kind: 'spawn'; subConvId: string; title: string }

/** Where the OS draws this window's controls (macOS left, Windows/Linux right)
 *  — read once, same call the main window's AppLayout makes. */
const windowControls = window.electronAPI.getWindowControls?.() ?? { side: 'right' as const, inset: 0 }
/** Windows/Linux: the header actions wear the caption-button look (they sit
 *  right beside the native min/max/close). macOS keeps the rounded icon button. */
const CAPTION_STYLE_ACTIONS = windowControls.side === 'right'

/** Hand-mirrored from AppLayout's PanelRightIcon (same tight viewBox — the
 *  padded 0..24 canvas made this glyph render smaller than the antd icons
 *  beside it, measured 2026-10-30). */
function PanelRightIcon({ size = 16, filled = false }: { size?: number; filled?: boolean }): React.ReactElement {  return (
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
      <TranslationProvider initialLocale='zh'>
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
      try { window.electronAPI.systemResumedAck() } catch {}
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

  const activeConvKey = conversationKeyOf(activeConversationKey) ?? convId ?? undefined

  /** The project's conversations, for the header switcher. */
  const projectConvs = useMemo(
    () => (isProjectWindow && projectId
      ? (conversations as unknown as Array<{ key: string; label?: string; projectId?: string; updatedAt?: string }>)
        .filter((c) => c.projectId === projectId)
      : []),
    [conversations, isProjectWindow, projectId],
  )

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
  const switchProjectConversation = useCallback((next: string): void => {
    if (next === convId) return
    setBooted(false)
    setConvId(next)
  }, [convId])

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
    return () => { cancelled = true }
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
    return () => { cancelled = true }
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
  const changeApprovalMode = useCallback((mode: SandboxApprovalMode): void => {
    // With no conversation yet the click has nothing to write to — hold it for
    // the one the first message will create (useChatController consumes it).
    if (activeConvKey) updateConversationApproval(activeConvKey, mode)
    else usePendingApprovalStore.getState().setMode(mode)
  }, [activeConvKey, updateConversationApproval])

  // ── 模型 — same per-conversation shape as AppContent (pin > column >
  // default), including the overflow re-aim pin bookkeeping. The draft arm
  // rides pendingProfileStore, exactly as the main window's welcome composer
  // does, so a model picked before the first message is the one it is created
  // with rather than a dead control.
  const pendingProfileId = usePendingProfileStore((s) => s.profileId)
  const activeConvProfileId = activeConvKey
    ? conversations.find((c: any) => c.key === activeConvKey)?.profileId
    : undefined
  const effectiveProfileId: string | undefined = activeConvKey
    ? (activeConvProfileId ?? settings.activeProfileId)
    : (pendingProfileId ?? settings.lastUsedProfileId ?? settings.activeProfileId)
  const profilePinned = activeConvKey ? activeConvProfileId != null : false
  const clearSessionWindow = useSessionContextWindowStore((s) => s.clearConv)
  const pinSessionWindow = useSessionContextWindowStore((s) => s.pin)
  const sessionWindowKey = activeConvKey && effectiveProfileId
    ? sessionWindowKeyOf(activeConvKey, effectiveProfileId)
    : null
  const pinnedSessionWindow = useSessionContextWindowStore((s) =>
    sessionWindowKey ? s.pinned[sessionWindowKey] : undefined)
  useEffect(() => {
    if (agentStatus.status === 'retrying' && agentStatus.contextWindow != null && activeConvKey && effectiveProfileId) {
      pinSessionWindow(activeConvKey, effectiveProfileId, agentStatus.contextWindow)
    }
  }, [agentStatus, activeConvKey, effectiveProfileId, pinSessionWindow])
  const profileContextLength = resolveContextWindow(
    settings.profiles ?? [],
    effectiveProfileId,
    settings.activeProfileId,
  )
  const displayContextLength = pinnedSessionWindow != null
    ? Math.min(profileContextLength, pinnedSessionWindow)
    : profileContextLength
  const changeProfile = useCallback((profileId: string): void => {
    if (activeConvKey) {
      if (profileId !== effectiveProfileId) clearSessionWindow(activeConvKey)
      updateConversationProfile(activeConvKey, profileId)
    } else {
      usePendingProfileStore.getState().setProfileId(profileId)
    }
  }, [activeConvKey, effectiveProfileId, updateConversationProfile, clearSessionWindow])
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
        (b) =>
          b.type === 'tool_use' &&
          b.subConvId === subAgentView.subConvId &&
          (b.status === 'running' || b.status === 'queued' || b.status === 'pending')
      )
    )
  }, [subAgentView, plan, messages])
  const subAgentPaused = subAgentView !== null && agentStatus.status === 'awaiting_continue'
  const subAgentPlanNode = subAgentView?.kind === 'plan'
    ? plan?.nodes.find(n => n.id === subAgentView.nodeId)
    : null
  const wbKey = activeConvKey ?? DRAFT_CONVERSATION_KEY
  const workbenchOpen = useWorkbenchStore((s) => s.openByConversation[wbKey] ?? false)
  const workbenchWidth = useWorkbenchStore((s) => s.width)
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
  const onOpenNodeReport = useCallback((nodeId: string) => {
    const node = plan?.nodes.find(n => n.id === nodeId)
    if (!node?.reportPath) return
    const wsDir = activeConvKey ? getWorkspaceDir(activeConvKey) : undefined
    usePreviewPaneStore.getState().openFile(activeConvKey ?? null, resolvePreviewPath(node.reportPath, wsDir ?? null))
  }, [plan, activeConvKey, getWorkspaceDir])
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
  const antdTheme = useMemo(
    () => buildAntdTheme(resolvedTheme),
    [resolvedTheme]
  )

  const activeConvTitle = conversations.find((c) => c.key === activeConvKey)?.label

  // ── 项目窗口的草稿面（2026-10-30 用户裁定「新建会话不需要 welcome 页面，干净
  //    点就行」）：输入框上方的空区只放一段居中的提示——项目名 + 一句话。完整
  //    欢迎页的 logo/问候/建议/项目卡在钉死的项目里都没有意义；welcomeHint 一给，
  //    ChatView 就不挂 WelcomeContent。空项目才走这条面（有会话时直接接最新）。
  const draftHint: React.ReactNode = isProjectWindow && project ? (
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
      <div style={{ fontSize: 12, color: 'var(--pm-text-muted)' }}>
        {t('projectWindow.draftSubtitle')}
      </div>
    </div>
  ) : undefined

  // ── Header (project window): the PROJECT is the window's identity, and the
  //    conversation switcher rides it. The dropdown trigger must be no-drag:
  //    the band it sits on is the OS drag region.
  const projectMenu: MenuProps = {
    items: [
      ...projectConvs.map((c) => ({ key: String(c.key), label: c.label || '新对话' })),
      ...(projectConvs.length > 0 ? [{ type: 'divider' as const }] : []),
      { key: '__new__', label: t('projectWindow.newConversation'), icon: <PlusOutlined /> },
    ],
    selectable: true,
    selectedKeys: activeConvKey ? [String(activeConvKey)] : [],
    onClick: ({ key }) => {
      if (key === '__new__') startProjectDraft()
      else switchProjectConversation(key)
    },
  }
  const projectHeader = project ? (
    <Dropdown menu={projectMenu} trigger={['click']} placement='bottomLeft'>
      <div
        data-pm-project-switcher
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          maxWidth: '60%',
          minWidth: 0,
          padding: '4px 8px',
          borderRadius: 6,
          cursor: 'pointer',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        <FolderOutlined style={{ fontSize: 14, color: `hsl(${projectHue(project)} 60% 47%)`, flexShrink: 0 }} />
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
          {project.name}
        </span>
        <DownOutlined style={{ fontSize: 10, color: 'var(--pm-text-quiet)', flexShrink: 0 }} />
      </div>
    </Dropdown>
  ) : null

  const chatView = (
    <ChatView
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
        expertId: c.expertId
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
      <XProvider>
        <ConfigProvider locale={locale === 'zh' ? zhCN : enUS} theme={antdTheme}>
          <AntdApp>
            <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--pm-bg)', overflow: 'hidden' }}>
              <div
                style={{
                  background: 'var(--pm-bg-container)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0 24px',
                  height: TITLE_BAR_HEIGHT,
                  flexShrink: 0,
                  position: 'relative',
                  zIndex: 1,
                  WebkitAppRegion: 'drag'
                } as React.CSSProperties}
              >
                {isProjectWindow ? projectHeader : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, maxWidth: '60%', minWidth: 0 }}>
                    <span
                      style={{
                        fontSize: FONT_SIZE.lg,
                        fontWeight: FONT_WEIGHT.semibold,
                        color: 'var(--pm-text)',
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
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
                  style={{
                    position: 'absolute',
                    right: 24 + titleBarRightInset(windowControls),
                    top: 0,
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: CAPTION_STYLE_ACTIONS ? 0 : 8,
                    WebkitAppRegion: 'no-drag',
                    ...(CAPTION_STYLE_ACTIONS ? captionButtonVars(resolvedTheme) : {})
                  } as React.CSSProperties}
                >
                  {!isProjectWindow && (
                    <Tooltip title={workbenchOpen ? t('appLayout.hideWorkbench') : t('appLayout.showWorkbench')}>
                      <Button
                        type="text"
                        className={`${CAPTION_STYLE_ACTIONS ? 'pm-caption-btn' : 'header-pane-btn'}${workbenchOpen ? ' on' : ''}`}
                        aria-label={workbenchOpen ? t('appLayout.hideWorkbench') : t('appLayout.showWorkbench')}
                        icon={<PanelRightIcon size={14} filled={workbenchOpen} />}
                        onClick={() =>
                          workbenchOpen
                            ? useWorkbenchStore.getState().setOpen(wbKey, false)
                            : useWorkbenchStore.getState().openTab(wbKey, 'workspace')
                        }
                      />
                    </Tooltip>
                  )}
                </div>
              </div>
              {isProjectWindow ? (
                <ProjectExplorer conversationId={activeConvKey}>
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
                </ProjectExplorer>
              ) : (
                <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
                  <div style={{ height: '100%' }}>{chatView}</div>
                  {subAgentView && (
                    <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: workbenchOpen ? workbenchWidth : 0 }}>
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
              <InstallNotifier messages={messages} />
            </div>
          </AntdApp>
        </ConfigProvider>
      </XProvider>
    </ErrorBoundary>
  )
}
