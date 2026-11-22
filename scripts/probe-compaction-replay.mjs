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
 *   node scripts/probe-compaction-replay.mjs --calibration-audit [--conv conv_xxx] [--replay 40]
 *   node scripts/probe-compaction-replay.mjs --resume-audit     [--conv conv_xxx] [--replay 40]
 *   node scripts/probe-compaction-replay.mjs --resume-bytes --request <dump.request.txt> [--cutoff-rowid N] [--fixed N]
 *     逐字节比较冷重建与真机请求。--fixed 省略时按 last_compaction.tokensBefore
 *     反推本次请求真实用的固定开销（生产按 enabledTools 计价，dump 的 tools 是
 *     精简版，差 ~10K token，用错就差出 80 条消息的切深）。
 *   node scripts/probe-compaction-replay.mjs --replay 40 --cold-frontier   # 单臂：只 seed 持久化前沿
 *
 * out/probe-compaction-replay.bundle.cjs 由
 *   npx esbuild scripts/_replay-entry.ts --bundle --platform=node --format=cjs \
 *     --outfile=out/probe-compaction-replay.bundle.cjs
 * 生成 — 探针驱动的是真实管线，不是复刻实现。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
/** 2026-11-22 audits (review_20261121.md:208 / review_20261103.md:171). */
const CALIBRATION_AUDIT = args.includes('--calibration-audit')
const RESUME_AUDIT = args.includes('--resume-audit')
const BYTES_AT = args.indexOf('--request')
const RESUME_BYTES = args.includes('--resume-bytes')
const CUTOFF_AT = args.indexOf('--cutoff-rowid')
const CUTOFF_ROW = CUTOFF_AT >= 0 ? Number(args[CUTOFF_AT + 1]) : null
/** The coverage frontier that was LIVE when the request was built. The DB keeps
 *  only the newest one, and the cut under test is exactly what overwrote it — so
 *  a default run resolves the frontier the cut PRODUCED, not the one it started
 *  from. Pass the predecessor here when comparing a cutting request byte for
 *  byte (see resumeBytes). */
const FRONTIER_AT = args.indexOf('--frontier')
const FRONTIER_ID = FRONTIER_AT >= 0 ? args[FRONTIER_AT + 1] : null
const AUDIT_K = REPLAY_K || 40
/** 'warm' re-anchors the DB frontier onto this window's drop boundary
 *  (seedWarm — what the live in-memory ledger would have claimed). 'cold'
 *  seeds ONLY the persisted frontier: the post-restart lazy rebuild, which
 *  since 2026-11-22 resolves against the FULL live transcript (and, for a
 *  transient regroup id, against its embedded epoch) instead of this cut's
 *  dropped region. Both arms should now agree on summary calls. */
const SEED_MODE = args.includes('--cold-frontier') ? 'cold' : 'warm'

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
 *  rehydrated cache rebuilds coverage positionally — over the FULL live
 *  transcript now, not the cut's dropped region — the same lazy path a
 *  post-restart process takes (documented, not hidden). */
function loadSessionMeta(conv) {
  const row = q(`SELECT history_summary, history_summary_frontier AS frontier,
                        last_compaction FROM conversations WHERE id='${conv}'`)[0]
  if (!row) return {}
  // The latest compaction EVENT, parsed. Two of its fields are the only way to
  // replay a WARM cut byte-for-byte:
  //   · summary.text  — the text the summarizer actually returned (the transcript
  //     keeps only the swapped-in `history_summary`, and a stub cannot fabricate
  //     an LLM's output);
  //   · tokensBefore  — the price this very cut was aimed WITH, which pins the
  //     fixed overhead the live build used (see `overheadFromEvent`).
  try {
    row.event = row.last_compaction ? JSON.parse(row.last_compaction) : null
  } catch {
    row.event = null
  }
  return row
}

/** The request's own wall clock, read off the dump's file name
 *  (`2026-11-22T12-26-28-500Z-api_<ms>_<rand>.request.txt`). The compaction
 *  event carries `ts` in ms — when the two agree, the event IS this request's
 *  cut, so its summary text and its price belong to the bytes under test. */
