import { app } from 'electron'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from '../storage'
import { settingsStore } from '../storage/settings-store'

/** ~/.pulsemind/logs/llm-requests/ — one file per LLM call, oldest pruned. */
export const LLM_DUMP_DIR = join(DATA_DIR, 'logs', 'llm-requests')
export const LLM_DUMP_MAX_FILES = 60
/** P3-b (PLAN-security-hardening): each dump is a full request body — a
 *  conversation transcript. The 60-file cap bounds the COUNT, not the AGE; a
 *  quiet week leaves month-old transcripts readable. 7 days is enough for any
 *  one debugging session, and no setting is added for a dev opt-in (打包默认关). */
export const LLM_DUMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

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
 * Dumping is a debugging aid, not a feature: on in dev, opt-in in a packaged
 * build via `debugLlmRequests` in settings.json. The store caches on mtime, so
 * flipping the flag applies to the next request without a restart.
 */
async function dumpEnabled(): Promise<boolean> {
  if (!app.isPackaged) return true
  try {
    return (await settingsStore.get()).debugLlmRequests === true
  } catch {
    // Off, not broken: reading settings can fail for reasons that have nothing
    // to do with the request (and whatever failed will report itself where it
    // was read for real). Diagnostics never get to surface an error here.
    return false
  }
}

/** A tool loop makes one dump per iteration — keep the directory bounded by
 *  count (existing) and by age (P3-b): past either line, the file goes. */
async function pruneOldest(): Promise<void> {
  const names = (await readdir(LLM_DUMP_DIR)).filter(n => n.endsWith('.json')).sort()
  const now = Date.now()
  for (let i = 0, excess = names.length - LLM_DUMP_MAX_FILES; i < excess; i++) {
    await unlink(join(LLM_DUMP_DIR, names[i])).catch(() => {})
  }
  if (names.length <= LLM_DUMP_MAX_FILES) {
    for (const name of names) {
      try {
        const mtime = (await stat(join(LLM_DUMP_DIR, name))).mtimeMs
        if (now - mtime > LLM_DUMP_MAX_AGE_MS) await unlink(join(LLM_DUMP_DIR, name)).catch(() => {})
      } catch { /* the count prune may have just removed it — nothing to do */ }
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

/**
 * Record the request exactly as it goes on the wire, to
 * `<DATA_DIR>/logs/llm-requests/<timestamp>-<requestId>.json`.
 *
 * Called after the llm-request hook and after profile headers are merged, so
 * the file is what the provider receives rather than what the engine intended.
 * The body is written verbatim — no envelope, no re-serialization — so
 * `jq .system`, `jq .tools` and `jq '.messages|length'` read the real payload
 * and two dumps can be diffed to find the byte where a prompt prefix diverged.
 */
export async function dumpLlmRequest(req: LlmRequestDump): Promise<void> {
  try {
    if (!req.body || !(await dumpEnabled())) return
    await mkdir(LLM_DUMP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(LLM_DUMP_DIR, `${stamp}-${req.requestId}.json`)
    await writeFile(file, req.body, 'utf-8')
    console.log(`[LLM Dump] ${file}`)
    console.log(`[LLM Dump] ${req.method} ${req.url} bytes=${req.body.length} ${summarizeBody(req.body)} headers=${JSON.stringify(maskSecrets(req.headers))}`)
    await pruneOldest()
  } catch (err) {
    // Diagnostics must never take the request path down with them.
    console.warn('[LLM Dump] failed:', err instanceof Error ? err.message : err)
  }
}
