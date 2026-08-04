import { useEffect, useRef, useCallback } from 'react'
import useXConversations from '@ant-design/x-sdk/es/x-conversations'
import type { AgentMessage, AgentStatus } from '../types/agent'
import type { AgentEngine } from '../agent/AgentEngine'
import { agentMessagesToConversation, storedMessagesToAgentMessages } from '../utils/message-utils'

// ── Hook ──

interface UseConversationPersistenceOptions {
  autoCleanup?: boolean
  messages: AgentMessage[]
  agentStatus: AgentStatus
  // Engine integration
  enginesRef: React.MutableRefObject<Map<string, AgentEngine>>
  activeEngineIdRef: React.MutableRefObject<string>
  getOrCreateEngine: (convId: string) => AgentEngine
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
    setConversations
  } = useXConversations()

  const conversationsRef = useRef(conversations)
  useEffect(() => { conversationsRef.current = conversations }, [conversations])

  // Sort by pinned first, then by updatedAt descending
  const sortConversations = (items: Array<{ key: string; label: string; pinned?: boolean; updatedAt?: string }>) => {
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

  const saveCurrentConversation = useCallback(async () => {
    const convId = convIdRef.current
    if (!convId || isSavingRef.current) return
    const msgs = messages
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
  }, [messages, conversations])
  saveRef.current = saveCurrentConversation

  const saveConversationSync = useCallback(() => {
    const convId = convIdRef.current
    if (!convId) return
    const msgs = messages
    if (!msgs || msgs.length === 0) return
    const firstText = msgs[0]?.contentBlocks?.find((b) => b.type === 'text')?.text || ''
    const existingConv = conversations.find(
      (c: { key: string; label: string }) => String(c.key) === convId
    )
    const existingTitle = existingConv?.label && existingConv.label !== '新对话'
      ? existingConv.label : null
    const title = existingTitle || firstText || '新对话'
    const conversation = agentMessagesToConversation(msgs, convId, title)

    // Always full save to capture content changes in existing messages
    window.electronAPI.saveConversationSync(conversation)
    savedMsgIdsRef.current.set(convId, new Set(conversation.messages.map(m => m.id)))
  }, [messages, conversations])

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
    saveTimerRef.current = setTimeout(() => { saveRef.current() }, 1000)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [messages, agentStatus.status])

  // ── Periodic save during streaming ──
  const periodicSaveRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (agentStatus.status === 'streaming') {
      if (!periodicSaveRef.current) {
        periodicSaveRef.current = setInterval(() => { saveRef.current() }, 10000)
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
        bumpConversation(convId)
      }
    }
  }, [agentStatus, saveCurrentConversation])

  // ── Load conversations from disk on mount ──
  useEffect(() => {
    async function loadConversations() {
      const convList = await window.electronAPI.listConversations()
      const items = sortConversations(
        convList.map((c) => ({ key: c.id, label: c.title, pinned: c.pinned, updatedAt: c.updatedAt }))
      )
      setConversations(items)
    }
    loadConversations()
  }, [setConversations])

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
        const engine = enginesRef.current.get(key)!
        setMessages([...engine.messages])
        setAgentStatus(engine.agentStatus)
        setStreamingBlocks([...engine.streamingBlocks])
        setPlan(engine.plan ? { ...engine.plan, steps: engine.plan.steps.map(s => ({ ...s })) } : null)
        // Track loaded message IDs so switching away doesn't trigger a redundant save.
        savedMsgIdsRef.current.set(key, new Set(engine.messages.map(m => m.id)))
      } else {
        setMessages([])
        setPlan(null)
        getOrCreateEngine(key).reset()

        window.electronAPI.getConversation(key).then(async conv => {
          if (!conv || conv.messages.length === 0) return
          if (activeEngineIdRef.current !== key) return
          const engine = enginesRef.current.get(key)
          if (engine && engine.messages.length > 0) return

          // Hydrate tool_results from separate table for engine use
          let fullConv = conv
          try { fullConv = await window.electronAPI.hydrateConversation(key) || conv } catch {}

          const agentMsgs = storedMessagesToAgentMessages(fullConv.messages)
          if (engine) {
            engine.loadConversation(agentMsgs)
            engine.loadPlan(key)
          }
          if (activeEngineIdRef.current === key) {
            setMessages(agentMsgs)
            setAgentStatus({ status: 'idle' })
          }
          // Mark all loaded messages as already saved
          savedMsgIdsRef.current.set(key, new Set(conv.messages.map(m => m.id)))
        }).catch(err => console.error('[Chat] Failed to load conversation:', err))
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
  const createNewConversation = useCallback(async () => {
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
    setMessages([])
    setAgentStatus({ status: 'idle' })
    setStreamingBlocks([])
    setPlan(null)
    convIdRef.current = ''
    activeEngineIdRef.current = ''
    setActiveConversationKey(undefined)

    // Then save previous conversation in the background (fire-and-forget).
    // Uses captured convId since convIdRef.current was already cleared.
    if (oldConvId && messages.length > 0) {
      // Only save if there are unsaved changes
      const savedIds = savedMsgIdsRef.current.get(oldConvId)
      const hasChanges = !savedIds || messages.some(m => !savedIds.has(m.id))
      if (hasChanges) {
        const firstText = messages[0]?.contentBlocks?.find((b) => b.type === 'text')?.text || ''
        const existingConv = conversations.find(
          (c: { key: string; label: string }) => String(c.key) === oldConvId
        )
        const existingTitle = existingConv?.label && existingConv.label !== '新对话'
          ? existingConv.label : null
        const title = existingTitle || firstText || '新对话'
        const conversation = agentMessagesToConversation(messages, oldConvId, title)

        window.electronAPI.saveConversation(conversation).catch(err =>
          console.error('[Chat] Background save failed during new conversation:', err)
        )
        savedMsgIdsRef.current.set(oldConvId, new Set(messages.map(m => m.id)))
      }
    }
  }, [conversations, autoCleanup, messages,
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

  return {
    // Conversation list
    conversations,
    activeConversationKey,
    setActiveConversationKey,
    addConversation,
    removeConversation,
    setConversations,
    conversationsRef,
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
    bumpConversation
  }
}
