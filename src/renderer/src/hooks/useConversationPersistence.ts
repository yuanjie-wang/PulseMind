// ── Conversation persistence & lifecycle ──
// Owns the conversation LIST (useXConversations state: keys, labels, pinning)
// and the save pipeline that flushes engine messages to SQLite — debounced,
// incremental (only unsaved message ids), and serialized through one in-flight
// promise so overlapping renders can't double-save. Also handles conversation
// switching (flush-then-swap), deletion with engine teardown, and auto-cleanup.
// Engine construction itself lives in useConversationEngine; this hook drives it.

import { useEffect, useRef, useCallback, useState } from 'react'
import useXConversations from '@ant-design/x-sdk/es/x-conversations'
import type { AgentMessage, AgentStatus } from '../types/agent'
import type { SessionEngineHandle } from './useConversationEngine'
import { agentMessagesToConversation, storedMessagesToAgentMessages } from '../utils/message-utils'
import { planIncrementalSave } from '../utils/incremental-save'
import type { SandboxApprovalMode } from '../../../shared/sandbox/policy'
import { usePendingApprovalStore } from '../stores/pendingApprovalStore'
import { conversationKeyOf } from '../../../shared/conversation-key'

// ── Hook ──

interface UseConversationPersistenceOptions {
  autoCleanup?: boolean
  messages: AgentMessage[]
  agentStatus: AgentStatus
  // Engine integration
  enginesRef: React.MutableRefObject<Map<string, SessionEngineHandle>>
  activeEngineIdRef: React.MutableRefObject<string>
  getOrCreateEngine: (convId: string) => SessionEngineHandle
  setMessages: React.Dispatch<React.SetStateAction<AgentMessage[]>>
  setAgentStatus: React.Dispatch<React.SetStateAction<AgentStatus>>
  setStreamingBlocks: React.Dispatch<React.SetStateAction<any[]>>
  setPlan: React.Dispatch<React.SetStateAction<any>>
}

