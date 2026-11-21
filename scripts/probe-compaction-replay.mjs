#!/usr/bin/env node
/**
 * Compaction replay probe — 拿真实会话的增长序列回放现役 epoch 压缩链。
 *
 * 来由（user 2026-11-21）：会话级缓存命中率 63% vs ZCode ~90%。修复前这条探针
 * 用三条臂（今日四门流水线 / 历史 d6f0e30 / 单决策点 oracle）量出了「损失在哪、
 * 另一个策略能拿回多少」；epoch 设计落库后（PLAN-compaction-epoch，2026-11-21），
 * 探针职责收窄为回归与保真：现役链在同一条真实曲线上切几次、每次切掉多少活
 * 前缀、预测命中率与 DB 实测差几个点。
 *
 * 只读：DB 用 `-readonly`；不写 ~/.pulsemind 任何文件。
 *
 * 用法：
 *   node scripts/probe-compaction-replay.mjs [--conv conv_xxx] [--json]
 *   node scripts/probe-compaction-replay.mjs --replay 40 [--verbose]
 *
 * out/probe-compaction-replay.bundle.cjs 由
 *   npx esbuild scripts/_replay-entry.ts --bundle --platform=node --format=cjs \
 *     --outfile=out/probe-compaction-replay.bundle.cjs
 * 生成 — 探针驱动的是真实管线，不是复刻实现。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
/** Today's shipped chain — the epoch. */
const R = require('../out/probe-compaction-replay.bundle.cjs')

const args = process.argv.slice(2)
const convArg = args.indexOf('--conv')
const CONV = convArg >= 0 ? args[convArg + 1] : 'conv_20261117170141'
const AS_JSON = args.includes('--json')
const DB = join(homedir(), '.pulsemind', 'db', 'pulsemind.db')

function q(sql) {
  const out = execFileSync('sqlite3', ['-readonly', '-json', DB, sql], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  return out.trim() ? JSON.parse(out) : []
}

/** One row per LLM request: the wire's own reports. */
function loadSeries(conv) {
  const rows = q(`
    SELECT rowid AS r, input_tokens AS w, cached_tokens AS c, output_tokens AS o,
           created_at AS t, role, length(content) AS clen,
           length(COALESCE(content_blocks,'')) AS blen
    FROM messages
    WHERE conversation_id='${conv}' AND input_tokens>0
    ORDER BY rowid`)
  for (const row of rows) row.at = Date.parse(row.t)
  return rows
}

// ── 1. 真实序列的损失归因 ─────────────────────────────────────────────
// 天花板 = Σ min(w_i, w_{i-1})：请求 i 最多能把「上一次请求的全部字节」都命
// 中。实测 cached 与它的差就是「被改写掉的前缀」—— 压缩、头部注入、TTL 都落
// 在这些差额里，先按大小与时间间隔切分，才知道哪一类改写在花钱。
function attribute(rows) {
  const items = []
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]
    const cur = rows[i]
    const ceiling = Math.min(cur.w, prev.w)
    items.push({
      i,
      ceiling,
      cached: cur.c,
      loss: Math.max(0, ceiling - cur.c),
      w: cur.w,
      gap: (cur.at - prev.at) / 1000,
      zero: cur.c === 0,
    })
  }
  const totalLoss = items.reduce((s, x) => s + x.loss, 0)
  const buckets = [
    { name: '<1K', max: 1_000 },
    { name: '1–5K', max: 5_000 },
    { name: '5–10K', max: 10_000 },
    { name: '10–20K', max: 20_000 },
    { name: '20–40K', max: 40_000 },
    { name: '≥40K', max: Infinity },
  ].map((b) => ({ ...b, n: 0, loss: 0 }))
  for (const x of items) {
    const b = buckets.find((bb) => x.loss < bb.max)
    b.n++
    b.loss += x.loss
  }
  const gaps = [
    { name: '<10s', max: 10 },
    { name: '10–60s', max: 60 },
    { name: '1–5m', max: 300 },
    { name: '5–15m', max: 900 },
    { name: '≥1h', max: 3_600 },
    { name: '∞', max: Infinity },
  ].map((b) => ({ ...b, n: 0, loss: 0 }))
  for (const x of items) {
    const b = gaps.find((bb) => x.gap < bb.max)
    b.n++
    b.loss += x.loss
  }
  // 「断点」= cached 掉回系统+工具地板（≈18–21K）或直接归零：这才是策略侧
  // 真正能消灭的损失；TTL 与供应商侧缓存粒度不在此列，也没法靠压缩改。
  const FLOOR = 22_000
  const breaks = items.filter((x) => x.cached < FLOOR)
  const breakLoss = breaks.reduce((s, x) => s + x.loss, 0)
  const ceilMass = items.reduce((s, x) => s + x.ceiling, 0)
  return { items, totalLoss, buckets, gaps, breaks, breakLoss, ceilMass }
}

