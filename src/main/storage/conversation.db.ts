import type { Conversation, ConversationIndexEntry, Message } from '../../shared/types/conversation'
import type { ContentBlock, ToolResultBlock } from '../../shared/types/agent'
import { toSandboxApprovalMode } from '../../shared/sandbox/policy'
import type { SandboxApprovalMode } from '../../shared/sandbox/policy'
import { extractSnippet } from '../../shared/search/snippet'
import { conversationKeyOf } from '../../shared/conversation-key'
import { getDb } from './database'
import { perfTime } from '../perf/perf-log'

/** Guard for the setters below.
 *
 * Each of them may run before its conversation row exists and therefore
 * stub-inserts one. An empty id is not a conversation — it is the client's
 * "nothing is open" sentinel (the conversation list opens at `''`; see
 * shared/conversation-key) — and honouring it produced a row with an empty id:
 * title 新对话, no messages, and visible in the sidebar. The renderer no longer
 * sends one; this is the last line so a client bug cannot write junk. */
function isRealConversationId(id: string): boolean {
  if (conversationKeyOf(id)) return true
  console.warn('[DB] ignored a write for an empty conversation id')
  return false
}

/** Derive conversation type from ID for backward compatibility. */
export function deriveConvType(id: string): string {
  if (id.startsWith('canvas_')) return 'canvas'
  if (id.startsWith('spawn_') || id.startsWith('sub_')) return 'spawn'
  // Tool-studio conversations (M5R): owned by the tool center, never listed
  // as chat conversations — and not 'normal', so M8 workspace resolution
  // never mints them a working directory.
  if (id.startsWith('toolstudio_')) return 'tool'
  // Routine runs (M4) are main-authored artifacts, not user chats: a distinct
  // type keeps them out of every 'normal'-filtered surface (sidebar list,
  // title/message search, memory pipeline) — they are reached through the
  // routine center's run history instead.
  if (id.startsWith('routine_')) return 'routine'
  // The routine / expert editors' form-assistant threads (form-assist family)
  // share the same hiding contract: reached only through their editor column,
  // never a chat row in any 'normal'-filtered surface.
  if (id.startsWith('expert_assist_')) return 'expert'
  return 'normal'
}

/** Tag a conversation's client origin (local UI vs ws extension session).
 *
 * Upserts rather than updates: a session is created *before* its first message
 * is persisted, so at stamping time the row often does not exist yet and a bare
 * UPDATE would silently do nothing — the row later created by message
 * persistence would carry no origin, which both leaks extension sessions into
 * the desktop chat list and hides them from the panel's own session list
 * (PLAN-browser-extension M1.4). */
