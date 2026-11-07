// ── Conversation persistence & lifecycle ──
// Owns the conversation LIST (useXConversations state: keys, labels, pinning)
// and the save pipeline that flushes engine messages to SQLite — debounced,
// incremental (new or content-dirty messages), and serialized through one in-flight
// promise so overlapping renders can't double-save. Also handles conversation
// switching (flush-then-swap), deletion with engine teardown, and auto-cleanup.
// Engine construction itself lives in useConversationEngine; this hook drives it.

import { useEffect, useRef, useCallback, useState } from 'react'
import useXConversations, { type ConversationData } from '@ant-design/x-sdk/es/x-conversations'
import type { AgentMessage, AgentStatus } from '../types/agent'
import type { SessionEngineHandle } from './useConversationEngine'
import { agentMessagesToConversation, storedMessagesToAgentMessages } from '../utils/message-utils'
import { ConversationSaveQueue, teardownConversation, sweepKeyOf, sweepKeysMatch, type SweepKey } from '../utils/incremental-save'
import type { Conversation } from '../../../shared/types/conversation'
import type { SandboxApprovalMode } from '../../../shared/sandbox/policy'
import { usePendingApprovalStore } from '../stores/pendingApprovalStore'
import { conversationKeyOf } from '../../../shared/conversation-key'
import { MAX_CACHED_CONVERSATIONS, TERMINAL_EVICTABLE_STATUSES } from './useConversationEngine'

// ── Hook ──

/** 流式会话的粗粒度检查点窗口：流式期每个会话至多每 60s 落一次库。 */
const STREAMING_CHECKPOINT_MS = 60_000

/** The eviction sweep step, extracted so tests can drive the REAL loop (the
 *  10s interval inside the hook effect is unreachable from vitest, and the
 *  previous wiring pin was a source-string scan — review 2026-10-12 低3).
 *
 *  The load-bearing part is the RE-VERIFY after `forget`: the candidate table
 *  and the gate above it were evaluated BEFORE the await, and `forget` waits
 *  on an in-flight SQLite write — tens to hundreds of ms across candidates —
 *  during which the world can move. Disposing a conversation the user just
 *  opened kills the status light and the event stream under their eyes
 *  (review 2026-10-12 中1, path 1); disposing one whose status flipped live
 *  inside the window kills a streaming turn (path 2). Skipping after the
 *  forget has already dropped the save baseline — the next real save goes
 *  full instead of incremental, which is the cheap and safe direction. */
export interface MirrorEvictionIo {
  /** Still past the cap? Re-read per candidate — every evict shrinks the map. */
  overCap: () => boolean
  /** The hook's verified-save gate; re-checked after the await too, so a
   *  mutation landing mid-window keeps the engine. */
  isEvictable: (id: string) => boolean
  forget: (id: string) => Promise<void>
  isActive: (id: string) => boolean
  /** Reads the engine handle's LIVE mirrored status; undefined = the engine
   *  already left the map mid-window (deleted, or disposed elsewhere). */
  statusOf: (id: string) => AgentStatus['status'] | undefined
  evict: (id: string) => void
}

export async function evictMirrorCandidates(candidates: string[], io: MirrorEvictionIo): Promise<void> {
  for (const id of candidates) {
    if (!io.overCap()) break
    if (!io.isEvictable(id)) continue
    await io.forget(id)
    if (io.isActive(id)) continue
    const status = io.statusOf(id)
    if (!status || !TERMINAL_EVICTABLE_STATUSES.includes(status)) continue
    if (!io.isEvictable(id)) continue
    io.evict(id)
  }
}

