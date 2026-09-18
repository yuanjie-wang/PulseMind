/**
 * Sub-conversation aggregation for the deliverables card (PLAN-deliverables
 * M2). The main session's rows come straight from the mirror (pure, always
 * fresh); this hook adds what the spawn tree wrote: at a TERMINAL turn status
 * it walks the spawn blocks' subConvIds breadth-first, hydrates each child
 * through the existing CONVERSATION_HYDRATE channel (SubAgentSessionView's
 * channel — no new IPC), derives the child's rows with the same pure
 * collector, and merges.
 *
 * Why only terminal: spawn_batch settles the parent turn only after every
 * child settles, so at `completed`/`error` the children are final — one
 * hydration each is enough, and a child still streaming contributes nothing
 * that would not be re-scanned at the next terminal anyway.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentMessage, AgentStatus } from '../types/agent'
import {
  collectDeliverables,
  mergeDeliverables,
  type Deliverable,
  type DeliverableRow
} from '../components/chat/deliverables'

/** spawn depth cap — main → child → grand → great-grand. A defense line, not
 *  a semantic (spawn chains deeper than this are not a thing the product has). */
const MAX_DEPTH = 3
/** Hydrations per scan. Also a defense line. */
const MAX_HYDRATES = 20
/** Module-level cache cap (LRU by insertion order). */
const CACHE_CAP = 40

interface ChildCacheEntry {
  rows: DeliverableRow[]
  title?: string
  /** Set once hydrated. The parent only reaches terminal after its children
   *  settle, so one hydration sees each child's final state; later scans skip
   *  settled entries instead of re-reading the DB. */
  settled: boolean
  /** The spawn targets found inside this child — a later scan that skips the
   *  settled child must still traverse THESE, or the grandchildren's cached
   *  rows silently drop out of the merge (the re-scan convergence trap). */
  childIds: string[]
}

/** Module-level: children outlive one hook mount (conversation switch and
 *  remount should not re-read the DB for an already-final child). */
const childCache = new Map<string, ChildCacheEntry>()

/** Every spawn block's subConvId in one message list (any depth of nesting is
 *  flattened here — the BFS below caps the levels). */
function spawnTargets(messages: AgentMessage[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    for (const block of message.contentBlocks ?? []) {
      if (block.type !== 'tool_use') continue
      if (block.name !== 'spawn_agent') continue
      const subConvId = (block as { subConvId?: unknown }).subConvId
      if (typeof subConvId === 'string' && subConvId.trim() !== '') ids.push(subConvId)
    }
  }
  return ids
}

const isTerminal = (status: AgentStatus['status'] | undefined): boolean =>
  status === 'completed' || status === 'error' || status === 'idle'

const EMPTY_DELIVERABLE: Deliverable = { rows: [], sources: [] }

export function useDeliverables(
  conversationId: string | null | undefined,
  messages: AgentMessage[],
  agentStatus?: AgentStatus
): Deliverable {
  const main = useMemo(() => collectDeliverables(messages), [messages])

  const status = agentStatus?.status
  const terminal = isTerminal(status)
  const convKey = conversationId ?? ''

  // The child state rides the conversation it was scanned for, and the reset
  // on switch happens during render (SubAgentSessionView's pattern): a second
  // effect clearing after the scan effect would race the fully-cached scan —
  // a scan with zero hydrates completes synchronously inside its effect, so a
  // later reset effect in the same commit would wipe its result.
  const [childState, setChildState] = useState<{ convKey: string; part: Deliverable }>({
    convKey,
    part: EMPTY_DELIVERABLE
  })
  if (childState.convKey !== convKey) setChildState({ convKey, part: EMPTY_DELIVERABLE })
  const childPart = childState.convKey === convKey ? childState.part : EMPTY_DELIVERABLE

  // One scan per (conversation × entry-into-scan-worthiness): terminal turns
  // rescan on transition, and cache hits make a rescan cheap — the guard only
  // stops the effect from re-deriving identical child state every render.
  const scannedRef = useRef('')

  useEffect(() => {
    if (convKey === '') return
    // A host without a status surface (no agentStatus at all) still gets its
    // history reopen scanned — first non-empty messages. With a status present
    // the terminal check alone governs: a LIVE conversation's first messages
    // arrive while executing, and that must not scan (the children are not
    // done; the terminal scan will).
    const statuslessFirstNonEmpty = agentStatus === undefined && messages.length > 0 && scannedRef.current !== convKey
    if (!terminal && !statuslessFirstNonEmpty) return
    scannedRef.current = convKey

    let cancelled = false
    const scan = async (): Promise<void> => {
      // BFS from the main session's spawn blocks; cached-settled children are
      // skipped entirely (their own children were visited when they were read).
      let level = spawnTargets(messages)
      const visited = new Set<string>()
      let hydrates = 0
      for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
        const next: string[] = []
        for (const id of level) {
          if (visited.has(id)) continue
          visited.add(id)
          const cached = childCache.get(id)
          if (cached?.settled) {
            next.push(...cached.childIds)
            continue
          }
          if (hydrates >= MAX_HYDRATES) continue
          hydrates++
          try {
            const conv = await window.electronAPI.hydrateConversation(id)
            if (cancelled) return
            const childMessages = (conv?.messages ?? []) as unknown as AgentMessage[]
            const derived = collectDeliverables(childMessages, { convId: id })
            childCache.set(id, {
              rows: derived.rows,
              title: conv?.title ?? undefined,
              settled: true,
              childIds: spawnTargets(childMessages)
            })
            while (childCache.size > CACHE_CAP) {
              const oldest = childCache.keys().next().value
              if (oldest === undefined) break
              childCache.delete(oldest)
            }
            next.push(...spawnTargets(childMessages))
          } catch {
            // Not cached: the next terminal scan retries a transient failure.
          }
        }
        level = next
      }

      if (cancelled) return
      const rows: DeliverableRow[] = []
      const sources: Deliverable['sources'] = []
      for (const id of visited) {
        const entry = childCache.get(id)
        if (!entry) continue
        rows.push(...entry.rows)
        if (entry.rows.length > 0) sources.push({ convId: id, title: entry.title })
      }
      setChildState({ convKey, part: { rows, sources } })
    }
    void scan()
    return () => {
      cancelled = true
    }
  }, [convKey, messages, terminal])

  return useMemo(() => mergeDeliverables([main, childPart]), [main, childPart])
}
