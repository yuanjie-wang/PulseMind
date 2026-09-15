import { getHost } from './host'
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

export const MAX_LOOP_ITERATIONS = 50

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
  maxTokens?: number
  maxLoopIterations?: number
  onProgress?: (summary: string) => void
  onComplete?: (result: SubAgentResult) => void
}

export interface SubAgentResult {
  messages: import('../types/agent').AgentMessage[]
  summary?: string
  status: 'completed' | 'error' | 'aborted'
  outputTokens?: number
  subConversationId?: string
}

export interface SubAgentHandle {
  id: string
  subConvId: string
  readonly messages: import('../types/agent').AgentMessage[]
  readonly agentStatus: import('../types/agent').AgentStatus
  abort(): void
  waitForCompletion(): Promise<SubAgentResult>
}
