import { app } from 'electron'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from '../storage'
import { settingsStore, readRawBooleanFlag } from '../storage/settings-store'

/** ~/.pulsemind/logs/llm-requests/ — one request+response pair per LLM call,
 *  oldest pruned. */
export const LLM_DUMP_DIR = join(DATA_DIR, 'logs', 'llm-requests')
export const LLM_DUMP_MAX_FILES = 60
/** P3-b (PLAN-security-hardening): each dump is a full request body — a
 *  conversation transcript. The 60-file cap bounds the COUNT, not the AGE; a
 *  quiet week leaves month-old transcripts readable. 7 days is enough for any
 *  one debugging session, and no setting is added for a dev opt-in (打包默认关). */
export const LLM_DUMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Dump files are the request (`<stamp>-<id>.request.txt`) and its paired
 *  response (`<stamp>-<id>.response.txt`) — one extension for both sides, the
 *  role carried by the marker, per user ruling 2026-10-08 「都用txt吧」. Both
 *  are prunable, and so is anything the alternate arms might match — the bare
 *  `.json` / `.response.sse` / `.response.json` patterns are defensive against
 *  future naming drift (no generation ever wrote them), retired within 7 days. */
const DUMP_NAME_RE = /\.json$|\.request\.txt$|\.response\.(?:json|sse|txt)$/

/**
 * Headers that identify the caller, masked to their last 4 chars before they
 * reach the console. Only the body is ever written to disk, so a credential can
 * leak nowhere but the log — and it does not leak there either.
 */
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|token)$/i

function maskSecrets(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADER.test(k) ? `***${v.slice(-4)}` : v
  }
  return out
}

export interface LlmRequestDump {
  requestId: string
  url: string
  method: string
  headers?: Record<string, string>
  body: string
}

/**
 * Dumping is a debugging aid: on by default in dev, opt-in in a packaged build
 * via `debugLlmRequests` — and once the settings-panel switch is used, IT wins
 * in both builds. The distinction rides the raw file: `settingsStore.get()`
 * normalizes an absent key to `false`, which cannot tell "never touched" (dev
 * dumps) from "explicitly switched off" (don't). `readRawBooleanFlag` reads
 * the tri-state; flipping the switch applies to the next request without a
 * restart, because the gate re-reads on every call.
 */
async function dumpEnabled(): Promise<boolean> {
  if (app.isPackaged) {
    try {
      return (await settingsStore.get()).debugLlmRequests === true
    } catch {
      // Off, not broken: reading settings can fail for reasons that have nothing
      // to do with the request (and whatever failed will report itself where it
      // was read for real). Diagnostics never get to surface an error here.
      return false
    }
  }
  try {
    return (await readRawBooleanFlag('debugLlmRequests')) !== false
  } catch {
    return true
  }
}

/** Keep the directory bounded by count (capped in REQUESTS — each pruned
 *  request takes its `.response.*` sibling with it, so a transcript never
 *  loses its answer half) and by age (P3-b — swept over every dump file,
 *  including a response whose request was gated off mid-call). */
async function pruneOldest(): Promise<void> {
  const names = (await readdir(LLM_DUMP_DIR)).filter(n => DUMP_NAME_RE.test(n)).sort()
  const now = Date.now()
  for (const name of names) {
    try {
      if (now - (await stat(join(LLM_DUMP_DIR, name))).mtimeMs > LLM_DUMP_MAX_AGE_MS) {
        await unlink(join(LLM_DUMP_DIR, name)).catch(() => {})
      }
    } catch { /* the count prune below may have just removed it */ }
  }
  // A request is `.request.txt` (current) or a `.json` that is not a
  // response's (earlier generations).
  const requests = names.filter(n => n.endsWith('.request.txt')
    || (n.endsWith('.json') && !n.endsWith('.response.json')))
  for (let i = 0, excess = requests.length - LLM_DUMP_MAX_FILES; i < excess; i++) {
    const name = join(LLM_DUMP_DIR, requests[i])
    await unlink(name).catch(() => {})
    // The sibling's extension varied across generations — try each rather
    // than guess.
    const stem = name.replace(/(?:\.request)?\.(?:json|txt)$/, '')
    for (const ext of ['.response.txt', '.response.json', '.response.sse']) {
      await unlink(`${stem}${ext}`).catch(() => {})
    }
  }
}

/**
 * Message and tool counts for the log line, so a dump identifies itself without
 * being opened. Shape-tolerant on purpose (both adapters put the history in
 * `messages` and the schemas in `tools`), and the distinction it draws is the
 * load-bearing one: an agent turn has tools, while every one-shot call in the
 * app — title, greeting, memory consolidation, session review — sends two
 * messages and no `tools` key whatsoever. Without this the newest file is
 * usually a memory call, and "where did the tools go?" costs an afternoon.
 * The parse never feeds back into the file, which stays verbatim.
 */
function summarizeBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: unknown[]; tools?: unknown[] }
    return `msgs=${parsed.messages?.length ?? 0} tools=${parsed.tools?.length ?? 0}`
  } catch {
    return 'msgs=? tools=?'
  }
}

/** The usage fields the two wire shapes carry — OpenAI-style prompt/completion
 *  naming, Anthropic's input/output naming. Anything else (model content that
 *  happens to echo a "usage" object) is ignored. */
const USAGE_KEYS = new Set([
  'prompt_tokens', 'completion_tokens', 'prompt_cache_hit_tokens',
  'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
])