function requestMsOf(reqPath) {
  const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(reqPath)
  if (!m) return null
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`)
  return Number.isFinite(ms) ? ms : null
}

/** True when the persisted compaction event was recorded by THIS request. */
function eventIsThisRequest(meta, reqPath) {
  const at = requestMsOf(reqPath)
  const ts = meta?.event?.ts
  return typeof ts === 'number' && at !== null && Math.abs(ts - at) <= 5_000
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
 *  region), so prices stay realistic while byte-identity stays reproducible.
 *
 *  `realText` overrides that stand-in with the text production really landed
 *  (`last_compaction.summary.text`). Only meaningful for the ONE request whose
 *  cut that event records — anywhere else the text belongs to a different
 *  region and replacing it would be fabricating bytes. */
function newCompactor(counters, meta, realText) {
  const state = { live: [] }
  const comp = new R.ContextCompactor({
    runHistorySummary: async (text) => {
      counters.summaryCalls++
      if (realText) return realText
      return text.slice(0, 6_800)
    },
    getMessages: () => state.live,
  })
  // Seed the persisted frontier + text through the product's own entry:
  // `covered` stays undefined so the compactor derives coverage from the
  // frontier (cacheCovered) over the full live transcript — the same lazy
  // path a post-restart process takes.
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
 *  reachable through a public setter, which is why the frontier carries it.
 *
 *  2026-11-22: this arm is now a BASELINE, not a workaround. Production's
 *  cacheCovered() resolves the frontier against the full live transcript, so
 *  the cold arm should land on the same number of summary calls without it. */
function seedWarm(comp, meta, bootCopy, bootFinal) {
  if (!meta?.frontier) return
  const kept = new Set(bootFinal.map((m) => m.id))
  const dropped = bootCopy.filter((m) => !kept.has(m.id))
  if (dropped.length === 0) return
  comp.seedHistorySummary(meta.history_summary ?? '', dropped[dropped.length - 1].id)
}

async function replay(K, seedMode = SEED_MODE) {
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
  // the arm's counter. `--cold-frontier` skips the re-anchor entirely and keeps
  // ONLY the persisted frontier — the exact state a post-restart process
  // rehydrates, because the in-memory `covered` ledger is never persisted.
  if (seedMode === 'warm' && meta?.frontier && pick.length > 0) {
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
    // `setCopyCalibration(measured / raw build estimate)`, clamped to the
    // shipped COPY_CALIBRATION_MIN/MAX). Without it every price sits in
    // raw-heuristic units ~1.9× the wire and the
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
    seedMode,
    frontier: meta.frontier ?? null,
  }
}

// ── Audits (2026-11-22) ───────────────────────────────────────────────
// Two questions the replay could answer only by eyeballing --verbose rows:
//   · calibration-audit — is `copyTokens` a usable wire anchor, or does the
//     [0.6, 1.6] clamp leave a systematic residual (review_20261121.md:208)?
//   · resume-audit — does a post-restart frontier-only cache pay an EXTRA
//     summarizer call (review_20261103.md:171 待核实 5)?
//
// IMPORTANT scope: `raw` here is the REPLAY copy's price and `wire` is the DB's
// report for the request that PRODUCED that transcript — they are NOT the same
// request body (the replay rebuilds from the persisted frontier, while the
// live process had already compacted). So `wire/raw` is a MIX of tokenizer
// slant and copy-shape difference. These audits therefore measure the clamp's
// BEHAVIOUR and the chain's response to it, not the production estimator's
// absolute accuracy. The clamp's convergence domain is derived from the
// formula alone and does not depend on this caveat.

/** Nearest-rank percentile over a numeric array. */
function quantile(xs, q) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * q) - 1))]
}

/** Audit the SHIPPED bounds, never a copied literal: a stale bundle would
 *  otherwise silently re-measure the retired [0.6, 1.6] domain. */
const CAL_MIN = R.COPY_CALIBRATION_MIN
const CAL_MAX = R.COPY_CALIBRATION_MAX
if (!(CAL_MIN > 0) || !(CAL_MAX > CAL_MIN)) {
  throw new Error('probe bundle is stale — rebuild out/probe-compaction-replay.bundle.cjs (missing COPY_CALIBRATION_MIN/MAX)')
}

function calibrationAudit(run) {
  const rows = run.arr.map((x, i) => {
    const raw = Math.max(1, x.raw)
    const wire = Math.max(1, x.wire)
    const wanted = wire / raw                 // what setCopyCalibration was ASKED for
    const applied = x.cal                   // factor that priced THIS request
    return {
      row: x.row,
      r: raw / wire,                        // raw/wire: >1 = heuristic over-reads
      wanted,
      applied,
      clampedWanted: Math.min(CAL_MAX, Math.max(CAL_MIN, wanted)),
      priceOverWire: x.price / wire,
      nextApplied: run.arr[i + 1]?.cal ?? null,
      cut: x.cut,
    }
  })
  const rs = rows.map((x) => x.r)
  const pov = rows.map((x) => x.priceOverWire)
  const atFloor = rows.filter((x) => Math.abs(x.clampedWanted - CAL_MIN) < 1e-9)
  const atCeil = rows.filter((x) => Math.abs(x.clampedWanted - CAL_MAX) < 1e-9)
  // The D12 danger direction: the engine's own price UNDER-reads the wire, so
  // `price > T` fires too late and the request can overflow before any gate.
  const underread = rows.filter((x) => x.priceOverWire < 0.95)
  // Wiring check: the factor applied on request i+1 must be the clamped
  // wanted ratio of request i (production: usage report → next build).
  // CUT ROWS AND THEIR PREDECESSORS ARE EXCLUDED: on a cut row `price` prices
  // the PRE-cut copy while `raw` prices the POST-cut `final`, so that row's
  // `cal` is not the applied factor — it breaks the predecessor's check
  // (observed: the only mismatched rows were cut-row predecessors).
  const comparable = rows.filter((x, i) =>
    !x.cut && !rows[i + 1]?.cut && x.nextApplied !== null)
  const mismatches = comparable
    .filter((x) => Math.abs(x.nextApplied - x.clampedWanted) >= 0.02)
    .map((x) => x.row)
  const cuts = rows.filter((x) => x.cut)

  console.log(`# copyCalibration 审计 — ${CONV}（最近 ${run.k} 请求 · b=${run.budget}）`)
  console.log('口径：raw = 回放副本的 copyTokensOf；wire = DB 该请求的 input_tokens。二者不是同一请求体，见源码注释。')
  console.log('')
  console.log(`现役钳 [${CAL_MIN}, ${CAL_MAX}]；收敛域（纯公式）：raw/wire ∈ [${(1 / CAL_MAX).toFixed(3)}, ${(1 / CAL_MIN).toFixed(3)}]；越界后 copyTokens = raw × clamp(wire/raw)。`)
  console.log(`  · 触下限 ${CAL_MIN.toFixed(2)}（raw 高估）: ${String(atFloor.length).padStart(3)} 请求 → 偏早倍数 = ${CAL_MIN.toFixed(2)} × raw/wire`)
  console.log(`  · 触上限 ${CAL_MAX.toFixed(2)}（raw 低估）: ${String(atCeil.length).padStart(3)} 请求 → 少报，D12 超窗方向`)
  console.log(`  · 域内（可收敛）          : ${String(rows.length - atFloor.length - atCeil.length).padStart(3)} 请求`)
  console.log('')
  console.log(`raw/wire        p25 ${quantile(rs, 0.25).toFixed(2)} · p50 ${quantile(rs, 0.5).toFixed(2)} · p75 ${quantile(rs, 0.75).toFixed(2)} · min ${Math.min(...rs).toFixed(2)} / max ${Math.max(...rs).toFixed(2)}`)
  console.log(`price/wire      p25 ${quantile(pov, 0.25).toFixed(2)} · p50 ${quantile(pov, 0.5).toFixed(2)} · p75 ${quantile(pov, 0.75).toFixed(2)} · 均值 ${(pov.reduce((a, b) => a + b, 0) / pov.length).toFixed(2)}`)
  console.log(`少报请求（price < 0.95×wire）: ${underread.length} / ${rows.length}  ← D12 关心的方向`)
  console.log(`回灌链路抽查（clamp(wanted_i) == applied_{i+1}，排除切割行及前驱）: ${comparable.length - mismatches.length} / ${comparable.length}` +
    (mismatches.length ? ` · 偏差行 ${mismatches.join(',')}（priming/切割边界，不影响结论）` : ''))
  console.log('')
  if (cuts.length) {
    for (const x of cuts) {
      console.log(`切割 row ${x.row}: price/wire=${x.priceOverWire.toFixed(2)} · raw/wire=${x.r.toFixed(2)} · 下一次 applied=${x.nextApplied ?? '—'}`)
    }
  } else {
    console.log('本窗口无切割。')
  }
  console.log('')
  // 旧钳 [0.6, 1.6] 的对照：同一批 wanted 有多少落在旧域外。放宽后这部分
  // 从「钳住、留残差」变成「按比例收敛」，是本次改动的直接收益面。
  const oldFloor = rows.filter((x) => x.wanted < 0.6).length
  const oldCeil = rows.filter((x) => x.wanted > 1.6).length
  const newOutside = rows.filter((x) => x.wanted < CAL_MIN || x.wanted > CAL_MAX).length
  console.log(`旧钳 [0.6, 1.6] 下越界 ${oldFloor + oldCeil} 请求（下限 ${oldFloor} / 上限 ${oldCeil}）→ 现役钳下越界 ${newOutside} 请求。`)
  console.log('判读：review_20261121.md:208 写「raw 是 wire 的 1.7–1.9× → 偏早 1.8×」。')
  console.log('      按旧钳公式 r=1.8 时钳到 0.6 只会得到 1.08×wire（只偏早 8%）；要偏早 1.8× 需 r≈3.0。')
  console.log('      即该行的「1.7–1.9×」与「偏早 1.8×」不是同一量，1.7–1.9× 是钳后残差而非启发式 raw 估读。')
}

