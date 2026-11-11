import { getHost } from './host'
import { parseMultiFileDiff } from '../../../shared/diff/patch-utils'
import { normalizePathInput } from '../../../shared/path-input'
// ── Helpers ──────────────────────────────────────────────────────────────

export function generateMsgId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

// ── Chunked file write helper ─────────────────────────────────────────────

const WRITE_CHUNK_SIZE = 8192

export async function writeFileChunked(
  filePath: string,
  content: string,
  append: boolean
): Promise<{ success: boolean; error?: string }> {
  if (content.length <= WRITE_CHUNK_SIZE) {
    return getHost().writeFile({ filePath, content, append })
  }
  const chunks: string[] = []
  let start = 0
  while (start < content.length) {
    let end = Math.min(start + WRITE_CHUNK_SIZE, content.length)
    if (end < content.length) {
      const nl = content.lastIndexOf('\n', end)
      if (nl > start) end = nl + 1
    }
    chunks.push(content.slice(start, end))
    start = end
  }
  let result = await getHost().writeFile({ filePath, content: chunks[0], append })
  if (!result.success) return result
  for (let i = 1; i < chunks.length; i++) {
    result = await getHost().writeFile({ filePath, content: chunks[i], append: true })
    if (!result.success) return result
  }
  return { success: true }
}

// ── MCP schema sanitizer ──────────────────────────────────────────────────
// MCP servers can return JSON Schema with constructs (anyOf, nullable,
// union types like ["string", "null"]) that Anthropic/OpenAI reject.
// This normalizes them to a compatible subset.

export function sanitizeSchema(schema: unknown): unknown {
  // Whitelist-based JSON Schema sanitizer for LLM API compatibility.
  // Strips unsupported constructs (anyOf, nullable, type arrays, null values)
  // and only keeps keywords that Anthropic/OpenAI accept.

  if (typeof schema !== 'object' || schema === null) {
    return { type: 'object', properties: {} }
  }
  const s = schema as Record<string, unknown>

  // ── Resolve $ref and composition keywords ──
  if (s.$ref) return { type: 'string' }
  if (s.anyOf || s.oneOf || s.allOf) {
    const candidates = (s.anyOf || s.oneOf || s.allOf) as unknown[]
    for (const c of candidates) {
      if (typeof c === 'object' && c !== null && !('$ref' in (c as Record<string, unknown>))) {
        return sanitizeSchema(c)
      }
    }
    return { type: 'string' }
  }

  // ── WHITELIST: only these JSON Schema keywords are kept ──
  const ALLOWED = new Set([
    'type', 'properties', 'items', 'required', 'description', 'enum',
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
    'multipleOf', 'minLength', 'maxLength', 'pattern',
    'minItems', 'maxItems', 'uniqueItems', 'additionalProperties'
  ])

  const result: Record<string, unknown> = {}
  for (const key of Object.keys(s)) {
    if (!ALLOWED.has(key)) continue     // drop unsupported keywords
    if (s[key] === null) continue        // drop null values — LLM APIs reject them
    result[key] = s[key]
  }

  // ── Normalize type ──
  if (Array.isArray(result.type)) {
    const nonNull = (result.type as unknown[]).find((t) => t !== 'null')
    result.type = typeof nonNull === 'string' ? nonNull : 'string'
  } else if (result.type === undefined || result.type === null) {
    if (result.enum !== undefined) result.type = 'string'
    else if (result.properties !== undefined) result.type = 'object'
    else result.type = 'string'
  }

  // ── Ensure root with properties is "object" ──
  if (result.properties !== undefined && result.type !== 'object') {
    result.type = 'object'
  }

  // ── additionalProperties: only boolean or schema object ──
  if ('additionalProperties' in result) {
    const ap = result.additionalProperties
    if (typeof ap === 'boolean') {
      // keep as-is
    } else if (typeof ap === 'object' && ap !== null) {
      result.additionalProperties = sanitizeSchema(ap)
    } else {
      delete result.additionalProperties   // includes null, number, etc.
    }
  }

  // ── Recurse ──
  if (result.properties && typeof result.properties === 'object') {
    const sanitized: Record<string, unknown> = {}
    for (const key of Object.keys(result.properties)) {
      sanitized[key] = sanitizeSchema((result.properties as Record<string, unknown>)[key])
    }
    result.properties = sanitized
  }
  if (result.items && typeof result.items === 'object' && !Array.isArray(result.items)) {
    result.items = sanitizeSchema(result.items)
  }

  return result
}