function usageFieldsOf(parsed: unknown): Record<string, number> {
  // Top-level `usage` is the OpenAI and non-streaming shape; Anthropic's
  // message_start nests it under `message.usage`.
  const obj = parsed as { usage?: unknown; message?: { usage?: unknown } } | null
  const usage = obj?.usage ?? obj?.message?.usage
  if (!usage || typeof usage !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(usage as Record<string, unknown>)) {
    if (typeof v === 'number' && v > 0 && USAGE_KEYS.has(k)) out[k] = v
  }
  return out
}

/**
 * The provider's usage report, read off the response the way each wire shape
 * carries it: a streaming body holds it in `data:` events — Anthropic puts
 * input_tokens in the FIRST event (message_start) and output_tokens in the
 * LAST (message_delta), OpenAI-style streams put both in the final usage
 * chunk — so both ends of the event list are scanned, bounded. A
 * non-streaming body carries it top-level. Returns '' when nothing usable is
 * found and the log line simply omits it. This mirrors what the renderer's
 * `[LLM Cache]` line prints and what the context ring anchors on — the two
 * numbers to eyeball against each other.
 */
export function summarizeResponseUsage(body: string): string {
  const merged: Record<string, number> = {}
  const merge = (text: string): void => {
    try {
      for (const [k, v] of Object.entries(usageFieldsOf(JSON.parse(text)))) merged[k] = v
    } catch { /* not the usage event — that is the common case */ }
  }
  const dataLines = body.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('data:') && !l.includes('[DONE]'))
    .map(l => l.slice(5).trim())
  if (dataLines.length > 0) {
    for (const line of dataLines.slice(0, 20)) merge(line)
    for (const line of dataLines.slice(-20)) merge(line)
  } else {
    merge(body)
  }
  const input = merged.prompt_tokens ?? merged.input_tokens
  const output = merged.completion_tokens ?? merged.output_tokens
  const cached = merged.prompt_cache_hit_tokens ?? merged.cache_read_input_tokens
  const parts: string[] = []
  if (input !== undefined) parts.push(`in=${input}`)
  if (cached !== undefined) parts.push(`cached=${cached}`)
  if (output !== undefined) parts.push(`out=${output}`)
  return parts.length > 0 ? ` usage=${parts.join(' ')}` : ''
}

/**
 * Record the request exactly as it goes on the wire, to
 * `<DATA_DIR>/logs/llm-requests/<timestamp>-<requestId>.request.txt`.
 *
 * Called after the llm-request hook and after profile headers are merged, so
 * the file is what the provider receives rather than what the engine intended.
 * The body is written verbatim — no envelope, no re-serialization — so
 * `jq .system`, `jq .tools` and `jq '.messages|length'` read the real payload
 * and two dumps can be diffed to find the byte where a prompt prefix diverged.
 * Returns the file path, so this call's response dump can pair with it.
 */
export async function dumpLlmRequest(req: LlmRequestDump): Promise<string | null> {
  try {
    if (!req.body || !(await dumpEnabled())) return null
    await mkdir(LLM_DUMP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(LLM_DUMP_DIR, `${stamp}-${req.requestId}.request.txt`)
    await writeFile(file, req.body, 'utf-8')
    console.log(`[LLM Dump] ${file}`)
    console.log(`[LLM Dump] ${req.method} ${req.url} bytes=${req.body.length} ${summarizeBody(req.body)} headers=${JSON.stringify(maskSecrets(req.headers))}`)
    await pruneOldest()
    return file
  } catch (err) {
    // Diagnostics must never take the request path down with them.
    console.warn('[LLM Dump] failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export interface LlmResponseDump {
  requestId: string
  /** This call's request-dump path, when one was written — the response pairs
   *  with it under the same stem (`<stem>.response.txt` instead of minting
   *  its own stamp), so the two files of one call sort together. */
  requestFile?: string | null
  /** HTTP status, or the reason a body never finished ('interrupted'). */
  status: string
  body: string
  truncated?: boolean
}

/**
 * Record the response exactly as it came back — the verbatim SSE event stream
 * for a streaming call, the plain body for a non-streaming one — next to its
 * request dump, as `<stem>.response.txt` (user ruling 2026-10-08: one
 * extension for both sides; what the body IS — SSE / JSON / an HTML error
 * page — is self-evident from its first lines). Written at the stream's end,
 * or at its failure point, which is when a response dump matters most (an
 * HTTP 400 body or a timed-out partial stream). Like the request dump:
 * verbatim, best-effort, and gated by the same flag so nothing is written
 * when dumping is off.
 */
export async function dumpLlmResponse(dump: LlmResponseDump): Promise<void> {
  try {
    if (!dump.body || !(await dumpEnabled())) return
    await mkdir(LLM_DUMP_DIR, { recursive: true })
    const base = dump.requestFile
      ? dump.requestFile.replace(/(?:\.request)?\.(?:json|txt)$/, '')
      : join(LLM_DUMP_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${dump.requestId}`)
    const file = `${base}.response.txt`
    await writeFile(file, dump.body, 'utf-8')
    console.log(`[LLM Dump] response ${file} status=${dump.status} bytes=${dump.body.length}${dump.truncated ? ' TRUNCATED' : ''}${summarizeResponseUsage(dump.body)}`)
    await pruneOldest()
  } catch (err) {
    console.warn('[LLM Dump] response failed:', err instanceof Error ? err.message : err)
  }
}