interface UseConversationPersistenceOptions {
  autoCleanup?: boolean
  /** Single-writer gate (PLAN-conversation-popout 2026-10-30): false in the
   *  popout window — it drives turns but never writes the transcript. The
   *  MAIN window is the one writer for every conversation, including ones it
   *  only mirrors via adoptConversation (a popped conversation's saves ride
   *  the main window's 10s sweep). Full-save runs deleteMessagesNotIn, so two
   *  writers with diverging mirrors could DELETE each other's rows — the
   *  gate exists so that can never happen. */
  savesEnabled?: boolean
  messages: AgentMessage[]
  agentStatus: AgentStatus
  // Engine integration
  enginesRef: React.MutableRefObject<Map<string, SessionEngineHandle>>
  activeEngineIdRef: React.MutableRefObject<string>
  getOrCreateEngine: (convId: string) => SessionEngineHandle
  /** Read receipt for the sidebar status light — this hook's switch path drives
   *  activeEngineIdRef directly and never routes through activateEngine, so the
   *  未读 clear has to ride here (useConversationEngine's markConversationRead). */
  markConversationRead: (convId: string) => void
  setMessages: React.Dispatch<React.SetStateAction<AgentMessage[]>>
  setAgentStatus: React.Dispatch<React.SetStateAction<AgentStatus>>
  setStreamingBlocks: React.Dispatch<React.SetStateAction<any[]>>
  setPlan: React.Dispatch<React.SetStateAction<any>>
  // Popout adoption (PLAN-conversation-popout): seed this window's mirror for
  // a conversation a popout opened, without touching React state or the
  // engine's live transcript.
  seedSessionSnapshot: (key: string, snapshot: {
    messages: unknown[]
    status: { status: string; error?: string; attempt?: number; maxRetries?: number; delayMs?: number; message?: string }
    streamingBlocks: unknown[]
    plan: unknown
    fileChanges?: unknown
  }) => void
  seedSessionHistory: (key: string, msgs: AgentMessage[], summary?: { text: string; firstKeptId: string } | null) => void
  // Mirror eviction (MAX_CACHED_CONVERSATIONS, 12h-run memory bound): the
  // engine hook owns the mechanism (candidate list by recency+status, mirror
  // drop), this hook owns the policy gate — nothing leaves the cache until a
  // verified save has covered it.
  listEvictionCandidates?: () => string[]
  evictEngine?: (convId: string) => void
}

