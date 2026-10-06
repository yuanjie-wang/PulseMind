// PLAN-experience-outcome M1 — outcome counters on the experience pool.
//
// Three layers, each tested at the layer vitest can actually own:
//  1. matchExperienceScript — the pure exec→experience matcher (direct);
//  2. the store's touch(name, outcome) — the GATE shape over a mock DB (the
//     real-database half is probe territory: better-sqlite3 is Electron-ABI,
//     see AGENTS.md);
//  3. the envelope/wiring — experience_read's stats tail and the exec
//     settlement's matcher hook, asserted as source the way
//     composer-char-cap / read-result-budget pin their wiring (node-env: no
//     engine mount).

import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The store import chain pulls real storage modules — point HOME at a temp
// dir BEFORE any project import (a test must never touch the live ~/.pulsemind).
// Project modules come in via dynamic import below, after the env is set.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-exp-outcome-'))
mkdirSync(join(process.env.HOME, '.pulsemind', 'experiences'), { recursive: true })

// ── mock DB (same discipline as experience-script-store.test.ts) ──
const rows = new Map<string, Record<string, unknown>>()

vi.mock('../src/main/storage/database', () => ({
  getDb: () => fakeDb,
  initializeDatabase: async () => {},
  ensureDbHealthy: async () => {},
}))

const fakeDb = {
  prepare(sql: string) {
    const s = sql.replace(/\s+/g, ' ')
    if (s.startsWith('SELECT outcome_json FROM experiences WHERE name')) {
      return { get: (n: string) => rows.get(n) }
    }
    if (s.startsWith('UPDATE experiences SET last_used_at')) {
      const withOutcome = s.includes('outcome_json = ?')
      return {
        run: (...args: unknown[]) => {
          const name = args[withOutcome ? 2 : 1] as string
          const prev = rows.get(name) ?? {}
          rows.set(name, {
            ...prev,
            last_used_at: args[0],
            use_count: ((prev.use_count as number) ?? 0) + 1,
            ...(withOutcome ? { outcome_json: args[1] } : {}),
          })
          return { changes: 1 }
        },
      }
    }
    if (s.startsWith('SELECT * FROM experiences')) {
      return { get: () => null, all: () => [...rows.values()] }
    }
    return { get: () => undefined, all: () => [], run: () => {} }
  },
}

const readSrc = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf-8')

describe('matchExperienceScript', () => {
  let matchExperienceScript: (command: string) => string | null
  beforeAll(async () => {
    ;({ matchExperienceScript } = await import('../src/shared/experience/script-usage'))
  })

  it('matches a node invocation of a companion script (posix + quoted)', () => {
    expect(matchExperienceScript(`node '/Users/u/.pulsemind/experiences/agg-csv/scripts/aggregate.mjs' --in data`)).toBe('agg-csv')
  })
  it('matches windows separators and $HOME indirection, names may be CJK', () => {
    expect(matchExperienceScript(`node C:\\Users\\u\\.pulsemind\\experiences\\web-mail\\scripts\\send.mjs`)).toBe('web-mail')
    expect(matchExperienceScript(`node $HOME/.pulsemind/experiences/cjk-名/scripts/run.mjs`)).toBe('cjk-名')
  })
  it('requires the node runtime — a bare cat must not inflate usage (LRU feed)', () => {
    expect(matchExperienceScript(`cat ~/.pulsemind/experiences/agg-csv/scripts/aggregate.mjs`)).toBeNull()
    expect(matchExperienceScript(`grep -r experiences/agg-csv/scripts .`)).toBeNull()
  })
  it('returns null for non-script commands and empty input', () => {
    expect(matchExperienceScript(`node server.js`)).toBeNull()
    expect(matchExperienceScript(``)).toBeNull()
  })
})

describe('experienceStore.touch outcome', () => {
  let experienceStore: typeof import('../src/main/storage/experience-store')['experienceStore']
  beforeAll(async () => {
    ;({ experienceStore } = await import('../src/main/storage/experience-store'))
  })

  beforeEach(() => {
    rows.clear()
    rows.set('agg-csv', {
      id: 'exp_1', name: 'agg-csv', title: 'CSV 汇总', description: '', category: 'code',
      created_at: '2026-10-06 10:00:00', last_used_at: null, use_count: 0,
      triggers: '[]', files_json: null, updated_at: null, content_hash: null, outcome_json: null,
    })
  })

  afterEach(() => {
    rows.clear()
  })

  it('plain touch stays LRU-only: no outcome_json is written', async () => {
    await experienceStore.touch('agg-csv')
    const row = rows.get('agg-csv')!
    expect(row.use_count).toBe(1)
    expect(row.last_used_at).toBeTruthy()
    expect(row.outcome_json).toBeNull()
  })

  it('outcome touch books the verdict alongside usage and accumulates', async () => {
    await experienceStore.touch('agg-csv', 'ok')
    await experienceStore.touch('agg-csv', 'ok')
    await experienceStore.touch('agg-csv', 'fail')
    const row = rows.get('agg-csv')!
    expect(row.use_count).toBe(3)
    const parsed = JSON.parse(row.outcome_json as string)
    expect(parsed).toMatchObject({ ok: 2, fail: 1 })
    expect(typeof parsed.lastOutcomeAt).toBe('string')
  })

  it('outcome touch on an unknown name is a silent no-op (no row minted)', async () => {
    await experienceStore.touch('ghost', 'ok')
    expect(rows.has('ghost')).toBe(false)
  })

  it('malformed stored outcome_json restarts the counters instead of throwing', async () => {
    rows.get('agg-csv')!.outcome_json = '{not json'
    await experienceStore.touch('agg-csv', 'ok')
    const parsed = JSON.parse(rows.get('agg-csv')!.outcome_json as string)
    expect(parsed).toMatchObject({ ok: 1, fail: 0 })
  })

  it('list() surfaces the counters as record.outcome', async () => {
    await experienceStore.touch('agg-csv', 'ok')
    const rec = experienceStore.list().find((r) => r.name === 'agg-csv')
    expect(rec?.outcome).toMatchObject({ ok: 1, fail: 0 })
    expect(rec?.outcome?.lastOutcomeAt).toBeTruthy()
  })
})

// ── wiring (source scans — the settlement hooks cannot run under node-env) ──
describe('wiring', () => {
  it('exec settlement books usage + verdict; background books usage only', () => {
    const src = readSrc('src/renderer/src/agent/executors/domain-tools.ts')
    expect(src).toMatch(/matchExperienceScript\(command\)/)
    // foreground finish: verdict from the real exit code
    expect(src).toContain("getHost().touchExperienceRecord(runExp, exitCode === 0 ? 'ok' : 'fail')")
    // background: usage without a guessed verdict
    expect(src).toMatch(/const bgExp = matchExperienceScript\(command\)[\s\S]{0,120}touchExperienceRecord\(bgExp\)\.catch/)
  })

  it('both experience envelopes carry the stats tail; Name Index stays byte-stable', () => {
    const src = readSrc('src/renderer/src/agent/tool-executors.ts')
    expect(src.match(/experienceStatsLine\(em, skillName\)/g)?.length).toBe(1)
    expect(src.match(/experienceStatsLine\(em2, cleanName\)/g)?.length).toBe(1)
    const manager = readSrc('src/renderer/src/experiences/ExperienceManager.ts')
    // the cache contract: the system prompt's Name Index never learns stats
    expect(manager).not.toMatch(/outcome|useCount/)
  })
})