function pct(n, d) {
  return d ? ((100 * n) / d).toFixed(1) + '%' : '—'
}
function k(n) {
  return (n / 1000).toFixed(1) + 'K'
}
function m(n) {
  return (n / 1e6).toFixed(1) + 'M'
}
function hp(frac) {
  return (100 * frac).toFixed(1) + '%'
}

function report(conv, rows, attr) {
  const sumW = rows.reduce((s, r) => s + r.w, 0)
  const sumC = rows.reduce((s, r) => s + r.c, 0)
  console.log(`# 会话 ${conv}`)
  console.log(
    `请求数 ${rows.length}  输入 ${m(sumW)}  tokens  缓存命中 ${m(sumC)}  →  实测命中率 ${pct(sumC, sumW)}`,
  )
  console.log(`\n## 天花板与损失`)
  console.log(
    `可命中上限（Σ min(w_i, w_{i−1})） ${m(attr.ceilMass)}  →  上限命中率 ${pct(attr.ceilMass, sumW)}`,
  )
  console.log(`实际损失 ${m(attr.totalLoss)}（占上限的 ${pct(attr.totalLoss, attr.ceilMass)}）`)
  console.log(`\n### 按单次损失大小`)
  console.log('损失区间 | 请求数 | 占比 | 损失合计 | 占总损失')
  for (const b of attr.buckets) {
    console.log(`${b.name.padEnd(7)} | ${String(b.n).padStart(6)} | ${pct(b.n, attr.items.length).padStart(6)} | ${m(b.loss).padStart(7)} | ${pct(b.loss, attr.totalLoss)}`)
  }
  console.log(`\n### 按与上一请求的间隔（TTL 分辨）`)
  console.log('间隔 | 请求数 | 损失合计 | 占总损失')
  for (const b of attr.gaps) {
    console.log(`${b.name.padEnd(7)} | ${String(b.n).padStart(6)} | ${m(b.loss).padStart(7)} | ${pct(b.loss, attr.totalLoss)}`)
  }
  console.log(`\n### 断点（cached < 22K，掉回系统+工具地板或归零）`)
  console.log(`断点请求 ${attr.breaks.length} / ${attr.items.length}（${pct(attr.breaks.length, attr.items.length)}）`)
  console.log(`断点造成的损失 ${m(attr.breakLoss)}，占总损失 ${pct(attr.breakLoss, attr.totalLoss)}、占上限 ${pct(attr.breakLoss, attr.ceilMass)}`)
  console.log(`其余损失（非断点） ${m(attr.totalLoss - attr.breakLoss)} = ${pct(attr.totalLoss - attr.breakLoss, attr.totalLoss)}`)
}

