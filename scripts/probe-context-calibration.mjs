#!/usr/bin/env node
/**
 * Copy-price calibration audit — 从 main.log 的真实配对行量估算器精度。
 *
 * 来由（2026-11-22）：review_20261122.md §5.7 的口径警告——回放探针的
 * `raw/wire` 取的是「回放切后副本 ÷ DB 里当时生产请求」，不是同一请求体，
 * 所以 0.42–4.25 的跨度不能当生产估算误差。真值只在生产侧同一请求的
 * `lastBuildCopyEstimate ↔ usage.inputTokens` 配对里（AgentEngine.ts:658-669）。
 * 本脚本只读那条配对行的落盘副本，回答三件事：
 *   1. 生产 raw/wire 的真实分位数落在哪，是否还在 [0.4, 5.0] 收敛域内；
 *   2. clamp 两端各触了多少次，方向分别是「过压缩」还是「少报/超窗」；
 *   3. price/wire 的少报率（<0.95×wire，D12 方向）与过报率（>1.05×wire）。
 *
 * 只读：不改 ~/.pulsemind 任何文件；--log 可指向导出的日志文件。
 *
 * 两种行都认：
 *   [ContextCalibration] raw=... wire=...          renderer console（不落 main.log）
 *   [ISO] [INFO] ContextCalibration: raw=... wire=...  main.log（经 logMain，source 后带冒号）
 *
 * 用法：
 *   node scripts/probe-context-calibration.mjs
 *   node scripts/probe-context-calibration.mjs --last 200
 *   node scripts/probe-context-calibration.mjs --log /path/to/main.log --json
 *
 * 模型分组总是随文本报告输出；--json 里也有 models 字段，无需额外开关。
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 与 context-compactor.ts 的 COPY_CALIBRATION_MIN/MAX 保持一致。 */
export const CAL_MIN = 0.2
export const CAL_MAX = 2.5

/** Nearest-rank quantile over an ascending array (same rule as epochLines). */
export function quantile(sorted, q) {
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))
  return sorted[idx]
}

/** Parse one log line into a calibration record, or null when it isn't one. */
export function parseCalibrationLine(line) {
  if (typeof line !== 'string') return null
  const match = /\[ContextCalibration\]\s*(.*)$|ContextCalibration:\s*(.*)$/.exec(line)
  if (!match) return null
  const payload = (match[1] ?? match[2] ?? '').trim()
  const num = (name) => {
    const found = new RegExp(`\\b${name}=(-?\\d+(?:\\.\\d+)?)`).exec(payload)
    return found ? Number(found[1]) : null
  }
  const raw = num('raw')
  const wire = num('wire')
  if (!(raw > 0) || !(wire > 0)) return null
  const want = num('want') ?? wire / raw
  const applied = num('applied') ?? Math.min(CAL_MAX, Math.max(CAL_MIN, want))
  const clamp = /\bclamp=(hit|no)\b/.exec(payload)?.[1] ?? (Math.abs(applied - want) > 1e-9 ? 'hit' : 'no')
  return {
    raw,
    wire,
    want,
    applied,
    clamp,
    b: num('b'),
    model: /\bmodel=(\S+)/.exec(payload)?.[1] ?? null,
    conv: /\bconv=(\S+)/.exec(payload)?.[1] ?? null,
  }
}

/** Aggregate records. A clamp LOW means raw over-reads (price > wire →
 *  over-compaction); a clamp HIGH means raw under-reads (price < wire →
 *  D12's under-report / overflow direction). */
export function summarizeCalibration(records) {
  const count = records.length
  const byModel = {}
  for (const r of records) {
    const key = r.model ?? '(unknown)'
    byModel[key] = (byModel[key] ?? 0) + 1
  }
  const out = {
    count,
    conversations: new Set(records.map((r) => r.conv).filter(Boolean)).size,
    models: byModel,
  }
  if (!count) return out

  const rawWire = records.map((r) => r.raw / r.wire).sort((a, b) => a - b)
  const priceWire = records.map((r) => (r.applied * r.raw) / r.wire).sort((a, b) => a - b)
  const stats = (a) => ({
    min: a[0],
    p5: quantile(a, 0.05),
    p25: quantile(a, 0.25),
    p50: quantile(a, 0.5),
    p75: quantile(a, 0.75),
    p95: quantile(a, 0.95),
    max: a[a.length - 1],
    mean: a.reduce((s, x) => s + x, 0) / a.length,
  })
  out.rawWire = stats(rawWire)
  out.priceWire = stats(priceWire)
  out.convergent = {
    lo: 1 / CAL_MAX,
    hi: 1 / CAL_MIN,
    inside: rawWire.filter((r) => r >= 1 / CAL_MAX && r <= 1 / CAL_MIN).length,
  }
  out.convergent.rate = out.convergent.inside / count
  out.clamp = {
    low: records.filter((r) => r.want < CAL_MIN).length,
    high: records.filter((r) => r.want > CAL_MAX).length,
    hit: records.filter((r) => r.clamp === 'hit').length,
  }
  out.clamp.rate = out.clamp.hit / count
  out.underreport = records.filter((r) => (r.applied * r.raw) < 0.95 * r.wire).length
  out.overreport = records.filter((r) => (r.applied * r.raw) > 1.05 * r.wire).length
  return out
}