// ── Shell escape helpers ──────────────────────────────────────────────────

export function shEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')
}

/**
 * Resolve a model-supplied file_path the way ToolExecutor.resolveWorkspacePath
 * does — the ONE spelling the read-before-write ledger is keyed by. Extracted
 * so the approval-side consumers (the protected-path gate) compare paths in
 * the same coordinate system the executor writes with; `~` passes through
 * unexpanded (the main process's normalizeUserPath is the authority).
 *
 * A `file:` / `local-file:` URI is stripped FIRST, because it names an ABSOLUTE
 * path (2026-11-10 UOS attachment: `[file:/home/…/x.png]` was joined onto the
 * session workspace as `<ws>/file:/home/…`, a spelling that cannot exist). The
 * same strip runs in the main process's gate and resolvers (shared/path-input),
 * so the key this returns and the path that lands on disk stay one spelling —
 * a protected path spelled as a URI cannot slip past the gate while file-ops
 * writes the real file.
 */
export function resolveToolFilePath(filePath: string, workspaceDir?: string): string {
  const target = normalizePathInput(filePath)
  if (!workspaceDir) return target
  if (/^[/\\]|[A-Za-z]:[/\\]/.test(target) || target.startsWith('~')) return target
  const sep = workspaceDir.includes('\\') ? '\\' : '/'
  return workspaceDir + sep + target
}

/**
 * Every filesystem path one write/edit tool call targets, RAW (unresolved —
 * consumers run resolveToolFilePath/isProjectInstructionsPath themselves, the
 * same contract the read-before-write gate's consumers follow). Single path
 * for everything with a file_path; the multi-file diff form (no file_path)
 * names its targets in the `diff --git` section headers. The approval-side
 * protected-path gate reads THIS so a multi-file diff cannot smuggle
 * .pulsemind/AGENTS.md past the ladder inside one of its sections.
 */
export function editToolTargetPaths(input: unknown): string[] {
  const inp = (input ?? {}) as { file_path?: unknown; diff?: unknown }
  const rawFp = typeof inp.file_path === 'string' ? inp.file_path.trim() : ''
  if (rawFp) return [rawFp]
  if (typeof inp.diff !== 'string' || !inp.diff.trim()) return []
  const sections = parseMultiFileDiff(inp.diff)
  if (!sections) return []
  return sections.map((s) => s.path).filter(Boolean)
}

/** POSIX '…' quoting: inside single quotes NOTHING is special except ' itself,
 *  closed as `'\''`. shEscape targets "…" contexts and does not escape ' — used
 *  inside '…' it let one raw ' close the quoting and inject (review_20261005
 *  P1-02: "a'; rm -rf ~;'" became two commands). Pair every '…' interpolation
 *  with THIS, never with shEscape. */