// ── 2. 回放：把真实增长序列喂给现役 epoch 链 ──────────────────────────
// 分析只说明「损失在哪」；回放回答「现役链在这条曲线上会怎样」。回放驱动的是
// 真实管线（scripts/_replay-entry.ts → out/probe-compaction-replay.bundle.cjs），
// 不是复刻实现：compactor 侧任何一层改动都自动进入结果。
//
// 口径：第 j 个请求的历史 = DB 里它之前的所有消息（= 引擎的 this.messages），
// 逐请求跑 passEpoch —— 与 AgentEngine.prepareLoopRequest 的 epoch 段逐行同构：
//     assembleCopy() → priceRequest() → price > T ? directCut(T − Δ)
// `getMessages()` 闭包指向本请求的历史，于是 assembleCopy 与 directCut 在 await
// 之后读到的锚点是引擎会读到的那一份。命中率按**字节前缀**估：相邻两次副本的
// 规范序列化串的最长公共前缀折成 token（+ 系统提示/工具 schema 的固定地板，
// 它永远命中）。

const REPLAY_AT = args.indexOf('--replay')
const REPLAY_K = REPLAY_AT >= 0 ? Number(args[REPLAY_AT + 1] || 40) : 0
const FIXED_AT = args.indexOf('--fixed')
const FIXED = FIXED_AT >= 0 ? Number(args[FIXED_AT + 1]) : 18_176
const BUDGET_AT = args.indexOf('--budget')
const BUDGET = BUDGET_AT >= 0 ? Number(args[BUDGET_AT + 1]) : 117_232
/** The measured system+tools floor: `cached_tokens` never drops below this in
 *  the real session (the prefix cache covers system+tools even when the whole
 *  message region is rewritten). Measured: the modal value of the session's
 *  `cached_tokens` floor is 19,200 — 1,024 higher than the estimator's 18,176
 *  for the same bytes (provider tokenizer vs heuristic). */
const FLOOR_AT = args.indexOf('--floor')
const FLOOR_WIRE = FLOOR_AT >= 0 ? Number(args[FLOOR_AT + 1]) : 19_200
const VERBOSE = args.includes('--verbose')

/** Share of the message region that survived as a cache prefix. */
function fracOf(cached, price) {
  const region = Math.max(1, price - FIXED)
  return Math.max(0, Math.min(1, (cached - FIXED) / region))
}

/** Every message row with its blocks parsed, in transcript order. */
function loadTranscript(conv) {
  const out = q(`
    SELECT rowid AS r, id, role, content_blocks AS cb, input_tokens AS w,
           cached_tokens AS c, output_tokens AS o, created_at AS t
    FROM messages
    WHERE conversation_id='${conv}' AND content_blocks IS NOT NULL
    ORDER BY rowid`)
  return out.map((row) => ({
    r: row.r,
    w: row.w,
    c: row.c,
    at: Date.parse(row.t),
    msg: {
      id: row.id,
      role: row.role,
      contentBlocks: JSON.parse(row.cb),
      createdAt: row.t,
      inputTokens: row.w || undefined,
      outputTokens: row.o || undefined,
    },
  }))
}

/** The session's persisted compaction state — the ONLY summary facts the DB
 *  keeps. Seeding them is what makes the replay a mid-session window instead of
 *  a cold start: with no frontier the first cut's region is the whole history
 *  and the summarizer is paid for bytes the live process had already summarized
 *  epochs ago. Not recoverable from the DB: the in-memory coverage ledger, so a
 *  rehydrated cache rebuilds coverage positionally from the frontier — the same
 *  lazy path a post-restart process takes (documented, not hidden). */
function loadSessionMeta(conv) {
  const row = q(`SELECT history_summary, history_summary_frontier AS frontier,
                        last_compaction FROM conversations WHERE id='${conv}'`)[0]
  return row ?? {}
}

/** Canonical wire-ish bytes of one message + its own token price, memoised by
 *  object identity (the epoch hands the same frozen base objects across
 *  requests, so the memo hits where byte-identity holds). */
function meter() {
  const canonCache = new WeakMap()
  const tokenCache = new WeakMap()
  return {
    canon(m) {
      let s = canonCache.get(m)
      if (s === undefined) {
        s = JSON.stringify({ r: m.role, b: m.contentBlocks })
        canonCache.set(m, s)
      }
      return s
    },
    tokens(m) {
      let t = tokenCache.get(m)
      if (t === undefined) {
        t = R.estimateMessagesTokens([m])
        tokenCache.set(m, t)
      }
      return t
    },
  }
}