async function resumeAudit(K) {
  const warm = await replay(K, 'warm')
  const cold = await replay(K, 'cold')
  const firstCut = (run) => run.arr.find((x) => x.cut)?.trace ?? null
  const wCut = firstCut(warm)
  const cCut = firstCut(cold)
  console.log(`# resume 审计 — ${CONV}（最近 ${K} 请求 · frontier=${warm.frontier ?? '(none)'}）`)
  console.log('warm = frontier 重锚到本窗口 drop boundary（等价 live 的 covered 账本，基线）')
  console.log('cold = 只 seed 持久化 frontier（重启后按全量转录重建 covered；regroup 瞬时 id 走时间兜底）')
  console.log('')
  console.log(`摘要 LLM 调用   warm ${warm.calls}  /  cold ${cold.calls}   → 差 ${cold.calls - warm.calls}`)
  console.log(`切割次数        warm ${warm.cuts}  /  cold ${cold.cuts}`)
  console.log(`全灭请求        warm ${summarize(warm).floorReqs}  /  cold ${summarize(cold).floorReqs}`)
  console.log(`头部改写        warm ${summarize(warm).rewrites}  /  cold ${summarize(cold).rewrites}`)
  console.log(`首刀策略        warm ${wCut ? wCut.strategies.join('+') : '(无)'}  /  cold ${cCut ? cCut.strategies.join('+') : '(无)'}`)
  console.log(`首刀摘要字      warm ${wCut?.summaryChars ?? '—'}  /  cold ${cCut?.summaryChars ?? '—'}`)
  console.log('')
  console.log(`结论：${cold.calls > warm.calls
    ? `重启态仍多付 ${cold.calls - warm.calls} 次摘要 LLM —— 重建基准修复未覆盖本会话的形态（查 frontier 是否可解析）`
    : '两臂摘要调用数相同 —— cacheCovered 全量转录重建后，重启不再多付摘要（review_20261103.md:171 形态已修）'}`)
}

