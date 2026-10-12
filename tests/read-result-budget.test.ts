// read's dedicated tool-result budget (2026-09-30). read used to pass Infinity
// as addToolResult's maxTokens — a blanket exemption reading a file IS the
// task — but its pages are bounded by LINES (500/call), not bytes: a file with
// very long lines (minified bundle, single-line JSON, base64) turned one page
// into up to ~1MB ≈ hundreds of K tokens, exceeding the whole window in a
// single result with no token-level net anywhere. read now rides
// MAX_READ_RESULT_TOKENS (30K): every normal page lands whole, a pathological
// one gets the standard head+tail truncation + tmp/trunc/ offload.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_READ_RESULT_TOKENS, MAX_TOOL_RESULT_TOKENS } from '../src/renderer/src/agent/engine/engine-constants'
import { applyToolResultBudget } from '../src/renderer/src/agent/engine/result-ingestion'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

describe('MAX_READ_RESULT_TOKENS — read skips the 4K default, not the guardrail', () => {
  it('is a dedicated line well above the default', () => {
    expect(MAX_READ_RESULT_TOKENS).toBe(30_000)
    expect(MAX_READ_RESULT_TOKENS).toBeGreaterThan(MAX_TOOL_RESULT_TOKENS)
  })

  it('non-vacuity: the wiring scans read real sources', () => {
    expect(read('src/renderer/src/agent/tool-executors.ts')).toContain('MAX_READ_RESULT_TOKENS')
    expect(read('src/renderer/src/agent/AgentEngine.ts')).toContain('applyToolResultBudget')
  })

  it('every read call site passes the dedicated budget — Infinity is gone', () => {
    const executors = read('src/renderer/src/agent/tool-executors.ts')
    // maxTokens is addToolResult's 5th parameter — no call site may pass
    // Infinity there again (that IS the bypass this budget closed).
    expect(executors).not.toMatch(/,\s*Infinity\)/)
    // the three read branches (markitdown page, .doc/.ppt refusal, shell page)
    const sites = executors.match(/MAX_READ_RESULT_TOKENS/g) ?? []
    expect(sites.length).toBeGreaterThanOrEqual(3)
    // the engine module comment must not advertise the old exemption either
    expect(read('src/renderer/src/agent/AgentEngine.ts')).not.toContain('passes Infinity')
  })
})

describe('applyToolResultBudget — the guardrail shape read now shares', () => {
  const DEST = '~/.pulsemind/tmp/trunc/trunc_abcdef01_1700000000000.txt'

  it('a dense legitimate CJK page lands whole', () => {
    // 500 lines × 59 CJK chars + 499 newlines = 29,625 tokens by the CJK-aware
    // estimator (≈1 token/char, newlines ≈ 4/char) — under the line, so the
    // densest honest page the 500-line cap allows must not be cut.
    const page = Array.from({ length: 500 }, () => '汉'.repeat(59)).join('\n')
    expect(estimate(page)).toBe(29_625)
    const { text, truncated } = applyToolResultBudget(page, false, MAX_READ_RESULT_TOKENS, DEST)
    expect(truncated).toBe(false)
    expect(text).toBe(page)
  })

  it('a pathological long-line page is head+tail truncated with the offload marker', () => {
    const page = '汉'.repeat(40_000) // 40,000 tokens > 30,000
    const { text, truncated } = applyToolResultBudget(page, false, MAX_READ_RESULT_TOKENS, DEST)
    expect(truncated).toBe(true)
    expect(text.startsWith(page.slice(0, 22_500))).toBe(true) // 75% head
    expect(text.endsWith(page.slice(-7_500))).toBe(true) // 25% tail
    expect(text).toContain('Tool result truncated')
    expect(text).toContain(DEST)
    expect(text).toContain('use `read` to page through it')
    expect(text.length).toBeLessThan(page.length)
  })

  it('is priced in tokens, not chars — a latin page over the char budget still lands whole', () => {
    // 31,000 latin chars ≈ 7,750 tokens: the length short-circuit alone would
    // wrongly cut it; the estimate must save it. (Minified JS IS this shape
    // until ~4x this size.)
    const page = 'a'.repeat(31_000)
    const { text, truncated } = applyToolResultBudget(page, false, MAX_READ_RESULT_TOKENS, DEST)
    expect(truncated).toBe(false)
    expect(text).toBe(page)
  })

  it('a huge latin page (minified bundle) is cut too', () => {
    const page = 'a'.repeat(200_000) // 50,000 tokens > 30,000
    const { text, truncated } = applyToolResultBudget(page, false, MAX_READ_RESULT_TOKENS, DEST)
    expect(truncated).toBe(true)
    expect(text).toContain('Tool result truncated')
  })

  it('errors pass whole regardless of size', () => {
    const page = '汉'.repeat(40_000)
    const { text, truncated } = applyToolResultBudget(page, true, MAX_READ_RESULT_TOKENS, DEST)
    expect(truncated).toBe(false)
    expect(text).toBe(page)
  })
})