/** Longest common char prefix of two strings, then its token price. */
function prefixTokens(a, b) {
  if (!a || !b) return 0
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return R.estimateTextTokens(a.slice(0, i))
}

/** Match two copies message-by-message: identical messages contribute their
 *  cached price; the first differing pair contributes its char-prefix price. */
function cachedOf(prev, cur, m) {
  if (!prev) return 0
  let acc = 0
  const max = Math.min(prev.length, cur.length)
  for (let i = 0; i < max; i++) {
    if (prev[i] === cur[i]) {
      acc += m.tokens(cur[i])
      continue
    }
    const a = m.canon(prev[i])
    const b = m.canon(cur[i])
    if (a === b) {
      acc += m.tokens(cur[i])
      continue
    }
    return acc + prefixTokens(a, b)
  }
  return acc
}

/** One request through the shipped epoch chain. `live` is this request's
 *  history; the compactor's getMessages() closure must already point at it. */
async function passEpoch(compactor, live, fixed, budget) {
  const lines = compactor.epochLines(budget)
  const copy = compactor.assembleCopy()
  // Books this request's growth sample — on EVERY request, cut or not: the
  // curve is what positions T and sizes Δ (same reader as the engine).
  const price = compactor.priceRequest(copy, fixed)
  let final = copy
  let cut = null
  if (price > lines.trigger) {
    cut = await compactor.directCut(lines.target, { overhead: fixed, copy })
    if (cut.cut) final = cut.messages
  }
  return {
    copy,
    final,
    price,
    lines,
    cut,
    trace: {
      T: lines.trigger,
      delta: lines.depth,
      target: lines.target,
      growth: lines.growth,
      cut: !!cut?.cut,
      strategies: cut?.strategies ?? [],
      dropped: cut?.droppedMessages ?? 0,
      priceAfter: cut?.cut ? cut.priceAfter : price,
      summaryChars: compactor.getHistorySummary()?.text.length ?? 0,
      replays: compactor.lastInjectReplayCount,
      reminder: compactor.lastReminderCount,
    },
  }
}

/** One summary call = a counter bump; text is a deterministic stand-in sized
 *  like the real summarizer's output (conv …: 6,797 chars for a 40K-char
 *  region), so prices stay realistic while byte-identity stays reproducible. */
function newCompactor(counters, meta) {
  const state = { live: [] }
  const comp = new R.ContextCompactor({
    runHistorySummary: async (text) => {
      counters.summaryCalls++
      return text.slice(0, 6_800)
    },
    getMessages: () => state.live,
  })
  // Seed the persisted frontier + text through the product's own entry:
  // `covered` stays undefined so the compactor derives coverage from the
  // frontier (cacheCovered) — the same lazy path a post-restart process takes.
  if (meta?.frontier) comp.seedHistorySummary(meta.history_summary ?? '', meta.frontier)
  return { comp, state }
}

/** Re-base the seeded frontier onto the WINDOW's own drop boundary.
 *
 *  The DB keeps only the LATEST frontier, so a window ending earlier in the
 *  transcript starts with a frontier that sits AHEAD of its own drop boundary:
 *  `cacheCovered()` looks the id up in the dropped region, finds nothing, and
 *  claims an EMPTY set — every drop then reads as "never summarized", the
 *  summarizer is paid for bytes the live process had summarized epochs ago, and
 *  the summary-call column understates nothing but the model does get a bigger
 *  region than it would have (the copy's bytes are unaffected: summaries ride
 *  the base).
 *
 *  The live ledger at window start DID claim those messages. So the honest seed
 *  is the DB text plus coverage of the first pass's whole drop region — seeding
 *  the frontier at that region's last id makes cacheCovered's positional
 *  rebuild claim exactly it. `covered` itself is not persisted and not
 *  reachable through a public setter, which is why the frontier carries it. */