/** Plain text of an OpenAI wire message (content is a string for user/tool,
 *  an array for assistant messages on some gateways). */
function wireText(m) {
  if (typeof m?.content === 'string') return m.content
  if (Array.isArray(m?.content)) {
    return m.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
  }
  return ''
}

/** The DB row this request's LAST real message came from. The request dump
 *  also carries the synthetic state block at the end; a resumed request adds
 *  nothing after the user's new message, so finding that message is the
 *  cutoff. Tool rows match by tool_call_id, user/assistant rows by text. */
function findDumpCutoff(transcript, dump) {
  const msgs = dump.messages ?? []
  const stateAt = msgs.findIndex((m, i) => i > 0 && typeof m?.content === 'string' && m.content.startsWith('<session-state>'))
  const real = stateAt >= 0 ? msgs.slice(0, stateAt) : msgs
  const last = [...real].reverse().find((m) => m?.role !== 'system')
  if (!last) return null
  for (let i = transcript.length - 1; i >= 0; i--) {
    const row = transcript[i]
    const blocks = row.msg.contentBlocks ?? []
    if (last.role === 'tool') {
      if (blocks.some((b) => b.type === 'tool_result' && b.tool_use_id === last.tool_call_id)) return row.r
    } else if (last.role === 'assistant') {
      const ids = (last.tool_calls ?? []).map((tc) => tc.id)
      if (ids.some((id) => blocks.some((b) => b.type === 'tool_use' && b.id === id))) return row.r
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      if (text === wireText(last)) return row.r
    } else if (last.role === 'user') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      if (text === wireText(last)) return row.r
    }
  }
  return null
}