export function useConversationPersistence(options: UseConversationPersistenceOptions) {
  const {
    autoCleanup, messages, agentStatus,
    enginesRef, activeEngineIdRef, getOrCreateEngine, markConversationRead,
    setMessages, setAgentStatus, setStreamingBlocks, setPlan,
    listEvictionCandidates, evictEngine,
    seedSessionSnapshot, seedSessionHistory
  } = options
  const savesEnabled = options.savesEnabled !== false

  // ── Conversation list management (useXConversations) ──
  const {
    conversations,
    activeConversationKey,
    setActiveConversationKey,
    addConversation,
    removeConversation,
    setConversation,
    setConversations,
    getConversation
  // The sdk hook demands a config argument; the empty object is the
  // default behaviour the zero-arg call always relied on.
  } = useXConversations({})

  // This ref is a POST-COMMIT snapshot: it only syncs in an effect, after React
  // has rendered. The sdk store, by contrast, is updated synchronously by its
  // own methods (addConversation/setConversation). Any list edit derived from
  // the ref in the same synchronous block as one of those methods reads the
  // pre-edit list — see updateConversationApproval for what that costs.
  const conversationsRef = useRef(conversations)
  useEffect(() => { conversationsRef.current = conversations }, [conversations])

  // Sort by pinned first, then by updatedAt descending
  const sortConversations = (items: ConversationData[]) => {
    return [...items].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      const aTime = a.updatedAt || ''
      const bTime = b.updatedAt || ''
      return bTime.localeCompare(aTime)
    })
  }

  /** The sdk's setConversation MERGES at runtime (Object.assign onto the
   *  existing item); its type just demands the full shape, so every partial
   *  update funnels through this one documented widening. */
  const partialOf = (key: string, partial: Record<string, unknown>): ConversationData =>
    ({ key, ...partial } as ConversationData)

  // ── Save state ──
  const convIdRef = useRef<string>('')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const saveQueueRef = useRef(new ConversationSaveQueue<Conversation>())
  // Do not persist the placeholder engine while its DB hydration is in flight.
  const loadingIdsRef = useRef(new Set<string>())

  // ChatView suppresses the welcome screen while loading a conversation.
  const [isLoadingConversation, setIsLoadingConversation] = useState(false)

  const snapshotConversation = useCallback((convId: string): Conversation | undefined => {
    if (loadingIdsRef.current.has(convId)) return
    const engine = enginesRef.current.get(convId)
    if (!engine) return
    const msgs = engine.messages
    const firstText = msgs[0]?.contentBlocks?.find(b => b.type === 'text')?.text || ''
    const existing = conversationsRef.current.find(c => String(c.key) === convId)
    const title = existing?.label && existing.label !== '新对话' ? existing.label : firstText || '新对话'
    const conversation = agentMessagesToConversation(msgs, convId, title)
    const hs = engine.getHistorySummary()
    if (hs) {
      conversation.historySummary = hs.text
      conversation.historySummaryFrontier = hs.firstKeptId
    }
    return conversation
  }, [enginesRef])

  // One lane for ALL asynchronous message writes, with a fresh captured payload
  // at dispatch and acknowledgement only after success. No status/ID-only gate.
  // Returns success so the sweep's clean-key bookkeeping only marks verified
  // saves (a failed write must retry on the next tick, review 2026-09-18 M2).
  const saveConversationById = useCallback(async (convId: string, full = false): Promise<boolean> => {
    if (!convId || !savesEnabled) return false
    try {
      await saveQueueRef.current.save(convId, () => snapshotConversation(convId), async (snapshot, plan) => {
        if (plan.mode === 'full') {
          await window.electronAPI.saveConversation(snapshot)
        } else {
          await window.electronAPI.appendConversationMessages(
            convId, snapshot.title, plan.indices.map(i => snapshot.messages[i])
          )
        }
      }, full)
      return true
    } catch (err) {
      // Leave the failed snapshot dirty. The next debounce/periodic flush retries
      // fresh data rather than replaying an old payload over newer content.
      console.error('[Chat] conversation save failed:', err)
      return false
    }
  }, [snapshotConversation, savesEnabled])

  const saveCurrentConversation = useCallback(
    () => saveConversationById(convIdRef.current, true), [saveConversationById]
  )
  const saveNewRef = useRef<() => Promise<unknown>>(null as unknown as () => Promise<unknown>)
  // eslint-disable-next-line react-hooks/refs -- latest-conversation-id bridge for the sync saver; read only from callers after commit
  saveNewRef.current = () => saveConversationById(convIdRef.current)

  const saveConversationByIdSync = useCallback((convId: string) => {
    if (!convId || !savesEnabled) return
    const snapshot = snapshotConversation(convId)
    if (!snapshot) return
    try {
      saveQueueRef.current.saveSync(convId, snapshot, value => window.electronAPI.saveConversationSync(value))
    } catch (err) {
      console.error('[Chat] synchronous conversation save failed:', err)
    }
  }, [snapshotConversation, savesEnabled])

  const saveConversationSync = useCallback(() => {
    saveConversationByIdSync(convIdRef.current)
  }, [saveConversationByIdSync])

  /** Flush inactive cached engines too, including late tool results. */
  const saveAllConversationsSync = useCallback(() => {
    for (const convId of enginesRef.current.keys()) saveConversationByIdSync(convId)
  }, [saveConversationByIdSync, enginesRef])

  // ── Debounced auto-save when messages change ──
  // Intentionally omits activeConversationKey and saveCurrentConversation
  // from deps — saving is driven by data changes, not UI navigation.
  // saveNewRef bridges the latest callback without causing effect re-run.
  useEffect(() => {
    if (!activeConversationKey || agentStatus.status === 'streaming') return
    if (!savesEnabled) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => { saveNewRef.current() }, 1000)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [messages, agentStatus.status, savesEnabled])

  // Active renders are not a notification source for background conversations.
  // A cheap no-op content comparison gives every cached engine crash recovery,
  // including an old tool_result updated after the user switches away.
  // M2 (review 2026-09-18): skip the whole-session capture when the engine's
  // messages array reference and summary pair are unchanged since the last
  // VERIFIED save — see the sweep gate in incremental-save.ts. The PRE-save
  // key is recorded only after a verified save: a mutation that lands while
  // the write runs rebuilds the array, the recorded reference goes stale, and
  // the next tick re-checks; a failed save records nothing and retries.
  const sweepCleanKeysRef = useRef(new Map<string, SweepKey>())
  // 流式检查点的「上次落库时刻」——只记验证成功的保存，保证两次流式落库
  // 间隔 ≥ STREAMING_CHECKPOINT_MS。
  const streamingCheckpointAtRef = useRef(new Map<string, number>())
  /** Eviction gate (mirror eviction, MAX_CACHED_CONVERSATIONS): a conversation
   *  may drop its cached mirror only when nothing about it is unsaved — the
   *  sweep's clean-key ledger IS the verified-save record (sweepKeysMatch
   *  compares the engine's current content fingerprint against the last
   *  VERIFIED save), and a hydration still in flight has no engine worth
   *  trusting yet. */
  const isEvictable = useCallback((convId: string) => {
    if (loadingIdsRef.current.has(convId)) return false
    const engine = enginesRef.current.get(convId)
    if (!engine) return true
    return sweepKeysMatch(sweepCleanKeysRef.current.get(convId), sweepKeyOf(engine))
  }, [enginesRef])

  useEffect(() => {
    const timer = setInterval(() => {
      void (async () => {
        // Single-writer: the popout window skips the whole tick — saves AND
        // eviction (its only engine is the active one, never a candidate, so
        // nothing of value is skipped). Its conversation is saved by the main
        // window's own sweep — adoption guarantees the main window holds the
        // mirror.
        if (!savesEnabled) return
        const now = Date.now()
        for (const [id, engine] of enginesRef.current.entries()) {
          // 流式会话走粗粒度检查点（窗口见 streamingCheckpointAtRef）；防抖路径
          // 的 streaming 守卫维持原样——1s 级的流式期重复写没有必要，回合收尾的
          // streaming→completed 迁移另有立即保存。纯流式段（delta 只进
          // streamingBlocks，messages 数组引用不变）仍被下方 sweepKey 引用相等
          // 短路，不白付快照 + 逐条 stringify；被窗口真正放行的只是 append 后
          // 的增量保存。
          const streaming = engine.agentStatus.status === 'streaming'
          if (streaming && now - (streamingCheckpointAtRef.current.get(id) ?? 0) < STREAMING_CHECKPOINT_MS) continue
          const key = sweepKeyOf(engine)
          if (sweepKeysMatch(sweepCleanKeysRef.current.get(id), key)) continue
          void saveConversationById(id).then((ok) => {
            if (ok) {
              sweepCleanKeysRef.current.set(id, key)
              if (streaming) streamingCheckpointAtRef.current.set(id, Date.now())
            }
          })
        }
        // ── Mirror eviction ──
        // Past MAX_CACHED_CONVERSATIONS cached mirrors, drop the OLDEST-IDLE
        // ones (selectEvictionCandidates: terminal status, non-active,
        // oldest-touch first) until back under the cap. The gate refuses
        // anything unsaved; `forget` awaits an in-flight write and drops the
        // save baseline (its fingerprints ≈ the messages' own JSON) — the
        // baseline is re-seeded from hydration if the conversation returns.
        // Runs AFTER the save loop, so entries verified this very tick are
        // immediately eligible. The loop body (and the post-forget re-verify
        // that keeps an activation or a live turn from being disposed) lives
        // in evictMirrorCandidates — exported so tests drive the real thing.
        if (!listEvictionCandidates || !evictEngine) return
        if (enginesRef.current.size <= MAX_CACHED_CONVERSATIONS) return
        await evictMirrorCandidates(listEvictionCandidates(), {
          overCap: () => enginesRef.current.size > MAX_CACHED_CONVERSATIONS,
          isEvictable,
          forget: id => saveQueueRef.current.forget(id),
          isActive: id => activeEngineIdRef.current === id,
          statusOf: id => enginesRef.current.get(id)?.agentStatus.status,
          evict: evictEngine
        })
      })()
    }, 10000)
    return () => clearInterval(timer)
    // activeEngineIdRef is read via .current inside the sweep (review_20261013
    // 低3's exhaustive-deps note) — the ref is stable, listed to silence the
    // warning without changing eviction timing.
  }, [enginesRef, saveConversationById, listEvictionCandidates, evictEngine, isEvictable, savesEnabled, activeEngineIdRef])

  // ── Save immediately when streaming ends ──
  const prevAgentStatusRef = useRef(agentStatus.status)
  useEffect(() => {
    const prev = prevAgentStatusRef.current
    prevAgentStatusRef.current = agentStatus.status
    if ((prev === 'streaming' && agentStatus.status === 'completed') ||
        (prev === 'streaming' && agentStatus.status === 'error')) {
      if (savesEnabled) saveCurrentConversation()
      // Move active conversation to top of list
      if (activeConversationKey) {
        const convId = String(activeConversationKey)
      // bumpConversation is declared later via useCallback; this effect body
      // runs after render when the binding is initialized. Stable identity
      // (empty deps), so it does not need to be in the dependency list.
      // eslint-disable-next-line react-hooks/immutability
      bumpConversation(convId)
      }
    }
  }, [agentStatus, saveCurrentConversation, savesEnabled])

  // ── Load conversations from disk on mount (and re-list on demand) ──
  // reloadConversations re-reads the DB — used after the settings page's 数据清理
  // retention save (SETTINGS_SET awaits cleanupExpiredConversations main-side;
  // the callback rides onReloadConversations → DataRuntimeSettings, review
  // 2026-09-18 M4), so the sidebar drops pruned rows immediately.
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
        approvalMode: c.approvalMode,
        // And the conversation's own model (composer's 模型下拉); absent =
        // follows the global default.
        profileId: c.profileId
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

    // Capture the ID before switching; the queue reads only that engine and
    // compares content, including same-ID edits and changes outside the tail.
    const prevConvId = convIdRef.current
    if (prevConvId) void saveConversationById(prevConvId, true)
    activeEngineIdRef.current = key
    // Opening the conversation is the read receipt (status lights): the clear
    // rides HERE, not activateEngine — this switch path never routes through it.
    markConversationRead(key)

    if (key) {
      if (enginesRef.current.has(key)) {
        // Cached engine: messages set synchronously, no loading window needed.
        setIsLoadingConversation(false)
        const engine = enginesRef.current.get(key)!
        setMessages([...engine.messages])
        setAgentStatus(engine.agentStatus)
        setStreamingBlocks([...engine.streamingBlocks])
        setPlan(engine.plan ? { ...engine.plan, nodes: engine.plan.nodes.map(n => ({ ...n })) } : null)
        // Cached is not synonymous with saved: never reseed its baseline here.
      } else {
        setMessages([])
        setPlan(null)
        setIsLoadingConversation(true)
        loadingIdsRef.current.add(key)
        getOrCreateEngine(key).reset()

        // ONE hydration round-trip: hydrateConversation builds on the same
        // rows getConversation returns, so the pre-pass below used to parse
        // and IPC-serialize the whole conversation twice per open.
        window.electronAPI.hydrateConversation(key).then(conv => {
          if (!conv || conv.messages.length === 0) {
            // A failed read yields no snapshot to seed, and the engine stays
            // empty; loadingId release happens in .finally below.
            // Genuinely empty conversation — welcome should show once loading clears.
            if (activeEngineIdRef.current === key) setIsLoadingConversation(false)
            return
          }
          if (activeEngineIdRef.current !== key) return
          const engine = enginesRef.current.get(key)
          if (engine && engine.messages.length > 0) return

          const fullConv = conv
          // Hydration awaited IPC: re-check the engine before replacing live data.
          if (enginesRef.current.get(key) !== engine || (engine && engine.messages.length > 0)) return
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
          // Seed exactly the normalized hydrated data loaded into the engine,
          // not the reference-only DB preview and not a later live snapshot.
          const baseline = agentMessagesToConversation(agentMsgs, key, fullConv.title)
          baseline.historySummary = fullConv.historySummary
          baseline.historySummaryFrontier = fullConv.historySummaryFrontier
          saveQueueRef.current.seed(key, baseline)
        }).catch(err => {
          console.error('[Chat] Failed to load conversation:', err)
          // Never leave the view stuck blank if the load fails while the user
          // is still on this conversation.
          if (activeEngineIdRef.current === key) setIsLoadingConversation(false)
        }).finally(() => { loadingIdsRef.current.delete(key) })
      }
    }

    setActiveConversationKey(key)
    convIdRef.current = key
  }, [saveConversationById, setActiveConversationKey, getOrCreateEngine, markConversationRead,
      enginesRef, activeEngineIdRef, setMessages, setAgentStatus, setStreamingBlocks, setPlan])

  // ── Popout adoption (PLAN-conversation-popout, single-writer) ──
  // The MAIN window is the only transcript writer. When a popout opens a
  // conversation, this gives the main window a mirror of it (enginesRef
  // entry + save baseline) WITHOUT switching the view onto it — from then on
  // the ordinary 10s sweep and the beforeunload flush persist the
  // conversation exactly like any other cached engine. Already-mirrored
  // conversations adopt as a no-op.
  const adoptConversation = useCallback(async (key: string): Promise<void> => {
    if (!key || enginesRef.current.has(key)) return
    loadingIdsRef.current.add(key)
    try {
      // Idempotent main-side create: whether the popout's own createSession
      // won the race or this call did, both land on the same session.
      getOrCreateEngine(key)
      const [snap, conv] = await Promise.all([
        window.electronAPI.agentSessionSnapshot(key).catch(() => null),
        window.electronAPI.hydrateConversation(key).catch(() => null),
      ])
      const engine = enginesRef.current.get(key)
      if (!engine) return
      const dbMsgs = conv?.messages?.length ? storedMessagesToAgentMessages(conv.messages) : []
      const snapMsgs = Array.isArray(snap?.messages) ? (snap!.messages as AgentMessage[]) : []
      if (engine.messages.length === 0 && snapMsgs.length === 0 && dbMsgs.length > 0) {
        // Cold boot: nobody hydrated the engine yet, and there is no live
        // content to clobber — the ordinary cold-open path, minus the view.
        engine.loadConversation(dbMsgs)
        engine.seedHistorySummary(conv!.historySummary, conv!.historySummaryFrontier)
        engine.loadPlan(key)
        seedSessionHistory(key, dbMsgs,
          conv!.historySummary ? { text: conv!.historySummary, firstKeptId: conv!.historySummaryFrontier ?? '' } : null)
      } else if (snapMsgs.length >= dbMsgs.length && snapMsgs.length > 0) {
        // Live engine (the popout hydrated it, maybe already streaming):
        // NEVER write the engine — mirror only, straight from the manager's
        // own snapshot. The snapshot length IS where future appends expect
        // the mirror to be.
        seedSessionSnapshot(key, snap!)
      } else if (dbMsgs.length > 0) {
        // Snapshot raced the popout's hydrate and came back empty: the DB
        // rows are still an exact prefix of the manager's history.
        seedSessionHistory(key, dbMsgs,
          conv?.historySummary ? { text: conv.historySummary, firstKeptId: conv.historySummaryFrontier ?? '' } : null)
      }
      // The save baseline is ALWAYS the DB truth (what appendConversationMessages
      // already persisted): the sweep appends the mirror's unsaved tail.
      if (conv) {
        const baseline = agentMessagesToConversation(dbMsgs, key, conv.title)
        baseline.historySummary = conv.historySummary
        baseline.historySummaryFrontier = conv.historySummaryFrontier
        saveQueueRef.current.seed(key, baseline)
      }
    } finally {
      loadingIdsRef.current.delete(key)
    }
  }, [enginesRef, getOrCreateEngine, seedSessionSnapshot, seedSessionHistory])

  // ── Helper: update title in list ──
  // Existence is read from the store's LIVE list (getConversation), never from
  // conversationsRef: generateTitle's short-message path calls this in the same
  // synchronous block as addConversation — "hi" (< 6 chars) — where both the
  // ref and the render closure are pre-add snapshots, so the old ref lookup
  // missed the just-added item and the bare re-add below REPLACED it, dropping
  // its projectId: the conversation fell out of its 项目 group into 对话 while
  // the DB binding (written by the same block) stayed correct.
  //
  // `projectId` rides the cross-window push (CONVERSATION_TITLE_CHANGED): a
  // conversation created in a SECONDARY window (immersive project window /
  // popout) is unknown to this window's list — the bare re-add is its FIRST
  // sighting, and without the binding it grouped under 对话 forever while the
  // DB row stayed correctly bound (2026-11-01 用户报「沉浸模式新建的会话归到了
  // 普通对话」). The found-branch backfills too, healing entries an older
  // build added bare. 'default' normalizes to absent, the list's convention.
  const updateConversationTitleInList = (convId: string, title: string, projectId?: string) => {
    const stamp = new Date().toISOString()
    const bound = projectId && projectId !== 'default' ? projectId : undefined
    if (getConversation(convId)) {
      setConversation(convId, partialOf(convId, { label: title, updatedAt: stamp, ...(bound ? { projectId: bound } : {}) }))
      return
    }
    setConversations(
      sortConversations([{ key: convId, label: title, updatedAt: stamp, projectId: bound }, ...conversationsRef.current])
    )
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
    // Auto-cleanup evicts beyond MAX_SESSIONS. The eviction must go through the
    // same teardown as an explicit delete: the cached engine left in enginesRef
    // was re-read by the 10s sweep and the beforeunload flush, and both write
    // channels are UPSERTs — the deleted row came back on the next tick.
    const evictedIds = new Set<string>()
    const MAX_SESSIONS = 100
    if (autoCleanup && conversations.length >= MAX_SESSIONS) {
      const toRemove = conversations.length - MAX_SESSIONS + 1
      const oldest = conversations.slice(-toRemove) as Array<{ key: string }>
      for (const c of oldest) {
        evictedIds.add(String(c.key))
        removeConversation(c.key)
        // deleteWorkspace: the eviction is the ONE delete that also removes
        // the conversation's minted workspace folder (12h disk bound — the
        // folder tree grew to 10GB/302 folders in 5.5 weeks with no other
        // cleanup). The guard is main-side (project jail roots, backfill rows
        // pointing at the global root itself, and a moved base are never
        // touched); a manual delete omits the flag and keeps the folder.
        await teardownConversation(String(c.key), enginesRef.current, saveQueueRef.current,
          id => window.electronAPI.deleteConversation(id, { deleteWorkspace: true }).catch(() => {}))
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
    setActiveConversationKey('')

    // Then save previous conversation in the background (fire-and-forget).
    // Uses captured convId since convIdRef.current was already cleared; the
    // queue reads only that engine, so the save cannot be mis-filed under a
    // different conversation ID. A conversation the cleanup above just deleted
    // must NOT be flushed here — this was the last resurrection path: the full
    // save re-upserted the row the sweep's append had already brought back.
    if (oldConvId && !evictedIds.has(oldConvId)) void saveConversationById(oldConvId, true)
  }, [conversations, autoCleanup, enginesRef, saveConversationById,
      setMessages, setAgentStatus, setStreamingBlocks, setPlan,
      activeEngineIdRef, setActiveConversationKey, removeConversation])

  // ── Delete conversation ──
  // The teardown order (engine out of the map → queue.forget → delete row) is
  // shared with the auto-cleanup eviction via teardownConversation: a cached
  // engine left behind was re-saved by the periodic sweep and the beforeunload
  // flush, and both save channels are upserts, so the deleted row came back.
  const deleteConversation = useCallback(async (key: string) => {
    removeConversation(key)
    if (key === convIdRef.current) {
      setMessages([])
      setAgentStatus({ status: 'idle' })
      setStreamingBlocks([])
      setPlan(null)
    }
    await teardownConversation(key, enginesRef.current, saveQueueRef.current,
      id => window.electronAPI.deleteConversation(id))
  }, [removeConversation, enginesRef, setMessages, setAgentStatus, setStreamingBlocks, setPlan])

  // ── Rename conversation ──
  const renameConversation = useCallback((key: string, newLabel: string) => {
    setConversations(
      conversationsRef.current.map(
        (c) =>
          String(c.key) === key ? { ...c, label: newLabel } : c
      )
    )
    window.electronAPI.updateConversationTitle(key, newLabel)
  }, [setConversations])

  // ── Clear all conversations ──
  const clearAllConversations = useCallback(async () => {
    const keys = conversations.map((c: { key: string }) => c.key)
    for (const k of keys) {
      await teardownConversation(k, enginesRef.current, saveQueueRef.current,
        id => window.electronAPI.deleteConversation(id))
    }
    for (const [, engine] of enginesRef.current) {
      engine.dispose()
    }
    enginesRef.current.clear()
    setConversations([])
    setMessages([])
    setAgentStatus({ status: 'idle' })
    setStreamingBlocks([])
    setPlan(null)
    convIdRef.current = ''
    setActiveConversationKey('')
  }, [conversations, enginesRef, setConversations, setMessages,
      setAgentStatus, setStreamingBlocks, setPlan, setActiveConversationKey])

  // ── Toggle pin ──
  const togglePin = useCallback(async (key: string, pinned: boolean) => {
    setConversations(
      sortConversations(
        conversationsRef.current.map(
          (c) =>
            String(c.key) === key ? { ...c, pinned } : c
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
    setConversation(id, partialOf(id, { approvalMode: mode }))
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

  // ── Model binding (模型, per conversation) ──
  // Same optimistic pattern as the approval binding above: the list item
  // carries the model the composer shows, and the DB column (stub-inserting
  // the row when needed) is the durable copy the main-side session manager
  // re-resolves on refreshOptions. `profileId = null` unpins — the
  // conversation follows the global default again.
  const updateConversationProfile = useCallback((convId: string, profileId: string | null) => {
    const id = conversationKeyOf(convId)
    if (!id) {
      console.warn('[Persistence] profile update ignored: no conversation open')
      return
    }
    // Store-live per-item setter, never a map over conversationsRef — the
    // same-tick-as-addConversation trap documented on updateConversationApproval.
    setConversation(id, partialOf(id, { profileId: profileId ?? undefined }))
    void (async () => {
      try {
        await window.electronAPI.setConversationProfile?.(id, profileId)
        await window.electronAPI.agentSessionRefreshOptions?.(id)
      } catch (err) {
        console.warn('[Persistence] profile update failed:', err)
      }
    })()
  }, [setConversation])

  // ── Activate a conversation (state + ref kept in sync) ──
  const activateConversation = useCallback((key: string) => {
    setActiveConversationKey(key)
    convIdRef.current = key
  }, [setActiveConversationKey])

  // ── Cross-window title sync (PLAN-conversation-popout) ──
  // Title generation/rename happens in whichever window drove it; main fans
  // the DB write out as CONVERSATION_TITLE_CHANGED, so this window's sidebar
  // list follows without a reload. The popout window also receives its own
  // write's echo — harmless (it updates the same single entry its local
  // generateTitle already updated).
  const titleInListRef = useRef(updateConversationTitleInList)
  // eslint-disable-next-line react-hooks/refs -- latest mirror; the subscription below is mount-only
  titleInListRef.current = updateConversationTitleInList
  useEffect(() => {
    const unsub = window.electronAPI.onConversationTitleChanged(({ id, title, projectId }) => {
      titleInListRef.current(id, title, projectId)
    })
    return unsub
  }, [])

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
    adoptConversation,
    updateConversationTitleInList,
    createNewConversation,
    deleteConversation,
    renameConversation,
    clearAllConversations,
    togglePin,
    bumpConversation,
    updateConversationExpert,
    updateConversationApproval,
    updateConversationProfile,
    activateConversation
  }
}