function seedWarm(comp, meta, bootCopy, bootFinal) {
  if (!meta?.frontier) return
  const kept = new Set(bootFinal.map((m) => m.id))
  const dropped = bootCopy.filter((m) => !kept.has(m.id))
  if (dropped.length === 0) return
  comp.seedHistorySummary(meta.history_summary ?? '', dropped[dropped.length - 1].id)
}

async function replay(K) {
  const transcript = loadTranscript(CONV)
  const meta = loadSessionMeta(CONV)
  const reqIdx = transcript.map((x, i) => (x.msg.inputTokens > 0 ? i : -1)).filter((i) => i >= 0)
  // Prime with ONE request outside the window: the first reported request's
  // prefix survival is a real delta (vs the primed copy), not a boundary zero.
  // Without it every run reports a phantom floor request at index 0.
  const pickAll = reqIdx.slice(-(K + 1))
  const pick = pickAll.slice(1)
  const m = meter()

  // Request j's history = every row before its own assistant row.
  const historyOf = (rowIndex) => transcript.slice(0, rowIndex).map((x) => x.msg)

  const counters = { summaryCalls: 0 }
  const { comp, state } = newCompactor(counters, meta)

  // Warm start on a THROWAWAY compactor so the boot summary call never touches
  // the arm's counter.
  if (meta?.frontier && pick.length > 0) {
    const boot = newCompactor({ summaryCalls: 0 }, meta)
    boot.state.live = historyOf(pick[0])
    const first = await passEpoch(boot.comp, boot.state.live, FIXED, BUDGET)
    seedWarm(comp, meta, first.copy, first.final)
  }

  const arr = []
  let prev = null
  let cuts = 0
  let peak = 0
  for (let j = 0; j < pickAll.length; j++) {
    const rowIndex = pickAll[j]
    state.live = historyOf(rowIndex)
    const { final, price, lines, trace } = await passEpoch(comp, state.live, FIXED, BUDGET)
    // Close the estimator loop the way the engine does: the provider's own
    // usage report calibrates the NEXT request's copy price (stream-runner →
    // `setCopyCalibration(measured / raw build estimate)`, clamped 0.6–1.6).
    // Without it every price sits in raw-heuristic units ~1.9× the wire and the
    // epoch would cut at 48K wire instead of at its 85% line — a simulation
    // that over-compacts by construction. The DB is the meter here, exactly as
    // the provider is in production.
    const raw = R.copyTokensOf(final, FIXED)
    comp.setCopyCalibration(Math.max(FLOOR_WIRE, transcript[rowIndex].w) / Math.max(1, raw))
    const prefix = cachedOf(prev, final, m)
    prev = final
    if (j === 0) continue // priming request: seeds `prev`, not reported
    if (trace.cut) cuts++
    peak = Math.max(peak, price)
    const cached = FIXED + Math.min(prefix, Math.max(0, price - FIXED))
    arr.push({
      row: transcript[rowIndex].r,
      price,
      raw,
      cal: price / Math.max(1, raw),
      cached,
      frac: fracOf(cached, price),
      api: final.length,
      cut: trace.cut,
      T: lines.trigger,
      target: lines.target,
      wire: Math.max(FLOOR_WIRE, transcript[rowIndex].w),
      trace,
    })
  }

  // ── Re-basing on the measured wire ──
  // The estimator misprices this content mix (structure-dense tool JSON + CJK),
  // so absolute copy prices are not comparable to the DB's `input_tokens`. What
  // survives from the simulation is exactly the structure it can know: how much
  // of the message prefix the policy keeps alive. Price each request's message
  // region at the DB's OWN wire size (`frac × (wire − floor)` + floor), so the
  // predicted hit rate answers "on these same requests, what share would the
  // prefix cache have covered?".
  const observedRows = pick.map((i) => ({ row: transcript[i].r, w: transcript[i].w, c: transcript[i].c }))
  for (let i = 0; i < arr.length; i++) {
    const wire = Math.max(FLOOR_WIRE, observedRows[i].w)
    arr[i].wire = wire
    arr[i].wireCached = FLOOR_WIRE + arr[i].frac * (wire - FLOOR_WIRE)
  }
  const sumW = observedRows.reduce((s, x) => s + x.w, 0)
  return {
    arr,
    calls: counters.summaryCalls,
    cuts,
    peak,
    k: pick.length,
    meta: !!meta.frontier,
    fixed: FIXED,
    budget: BUDGET,
    floor: FLOOR_WIRE,
    observed: { w: sumW, c: observedRows.reduce((s, x) => s + x.c, 0) },
    observedRows,
  }
}