/** The fixed overhead the LIVE build priced this cut with, recovered from the
 *  event's own `tokensBefore`.
 *
 *  Why not recompute it: production sums `estimateTextTokens(system)` +
 *  `estimateTextTokens(JSON.stringify(enabledTools))` + the state block, and
 *  `enabledTools` is the ENGINE's tool list — full descriptions and schemas —
 *  while the dump carries the adapter's converted, trimmed `tools`. The two
 *  differ by ~10K tokens in this repo (20771 reconstructed vs 30731 live), and
 *  a 2% price error is not cosmetic: the same target then cuts 252 messages
 *  instead of 332, i.e. a completely different head.
 *
 *  `tokensBefore` is `copyTokens(copy, overhead)` = the calibrated price of the
 *  SAME copy, so subtracting the copy's own uncalibrated price leaves exactly
 *  the overhead that reproduces it. Any learned `copyCalibration` factor rides
 *  along into this number (the factor is per-session and never persisted), which
 *  is the intended reading: replay the cut at the price the cut was aimed with,
 *  not at the price a cold process would guess.
 *
 *  Returns `null` when the event's price is SMALLER than this rebuild's own
 *  content — no overhead can explain that, and the real reason is that the
 *  request was a WARM cut (an epoch base existed, so its copy was `base + tail`,
 *  not the whole history). Nothing about such a request is reproducible from
 *  the DB by construction (D11), and pretending otherwise prints a 2x message
 *  count as if it were a bug. */
function overheadFromEvent(comp, copy, event) {
  const before = event?.tokensBefore
  if (typeof before !== 'number' || !Number.isFinite(before) || before <= 0) return null
  const bare = R.copyTokensOf(copy, 0)
  if (before <= bare) return null
  return Math.round(before - bare)
}

/** 真机字节级验收：从 DB 全量转录按重启路径重建 —— assembleCopy → price →
 *  directCut（若过线）—— 再用**同一个** OpenAI 适配器把 finalMessages +
 *  请求里的 state block 编成 wire，与真机 request dump 逐条、逐字节比较。
 *
 *  这不是回放相似度：system prompt、summary 文本、state block 全部取真实
 *  dump，比较的是 `JSON.stringify(apiMessages)` 的完全相等。
 *
 *  两个输入必须在「本次请求」的刻度上，否则比较的是两个不同的世界：
 *
 *  1) **固定开销**。生产按 `system + JSON.stringify(enabledTools) + stateBlock`
 *     计价，而 enabledTools 是引擎侧的完整工具定义（含长 description +
 *     schema），dump 里的 `tools` 是适配器转换后的精简版——两者差 ~10K
 *     token（本会话 20771 vs 30731）。用错这一个数，价格差 2%，切深就从
 *     332 条掉到 252 条，逐条比较全是「多出来的消息」。所以：给了 `--fixed`
 *     就用它；否则在事件属于本请求时用 `tokensBefore` 反推（见
 *     overheadFromEvent）。
 *
 *  2) **摘要文本**。stub 摘要不可能等于线上 LLM 的输出。事件属于本请求时，
 *     `last_compaction.summary.text` 就是这次切割落地的那段文本，直接回灌
 *     给 summarizer 即可；事件不属于本请求（DB 只留最新一条）时，宁可标红
 *     也不拿未来的摘要重放过去。
 *
 *  剩下的仍是不可复现的：`copyCalibration`（每会话学习、不落库）被上面的
 *  开销反推吸收，等价于「按本次请求真实价格重放」；`covered` 账本不落库，
 *  由 cacheCovered 按前沿位置重建，这正是重启后真实走的那条路。 */
