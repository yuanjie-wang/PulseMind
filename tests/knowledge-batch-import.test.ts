// ── 知识中心「导入大批量文件时会卡死」— the freeze fixes across their layers ──
// Four independent freeze sources, fixed together:
//   A. a synchronous readdir walk inside an ipcMain handler (main-process
//      beachball) — MEASURED in `scripts/probe-knowledge-base.mjs` section ⑫
//      with an event-loop tick counter plus a local copy of the OLD sync walk
//      as the zero control;
//   B. prepareImport's one-SELECT-per-path — probe ⑫ pins its semantics across
//      IN-chunks (order, duplicate inputs, base scoping, >1 chunk);
//   C/D/E. the renderer half: a full list+stats reload after EVERY file, one
//      extractor fork per file, getSettings per file, one swallow-everything
//      catch, and an unbounded `push(...paths)` apply-spread. A component
//      cannot be mounted here (vitest is node-env, no jsdom), so those are
//      asserted as SOURCE — which call sites exist, which shapes are gone.
//
// Every scan below states what fails when it goes (measured by mutation: the
// backup/restore counts are in the review record).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { throttleTrailing } from '../src/renderer/src/utils/throttle'

const ROOT = join(__dirname, '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')

const panel = () => read('src/renderer/src/components/knowledge/KnowledgePanel.tsx')

/** The body of a top-level `const <name> = useCallback(` — to its closing
 *  `}, [` — so assertions scope to one function, not the whole file. */
const callbackBody = (src: string, name: string): string => {
  const start = src.indexOf(`const ${name} = useCallback`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  const end = src.indexOf('}, [', start)
  expect(end, `${name} body end not found`).toBeGreaterThan(-1)
  return src.slice(start, end)
}

// ── C: throttleTrailing, the unit behind every coalesced refresh ──

describe('throttleTrailing (utils/throttle.ts)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('leading edge runs immediately, then coalesces a burst into ONE trailing run', () => {
    const runs: number[] = []
    const throttled = throttleTrailing(() => runs.push(Date.now()))

    throttled.schedule() // leading
    expect(runs).toHaveLength(1)

    // A 400ms burst (inside the 500ms window): nothing more may run…
    for (let i = 0; i < 40; i++) {
      throttled.schedule()
      vi.advanceTimersByTime(10)
    }
    expect(runs).toHaveLength(1)

    // …but the burst's LAST ask is guaranteed a trailing run once the window closes.
    vi.advanceTimersByTime(100)
    expect(runs).toHaveLength(2)
  })

  it('the trailing run fires once no matter how many asks queued behind it', () => {
    const fn = vi.fn()
    const throttled = throttleTrailing(fn)
    throttled.schedule() // leading — fn called
    fn.mockClear()
    for (let i = 0; i < 100; i++) throttled.schedule()
    vi.advanceTimersByTime(499)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5000)
    expect(fn).toHaveBeenCalledTimes(1) // nothing re-fires once the trailing ran
  })

  it('flush runs a pending trailing call now; a second flush is a no-op', () => {
    const fn = vi.fn()
    const throttled = throttleTrailing(fn)
    throttled.schedule() // leading
    fn.mockClear()
    throttled.schedule() // queues trailing
    throttled.flush()
    expect(fn).toHaveBeenCalledTimes(1)
    throttled.flush() // nothing pending — no double run
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('cancel (unmount) drops the pending run, leaves no timer, and the throttle is reusable', () => {
    const fn = vi.fn()
    const t = throttleTrailing(fn)
    t.schedule() // leading
    t.schedule() // trailing pending
    t.cancel()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10_000)
    expect(fn).toHaveBeenCalledTimes(1) // the dropped trailing never fired

    t.schedule() // window long expired — leading edge again
    expect(fn).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(500)
    expect(fn).toHaveBeenCalledTimes(2) // and nothing was left pending by the cancel
  })
})

// ── A: the walk awaits, and the skip list exists ──