// local import-free mirror of context-estimate's estimator, so the boundary
// arithmetic above is legible without importing the module twice
function estimate(text: string): number {
  const cjk = text.length - text.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, '').length
  return cjk + Math.ceil((text.length - cjk) / 4)
}

// ── The offload must be REACHABLE (2026-10-10): the marker promises
// "full text saved at ~/.pulsemind/tmp/trunc/…, use read" — but that path
// used to be judged by the same guard as any other ~/.pulsemind target: the
// write was denied (deny root, neither workspace nor skills) and silently
// swallowed, and `read` was denied the same way. The offload dir is now a
// sanctioned extra-writable root (main/sandbox/guard.ts), which exempts it
// from the deny roots AND the workspace jail, reads and writes alike.
describe('truncation offload reachability — the read-back is not a dead link', () => {
  const home = process.env.HOME || '/home/x'
  const trunc = `${home}/.pulsemind/tmp/trunc/trunc_abc_1.txt`

  it('guardPath admits reads AND writes inside the offload root when it is sanctioned', async () => {
    const { guardPath } = await import('../src/shared/sandbox/path-jail')
    const denyRoots = [`${home}/.ssh`, `${home}/.aws`, `${home}/.gnupg`, `${home}/.pulsemind`]
    const extra = [{ dir: `${home}/.pulsemind/tmp/trunc`, real: null }]
    for (const operation of ['read', 'write'] as const) {
      const ok = guardPath({
        target: trunc,
        operation,
        denyRoots,
        workspaceDir: `${home}/somewhere-else`,
        realTarget: trunc,
        extraWritableRoots: extra,
      })
      expect(ok.ok, `${operation} inside the sanctioned offload root must pass`).toBe(true)
    }
  })

  it('negative control: without the sanctioned root the same target is denied', async () => {
    const { guardPath } = await import('../src/shared/sandbox/path-jail')
    const denyRoots = [`${home}/.pulsemind`]
    const denied = guardPath({
      target: trunc,
      operation: 'write',
      denyRoots,
      workspaceDir: `${home}/somewhere-else`,
      realTarget: trunc,
      extraWritableRoots: [],
    })
    expect(denied.ok).toBe(false)
  })

  it('wiring: guard.ts sanctions the offload root alongside skills, and the engine surfaces offload failures', () => {
    const guard = read('src/main/sandbox/guard.ts')
    expect(guard).toContain("'.pulsemind', 'tmp', 'trunc'")
    expect(guard).toContain('{ dir: truncRoot, real: truncReal }')
    // the engine must not swallow an offload failure silently again
    const engine = read('src/renderer/src/agent/AgentEngine.ts')
    expect(engine).toContain('truncation offload denied')
    expect(engine).toContain('truncation offload failed')
    expect(engine).not.toMatch(/writeFile\(\{ filePath: offloadDest, content \}\)\.catch\(/)
  })
})

// ── The read cache must be reachable the same way (2026-10-12): `read`'s
// markitdown Note advertises "Full conversion saved at
// ~/.pulsemind/tmp/read-cache/…" so the model can search headings/keywords
// in the conversion and only then page `read` to the hits — convert once,
// query many. Under a workspace session the advertised path was judged like
// any other ~/.pulsemind target (deny root) and every read/search of it was
// denied: the whole large-document strategy was a dead link. guard.ts now
// sanctions the dir, same shape as trunc.
describe('read-cache reachability — the conversion Note is not a dead link', () => {
  const home = process.env.HOME || '/home/x'
  const cached = `${home}/.pulsemind/tmp/read-cache/conv_abc.md`

  it('guardPath admits reads AND writes inside the cache root when it is sanctioned', async () => {
    const { guardPath } = await import('../src/shared/sandbox/path-jail')
    const denyRoots = [`${home}/.ssh`, `${home}/.aws`, `${home}/.gnupg`, `${home}/.pulsemind`]
    const extra = [{ dir: `${home}/.pulsemind/tmp/read-cache`, real: null }]
    for (const operation of ['read', 'write'] as const) {
      const ok = guardPath({
        target: cached,
        operation,
        denyRoots,
        workspaceDir: `${home}/somewhere-else`,
        realTarget: cached,
        extraWritableRoots: extra,
      })
      expect(ok.ok, `${operation} inside the sanctioned cache root must pass`).toBe(true)
    }
  })

  it('negative control: without the sanctioned root the same target is denied', async () => {
    const { guardPath } = await import('../src/shared/sandbox/path-jail')
    const denied = guardPath({
      target: cached,
      operation: 'read',
      denyRoots: [`${home}/.pulsemind`],
      workspaceDir: `${home}/somewhere-else`,
      realTarget: cached,
      extraWritableRoots: [],
    })
    expect(denied.ok).toBe(false)
  })

  it('wiring: guard.ts sanctions the read-cache root alongside skills/trunc', () => {
    const guard = read('src/main/sandbox/guard.ts')
    expect(guard).toContain("'.pulsemind', 'tmp', 'read-cache'")
    expect(guard).toContain('{ dir: readCacheRoot, real: readCacheReal }')
  })
})