async function resumeBytes() {
  if (BYTES_AT < 0 || !args[BYTES_AT + 1]) throw new Error('--resume-bytes needs --request <dump.request.txt>')
  const reqPath = args[BYTES_AT + 1]
  const dump = JSON.parse(readFileSync(reqPath, 'utf8'))
  const transcript = loadTranscript(CONV)
  const cutoff = CUTOFF_ROW ?? findDumpCutoff(transcript, dump)
  if (cutoff == null) throw new Error('cannot locate the request\'s last message in the DB transcript; pass --cutoff-rowid')
  const live = transcript.filter((x) => x.r <= cutoff).map((x) => x.msg)
  if (live.length === 0) throw new Error(`no transcript rows at or before rowid ${cutoff}`)

  const meta = loadSessionMeta(CONV)
  const ownEvent = eventIsThisRequest(meta, reqPath) ? meta.event : null
  // The text the live summarizer returned for THIS cut — the only summary bytes
  // that can be reproduced exactly.
  //
  // Caveat this replay cannot escape: the event stores the LANDED text, and a
  // landing on the extension path is `cache.text + extra` joined. Feeding that
  // merged text back as the summarizer's output makes the stub append the whole
  // thing a second time. The pre-extension cache text is not persisted anywhere,
  // so the split is unrecoverable; `doubledSummary` in the output flags it
  // instead of silently reporting a phantom diff.
  const landedSummary = ownEvent?.summary?.text && ownEvent.summary.text.length > 0 ? ownEvent.summary.text : null
  const counters = { summaryCalls: 0 }
  const { comp, state } = newCompactor(counters, meta, landedSummary)
  state.live = live
  if (FRONTIER_ID) comp.seedHistorySummary(meta.history_summary ?? '', FRONTIER_ID)
  const lines = comp.epochLines(BUDGET)
  const copy = comp.assembleCopy()
  // Overhead: explicit flag > the event's own price > the module default. See
  // `overheadFromEvent` for why the event is the honest source — and for the
  // null case, which means this request was a WARM cut and cannot be rebuilt.
  const derived = FIXED_AT >= 0 ? FIXED : (ownEvent ? overheadFromEvent(comp, copy, ownEvent) : null)
  // A request is only UNREBUILDABLE when its own event contradicts the rebuild:
  // an event whose price sits BELOW this copy's own content means the live copy
  // was `base + tail`. No event at all is just an uncompacted session — the
  // cleanest cold rebuild there is.
  const coldRebuild = FIXED_AT >= 0 || !ownEvent || derived !== null
  const fixed = derived ?? FIXED
  const price = comp.priceRequest(copy, fixed)
  let final = copy
  let cut = null
  if (price > lines.trigger) {
    cut = await comp.directCut(lines.target, { overhead: fixed, copy })
    if (cut.cut) final = cut.messages
  }

  const systemPrompt = dump.messages?.[0]?.role === 'system' ? dump.messages[0].content : ''
  const last = dump.messages?.[dump.messages.length - 1]
  const stateText = typeof last?.content === 'string' && last.content.startsWith('<session-state>') ? last.content : null
  const withState = stateText
    ? [...final, { id: 'resume-state', role: 'user', contentBlocks: [{ type: 'text', text: stateText }], createdAt: new Date().toISOString() }]
    : final
  const built = R.openaiAdapter.buildMessages(withState, systemPrompt).apiMessages
  const dumpMsgs = dump.messages ?? []
  let firstDiff = -1
  for (let i = 0; i < Math.max(built.length, dumpMsgs.length); i++) {
    if (JSON.stringify(built[i]) !== JSON.stringify(dumpMsgs[i])) { firstDiff = i; break }
  }
  const exact = firstDiff === -1 && built.length === dumpMsgs.length
  // Did the回灌 text get appended onto itself? The summary message is the only
  // carrier of the cached text, so a length roughly doubled vs the persisted
  // text means the cut took the extension path and the stub doubled it.
  const summaryMsg = built.find((m) => wireText(m).startsWith('【历史对话摘要】'))
  const summaryTextLen = summaryMsg ? wireText(summaryMsg).length : 0
  const doubledSummary = !!landedSummary && summaryTextLen > landedSummary.length * 1.5
  const result = {
    conv: CONV,
    request: reqPath,
    cutoff,
    liveMessages: live.length,
    copyMessages: copy.length,
    finalMessages: final.length,
    builtMessages: built.length,
    dumpMessages: dumpMsgs.length,
    fixedOverhead: Math.round(fixed),
    coldRebuild,
    price: Math.round(price),
    trigger: Math.round(lines.trigger),
    target: Math.round(lines.target),
    cut: !!cut?.cut,
    strategies: cut?.strategies ?? [],
    droppedMessages: copy.length - final.length,
    summaryCalls: counters.summaryCalls,
    summarySource: landedSummary ? 'persisted' : (counters.summaryCalls > 0 ? 'stub' : 'none'),
    doubledSummary,
    eventIsThisRequest: !!ownEvent,
    exact,
    firstDiff,
  }
  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`# resume bytes — ${CONV}`)
    console.log(`request        ${reqPath}`)
    console.log(`cutoff rowid   ${cutoff}（live ${live.length} 条；copy ${copy.length} → final ${final.length}，丢 ${copy.length - final.length} 条）`)
    console.log(`epoch          price ${Math.round(price)} / T ${Math.round(lines.trigger)} / target ${Math.round(lines.target)} · overhead ${Math.round(fixed)} · cut=${cut?.cut ? 'yes' : 'no'}${cut?.cut ? ` [${cut.strategies.join('+')}]` : ''}`)
    console.log(`wire           built ${built.length} 条 / dump ${dumpMsgs.length} 条`)
    console.log(`摘要调用       ${counters.summaryCalls}${counters.summaryCalls > 0 && landedSummary
      ? '（回灌落库文本，字节可比）'
      : counters.summaryCalls > 0 ? '（stub 文本，字节不可比——该事件不属于本请求）' : '（复用缓存）'}`)
    if (!coldRebuild) {
      console.log(`注意           本请求是热态切割（epoch base 存在）：event price ${Math.round(ownEvent?.tokensBefore ?? 0)} < 冷重建自带内容 ${Math.round(R.copyTokensOf(copy, 0))}，`)
      console.log(`               丢 ${ownEvent?.droppedMessages ?? '?'} 条 vs 冷重建 ${copy.length - final.length} 条 ⇒ 逐字节比较无意义（D11：base 不持久化），只能看趋势。`)
    }
    if (doubledSummary) {
      console.log(`注意           落库摘要是「合并后全文」，本次切割走扩展分支时回灌会把它追加第二遍（${summaryTextLen} vs ${landedSummary.length} 字符）。`)
      console.log(`               这不是产品差异：扩展前的缓存文本没有任何地方持久化，无法还原。此时逐字节比较只对摘要消息本身无效。`)
    }
    if (exact) {
      console.log('结果           BYTE-IDENTICAL —— 冷重建的 apiMessages 与真机 dump 逐字节相同')
    } else {
      const i = Math.max(0, firstDiff)
      const a = JSON.stringify(built[i] ?? null)
      const b = JSON.stringify(dumpMsgs[i] ?? null)
      let at = 0
      while (at < Math.min(a.length, b.length) && a[at] === b[at]) at++
      console.log(`结果           DIFF —— firstDiff=${firstDiff}（${i >= dumpMsgs.length ? 'built 多出消息' : i >= built.length ? 'built 缺少消息' : `第 ${at} 个字符起`}）`)
      if (i < built.length && i < dumpMsgs.length) {
        console.log(`  built: ${a.slice(Math.max(0, at - 120), at + 240)}`)
        console.log(`  dump : ${b.slice(Math.max(0, at - 120), at + 240)}`)
      }
      // The recurring residual, called out instead of left to string surgery:
      // both sides carry the SAME summary text and differ only in the coverage
      // line. That line is rendered from (this cut's dropped region ∩ covered
      // ledger), and the ledger is not persisted — a restart rebuilds it as a
      // transcript PREFIX off `firstKeptId`, while the live ledger is a union of
      // holes (light drops whole tool cycles out of the middle). A prefix cannot
      // express a hole-union, so the rebuild over-claims by the cycle that the
      // summary never saw. Everything else in the wire still has to match.
      const covOf = (m) => {
        const t = wireText(m)
        const line = t.split('\n').find((l) => l.startsWith('〔覆盖〕'))
        return line ?? null
      }
      const ca = covOf(built[i])
      const cb = covOf(dumpMsgs[i])
      if (ca && cb) {
        console.log(`  覆盖头差异（唯一残差，账本不落库所致）：`)
        console.log(`    built: ${ca}`)
        console.log(`    dump : ${cb}`)
      }
    }
  }
  process.exitCode = exact ? 0 : 1
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
if (RESUME_BYTES) {
  await resumeBytes()
} else if (RESUME_AUDIT) {
  await resumeAudit(AUDIT_K)
} else if (CALIBRATION_AUDIT) {
  calibrationAudit(await replay(AUDIT_K))
} else if (REPLAY_K > 0) {
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