export function useConversationPersistence(options: UseConversationPersistenceOptions) {
  const {
    autoCleanup, messages, agentStatus,
    enginesRef, activeEngineIdRef, getOrCreateEngine,
    setMessages, setAgentStatus, setStreamingBlocks, setPlan
  } = options

  // ── Conversation list management (useXConversations) ──
  const {
    conversations,
    activeConversationKey,
    setActiveConversationKey,
    addConversation,
    removeConversation,
    setConversation,
    setConversations
  } = useXConversations()

  // This ref is a POST-COMMIT snapshot: it only syncs in an effect, after React
  // has rendered. The sdk store, by contrast, is updated synchronously by its
  // own methods (addConversation/setConversation). Any list edit derived from
  // the ref in the same synchronous block as one of those methods reads the
  // pre-edit list — see updateConversationApproval for what that costs.
  const conversationsRef = useRef(conversations)
  useEffect(() => { conversationsRef.current = conversations }, [conversations])

  // Sort by pinned first, then by updatedAt descending
  const sortConversations = (items: Array<{ key: string; label: string; pinned?: boolean; updatedAt?: string; projectId?: string }>) => {
    return [...items].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      const aTime = a.updatedAt || ''
      const bTime = b.updatedAt || ''
      return bTime.localeCompare(aTime)
    })
  }

  // ── Save state ──
  const convIdRef = useRef<string>('')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const isSavingRef = useRef(false)
  const saveRef = useRef<() => Promise<void>>(null as unknown as () => Promise<void>)
  /** Tracks persisted message IDs per conversation to enable incremental saves. */
  const savedMsgIdsRef = useRef<Map<string, Set<string>>>(new Map())

  // True while a conversation's messages are being loaded from the DB after a
  // switch. ChatView suppresses the welcome screen during this window so the
  // user doesn't see it flash between the old and new conversation's messages.
  const [isLoadingConversation, setIsLoadingConversation] = useState(false)

  const saveCurrentConversation = useCallback(async () => {
    const convId = convIdRef.current
    if (!convId || isSavingRef.current) return
    // Source messages from the engine keyed by convId — never the shared
    // `messages` state, whose stale closure previously wrote one conversation's
    // messages under another conversation's ID.
    const engine = enginesRef.current.get(convId)
    const msgs = engine?.messages
    if (!msgs || msgs.length === 0) return

    isSavingRef.current = true

    const firstText = msgs[0]?.contentBlocks?.find((b) => b.type === 'text')?.text || ''
    const existingConv = conversations.find(
      (c: { key: string; label: string }) => String(c.key) === convId
    )
    const existingTitle = existingConv?.label && existingConv.label !== '新对话'
      ? existingConv.label
      : null
    const title = existingTitle || firstText || '新对话'

    const conversation = agentMessagesToConversation(msgs, convId, title)
    const hs = engine?.getHistorySummary()
    if (hs) {
      conversation.historySummary = hs.text
      conversation.historySummaryFrontier = hs.firstKeptId
    }

    try {
      // Always do a full save to capture content changes in existing messages
      // (e.g. exitCode set on tool_use after tool execution completes).
      // The incremental save optimization (skipping already-saved message IDs)
      // would miss these in-place updates, causing exitCode to be absent after
      // app restart — which makes completed tools appear as "failed" in the UI.
      await window.electronAPI.saveConversation(conversation)
      savedMsgIdsRef.current.set(convId, new Set(conversation.messages.map(m => m.id)))
      convIdRef.current = convId
    } catch (err) {
      console.error('[Chat] saveCurrentConversation failed, retrying once:', err)
      try {
        await window.electronAPI.saveConversation(conversation)
        savedMsgIdsRef.current.set(convId, new Set(conversation.messages.map(m => m.id)))
        convIdRef.current = convId
      } catch (err2) {
        console.error('[Chat] saveCurrentConversation failed after retry, data may be lost:', err2)
      }
    } finally {
      isSavingRef.current = false
    }
  }, [conversations, enginesRef])
  saveRef.current = saveCurrentConversation

  /** Incremental save: appends only messages that appeared since the last save,
   *  plus a small re-saved tail for in-place block updates. Used for the periodic
   *  save while streaming and the debounced save between loop rounds — a full
   *  saveConversation rewrite over a long task's history (JSON.stringify of every
   *  contentBlocks + re-insert of every tool_result) stalls the main process's
   *  synchronous SQLite on the shared event loop. The full save remains the
   *  end-of-stream and beforeunload path. */
  const saveNewMessages = useCallback(async () => {
    const convId = convIdRef.current
    if (!convId) return
    const engine = enginesRef.current.get(convId)
    const msgs = engine?.messages
    if (!msgs || msgs.length === 0) return

    const savedIds = savedMsgIdsRef.current.get(convId)
    const plan = planIncrementalSave(msgs, savedIds)
    if (plan.mode === 'full') {
      // History shrank in memory (compaction/regeneration) — refresh everything.
      await saveRef.current()
      return
    }
    // Browsing no-op: selecting a conversation reloads its persisted messages
    // into state, which retriggers this debounced save with zero new IDs. The
    // idle tail has nothing to capture, and writing it would stamp the DB's
    // updated_at with "now" — advancing the sidebar's last-interaction time
    // without any interaction. While streaming the tail re-save still runs:
    // in-place block updates (exitCode) need the crash-recovery net.
    if (!plan.hasNew && agentStatus.status !== 'streaming') return
    const fromIdx = plan.fromIdx

    const firstText = msgs[0]?.contentBlocks?.find((b) => b.type === 'text')?.text || ''
    const existingConv = conversations.find((c) => String(c.key) === convId)
    const existingTitle = existingConv?.label && existingConv.label !== '新对话'
      ? existingConv.label
      : null
    const title = existingTitle || firstText || '新对话'

    const toSave = agentMessagesToConversation(msgs.slice(fromIdx), convId, title)
    try {
      await window.electronAPI.appendConversationMessages(convId, title, toSave.messages)
      savedMsgIdsRef.current.set(convId, new Set(msgs.map(m => m.id)))
    } catch (err) {
      console.error('[Chat] incremental save failed:', err)
    }
  }, [conversations, enginesRef, agentStatus.status])
  const saveNewRef = useRef<() => Promise<void>>(null as unknown as () => Promise<void>)
  saveNewRef.current = saveNewMessages

  const saveConversationSync = useCallback(() => {
    const convId = convIdRef.current
    if (!convId) return
    const engine = enginesRef.current.get(convId)
    const msgs = engine?.messages
    if (!msgs || msgs.length === 0) return
    const firstText = msgs[0]?.contentBlocks?.find((b) => b.type === 'text')?.text || ''
    const existingConv = conversations.find(
      (c: { key: string; label: string }) => String(c.key) === convId
    )
    const existingTitle = existingConv?.label && existingConv.label !== '新对话'
      ? existingConv.label : null
    const title = existingTitle || firstText || '新对话'
    const conversation = agentMessagesToConversation(msgs, convId, title)
    const hs = engine?.getHistorySummary()
    if (hs) {
      conversation.historySummary = hs.text
      conversation.historySummaryFrontier = hs.firstKeptId
    }

    // Always full save to capture content changes in existing messages
    window.electronAPI.saveConversationSync(conversation)
    savedMsgIdsRef.current.set(convId, new Set(conversation.messages.map(m => m.id)))
  }, [conversations, enginesRef])

  /** Synchronously save ALL in-memory conversations, not just the active one.
   *  Required in beforeunload — if the user last clicked a blank conversation,
   *  sync-save-of-active would skip it (0 messages) and lose the previous one. */
  const saveAllConversationsSync = useCallback(() => {
    saveConversationSync()
    for (const [convId, engine] of enginesRef.current) {
      if (convId === convIdRef.current) continue
      if (engine.messages.length === 0) continue
      const firstText = engine.messages[0]?.contentBlocks?.find((b) => b.type === 'text')?.text || ''
      const existingConv = conversationsRef.current.find(
        (c: { key: string; label: string }) => String(c.key) === convId
      )
      const existingTitle = existingConv?.label && existingConv.label !== '新对话'
        ? existingConv.label : null
      const title = existingTitle || firstText || '新对话'
      const conversation = agentMessagesToConversation(engine.messages, convId, title)
      const hs = engine.getHistorySummary()
      if (hs) {
        conversation.historySummary = hs.text
        conversation.historySummaryFrontier = hs.firstKeptId
      }
      window.electronAPI.saveConversationSync(conversation)
    }
  }, [saveConversationSync, enginesRef])

  // ── Debounced auto-save when messages change ──
  // Intentionally omits activeConversationKey and saveCurrentConversation
  // from deps — saving is driven by data changes, not UI navigation.
  // saveRef bridges the latest callback without causing effect re-run.
  useEffect(() => {
    if (!activeConversationKey || agentStatus.status === 'streaming') return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => { saveNewRef.current() }, 1000)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [messages, agentStatus.status])

  // ── Periodic save during streaming ──
  const periodicSaveRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (agentStatus.status === 'streaming') {
      if (!periodicSaveRef.current) {
        periodicSaveRef.current = setInterval(() => { saveNewRef.current() }, 10000)
      }
    } else {
      if (periodicSaveRef.current) {
        clearInterval(periodicSaveRef.current)
        periodicSaveRef.current = null
      }
    }
    return () => {
      if (periodicSaveRef.current) {
        clearInterval(periodicSaveRef.current)
        periodicSaveRef.current = null
      }
    }
  }, [agentStatus.status])

  // ── Save immediately when streaming ends ──
  const prevAgentStatusRef = useRef(agentStatus.status)
  useEffect(() => {
    const prev = prevAgentStatusRef.current
    prevAgentStatusRef.current = agentStatus.status
    if ((prev === 'streaming' && agentStatus.status === 'completed') ||
        (prev === 'streaming' && agentStatus.status === 'error')) {
      saveCurrentConversation()
      // Move active conversation to top of list
      if (activeConversationKey) {
        const convId = String(activeConversationKey.description || activeConversationKey.toString())
      // bumpConversation is declared later via useCallback; this effect body
      // runs after render when the binding is initialized. Stable identity
      // (empty deps), so it does not need to be in the dependency list.
      // eslint-disable-next-line react-hooks/immutability
      bumpConversation(convId)
      }
    }
  }, [agentStatus, saveCurrentConversation])

  // ── Load conversations from disk on mount (and re-list on demand) ──
  // reloadConversations re-reads the DB — used after 对话管理's retention
  // cleanup removed rows main-side, so the sidebar drops them immediately.
  const reloadConversations = useCallback(async () => {
    const convList = await window.electronAPI.listConversations()
    setConversations(sortConversations(
      convList.map((c) => ({
        key: c.id,
        label: c.title,
        pinned: c.pinned,
        updatedAt: c.updatedAt,
        // Keep the project binding or the welcome page's project cards lose
        // their latest-conversation line on every reload ('default'
        // normalizes to absent per the list type).
        projectId: c.projectId && c.projectId !== 'default' ? c.projectId : undefined,
        // The @-summoned expert binding (drives the input-area chip).
        expertId: c.expertId || undefined,
        // And the conversation's own approval level (composer's 授权 control).
        approvalMode: c.approvalMode
      }))
    ))
  }, [setConversations])

  useEffect(() => {
    async function loadConversations() {
      await reloadConversations()
    }
    loadConversations()
  }, [reloadConversations])

  // ── Select conversation / switch active engine ──
  const handleSelectConversation = useCallback(async (key: string) => {
    // Use both the ref AND the store snapshot to prevent getting out of sync
    if (key === convIdRef.current && key === activeConversationKey) return

    // Before switching, clear any pending auto-save timer to prevent it from
    // firing after convIdRef.current is updated but before React re-renders,
    // which would save stale messages under the wrong conversation ID.
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)

    // Only save if there are unsaved changes (new messages or in-place edits).
    // Uses savedMsgIdsRef to compare current message IDs against last-saved set.
    // This avoids unnecessary saves when the user is just browsing conversations.
    const prevConvId = convIdRef.current
    if (prevConvId && messages.length > 0) {
      const savedIds = savedMsgIdsRef.current.get(prevConvId)
      const hasChanges = !savedIds || messages.some(m => !savedIds.has(m.id))
      if (hasChanges) {
        saveCurrentConversation().catch(err => console.error("[Chat] Background save failed:", err))
      }
    }
    activeEngineIdRef.current = key

    if (key) {
      if (enginesRef.current.has(key)) {
        // Cached engine: messages set synchronously, no loading window needed.
        setIsLoadingConversation(false)
        const engine = enginesRef.current.get(key)!
        setMessages([...engine.messages])
        setAgentStatus(engine.agentStatus)
        setStreamingBlocks([...engine.streamingBlocks])
        setPlan(engine.plan ? { ...engine.plan, nodes: engine.plan.nodes.map(n => ({ ...n })) } : null)
        // Track loaded message IDs so switching away doesn't trigger a redundant save.
        savedMsgIdsRef.current.set(key, new Set(engine.messages.map(m => m.id)))
      } else {
        setMessages([])
        setPlan(null)
        setIsLoadingConversation(true)
        getOrCreateEngine(key).reset()

        window.electronAPI.getConversation(key).then(async conv => {
          if (!conv || conv.messages.length === 0) {
            // Genuinely empty conversation — welcome should show once loading clears.
            if (activeEngineIdRef.current === key) setIsLoadingConversation(false)
            return
          }
          if (activeEngineIdRef.current !== key) return
          const engine = enginesRef.current.get(key)
          if (engine && engine.messages.length > 0) return

          // Hydrate tool_results from separate table for engine use
          let fullConv = conv
          try { fullConv = await window.electronAPI.hydrateConversation(key) || conv } catch {}

          const agentMsgs = storedMessagesToAgentMessages(fullConv.messages)
          if (engine) {
            engine.loadConversation(agentMsgs)
            engine.seedHistorySummary(fullConv.historySummary, fullConv.historySummaryFrontier)
            engine.loadPlan(key)
          }
          if (activeEngineIdRef.current === key) {
            setMessages(agentMsgs)
            setAgentStatus({ status: 'idle' })
            setIsLoadingConversation(false)
          }
          // Mark all loaded messages as already saved
          savedMsgIdsRef.current.set(key, new Set(conv.messages.map(m => m.id)))
        }).catch(err => {
          console.error('[Chat] Failed to load conversation:', err)
          // Never leave the view stuck blank if the load fails while the user
          // is still on this conversation.
          if (activeEngineIdRef.current === key) setIsLoadingConversation(false)
        })
      }
    }

    setActiveConversationKey(key)
    convIdRef.current = key
  }, [saveCurrentConversation, setActiveConversationKey, getOrCreateEngine,
      enginesRef, activeEngineIdRef, setMessages, setAgentStatus, setStreamingBlocks, setPlan])

  // ── Helper: update title in list ──
  const updateConversationTitleInList = (convId: string, title: string) => {
    const existing = conversationsRef.current
    if (existing.some((c: { key: string }) => c.key === convId)) {
      setConversations(
        existing.map((c: { key: string; label: string; updatedAt?: string }) =>
          c.key === convId ? { ...c, label: title, updatedAt: new Date().toISOString() } : c
        )
      )
    } else {
      setConversations(
        sortConversations([{ key: convId, label: title, updatedAt: new Date().toISOString() }, ...existing])
      )
    }
  }

  // ── Create new conversation ──
  // Project binding for the NEXT lazily-created conversation (M3.6): set by
  // createNewConversation(projectId), consumed when handleRequest materializes
  // the conversation row.
  const pendingProjectIdRef = useRef<string | null>(null)
  const takePendingProjectId = useCallback((): string | undefined => {
    const v = pendingProjectIdRef.current
    pendingProjectIdRef.current = null
    return v ?? undefined
  }, [])

  const createNewConversation = useCallback(async (projectId?: string) => {
    pendingProjectIdRef.current = projectId ?? null
    // A level held for the conversation being composed does not carry into the
    // next one: 新会话 defaults to the shared level (按需确认) whatever was picked
    // last time, and the composer asks again. Without this, abandoning a new
    // chat after picking 全部允许 would silently widen the following one.
    usePendingApprovalStore.getState().clearMode()
    const MAX_SESSIONS = 100
    if (autoCleanup && conversations.length >= MAX_SESSIONS) {
      const toRemove = conversations.length - MAX_SESSIONS + 1
      const oldest = conversations.slice(-toRemove) as Array<{ key: string }>
      for (const c of oldest) {
        removeConversation(c.key)
        window.electronAPI.deleteConversation(c.key).catch(() => {})
      }
    }

    // Capture current state before clearing (messages from closure, before setMessages([]))
    const oldConvId = convIdRef.current

    // Clear state FIRST (synchronously) so handleRequest can't race and
    // target the old conversation if the user types before the async save completes.
    setIsLoadingConversation(false)
    setMessages([])
    setAgentStatus({ status: 'idle' })
    setStreamingBlocks([])
    setPlan(null)
    convIdRef.current = ''
    activeEngineIdRef.current = ''
    setActiveConversationKey(undefined)

    // Then save previous conversation in the background (fire-and-forget).
    // Uses captured convId since convIdRef.current was already cleared, and
    // sources messages from the engine (never the shared state) so the save
    // cannot be mis-filed under a different conversation ID.
    const oldEngine = enginesRef.current.get(oldConvId)
    const oldMsgs = oldEngine?.messages
    if (oldConvId && oldMsgs && oldMsgs.length > 0) {
      // Only save if there are unsaved changes
      const savedIds = savedMsgIdsRef.current.get(oldConvId)
      const hasChanges = !savedIds || oldMsgs.some(m => !savedIds.has(m.id))
      if (hasChanges) {
        const firstText = oldMsgs[0]?.contentBlocks?.find((b) => b.type === 'text')?.text || ''
        const existingConv = conversations.find(
          (c: { key: string; label: string }) => String(c.key) === oldConvId
        )
        const existingTitle = existingConv?.label && existingConv.label !== '新对话'
          ? existingConv.label : null
        const title = existingTitle || firstText || '新对话'
        const conversation = agentMessagesToConversation(oldMsgs, oldConvId, title)

        window.electronAPI.saveConversation(conversation).catch(err =>
          console.error('[Chat] Background save failed during new conversation:', err)
        )
        savedMsgIdsRef.current.set(oldConvId, new Set(oldMsgs.map(m => m.id)))
      }
    }
  }, [conversations, autoCleanup, enginesRef,
      setMessages, setAgentStatus, setStreamingBlocks, setPlan,
      activeEngineIdRef, setActiveConversationKey, removeConversation])

  // ── Delete conversation ──
  const deleteConversation = useCallback(async (key: string) => {
    removeConversation(key)
    if (key === convIdRef.current) {
      enginesRef.current.get(key)?.reset()
      setMessages([])
      setAgentStatus({ status: 'idle' })
      setStreamingBlocks([])
      setPlan(null)
    }
    enginesRef.current.get(key)?.dispose()
    enginesRef.current.delete(key)
    savedMsgIdsRef.current.delete(key)
    await window.electronAPI.deleteConversation(key)
  }, [removeConversation, enginesRef, setMessages, setAgentStatus, setStreamingBlocks, setPlan])

  // ── Rename conversation ──
  const renameConversation = useCallback((key: string, newLabel: string) => {
    setConversations(
      conversationsRef.current.map(
        (c: { key: string; label: string }) =>
          c.key === key ? { ...c, label: newLabel } : c
      )
    )
    window.electronAPI.updateConversationTitle(key, newLabel)
  }, [setConversations])

  // ── Clear all conversations ──
  const clearAllConversations = useCallback(async () => {
    const keys = conversations.map((c: { key: string }) => c.key)
    for (const k of keys) {
      await window.electronAPI.deleteConversation(k)
    }
    for (const [, engine] of enginesRef.current) {
      engine.dispose()
    }
    enginesRef.current.clear()
    savedMsgIdsRef.current.clear()
    setConversations([])
    setMessages([])
    setAgentStatus({ status: 'idle' })
    setStreamingBlocks([])
    setPlan(null)
    convIdRef.current = ''
    setActiveConversationKey(undefined)
  }, [conversations, enginesRef, setConversations, setMessages,
      setAgentStatus, setStreamingBlocks, setPlan, setActiveConversationKey])

  // ── Toggle pin ──
  const togglePin = useCallback(async (key: string, pinned: boolean) => {
    setConversations(
      sortConversations(
        conversationsRef.current.map(
          (c: { key: string; label: string; pinned?: boolean; updatedAt?: string }) =>
            c.key === key ? { ...c, pinned } : c
        )
      )
    )
    await window.electronAPI.toggleConversationPin(key, pinned)
  }, [setConversations])

  // ── Bump conversation to top of list ──
  const bumpConversation = useCallback((convId: string) => {
    setConversations(
      sortConversations(
        conversationsRef.current.map((c: any) =>
          String(c.key) === convId ? { ...c, updatedAt: new Date().toISOString() } : c
        )
      )
    )
  }, [setConversations])

  // ── Summoned expert binding (expert config pack refactor) ──
  // Mirrors the @-summoned expert binding: list item updated for the chip +
  // IPC persists the DB column (stub-inserts the row, so it may run before the
  // first save).
  const updateConversationExpert = useCallback((convId: string, expertId: string | null) => {
    setConversations(
      conversationsRef.current.map((c: any) =>
        String(c.key) === convId ? { ...c, expertId: expertId ?? undefined } : c
      )
    )
    void window.electronAPI.setConversationExpert?.(convId, expertId)
  }, [setConversations])

  // ── Approval level binding (授权, per conversation) ──
  // Same optimistic pattern: the list item carries the level the composer shows,
  // and the DB column (stub-inserting the row when needed) is the durable copy
  // the main-side session manager re-reads on every ask.
  const updateConversationApproval = useCallback((convId: string, mode: SandboxApprovalMode) => {
    // An empty id is the sdk's "nothing is open" sentinel, not a conversation to
    // write to (see conversationKeyOf) — without this the call reached the
    // stub-insert and created a row with an empty id.
    const id = conversationKeyOf(convId)
    if (!id) {
      console.warn('[Persistence] approval update ignored: no conversation open')
      return
    }
    // Optimistic update through the sdk's per-item setter, never a map over
    // conversationsRef: the ref only syncs after commit, and the first message's
    // materialization (useChatController) calls this in the same synchronous
    // block as addConversation — the stale map found nothing AND wrote the
    // pre-add list back over the item it was meant to update. The conversation
    // lost its approvalMode (and projectId), and the composer fell back to
    // 按需确认 the moment the message was sent ("选了全部允许，发送后变成按需确认").
    setConversation(id, { approvalMode: mode })
    // Refresh after the write lands: the session manager re-reads the column on
    // its own at the next ask, but this also applies a mid-loop change now.
    void (async () => {
      try {
        await window.electronAPI.setConversationApprovalMode?.(id, mode)
        await window.electronAPI.agentSessionRefreshOptions?.(id)
      } catch (err) {
        console.warn('[Persistence] approval update failed:', err)
      }
    })()
  }, [setConversation])

  // ── Activate a conversation (state + ref kept in sync) ──
  const activateConversation = useCallback((key: string) => {
    setActiveConversationKey(key)
    convIdRef.current = key
  }, [setActiveConversationKey])

  return {
    // Conversation list
    conversations,
    activeConversationKey,
    setActiveConversationKey,
    addConversation,
    removeConversation,
    setConversations,
    reloadConversations,
    conversationsRef,
    // Conversation switch loading window (welcome-screen suppression)
    isLoadingConversation,
    // Project binding for the next lazily-created conversation (M3.6)
    takePendingProjectId,
    // Save
    saveCurrentConversation,
    saveConversationSync,
    saveAllConversationsSync,
    convIdRef,
    // CRUD
    handleSelectConversation,
    updateConversationTitleInList,
    createNewConversation,
    deleteConversation,
    renameConversation,
    clearAllConversations,
    togglePin,
    bumpConversation,
    updateConversationExpert,
    updateConversationApproval,
    activateConversation
  }
}
