/**
 * edit failure statistics — a longitudinal report over the real conversation
 * history, by edit FORM (search/replace vs diff vs multi-file diff) and by
 * model. The measurement behind the 2026-10-29 edit-form steering.
 *
 * Why it exists: the question 「did read's line numbers make edits fail more?」
 * (asked 2026-10-29) could not be answered from feel. Classifying 882 edit
 * calls by form showed the numbering was innocent — search/replace held at
 * ~2% failure before and after it shipped, the read-prefix detector had fired
 * 0 times — while the diff form failed 59–91% of calls on every flash-class
 * model in use. The manual, the schema and every hunk error were re-pointed
 * at search/replace on that evidence; this probe is how the next decision
 * (a per-profile gate on the diff form) gets its numbers instead of a feeling.
 *
 * How: node:sqlite opens `~/.pulsemind/db/pulsemind.db` read-only through the
 * `immutable=1` URI (the app may be running; WAL + plain read-only cannot
 * create the -shm file and fails with SQLITE_CANTOPEN), so nothing is written
 * and no Electron-ABI module is needed. Tool calls are the `tool_use` blocks
 * of assistant messages; outcomes are the matching `tool_result` blocks of
 * user messages (the `tool_results` table supplies the full text where the
 * inline copy was truncated). Classification matches the error text the
 * tools emit — frozen phrases (`old_str not found in`, `Hunk at line … does
 * not match`, `No valid hunks found`) that tests/edit-similarity.test.ts and
 * tests/multi-file-patch.test.ts pin — and ONLY on error results, because
 * reading the source files that contain those phrases would otherwise count
 * as failures (the first cut of this analysis was polluted exactly so).
 *
 * Usage:
 *   node scripts/probe-edit-failure-stats.mjs                # all time
 *   node scripts/probe-edit-failure-stats.mjs --since 2026-10-28T06:00:00Z
 *                                                            # before/after split
 *   node scripts/probe-edit-failure-stats.mjs --db /path/to/pulsemind.db --json
 *   (node:sqlite prints an ExperimentalWarning on Node 22; add
 *    `--disable-warning=ExperimentalWarning` to the node invocation to silence it)
 *
 * `--since` splits the report into BEFORE/AFTER a change (UTC ISO timestamp;
 * a bare date is midnight UTC). `switched→replace` counts, for each failed
 * diff-form call, whether the SAME conversation's next edit call used
 * search/replace — the behaviour the steering is meant to produce.
 */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const argOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
const asJson = args.includes('--json')
const since = argOf('--since')
const dataDir = join(homedir(), '.pulsemind')
const dbPath = argOf('--db') ?? join(dataDir, 'db', 'pulsemind.db')
if (!existsSync(dbPath)) { console.error(`database not found: ${dbPath}`); process.exit(2) }

const db = new DatabaseSync(`file:${dbPath}?immutable=1`, { readOnly: true })

// ── profile → model name (settings.json providers[].models[]) ──
const pidToModel = new Map()
try {
  const settings = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))
  for (const p of settings.providers ?? []) for (const m of p.models ?? []) pidToModel.set(m.id, m.model ?? m.name ?? m.id)
} catch { /* no settings → profile ids are shown raw */ }
const convModel = new Map()
const convTitle = new Map()
for (const row of db.prepare('SELECT id, profile_id, title FROM conversations').all()) {
  convTitle.set(row.id, row.title ?? '')
  convModel.set(row.id, row.profile_id
    ? (pidToModel.get(row.profile_id) ?? row.profile_id)
    : (row.id.startsWith('sub_') ? 'sub-agent' : 'default'))
}

// ── tool calls (assistant tool_use blocks) ──
const calls = new Map() // tool_use_id → record
const parse = (s) => { try { return JSON.parse(s) } catch { return null } }
for (const row of db.prepare("SELECT conversation_id, created_at, content_blocks FROM messages WHERE role='assistant' AND content_blocks IS NOT NULL ORDER BY created_at").all()) {
  const blocks = parse(row.content_blocks)
  if (!Array.isArray(blocks)) continue
  for (const b of blocks) {
    if (b?.type !== 'tool_use' || b.name !== 'edit') continue
    const input = b.input ?? {}
    const form = 'diff' in input ? (input.file_path ? 'diff' : 'multi-file diff') : ('old_str' in input ? 'search/replace' : 'other')
    calls.set(b.id, { id: b.id, conv: row.conversation_id, created: row.created_at, form, model: convModel.get(row.conversation_id) ?? '?', outcome: 'ok', prefix: false, steered: false })
  }
}

// ── outcomes (user tool_result blocks; tool_results table for the full text) ──
const fullText = new Map()
for (const r of db.prepare('SELECT tool_use_id, content FROM tool_results').all()) fullText.set(r.tool_use_id, r.content ?? '')
const textOf = (b) => {
  const c = b.content
  const inline = Array.isArray(c) ? c.map((x) => (x && typeof x === 'object' ? x.text ?? '' : String(x ?? ''))).join(' ') : String(c ?? '')
  const stored = fullText.get(b.tool_use_id)
  return stored && stored.length > inline.length ? stored : inline
}
for (const row of db.prepare("SELECT content_blocks FROM messages WHERE role='user' AND content_blocks IS NOT NULL").all()) {
  const blocks = parse(row.content_blocks)
  if (!Array.isArray(blocks)) continue
  for (const b of blocks) {
    if (b?.type !== 'tool_result') continue
    const call = calls.get(b.tool_use_id)
    if (!call) continue
    const text = textOf(b)
    const head = text.slice(0, 400)
    const isError = b.is_error === true || text.startsWith('Error')
    if (head.includes('old_str not found in')) call.outcome = 'miss'
    else if (head.includes('Hunk at line') && head.includes('does not match')) call.outcome = 'hunk mismatch'
    else if (head.includes('No valid hunks found')) call.outcome = 'hunk syntax'
    else if (isError) call.outcome = 'other error'
    if (call.outcome !== 'ok') {
      call.prefix = text.includes('line-number prefix')
      call.steered = text.includes('search/replace')
    }
  }
}