export function shSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export function psEscape(s: string): string {
  return s.replace(/'/g, "''")
}

export function extractJsonFromLLM(text: string): string {
  let clean = text.trim()
  const jsonBlockMatch = clean.match(/^```(?:json)?\s*\n?([\s\S]*?)```$/)
  if (jsonBlockMatch) clean = jsonBlockMatch[1].trim()
  return clean
}

// ── Hook wrappers ─────────────────────────────────────────────────────────

export async function safeInvoke<T>(hook: ((ctx: T) => T | Promise<T>) | undefined, context: T, hookName: string): Promise<T> {
  if (!hook) return context
  try {
    const result = await hook(context)
    return result ?? context
  } catch (err) {
    console.warn(`[Hooks] ${hookName} error:`, err)
    return context
  }
}

export async function safeInvokeObserver<T>(hook: ((ctx: T) => void | Promise<void>) | undefined, context: T, hookName: string): Promise<void> {
  if (!hook) return
  try { await hook(context) } catch (err) { console.warn(`[Hooks] ${hookName} error:`, err) }
}

// ── Constants ─────────────────────────────────────────────────────────────

export const MAX_LOOP_ITERATIONS = 200

/** The loop cap's effective base: MAX_LOOP_ITERATIONS until 设置 → 助手设置
 *  applies a saved `maxLoopIterations` (session-manager at startup/save for
 *  the main-process-hosted engines). Module state like the sub-agent limiter's
 *  cap, because the resets
 *  in startLoop/reset/loadConversation read it per turn — a settings change
 *  lands from the next turn on without touching live engines mid-turn.
 *  `null`/invalid falls back to the constant, so a settings object that
 *  predates the field keeps the constant's value. */
let loopIterationLimit: number | null = null

export function getLoopIterationLimit(): number {
  return loopIterationLimit ?? MAX_LOOP_ITERATIONS
}

export function setLoopIterationLimit(value: number | null | undefined): void {
  loopIterationLimit = typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : null
}

// ── Spawn Sub-Agent types ──────────────────────────────────────────────

export interface SpawnSubAgentConfig {
  systemPrompt: string
  initialMessages: import('../types/agent').AgentMessage[]
  /** Conversation-list title for the sub-agent session (expert name + task). */
  title?: string
  /** 可用技能 / 可用连接器白名单 of the DELEGATED expert pack. The full pack is
   *  never inherited — its instructions are baked into systemPrompt — so the
   *  whitelists travel separately and the spawned engine enforces them exactly
   *  like a @-summoned expert does. Empty array = none allowed; undefined (no
   *  expert pack, i.e. a general sub-agent) = no restriction. */
  allowedSkills?: string[]
  allowedMcpServers?: string[]
  /** explore 预设（2026-10-27）的只读工具集白名单：spawn-tool 按预设置入，
   *  spawn-manager 穿透到 subOpts.allowedTools → 引擎的 allowedToolsSet →
   *  tool-collection 的白名单过滤（并同时关闭该子引擎的 MCP 发现）。
   *  undefined = 不限制（普通派发原样继承父会话工具集）。 */
  allowedTools?: string[]
  /** PLAN-plan-split v2 R6: set ONLY for spawns of splittable plan nodes.
   *  Arms create_sub_plan in the sub-engine's toolset and carries the
   *  parent-plan bridge constants; `createdIds` is filled by spawn-manager's
   *  bridge callback so the parent's spawn executor can report the split in
   *  its envelope. attemptId is the parent-minted dispatch id the merge
   *  CASes on. */
  planSplit?: { nodeRef: string; attemptId: string; createdIds: string[] }
  maxTokens?: number
  maxLoopIterations?: number
  onProgress?: (summary: string) => void
  onComplete?: (result: SubAgentResult) => void
}

export interface SubAgentResult {
  messages: import('../types/agent').AgentMessage[]
  summary?: string
  status: 'completed' | 'error' | 'aborted'
  /** Why the turn closed with 'error' (loop limit, request failure, thinking-only
   *  repeat, stream failure) — the sub-engine's agentStatus.error at settlement
   *  time. Without it the parent's envelope and tool card can only say
   *  `Status: error`; the reason string used to die with the sub-engine's
   *  in-memory state. Undefined for completed/aborted. */
  error?: string
  outputTokens?: number
  subConversationId?: string
  /** 终态语义（2026-11-12）：status 仍是 'completed' 时，用它区分「模型自己收尾」
   *  与「输出被长度上限切断的半截话」。故意不新增 'incomplete' 状态——spawn-tool
   *  有 18 处分支按 status 判定交付/exitCode/isError，翻它们是另一次独立裁决。 */
  stopReason?: import('../types/agent').TurnStopReason
}

/** 原始 stop_reason → 终态词。未识别的落 'unknown'：仍是「完成」，只是分类不明，
 *  行为与此前完全一致——本函数不改变任何分支，只给观测层一个可统计的词。 */
export function classifyStopReason(raw: string | null): import('../types/agent').TurnStopReason {
  switch (raw) {
    case 'end_turn':
    case 'max_tokens':
    case 'tool_use':
    case 'stop_sequence':
      return raw
    default:
      return 'unknown'
  }
}

export interface SubAgentHandle {
  id: string
  subConvId: string
  readonly messages: import('../types/agent').AgentMessage[]
  readonly agentStatus: import('../types/agent').AgentStatus
  abort(): void
  waitForCompletion(): Promise<SubAgentResult>
}