function summarize(run) {
  const arr = run.arr
  const wire = arr.reduce((s, x) => s + x.wire, 0)
  const wireCached = arr.reduce((s, x) => s + x.wireCached, 0)
  const frac = arr.reduce((s, x) => s + x.frac, 0) / Math.max(1, arr.length)
  // 两个结构指标，都与 token 刻度的绝对值无关：
  //  「全灭」= 本请求的消息前缀几乎为零（只剩 system+tools 地板）；
  //  「头部改写」= 上一次还活着的前缀（≥20%）这一次掉到 <10% —— 一次
  //  真的把活前缀打断的切割。前者是症状，后者是事件。
  let floorReqs = 0
  let rewrites = 0
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].frac < 0.02) floorReqs++
    if (i > 0 && arr[i - 1].frac >= 0.2 && arr[i].frac < 0.1) rewrites++
  }
  return {
    wireHit: wire ? wireCached / wire : 0,
    frac,
    wire: wire / Math.max(1, arr.length),
    price: arr.reduce((s, x) => s + x.price, 0) / Math.max(1, arr.length),
    floorReqs,
    rewrites,
    peak: run.peak,
  }
}

/** The same structural metrics read straight off the DB wires — the fidelity
 *  yardstick: the replay's message-prefix survival has to land near this
 *  pattern or the simulation is telling its own story. */
function observedMetrics(rows) {
  const w = rows.reduce((s, x) => s + x.w, 0)
  const c = rows.reduce((s, x) => s + x.c, 0)
  const fracs = rows.map((x) => Math.max(0, Math.min(1, (x.c - FLOOR_WIRE) / Math.max(1, x.w - FLOOR_WIRE))))
  let floorReqs = 0
  let rewrites = 0
  for (let i = 0; i < rows.length; i++) {
    if (fracs[i] < 0.02) floorReqs++
    if (i > 0 && fracs[i - 1] >= 0.2 && fracs[i] < 0.1) rewrites++
  }
  // Provider-side ceiling. The freshest bytes of every request can never be a
  // cache hit, so a perfectly stable head still lands below 100%: this is the
  // p90 hit the DB reports on its own ALIVE rows (prefix survived), and it is
  // the ceiling BOTH arms share — same content, same provider. The epoch's
  // prefix-survival number is therefore multiplied by this to project a real
  // hit rate; without it 「存活 100%」 would print as 「命中 100%」, which no
  // provider can deliver.
  const alive = rows.filter((x) => x.w > 30000 && x.c > FLOOR_WIRE).map((x) => x.c / x.w).sort((a, b) => a - b)
  const ceil = alive.length ? alive[Math.min(alive.length - 1, Math.floor(alive.length * 0.9))] : 0
  return {
    hit: w ? c / w : 0,
    frac: fracs.reduce((s, x) => s + x, 0) / Math.max(1, rows.length),
    wire: w / Math.max(1, rows.length),
    floorReqs,
    rewrites,
    ceil,
  }
}