// ── switched→replace: after a failed diff-form call, what did the next edit in the conversation use? ──
const byConv = new Map()
for (const c of calls.values()) { if (!byConv.has(c.conv)) byConv.set(c.conv, []); byConv.get(c.conv).push(c) }
for (const list of byConv.values()) {
  list.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0))
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    if (c.outcome === 'ok' || !c.form.includes('diff')) continue
    const next = list[i + 1]
    c.next = next ? next.form : '(none)'
  }
}

// ── report ──
const rows = [...calls.values()]
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—')
const summarize = (sel) => {
  const n = sel.length
  const by = {}
  for (const r of sel) by[r.outcome] = (by[r.outcome] ?? 0) + 1
  const fail = n - (by.ok ?? 0)
  const diffFails = sel.filter((r) => r.outcome !== 'ok' && r.form.includes('diff'))
  const switched = diffFails.filter((r) => r.next === 'search/replace').length
  return {
    calls: n, fail, failRate: pct(fail, n),
    miss: by.miss ?? 0, hunkMismatch: by['hunk mismatch'] ?? 0, hunkSyntax: by['hunk syntax'] ?? 0, other: by['other error'] ?? 0,
    prefixDetected: sel.filter((r) => r.prefix).length,
    steeredErrors: sel.filter((r) => r.steered).length,
    switchedToReplace: diffFails.length ? `${switched}/${diffFails.length}` : '—',
  }
}
const groupBy = (sel, key) => {
  const out = {}
  for (const v of [...new Set(sel.map(key))].sort()) out[v] = summarize(sel.filter((r) => key(r) === v))
  return out
}
const section = (label, sel) => ({
  label,
  all: summarize(sel),
  byForm: groupBy(sel, (r) => r.form),
  byModel: Object.fromEntries(Object.entries(groupBy(sel, (r) => r.model)).map(([m, s]) => [m, { ...s, byForm: groupBy(sel.filter((r) => r.model === m), (r) => r.form) }])),
})

const sinceIso = since ? (since.length === 10 ? `${since}T00:00:00Z` : since) : null
const sinceKey = sinceIso ? new Date(sinceIso).toISOString() : null
const sections = sinceKey
  ? [section(`BEFORE ${sinceKey}`, rows.filter((r) => r.created < sinceKey)), section(`AFTER  ${sinceKey}`, rows.filter((r) => r.created >= sinceKey))]
  : [section('ALL TIME', rows)]

const topConvs = (sel) => {
  const per = new Map()
  for (const r of sel) { if (r.outcome === 'ok') continue; per.set(r.conv, (per.get(r.conv) ?? 0) + 1) }
  return [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([conv, fails]) => ({ conv, fails, calls: sel.filter((r) => r.conv === conv).length, model: convModel.get(conv), title: (convTitle.get(conv) ?? '').slice(0, 40) }))
}

const lastSel = sinceKey ? rows.filter((r) => r.created >= sinceKey) : rows

if (asJson) {
  console.log(JSON.stringify({ db: dbPath, totalCalls: rows.length, sections, topFailingConversations: topConvs(lastSel) }, null, 2))
  process.exit(0)
}

const line = (name, s, indent = '') =>
  `${indent}${name.padEnd(28 - indent.length)} n=${String(s.calls).padStart(4)}  fail=${String(s.fail).padStart(3)} (${s.failRate.padStart(6)})  miss=${String(s.miss).padStart(3)} hunk=${String(s.hunkMismatch).padStart(3)} syntax=${String(s.hunkSyntax).padStart(2)} other=${String(s.other).padStart(2)}  prefix=${s.prefixDetected} steered=${s.steeredErrors} switched→replace=${s.switchedToReplace}`

console.log(`edit failure statistics — ${dbPath}`)
console.log(`${rows.length} edit calls across ${byConv.size} conversations\n`)
for (const sec of sections) {
  console.log(`=== ${sec.label} ===`)
  console.log(line('all', sec.all))
  for (const [form, s] of Object.entries(sec.byForm)) console.log(line(form, s, '  '))
  console.log('  -- by model --')
  for (const [model, s] of Object.entries(sec.byModel)) {
    console.log(line(model, s, '  '))
    for (const [form, fs] of Object.entries(s.byForm)) console.log(line(form, fs, '      '))
  }
  console.log()
}
const tops = topConvs(lastSel)
if (tops.length) {
  console.log(`=== conversations with the most failures (${sinceKey ? 'after the split' : 'all time'}) ===`)
  for (const t of tops) console.log(`  ${t.conv.padEnd(28)} fails=${String(t.fails).padStart(2)}/${String(t.calls).padEnd(3)} ${String(t.model).padEnd(22)} ${t.title}`)
}
console.log('\nreading guide: `prefix` = read-prefix mis-copies the detector named; `steered` = failures whose error text pointed at search/replace (the 2026-10-29 tails); `switched→replace` = failed diff calls followed by a search/replace call in the same conversation.')