describe('A. the folder walk yields the main process (the beachball source)', () => {
  it('walks with fs.promises, never the sync APIs', () => {
    const svc = read('src/main/services/knowledge-queries.ts')
    // Pre-fix: readdirSync/statSync recursion inside an ipcMain handler — one
    // big folder and the whole app's UI froze until the walk finished.
    expect(svc).toMatch(/import \{ readdir as readdirAsync, stat as statAsync \} from 'node:fs\/promises'/)
    expect(svc).toMatch(/entries = await readdirAsync\(dir, \{ withFileTypes: true \}\)/)
    expect(svc).toMatch(/await walk\(full\)/)
    expect(svc).not.toMatch(/readdirSync\(/)
    expect(svc).not.toMatch(/statSync\(/)
  })

  it('skips node_modules and .git at every depth — both callers await the walk', () => {
    const svc = read('src/main/services/knowledge-queries.ts')
    // Without SKIP_DIRS a code folder's dependency tree is walked (seconds of
    // blocked main process) AND every .md/.txt in it becomes a candidate.
    expect(svc).toMatch(/const SKIP_DIRS = new Set\(\['node_modules', '\.git'\]\)/)
    expect(svc).toMatch(/if \(!SKIP_DIRS\.has\(entry\.name\)\) await walk\(full\)/)
    expect(svc).toMatch(/const filePaths = await collectSupportedFiles\(folderPath\)/)
    expect(svc).toMatch(/return importLocalFiles\(await collectSupportedFiles\(folderPath\), baseId\)/)
  })
})

// ── B: prepareImport batches its reads without changing semantics ──

describe('B. prepareImport reads the DB in IN-chunks, once per chunk', () => {
  const bodyOfPrepare = (): string => {
    const store = read('src/main/storage/knowledge-store.ts')
    // From the section header: PREPARE_IMPORT_CHUNK lives just ABOVE the
    // function it feeds, with its own doc comment.
    const start = store.indexOf('// ─── Prepare Import')
    expect(start).toBeGreaterThan(-1)
    const end = store.indexOf('// ─── Base64 image extraction', start)
    expect(end).toBeGreaterThan(start)
    return store.slice(start, end)
  }

  it('one WHERE source_path IN (…) per PREPARE_IMPORT_CHUNK, not one query per path', () => {
    const body = bodyOfPrepare()
    // Pre-fix: `for (fp of filePaths) { getKnowledgeFileBySource(fp, …) }` — a
    // prepared SELECT per file, all synchronous main-process work.
    expect(body).toMatch(/const PREPARE_IMPORT_CHUNK = 500/)
    expect(body).toMatch(/WHERE source_path IN \(\$\{placeholders\}\)/)
    expect(body).toMatch(/i \+= PREPARE_IMPORT_CHUNK/)
    expect(body).not.toMatch(/getKnowledgeFileBySource\(/)
  })

  it('keeps the old predicate exactly: base scoping optional, no source_url column', () => {
    const body = bodyOfPrepare()
    // baseId undefined must mean CROSS-base (the old `.get` had no clause)…
    expect(body).toMatch(/const clause = baseId !== undefined \? ' AND base_id = \?' : ''/)
    // …and the old caller passed `undefined` for sourceUrl, so the SQL must
    // select/match on source_path alone (the doc comment legitimately NAMES
    // source_url — only a query may not reference it).
    expect(body).toMatch(/SELECT id, source_path FROM knowledge_files WHERE source_path IN/)
    expect(body).not.toMatch(/SELECT[^`]*source_url/)
  })
})

// ── C/D/E: the import queue stops doing per-file world work ──

describe('D. one worker fork per chunk, one settings read per run', () => {
  it('runImportQueue feeds importFiles a same-base CHUNK, never a single path', () => {
    const src = panel()
    const body = callbackBody(src, 'runImportQueue')
    // Pre-fix: `importFiles([item.path], item.baseId)` — one child_process.fork
    // per file; a 5k-file folder was 5k forks.
    expect(src).toMatch(/const IMPORT_CHUNK = 16/)
    expect(body).toMatch(/while \(chunk\.length < IMPORT_CHUNK/)
    expect(body).toMatch(/results = await knowledgeManager\.importFiles\(chunk, chunkBase\)/)
    expect(src).not.toMatch(/importFiles\(\[/)
  })

  it('the autoCompile gate is read ONCE per run, not once per file', () => {
    const src = panel()
    // Pre-fix: `await window.electronAPI.getSettings()` inside the per-item
    // loop — one IPC round trip per file for a boolean.
    const reads = src.match(/await window\.electronAPI\.getSettings\(\)/g) ?? []
    expect(reads).toHaveLength(1)
    const body = callbackBody(src, 'runImportQueue')
    expect(body).toMatch(/let autoCompile = false/)
    expect(body).toMatch(/if \(autoCompile\) enqueueCompileForFile/)
  })

  it('failures are counted and reported once at the end, not swallowed per item', () => {
    const body = callbackBody(panel(), 'runImportQueue')
    // Pre-fix: `catch { // Import failed — skip }` — a run where every file
    // died still showed a full green bar.
    expect(body).toMatch(/const noteFailure = /)
    expect(body).toMatch(/notify\.warning\(`导入结束：\$\{failed\} 个文件失败/)
    // A chunk that throws wholesale still settles its accounting (shifted items
    // must reach 100% or the bar hangs).
    expect(body).toMatch(/noteFailure\(`\$\{chunk\.length\} 个文件批量导入失败/)
    expect(body).toMatch(/settle\(chunk\.length\)/)
  })
})

describe('C. refreshes are throttled and the duplicate getStats is gone', () => {
  it('every queue refresh goes through ONE throttleTrailing, cancelled on unmount', () => {
    const src = panel()
    // `_onRefresh?.()` may appear only inside the throttle's constructor —
    // the old per-item call sites (import loop, compile sink) are the churn.
    expect(src).toMatch(/const _refreshThrottled = throttleTrailing\(\(\) => _onRefresh\?\.\(\), REFRESH_THROTTLE_MS\)/)
    const direct = src.match(/_onRefresh\?\.\(\)/g) ?? []
    expect(direct).toHaveLength(1)
    expect(src).toMatch(/compileQueue\.sinks\.onRefresh = \(\) => _refreshThrottled\.schedule\(\)/)
    expect(src).toMatch(/_refreshThrottled\.cancel\(\)/) // the cleanup half
    expect(src).toMatch(/const REFRESH_THROTTLE_MS = 500/)
  })

  it('_onRefresh is ONE loadFiles — no second getStats, no orphaned baseIdRef', () => {
    const src = panel()
    // Pre-fix it re-fetched stats (a recursive wiki-dir readdir) and pushed
    // state manually, doubling every refresh; loadFiles already does both.
    const start = src.indexOf('_onRefresh = async () =>')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('}', start))
    expect(body).toMatch(/await loadFilesRef\.current\(\)/)
    expect(body).not.toMatch(/getStats/)
    expect(src).not.toMatch(/baseIdRef/)
  })

  it('the compile queue refreshes through the same throttle', () => {
    // Both queues reloading per item is what made a big import fight the
    // compile pass for the main thread's attention.
    const src = panel()
    expect(src).toMatch(/compileQueue\.sinks\.onRefresh = \(\) => _refreshThrottled\.schedule\(\)/)
    expect(src).not.toMatch(/compileQueue\.sinks\.onRefresh = _onRefresh\b/)
  })
})

describe('E. enqueueImport pushes in slices (no apply-spread overflow)', () => {
  it('ENQUEUE_CHUNK gates the push; the one-shot spread is gone', () => {
    const src = panel()
    // `push(...100k items)` is an apply-spread over the argument list — a
    // RangeError before a single import runs.
    expect(src).toMatch(/const ENQUEUE_CHUNK = 10_000/)
    expect(src).toMatch(/for \(let i = 0; i < newFiles\.length; i \+= ENQUEUE_CHUNK\)/)
    expect(src).toMatch(/_pendingImportItems\.push\(\s*\.\.\.newFiles\.slice\(i, i \+ ENQUEUE_CHUNK\)\.map/)
    expect(src).not.toMatch(/_pendingImportItems\.push\(\.\.\.newFiles\.map/)
  })
})