function fmt(x, digits = 3) {
  return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(digits) : '—'
}

function pct(n, total) {
  return total ? `${((n / total) * 100).toFixed(1)}%` : '—'
}

function textReport(path, size, records, summary) {
  const lines = [
    '[ContextCalibration] 生产估算精度报告',
    `日志: ${path} (${(size / 1024).toFixed(0)}KB)`,
    `样本: ${summary.count} 条 · ${summary.conversations} 个会话`,
    `模型: ${Object.entries(summary.models).map(([m, n]) => `${m}=${n}`).join(', ') || '—'}`,
  ]
  if (!summary.count) {
    lines.push(
      '',
      '没有找到配对行。配对日志是 2026-11-22 才落地的；',
      '识别格式: [ContextCalibration] raw=… wire=…  /  [ISO] [INFO] ContextCalibration: raw=… wire=…',
      'renderer console 不进 main.log，只有经宿主通道落盘的行才能在这里读到。',
      '跑一段真机会话（发几条带工具的消息）后再回来看。',
    )
    return lines.join('\n')
  }
  const r = summary.rawWire
  const p = summary.priceWire
  lines.push(
    '',
    `raw/wire   min=${fmt(r.min)} p5=${fmt(r.p5)} p25=${fmt(r.p25)} p50=${fmt(r.p50)} p75=${fmt(r.p75)} p95=${fmt(r.p95)} max=${fmt(r.max)} mean=${fmt(r.mean)}`,
    `price/wire min=${fmt(p.min)} p5=${fmt(p.p5)} p25=${fmt(p.p25)} p50=${fmt(p.p50)} p75=${fmt(p.p75)} p95=${fmt(p.p95)} max=${fmt(p.max)} mean=${fmt(p.mean)}`,
    '',
    `收敛域 [${fmt(summary.convergent.lo)}, ${fmt(summary.convergent.hi)}] 内: ${summary.convergent.inside}/${summary.count} (${pct(summary.convergent.inside, summary.count)})`,
    `触钳: ${summary.clamp.hit}/${summary.count} (${pct(summary.clamp.hit, summary.count)}) — 下限 ${summary.clamp.low}（raw 高估→过压缩）/ 上限 ${summary.clamp.high}（raw 低估→少报）`,
    `少报 price<0.95×wire: ${summary.underreport}/${summary.count} (${pct(summary.underreport, summary.count)}) ← D12 超窗方向`,
    `过报 price>1.05×wire: ${summary.overreport}/${summary.count} (${pct(summary.overreport, summary.count)})`,
  )
  return lines.join('\n')
}

function main() {
  const args = process.argv.slice(2)
  const logIdx = args.indexOf('--log')
  const path = logIdx >= 0 ? args[logIdx + 1] : join(homedir(), '.pulsemind', 'logs', 'main.log')
  const lastIdx = args.indexOf('--last')
  const last = lastIdx >= 0 ? Number(args[lastIdx + 1]) : null
  const asJson = args.includes('--json')

  let text = ''
  let size = 0
  try {
    text = readFileSync(path, 'utf8')
    size = statSync(path).size
  } catch (err) {
    const message = `[ContextCalibration] 读不到日志 ${path}: ${err.code ?? err.message}`
    if (asJson) console.log(JSON.stringify({ path, error: message, count: 0 }))
    else console.log(message)
    return
  }

  let records = text.split(/\r?\n/).map(parseCalibrationLine).filter(Boolean)
  if (Number.isFinite(last) && last > 0) records = records.slice(-last)
  const summary = summarizeCalibration(records)
  if (asJson) console.log(JSON.stringify({ path, size, ...summary }, null, 2))
  else console.log(textReport(path, size, records, summary))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
