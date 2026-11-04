/** Transcript persistence for main-hosted sessions (2026-11-02).
 *
 * The browser extension's sessions run in the main process with no renderer
 * to save for them — `useConversationPersistence` mirrors only the desktop's
 * own conversations — so every extension conversation stayed the stub its
 * origin stamp inserted: `title=''`/「新对话」, zero messages, FOREVER. The
 * 历史会话 menu listed 32 such rows on the dev machine, none of them resumable
 * after a desktop restart, and `session.list`'s EXISTS(messages) rule (same
 * day) then listed nothing at all. The routine runner met the same gap and
 * papered over it at settlement (`persistTranscript`); this generalizes it.
 *
 * Rule: on every turn END — a `status` event landing outside
 * `isActiveStatus` — the session's live transcript is written through
 * `saveConversation`. One upsert per turn, never per chunk. Only HOSTED
 * origins (`isHostedClientId`) persist here: a desktop conversation's renderer
 * is its writer, and a second channel would resurrect rows the renderer
 * deleted (the G84 double-writer trap). The same trap is why the transcript
 * is read through `snapshot()` and not `history()`: snapshot answers null for
 * a session the service no longer holds (deleted mid-turn) where history's
 * ensureEntry would mint one — and a null means nothing is written.
 *
 * Title follows the desktop's own rule (useConversationPersistence): an
 * existing title survives unless it is the placeholder; otherwise the first
 * message's first text block. The history summary rides along too (review
 * 20261103 中2): the upsert's conflict clause writes
 * `history_summary = excluded.history_summary`, so a save WITHOUT the summary
 * NULLed the column every turn and a compacted session resumed full-width,
 * paying one fresh compaction LLM call after every restart. The desktop writer
 * assigns `engine.getHistorySummary()` before its save; here the same value
 * arrives through `engineCall` (best-effort — a failure saves summary-less
 * rather than not saving). */

import type { AgentEventData } from '../../shared/agent-protocol'
import { isActiveStatus, mirroredStatus } from '../../shared/agent-session/mirror'
import type { AgentMessage } from '../../renderer/src/types/agent'
import { agentMessagesToConversation } from '../../renderer/src/utils/message-utils'
import { isHostedClientId } from './client-registry'

const PLACEHOLDER_TITLE = '新对话'

export interface HostedPersistenceDeps {
  onEvent: (sink: (sessionId: string, data: AgentEventData) => void) => () => void
  /** Null when the service does not hold the session (deleted) — nothing is written then. */
  snapshot: (sessionId: string) => Promise<{ messages: unknown[] } | null>
  /** The conversation's stamped origin (null = never stamped / row gone). */
  origin: (sessionId: string) => string | null
  /** The stored title, so a user rename survives the turn-end rewrite. */
  title: (sessionId: string) => string | null
  /** The engine's history-summary cache (`{text, firstKeptId}` or null),
   *  through engineCall('getHistorySummary') — the column the desktop writer
   *  also fills, and one the save would otherwise NULL every turn. */
  historySummary: (sessionId: string) => Promise<{ text: string; firstKeptId?: string } | null>
  save: (conversation: ReturnType<typeof agentMessagesToConversation>) => void
  warn?: (message: string, err: unknown) => void
}

/** The desktop's title rule, verbatim (useConversationPersistence.snapshotConversation). */
export function deriveHostedTitle(existing: string | null, messages: AgentMessage[]): string {
  if (existing && existing !== PLACEHOLDER_TITLE) return existing
  const firstText = messages[0]?.contentBlocks?.find((b) => b.type === 'text')?.text || ''
  return firstText || PLACEHOLDER_TITLE
}

/** A status event whose NEW status is a resting one — the turn ended (idle),
 *  or died (error). Parked states (awaiting_*) are active: the turn is still
 *  open, and the transcript lands when it closes. */
export function isTurnEndEvent(data: AgentEventData): boolean {
  if (data.type !== 'status') return false
  // The status event IS a StatusSnapshot (plus its tool carriers); the mirror's
  // own folding turns it into the AgentStatus the activity predicate reads.
  return !isActiveStatus(mirroredStatus(data))
}

/** Persist one hosted session's transcript now (the per-event body, exported
 *  for the tests and for a settle-time flush). Resolves false when nothing was
 *  written: not hosted, no messages, or the service no longer holds it. */
export async function persistHostedTranscript(deps: HostedPersistenceDeps, sessionId: string): Promise<boolean> {
  const origin = deps.origin(sessionId)
  if (!origin || !isHostedClientId(origin)) return false
  const snap = await deps.snapshot(sessionId)
  if (!snap) return false
  const messages = snap.messages as AgentMessage[]
  if (!Array.isArray(messages) || messages.length === 0) return false
  const conversation = agentMessagesToConversation(messages, sessionId, deriveHostedTitle(deps.title(sessionId), messages))
  // Same assignment the desktop writer makes (useConversationPersistence
  // snapshotConversation): without it the upsert's conflict clause NULLs the
  // column and every compacted session re-compacts from scratch after a
  // restart. Best-effort — a summary read failure saves summary-less rather
  // than dropping the transcript.
  try {
    const hs = await deps.historySummary(sessionId)
    if (hs) {
      conversation.historySummary = hs.text
      conversation.historySummaryFrontier = hs.firstKeptId
    }
  } catch {
    /* summary read failed — the transcript still lands */
  }
  deps.save(conversation)
  return true
}

/** Subscribe; returns the unsubscribe. Failures are logged and never thrown
 *  into the engine's notify chain (the sink runs inside emit). */
export function installHostedPersistence(deps: HostedPersistenceDeps): () => void {
  const warn = deps.warn ?? ((message, err) => console.warn(`[hosted-persistence] ${message}`, err))
  return deps.onEvent((sessionId, data) => {
    if (!isTurnEndEvent(data)) return
    void persistHostedTranscript(deps, sessionId).catch((err) => warn(`transcript persistence failed (${sessionId})`, err))
  })
}