const rows = loadSeries(CONV)
const attr = attribute(rows)
if (REPLAY_K > 0) {
  report(CONV, rows, attr)
  console.log('')
  const run = await replay(REPLAY_K)
  const s = summarize(run)
  const o = observedMetrics(run.observedRows)
  const cw = (v, n = 12) => String(v).padStart(n)
  console.log(
    `# 回放（最近 ${run.k} 个请求 · b=${run.budget} · 固定地板 A=${run.fixed} / wire=${run.floor} · 摘要种子=${run.meta ? 'DB 前沿' : '无'}）`,
  )
  console.log('现役链 = assembleCopy → priceRequest → price > T ? directCut(T − Δ)（与 prepareLoopRequest 同构）')
  console.log('')
  console.log('指标                       |        现役（epoch） |        DB 实测')
  console.log(
    `前缀存活折 wire（上限）     | ${hp(s.wireHit).padStart(20)} | ${hp(o.hit).padStart(14)}`,
  )
  console.log(
    `预计命中 ≈ 存活 × 天花板    | ${hp(s.wireHit * o.ceil).padStart(19)} | ${hp(o.hit).padStart(14)}`,
  )
  console.log(
    `平均消息前缀存活            | ${hp(s.frac).padStart(20)} | ${hp(o.frac).padStart(14)}`,
  )
  console.log(
    `全灭请求（前缀 ≈ 0）        | ${cw(s.floorReqs).padStart(20)} | ${cw(o.floorReqs).padStart(14)}`,
  )
  console.log(
    `头部改写（活前缀被打断）    | ${cw(s.rewrites).padStart(20)} | ${cw(o.rewrites).padStart(14)}`,
  )
  console.log(
    `摘要 LLM 调用               | ${cw(run.calls).padStart(20)} | ${'—'.padStart(14)}`,
  )
  console.log(
    `切割次数（epoch 铸基）      | ${cw(run.cuts).padStart(20)} | ${'—'.padStart(14)}`,
  )
  console.log(
    `装配价峰值（估计刻度）      | ${cw(k(s.peak)).padStart(20)} | ${'—'.padStart(14)}`,
  )
  console.log('')
  console.log(
    `保真度：平均装配价 ${k(s.price)} vs DB wire ${k(o.wire)}（校准闭环应收敛）· 天花板 ${hp(o.ceil)}（DB 存活行 p90）`,
  )
  if (VERBOSE) {
    console.log('')
    console.log('    row |     copy price |      T / Δ (target) | 切 | 前缀存活 | DB wire/hit | 策略 · 丢 N 条 · 摘要字 · 回放')
    for (let i = 0; i < run.arr.length; i++) {
      const x = run.arr[i]
      const d = run.observedRows[i]
      const t = x.trace
      console.log(
        `${String(x.row).padStart(7)} | ${k(x.price).padStart(14)} | ` +
          `${k(x.T).padStart(5)} / ${k(t.delta).padStart(4)} (${k(x.target).padStart(5)}) | ` +
          `${x.cut ? '●' : ' '}  | ${hp(x.frac).padStart(8)} | ` +
          `${k(d.w).padStart(5)} ${pct(d.c, d.w).padStart(6)} | ` +
          `${t.strategies.length ? t.strategies.join('+') : '—'} · ${t.dropped} 条 · ${t.summaryChars} · ${t.replays}`,
      )
      console.log(
        `        ↳ 增长 ${k(t.growth)} · ${x.cut ? `切后 ${k(t.priceAfter)}` : '未切'} · ` +
          `校准 ${x.cal.toFixed(2)}（raw ${k(x.raw)} / wire ${k(x.wire)}）· 提醒 ${t.reminder} · 副本 ${x.api} 条`,
      )
    }
  }
} else if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        conv: CONV,
        requests: rows.length,
        sumW: rows.reduce((s, r) => s + r.w, 0),
        sumC: rows.reduce((s, r) => s + r.c, 0),
        loss: attr.totalLoss,
        ceiling: attr.ceilMass,
        breaks: attr.breaks.length,
        breakLoss: attr.breakLoss,
        buckets: attr.buckets.map((b) => ({ name: b.name, n: b.n, loss: b.loss })),
        gaps: attr.gaps.map((b) => ({ name: b.name, n: b.n, loss: b.loss })),
      },
      null,
      2,
    ),
  )
} else {
  report(CONV, rows, attr)
}