export function updateConversationOrigin(id: string, origin: string): void {
  if (!isRealConversationId(id)) return
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, type, rect_id, origin)
       VALUES (?, '', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET origin = excluded.origin`
    )
    .run(id, now, now, deriveConvType(id), deriveRectId(id), origin)
}

/** Read a conversation's client origin (null when never stamped). */
export function getConversationOrigin(id: string): string | null {
  const row = getDb().prepare('SELECT origin FROM conversations WHERE id = ?').get(id) as { origin: string | null } | undefined
  return row?.origin ?? null
}

/** Recent conversations for one client origin — the browser extension's
 *  session list (PLAN-browser-extension M0.4, `session.list`). Carries the
 *  stored 授权 level so a remote client's approval control can show it. */
export function listConversationsByOrigin(
  origin: string,
  limit = 50,
): Array<{ id: string; title: string; updatedAt: string; approvalMode?: SandboxApprovalMode }> {
  const rows = getDb()
    .prepare('SELECT id, title, updated_at, approval_mode FROM conversations WHERE origin = ? ORDER BY updated_at DESC LIMIT ?')
    .all(origin, limit) as Array<{ id: string; title: string; updated_at: string; approval_mode: string | null }>
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    updatedAt: r.updated_at,
    approvalMode: toSandboxApprovalMode(r.approval_mode),
  }))
}

/** Batch-persist tool results (called before nanoCompact / by the agent host). */
export function persistToolResults(convId: string, results: Array<{ ref_id: string; conversation_id: string; message_id: string; block_index: number; tool_use_id: string; content: string; is_error: number }>): void {
  if (results.length === 0) return
  const database = getDb()
  // Ensure conversation exists (may be a new conversation not yet saved)
  database.prepare('INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at, type, rect_id) VALUES (?, ?, ?, ?, ?, ?)').run(convId, '', new Date().toISOString(), new Date().toISOString(), deriveConvType(convId), deriveRectId(convId))
  const stmt = database.prepare(
    'INSERT OR IGNORE INTO tool_results (ref_id, conversation_id, message_id, block_index, tool_use_id, content, is_error) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  database.transaction(() => {
    for (const r of results) stmt.run(r.ref_id, convId, r.message_id, r.block_index, r.tool_use_id, r.content, r.is_error)
  })()
}

/** Extract rect_id from canvas conversation IDs (canvas_<rectId>_<ts>_<rand>). */
export function deriveRectId(id: string): string | null {
  if (!id.startsWith('canvas_')) return null
  const parts = id.split('_')
  return parts[1] || null
}

// ── Tool result helpers ──

/** Extract tool_result blocks into tool_results table. Returns sanitized blocks for content_blocks JSON. */
function sanitizeToolResults(
  blocks: ContentBlock[] | undefined,
  convId: string,
  msgId: string,
  insertToolResult: (refId: string, convId: string, msgId: string, blockIndex: number, toolUseId: string, content: string, isError: number) => void
): ContentBlock[] | undefined {
  if (!blocks) return blocks
  let modified = false
  const out = blocks.map((block, idx) => {
    if (block.type !== 'tool_result') return block
    const trBlock = block as ToolResultBlock
    // Already has an ID (generated by renderer at creation time or from a previous save)
    if (trBlock.tool_result_id) {
      // Content may still be present (first save, renderer assigned ID before compression ran).
      // Don't write placeholder text to the table.
      if (trBlock.content && !trBlock.content.startsWith('[tool_result_id:')) {
        insertToolResult(trBlock.tool_result_id, convId, msgId, idx, trBlock.tool_use_id, trBlock.content, trBlock.is_error ? 1 : 0)
      }
      return { type: 'tool_result' as const, tool_use_id: trBlock.tool_use_id, tool_result_id: trBlock.tool_result_id, content: '' }
    }
    // No ID on the block. The renderer assigns tool_result_id for most paths,
    // but some (truncated/oversized rejections, adapter reconciliation) create
    // blocks without one. Derive a STABLE ref_id from message+tool_use so every
    // save writes the same row (INSERT OR REPLACE dedupes) — a fresh UUID here
    // would duplicate rows, since the mutation below only affects this IPC copy,
    // not the live renderer block.
    modified = true
    const toolResultId = `${msgId}_${trBlock.tool_use_id}`
    insertToolResult(toolResultId, convId, msgId, idx, trBlock.tool_use_id, trBlock.content, trBlock.is_error ? 1 : 0)
    // Mutate the original block so subsequent saves in this session detect it
    trBlock.tool_result_id = toolResultId
    return { type: 'tool_result' as const, tool_use_id: trBlock.tool_use_id, tool_result_id: toolResultId, content: '' }
  })
  return modified ? out : blocks
}

// ── Conversation CRUD ──

/**
 * Candidate updated_at derived from the messages being written: the newest
 * message timestamp, or `fallback` when the batch is empty. conversations.updated_at
 * means "last interaction time" (drives the sidebar ordering and its relative
 * label), so it must follow message data — stamping wall-clock "now" on every
 * write made merely viewing a conversation look recently active.
 */
function newestMessageAt(messages: ReadonlyArray<{ createdAt?: string }>, fallback: string): string {
  let newest = ''
  for (const m of messages) {
    if (m.createdAt && m.createdAt > newest) newest = m.createdAt
  }
  return newest || fallback
}

/** Hosted (browser-extension) client origins — their sessions never surface in
 *  the desktop chat list (裁定 3, PLAN-browser-extension). Kept in sync with
 *  client-registry.HOSTED_CLIENT_IDS (duplicated here to keep the DB layer
 *  free of agent-module imports). */
const HOSTED_ORIGINS = ['pulsemind-extension', 'anywhere-extension']

export function listConversations(): ConversationIndexEntry[] {
  const database = getDb()
  const originPlaceholders = HOSTED_ORIGINS.map(() => '?').join(', ')
  const rows = database
    .prepare(
      `SELECT
        c.id, c.title, c.summary, c.keywords, c.pinned, c.created_at, c.updated_at, c.project_id, c.workspace_dir, c.expert_id, c.approval_mode, c.profile_id,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS message_count
      FROM conversations c
      WHERE c.type = 'normal'
        AND (c.origin IS NULL OR c.origin NOT IN (${originPlaceholders}))
      ORDER BY c.pinned DESC, c.created_at DESC`
    )
    .all(...HOSTED_ORIGINS) as Array<{
      id: string; title: string; summary: string | null; keywords: string | null
      pinned: number; created_at: string; updated_at: string
      last_message: string | null; message_count: number; project_id: string | null
      workspace_dir: string | null; expert_id: string | null; approval_mode: string | null
      profile_id: string | null
    }>

  return rows.map((r) => ({
    id: r.id, title: r.title,
    summary: r.summary || undefined, keywords: r.keywords || undefined,
    pinned: r.pinned === 1, lastMessage: r.last_message?.slice(0, 100) || null,
    projectId: r.project_id || 'default',
    workspaceDir: r.workspace_dir || undefined,
    expertId: r.expert_id || undefined,
    approvalMode: toSandboxApprovalMode(r.approval_mode),
    profileId: r.profile_id || undefined,
    messageCount: r.message_count, createdAt: r.created_at, updatedAt: r.updated_at
  }))
}

export function getConversation(id: string): Conversation | null {
  const database = getDb()
  const conv = database
    .prepare('SELECT id, title, summary, keywords, history_summary, history_summary_frontier, approval_mode, profile_id, created_at, updated_at FROM conversations WHERE id = ?')
    .get(id) as { id: string; title: string; summary: string | null; keywords: string | null; history_summary: string | null; history_summary_frontier: string | null; approval_mode: string | null; profile_id: string | null; created_at: string; updated_at: string } | undefined
  if (!conv) return null

  const messages = database
    .prepare(
      'SELECT id, role, content, content_blocks, created_at, liked, favorited, processing_ms, input_tokens, output_tokens, cached_tokens, auto_summary, compressed_ids FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
    )
    .all(id) as Array<{ id: string; role: string; content: string; content_blocks: string | null; created_at: string; liked: number | null; favorited: number | null; processing_ms: number | null; input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null; auto_summary: number | null; compressed_ids: string | null }>

  return {
    id: conv.id, title: conv.title, summary: conv.summary || undefined,
    historySummary: conv.history_summary || undefined,
    historySummaryFrontier: conv.history_summary_frontier || undefined,
    approvalMode: toSandboxApprovalMode(conv.approval_mode),
    profileId: conv.profile_id || undefined,
    messages: messages.map((m) => ({
      id: m.id, role: m.role as 'user' | 'assistant',
      content: m.content,
      contentBlocks: m.content_blocks ? JSON.parse(m.content_blocks) : undefined,
      createdAt: m.created_at, liked: m.liked === 1, favorited: m.favorited === 1,
      processingMs: m.processing_ms ?? undefined, inputTokens: m.input_tokens ?? undefined,
      outputTokens: m.output_tokens ?? undefined,
      promptCacheHitTokens: m.cached_tokens ?? undefined,
      autoSummary: m.auto_summary === 1 || undefined,
      compressedIds: m.compressed_ids ? JSON.parse(m.compressed_ids) : undefined
    })),
    createdAt: conv.created_at, updatedAt: conv.updated_at
  }
}

export function saveConversation(conversation: Conversation): void {
  // PLAN-long-task-perf M0-T2: the synchronous full-conversation SQLite write
  // is the other perf-gate suspect (B6) — the wrapper keeps the body untouched.
  perfTime(`saveConversation conv=${conversation.id} msgs=${conversation.messages?.length ?? 0} bytes≈${(conversation.messages ?? []).reduce((n, m) => n + JSON.stringify(m.contentBlocks ?? []).length, 0)}`, () => saveConversationInner(conversation))
}

function saveConversationInner(conversation: Conversation): void {
  const database = getDb()
  const now = new Date().toISOString()
  // updated_at is the newest message time — but monotonic (PLAN T11): a full
  // save carrying older message data must never drag it below what a
  // concurrent append already stamped (sidebar ordering would jump).
  const lastMsgAt = newestMessageAt(conversation.messages || [], now)

  const upsertConv = database.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at, type, rect_id, history_summary, history_summary_frontier)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title,
       updated_at = MAX(conversations.updated_at, excluded.updated_at),
       history_summary = excluded.history_summary, history_summary_frontier = excluded.history_summary_frontier`
  )
  const upsertMsg = database.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, content_blocks, created_at, liked, favorited, processing_ms, input_tokens, output_tokens, cached_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       role = excluded.role, content = excluded.content, content_blocks = excluded.content_blocks,
       created_at = excluded.created_at,
       liked = excluded.liked,
       favorited = messages.favorited,
       processing_ms = excluded.processing_ms, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cached_tokens = excluded.cached_tokens`
  )
  const insertTokenUsage = database.prepare(
    'INSERT OR REPLACE INTO token_usage (id, input_tokens, output_tokens, cached_tokens, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  const insertToolResult = database.prepare(
    'INSERT OR REPLACE INTO tool_results (ref_id, conversation_id, message_id, block_index, tool_use_id, content, is_error) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  // P3-c (PLAN-security-hardening): a full save is the authority on what this
  // conversation holds, so rows it omits are residue — compaction truncation
  // and message deletion used to leave them forever (saveConversation is a
  // pure UPSERT). The reconciliation JSON is json_each-fed because a long
  // conversation would blow SQLite's bound-variable cap with `IN (?,?,…)`;
  // tool_results needs its own DELETE because its FK is conversation_id only
  // (database.ts) — dropped message rows do not drag their tool results along,
  // and both id columns are global primary keys a residue row would swallow
  // for any future reuse. Deliberately NOT added to appendConversationMessages:
  // append is append-only semantics ("只 upsert 指定消息" — its own comment),
  // and a reconciliation there would delete exactly the rows that did not
  // travel with the payload.
  const deleteMessagesNotIn = database.prepare(
    'DELETE FROM messages WHERE conversation_id = ? AND id NOT IN (SELECT value FROM json_each(?))'
  )
  const deleteToolResultsNotIn = database.prepare(
    'DELETE FROM tool_results WHERE conversation_id = ? AND message_id NOT IN (SELECT value FROM json_each(?))'
  )

  const save = database.transaction(() => {
    upsertConv.run(conversation.id, conversation.title || '新对话', conversation.createdAt || now, lastMsgAt, deriveConvType(conversation.id), deriveRectId(conversation.id), conversation.historySummary || null, conversation.historySummaryFrontier || null)

    // Message ids are generated BEFORE the loop: upsertMsg and the token_usage
    // row must share one id (a per-row `|| random` here once let the two calls
    // mint DIFFERENT ids for the same message), and the reconciliation list
    // must name the ids actually used — a generated id that stayed outside
    // savedIds would be inserted and then immediately deleted by our own
    // cleanup in the same transaction.
    const savedIds: string[] = []
    for (const msg of conversation.messages || []) {
      const msgId = msg.id || `msg_${conversation.id}_${now}_${savedIds.length}`
      const sanitized = sanitizeToolResults(msg.contentBlocks, conversation.id, msgId, (refId, convId, msgId2, blockIdx, toolUseId, content, isErr) => {
        insertToolResult.run(refId, convId, msgId2, blockIdx, toolUseId, content, isErr)
      })
      upsertMsg.run(
        msgId,
        conversation.id, msg.role, msg.content || '',
        sanitized ? JSON.stringify(sanitized) : null,
        msg.createdAt || now, msg.liked ? 1 : 0, msg.favorited ? 1 : 0,
        msg.processingMs ?? null, msg.inputTokens ?? null, msg.outputTokens ?? null, msg.promptCacheHitTokens ?? null
      )
      if (msg.inputTokens || msg.outputTokens) {
        insertTokenUsage.run(
          `tu_${msgId}`,
          msg.inputTokens || 0, msg.outputTokens || 0, msg.promptCacheHitTokens || 0, msg.createdAt || now
        )
      }
      savedIds.push(msgId)
    }

    // Same transaction as the upserts — the list and the rows it authorizes
    // land atomically, and a crash mid-save leaves the previous consistent set.
    const savedIdsJson = JSON.stringify(savedIds)
    deleteMessagesNotIn.run(conversation.id, savedIdsJson)
    deleteToolResultsNotIn.run(conversation.id, savedIdsJson)
  })
  save()
}

/** Append-only save: upserts conversation + only the specified messages (not all). */
export function appendConversationMessages(
  convId: string,
  title: string,
  messages: Message[]
): void {
  const database = getDb()
  const now = new Date().toISOString()

  const upsertConv = database.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at, type, rect_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title,
       updated_at = MAX(conversations.updated_at, excluded.updated_at)`
  )
  const upsertMsg = database.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, content_blocks, created_at, liked, favorited, processing_ms, input_tokens, output_tokens, cached_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       role = excluded.role, content = excluded.content, content_blocks = excluded.content_blocks,
       created_at = excluded.created_at,
       liked = excluded.liked,
       favorited = messages.favorited,
       processing_ms = excluded.processing_ms, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cached_tokens = excluded.cached_tokens`
  )
  const insertTokenUsage = database.prepare(
    'INSERT OR REPLACE INTO token_usage (id, input_tokens, output_tokens, cached_tokens, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  const insertToolResult = database.prepare(
    'INSERT OR REPLACE INTO tool_results (ref_id, conversation_id, message_id, block_index, tool_use_id, content, is_error) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )

  const save = database.transaction(() => {
    upsertConv.run(convId, title || '新对话', now, newestMessageAt(messages, now), deriveConvType(convId), deriveRectId(convId))
    for (const msg of messages) {
      const sanitized = sanitizeToolResults(msg.contentBlocks, convId, msg.id, (refId, convId2, msgId, blockIdx, toolUseId, content, isErr) => {
        insertToolResult.run(refId, convId2, msgId, blockIdx, toolUseId, content, isErr)
      })
      upsertMsg.run(
        msg.id,
        convId, msg.role, msg.content || '',
        sanitized ? JSON.stringify(sanitized) : null,
        msg.createdAt || now, msg.liked ? 1 : 0, msg.favorited ? 1 : 0,
        msg.processingMs ?? null, msg.inputTokens ?? null, msg.outputTokens ?? null, msg.promptCacheHitTokens ?? null
      )
      if (msg.inputTokens || msg.outputTokens) {
        insertTokenUsage.run(
          `tu_${msg.id}`,
          msg.inputTokens || 0, msg.outputTokens || 0, msg.promptCacheHitTokens || 0, msg.createdAt || now
        )
      }
    }
  })
  save()
}

/** Targeted metadata update for like/favorite toggles. */
export function updateMessageMetadata(
  msgId: string,
  data: { liked?: boolean; favorited?: boolean }
): void {
  const database = getDb()
  const updates: string[] = []
  const params: unknown[] = []
  if (data.liked !== undefined) { updates.push('liked = ?'); params.push(data.liked ? 1 : 0) }
  if (data.favorited !== undefined) { updates.push('favorited = ?'); params.push(data.favorited ? 1 : 0) }
  if (updates.length === 0) return
  params.push(msgId)
  database.prepare(`UPDATE messages SET ${updates.join(', ')} WHERE id = ?`).run(...params)
}

/** Stub-insert the minimal conversation row one binding write needs. The row
 *  itself is materialized by the first save, but a binding (project / expert /
 *  approval / workspace) can be chosen before that — usually before the row
 *  exists — so the write stubs a row in to carry it. The binding columns are
 *  bound by NAME: this family was once written with positional `?` params and
 *  setConversationProject bound the project id into `type` (and 'normal' into
 *  project_id), which made every project-mode first message invisible to the
 *  type='normal' list (repaired 2026-09-17, see repairSwappedProjectBindings). */
function stubInsertConversation(id: string, binding: Record<string, string>): void {
  const now = new Date().toISOString()
  const cols = { title: '新对话', type: deriveConvType(id), created_at: now, updated_at: now, ...binding }
  const names = Object.keys(cols)
  getDb()
    .prepare(`INSERT INTO conversations (id, ${names.join(', ')}) VALUES (@id, ${names.map((n) => '@' + n).join(', ')})`)
    .run({ id, ...cols })
}

/** Attach a conversation to a project (PLAN-0.4.0 M3.6). Called at conversation
 *  creation — usually before the row exists — so it stub-inserts the row.
 *  `saveConversation` later upserts without touching project_id, so the
 *  binding survives. */
export function setConversationProject(id: string, projectId: string): void {
  if (!isRealConversationId(id)) return
  const r = getDb().prepare('UPDATE conversations SET project_id = ? WHERE id = ?').run(projectId, id)
  if (r.changes === 0 && projectId !== 'default') {
    stubInsertConversation(id, { project_id: projectId })
  }
}

/** Resolve a conversation's project binding ('default' when unbound). */
export function getConversationProjectId(id: string): string {
  const row = getDb().prepare('SELECT project_id FROM conversations WHERE id = ?').get(id) as { project_id: string | null } | undefined
  return row?.project_id || 'default'
}

/** Bind (or unbind, expertId=null) the conversation's summoned expert.
 *  Same stub-insert contract as setConversationProject: may run before the row
 *  exists; later upserts never touch expert_id, so the binding survives. */
export function setConversationExpert(id: string, expertId: string | null): void {
  if (!isRealConversationId(id)) return
  const r = getDb().prepare('UPDATE conversations SET expert_id = ? WHERE id = ?').run(expertId, id)
  if (r.changes === 0 && expertId) {
    stubInsertConversation(id, { expert_id: expertId })
  }
}

/** Resolve a conversation's summoned expert id (null when unbound). */
export function getConversationExpertId(id: string): string | null {
  const row = getDb().prepare('SELECT expert_id FROM conversations WHERE id = ?').get(id) as { expert_id: string | null } | undefined
  return row?.expert_id || null
}

/** Store the conversation's tool-approval choice. Same stub-insert contract as
 *  setConversationExpert: may run before the row exists, and later upserts never
 *  touch approval_mode, so the choice survives. */
export function setConversationApprovalMode(id: string, mode: SandboxApprovalMode): void {
  if (!isRealConversationId(id)) return
  const r = getDb().prepare('UPDATE conversations SET approval_mode = ? WHERE id = ?').run(mode, id)
  if (r.changes === 0) {
    stubInsertConversation(id, { approval_mode: mode })
  }
}

/** Resolve a conversation's approval choice (undefined = never chosen). */
export function getConversationApprovalMode(id: string): SandboxApprovalMode | undefined {
  const row = getDb().prepare('SELECT approval_mode FROM conversations WHERE id = ?').get(id) as { approval_mode: string | null } | undefined
  return toSandboxApprovalMode(row?.approval_mode)
}

/** Pin the conversation to an LLM profile (null = unpin → follow the global
 *  default again). Same stub-insert contract as setConversationApprovalMode:
 *  may run before the row exists (the welcome composer's model picker), and
 *  later upserts never touch profile_id, so the choice survives. */
export function setConversationProfile(id: string, profileId: string | null): void {
  if (!isRealConversationId(id)) return
  const r = getDb().prepare('UPDATE conversations SET profile_id = ? WHERE id = ?').run(profileId, id)
  if (r.changes === 0 && profileId) {
    stubInsertConversation(id, { profile_id: profileId })
  }
}

/** Resolve a conversation's own model choice (undefined = never chosen — the
 *  conversation follows the global default). */
export function getConversationProfileId(id: string): string | undefined {
  const row = getDb().prepare('SELECT profile_id FROM conversations WHERE id = ?').get(id) as { profile_id: string | null } | undefined
  return row?.profile_id || undefined
}

/** The conversation's resolved working directory (M8), or null before the
 *  first session — used to jail browser file uploads (A-M4). */
export function getConversationWorkspaceDir(id: string): string | null {
  const row = getDb().prepare('SELECT workspace_dir FROM conversations WHERE id = ?').get(id) as { workspace_dir: string | null } | undefined
  return row?.workspace_dir || null
}

/** Store the conversation's resolved working directory (PLAN-0.4.0 M8).
 *  Like the other binding setters, this can run before the row exists (the row is
 *  materialized by the first save), so it stub-inserts when needed. */
export function setConversationWorkspaceDir(id: string, workspaceDir: string): void {
  if (!isRealConversationId(id)) return
  const r = getDb().prepare('UPDATE conversations SET workspace_dir = ? WHERE id = ?').run(workspaceDir, id)
  if (r.changes === 0) {
    stubInsertConversation(id, { workspace_dir: workspaceDir })
  }
}

/** One-time repair (2026-09-17): the positional stub-insert in
 *  setConversationProject bound the project id into `type` and 'normal' into
 *  `project_id`, so every project-mode conversation whose row it stubbed fell
 *  out of every type='normal' surface (sidebar lists, search, the memory
 *  pipeline) and bound to no project. The swap is unambiguous — 'normal' is a
 *  conversation type, never a project id ('default' / proj_*) — so put the
 *  columns back. Idempotent: the predicate only matches poisoned rows. */
export function repairSwappedProjectBindings(): void {
  const r = getDb()
    .prepare("UPDATE conversations SET project_id = type, type = 'normal' WHERE project_id = 'normal' AND type <> 'normal'")
    .run()
  if (r.changes > 0) console.log(`[DB] repaired ${r.changes} conversation row(s) with a swapped project binding`)
}

/** Delete a conversation together with the content rows it owns.
 *
 * Every caller means「会话连同其内容」— the sidebar delete, the retention
 * cleanup, a project's removal and the form-assist discard all say so in their
 * own comments — and an orphaned row is not merely dead weight: `messages.id`
 * is a global key whose OWNER is write-once (the message upsert never rewrites
 * `conversation_id`, see saveConversationInner), so a surviving row swallows a
 * later message that reuses its id. `token_usage` is deliberately left alone —
 * those tokens were really spent, and the usage ledger is not per-conversation. */
export function deleteConversation(id: string): void {
  const database = getDb()
  database.transaction(() => {
    database.prepare('DELETE FROM tool_results WHERE conversation_id = ?').run(id)
    database.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
    database.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  })()
}

/** Ids of unpinned conversations last updated before the retention window —
 *  the candidates for 对话管理's 最长保留时长 cleanup. Pinned conversations are
 *  never expired; callers decide which of these are safe to delete (a live
 *  session's row is excluded by the caller, which knows what is running). */
export function listExpiredConversationIds(retentionDays: number, limit = 500): string[] {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return []
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const rows = getDb()
    .prepare("SELECT id FROM conversations WHERE type = 'normal' AND (pinned IS NULL OR pinned = 0) AND updated_at < ? ORDER BY updated_at ASC LIMIT ?")
    .all(cutoff, limit) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/** One-shot data migration: routine-run conversations persisted before routine
 *  conversations got their own type were stamped 'normal' and surfaced in the
 *  user's chat list. Re-type them so they live only behind the routine center.
 *  Idempotent — safe to call on every startup. */
export function migrateRoutineConversationTypes(): void {
  getDb()
    .prepare("UPDATE conversations SET type = 'routine' WHERE type = 'normal' AND id LIKE 'routine\\_%' ESCAPE '\\'")
    .run()
}

// ── Conversation metadata ──

export function updateConversationTitle(id: string, title: string): void {
  getDb()
    .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, new Date().toISOString(), id)
}

export function updateConversationSummary(id: string, summary: string): void {
  getDb()
    .prepare('UPDATE conversations SET summary = ? WHERE id = ?')
    .run(summary, id)
}

export function updateConversationKeywords(id: string, keywords: string): void {
  getDb()
    .prepare('UPDATE conversations SET keywords = ? WHERE id = ?')
    .run(keywords, id)
}

export function getConversationExtractedMsgCount(id: string): number {
  const row = getDb()
    .prepare('SELECT extracted_msg_count FROM conversations WHERE id = ?')
    .get(id) as { extracted_msg_count: number } | undefined
  return row?.extracted_msg_count ?? 0
}

export function updateConversationExtractedMsgCount(id: string, count: number): void {
  getDb()
    .prepare('UPDATE conversations SET extracted_msg_count = ? WHERE id = ?')
    .run(count, id)
}

export function getConversationExperienceExtractedCount(id: string): number {
  const row = getDb()
    .prepare('SELECT experience_extracted_count FROM conversations WHERE id = ?')
    .get(id) as { experience_extracted_count: number } | undefined
  return row?.experience_extracted_count ?? 0
}

export function updateConversationExperienceExtractedCount(id: string, count: number): void {
  getDb()
    .prepare('UPDATE conversations SET experience_extracted_count = ? WHERE id = ?')
    .run(count, id)
}

export function updateConversationPinned(id: string, pinned: boolean): void {
  getDb()
    .prepare('UPDATE conversations SET pinned = ?, updated_at = ? WHERE id = ?')
    .run(pinned ? 1 : 0, new Date().toISOString(), id)
}

export function touchConversation(id: string): void {
  getDb()
    .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
}

export function saveConversationPlan(id: string, planJson: string | null): void {
  getDb()
    .prepare('UPDATE conversations SET plan_json = ? WHERE id = ?')
    .run(planJson, id)
}

export function getConversationPlan(id: string): string | null {
  const row = getDb()
    .prepare('SELECT plan_json FROM conversations WHERE id = ?')
    .get(id) as { plan_json: string | null } | undefined
  return row?.plan_json ?? null
}

/**
 * Load a conversation with full tool_result content filled from tool_results table.
 * Called when continuing a conversation (AgentEngine needs full content).
 *
 * `maxContentLength` caps each restored tool_result's content — the deliverables
 * BFS hydrates child sessions only to derive rows (pairing, is_error, paths) and
 * never reads the bodies, so it passes a cap instead of pulling every 200KB
 * output across the IPC into the renderer heap (PLAN-long-task-perf M3-T3).
 * The cap is applied IN SQL (`substr`): the full content lives ONLY in this
 * table (sanitizeToolResults blanks the inline copy on save), so a child full
 * of whole-file `read` results must not cost the files — reading them in full
 * and slicing after was the load freeze behind 11-wide spawn batches (0.4.1
 * report). Callers that need the full text (continuing a conversation) omit
 * the param and get byte-identical behaviour.
 */
export function hydrateConversation(id: string, maxContentLength?: number): Conversation | null {
  const conv = getConversation(id)
  if (!conv) return null

  const database = getDb()
  const rows = (maxContentLength != null
    ? database.prepare(
        'SELECT ref_id, substr(content, 1, ?) AS content, is_error FROM tool_results WHERE conversation_id = ?'
      ).all(maxContentLength, id)
    : database.prepare(
        'SELECT ref_id, content, is_error FROM tool_results WHERE conversation_id = ?'
      ).all(id)) as Array<{ ref_id: string; content: string; is_error: number }>

  const resultMap = new Map<string, { content: string; isError: number }>()
  for (const r of rows) resultMap.set(r.ref_id, { content: r.content, isError: r.is_error })

  for (const msg of conv.messages) {
    if (!msg.contentBlocks) continue
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_result' && block.tool_result_id) {
        const data = resultMap.get(block.tool_result_id)
        if (data) {
          block.content = maxContentLength != null && data.content.length > maxContentLength
            ? data.content.slice(0, maxContentLength)
            : data.content
          block.is_error = data.isError === 1
        }
      }
    }
  }

  return conv
}

/**
 * Atomically delete a set of message IDs and insert replacement messages.
 */
export function replaceMessagesAtomic(
  deletes: string[],
  inserts: Array<{
    id: string; conversation_id: string; role: string; content: string;
    content_blocks: string | null; created_at: string;
    auto_summary: number; compressed_ids: string | null
  }>
): void {
  if (deletes.length === 0 && inserts.length === 0) return
  const database = getDb()
  const delStmt = database.prepare('DELETE FROM messages WHERE id = ?')
  // tool_results has no FK on message_id, so deleting a message without this
  // would leave its tool_result rows orphaned and unreachable forever.
  const delTrStmt = database.prepare('DELETE FROM tool_results WHERE message_id = ?')
  const insStmt = database.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, content_blocks, created_at, auto_summary, compressed_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  database.transaction(() => {
    for (const id of deletes) { delStmt.run(id); delTrStmt.run(id) }
    for (const m of inserts) insStmt.run(m.id, m.conversation_id, m.role, m.content, m.content_blocks, m.created_at, m.auto_summary, m.compressed_ids)
  })()
}

/** Look up tool_result content by ref_id from the tool_results table. */
export function getToolResultsByIds(ids: string[]): Array<{
  ref_id: string; conversation_id: string; message_id: string
  block_index: number; tool_use_id: string; content: string; is_error: number
}> {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  return getDb().prepare(
    `SELECT ref_id, conversation_id, message_id, block_index, tool_use_id, content, is_error
     FROM tool_results WHERE ref_id IN (${placeholders})`
  ).all(...ids) as Array<{
    ref_id: string; conversation_id: string; message_id: string
    block_index: number; tool_use_id: string; content: string; is_error: number
  }>
}

export function listConversationsForMemory(opts: {
  afterTime?: string; beforeTime?: string; limit?: number
}): Array<{ id: string; title: string; summary: string | null; keywords: string | null; updatedAt: string }> {
  const database = getDb()
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.afterTime) { conditions.push('updated_at > ?'); params.push(opts.afterTime) }
  if (opts.beforeTime) { conditions.push('updated_at < ?'); params.push(opts.beforeTime) }

  conditions.push("type = 'normal'")
  const where = 'WHERE ' + conditions.join(' AND ')
  const order = opts.beforeTime && !opts.afterTime ? 'DESC' : 'ASC'
  const limit = opts.limit ? `LIMIT ${opts.limit}` : ''

  return database.prepare(
    `SELECT id, title, summary, keywords, updated_at FROM conversations ${where} ORDER BY updated_at ${order} ${limit}`
  ).all(...params) as Array<{ id: string; title: string; summary: string | null; keywords: string | null; updatedAt: string }>
}

/**
 * Search conversations by keyword in title, summary, and keywords fields.
 * Uses LIKE '%keyword%' — performs a full table scan over conversations,
 * but the table is small (title/summary/keywords are short text columns),
 * so this is fast even with thousands of conversations.
 */
export function searchConversationsByKeyword(
  query: string, limit = 20,
  dateFilter?: { createdAfter?: string; createdBefore?: string; updatedAfter?: string; updatedBefore?: string }
): Array<{
  id: string; title: string; summary: string | null; keywords: string | null; updatedAt: string
}> {
  const database = getDb()
  const pattern = `%${query}%`
  const conditions: string[] = ["type = 'normal' AND (title LIKE ? OR summary LIKE ? OR keywords LIKE ?)"]
  const params: unknown[] = [pattern, pattern, pattern]

  if (dateFilter) {
    if (dateFilter.createdAfter) { conditions.push('created_at >= ?'); params.push(dateFilter.createdAfter) }
    if (dateFilter.createdBefore) { conditions.push('created_at < ?'); params.push(dateFilter.createdBefore) }
    if (dateFilter.updatedAfter) { conditions.push('updated_at >= ?'); params.push(dateFilter.updatedAfter) }
    if (dateFilter.updatedBefore) { conditions.push('updated_at < ?'); params.push(dateFilter.updatedBefore) }
  }

  params.push(limit)
  return database.prepare(
    `SELECT id, title, summary, keywords, updated_at AS updatedAt
     FROM conversations
     WHERE ${conditions.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT ?`
  ).all(...params) as Array<{
    id: string; title: string; summary: string | null; keywords: string | null; updatedAt: string
  }>
}

/**
 * Search message bodies, for the search center's message group. LIKE over
 * messages.content — same full-scan trade-off as the conversation keyword search,
 * and the same type filter so canvas/spawn transcripts stay out of results.
 * Each hit carries a one-line snippet around the match.
 */
export function searchMessagesByKeyword(
  query: string, limit = 20
): Array<{
  conversationId: string; conversationTitle: string; role: 'user' | 'assistant'; snippet: string; createdAt: string
}> {
  const rows = getDb().prepare(
    `SELECT m.conversation_id AS conversationId, c.title AS conversationTitle,
            m.role, m.content, m.created_at AS createdAt
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.type = 'normal' AND m.content LIKE ?
     ORDER BY m.created_at DESC
     LIMIT ?`
  ).all(`%${query}%`, limit) as Array<{
    conversationId: string; conversationTitle: string; role: 'user' | 'assistant'; content: string; createdAt: string
  }>

  return rows.map(({ content, ...row }) => ({ ...row, snippet: extractSnippet(content, query) }))
}

/** Longest preview the welcome page renders; keeps IPC payloads small. */
const LAST_USER_MESSAGE_MAX = 300

/**
 * Text of the user's most recent input in a conversation — what the welcome
 * page echoes back as "you last said …". Tool results are also persisted under
 * role 'user' with empty content, so rows without text are skipped; assistant
 * replies are skipped on purpose: the user's own words are the anchor for
 * resuming.
 */
export function getConversationLastUserMessage(id: string): string | null {
  const row = getDb().prepare(
    `SELECT content FROM messages
     WHERE conversation_id = ? AND role = 'user' AND TRIM(COALESCE(content, '')) <> ''
     ORDER BY created_at DESC
     LIMIT 1`
  ).get(id) as { content: string } | undefined
  const text = row?.content?.trim()
  return text ? text.slice(0, LAST_USER_MESSAGE_MAX) : null
}
