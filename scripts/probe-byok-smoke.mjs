#!/usr/bin/env node
// ── BYOK smoke probe (A1, product_20261005 行动清单) ──
//
// Four-item smoke over the REAL profiles in ~/.pulsemind/settings.json, both
// wire formats: ① SSE streaming ② tool calling ③ stop reason (stop vs length)
// ④ prompt-cache evidence (identical prefix sent twice).
//
//   node scripts/probe-byok-smoke.mjs [name-or-model-filter ...]
//
// No filter = every provider × model. Each probe keeps max_tokens tiny.
// Keys are never printed; ${ENV} placeholders resolve from process.env; `enc:`
// secrets cannot be decrypted outside the app and are reported as SKIPPED.
// Exit code 1 on any FAIL (gate-able), 0 otherwise (WARN/SKIP allowed).

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SETTINGS = join(homedir(), '.pulsemind', 'settings.json')
const TIMEOUT_MS = 60_000
const TOOL_NAME = 'get_weather'
const TOOL_DEF_OPENAI = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: 'Query current weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
  }
}
const TOOL_DEF_ANTHROPIC = {
  name: TOOL_NAME,
  description: 'Query current weather for a city.',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
}
const SYS = 'You are a smoke-test target. Answer in one short sentence.'
const Q = 'Say OK.'
const CACHE_PREFIX = 'You are a cache-probe. The magic word is PULSEMIND-CACHE-PROBE-20261005. ' + 'Filler sentence for prefix weight. '.repeat(40)

const filters = process.argv.slice(2)
const results = []
let failures = 0

function resolveKey(raw) {
  if (!raw) return { key: '', note: 'empty' }
  const m = raw.match(/^\$\{([A-Z0-9_]+)\}$/)
  if (m) {
    const v = process.env[m[1]]
    return v ? { key: v } : { key: '', note: `env ${m[1]} not set` }
  }
  if (raw.startsWith('enc:')) return { key: '', note: 'safeStorage-encrypted (decrypt needs the app)' }
  return { key: raw }
}

async function withTimeout(promise, what) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS) })
    ])
  } finally { clearTimeout(timer) }
}

async function sseLines(res) {
  const lines = []
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, idx).replace(/\r$/, ''))
      buf = buf.slice(idx + 1)
    }
  }
  if (buf) lines.push(buf)
  return lines
}

// ── OpenAI-format probes ──

async function openaiProbe(base, headers, model, { stream = true, maxTokens = 64, messages = null, tools = null, toolChoice = null } = {}) {
  const body = { model, max_tokens: maxTokens, stream }
  if (stream) body.stream_options = { include_usage: true }
  body.messages = messages ?? [
    { role: 'system', content: SYS },
    { role: 'user', content: Q }
  ]
  if (tools) { body.tools = tools; body.tool_choice = toolChoice ?? 'auto' }
  const res = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  if (!stream) return { json: await res.json(), sse: null }
  const lines = await sseLines(res)
  let chunks = 0, content = '', finish = null, usage = null, toolCalls = null, err = null
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') continue
    let ev
    try { ev = JSON.parse(payload) } catch { continue }
    if (ev.error) { err = ev.error.message ?? JSON.stringify(ev.error); break }
    if (ev.choices?.[0]?.delta?.content) { chunks++; content += ev.choices[0].delta.content }
    const tc = ev.choices?.[0]?.delta?.tool_calls
    if (tc) {
      chunks++
      toolCalls ??= []
      for (const t of tc) {
        const slot = toolCalls[t.index ?? 0] ??= { name: '', args: '' }
        if (t.function?.name) slot.name += t.function.name
        if (t.function?.arguments) slot.args += t.function.arguments
      }
    }
    if (ev.choices?.[0]?.finish_reason) finish = ev.choices[0].finish_reason
    if (ev.usage) usage = ev.usage
  }
  if (err) throw new Error(`stream error: ${err}`)
  return { chunks, content, finish, usage, toolCalls, sse: true, json: null }
}

const cachedTokensOf = u =>
  u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? null

async function smokeOpenai(name, base, headers, model) {
  const rows = []
  // ① SSE
  let first
  try {
    first = await withTimeout(openaiProbe(base, headers, model), `${name} SSE`)
    rows.push(['SSE', first.sse && first.chunks >= 1 ? 'PASS' : 'FAIL',
      `${first.chunks} chunks, ${first.content.trim().length} chars, model=${first.usage?.model ?? model}`])
  } catch (e) { rows.push(['SSE', 'FAIL', String(e.message).slice(0, 140)]); first = null }
  // ③ stop reason（两次读数：自然停 vs 长度截断。截断探针 max_tokens=1——
  //    8 个 token 装得下「OK」，早先 8 的口径把「模型答完了」误判成网关吞了 length）
  if (first) {
    try {
      const tiny = await withTimeout(openaiProbe(base, headers, model, { maxTokens: 1 }), `${name} stop-reason`)
      const naturalOk = first.finish === 'stop'
      const lengthOk = tiny.finish === 'length'
      rows.push(['stop-reason', naturalOk && lengthOk ? 'PASS' : 'FAIL',
        `natural=${first.finish} length-capped=${tiny.finish}`])
    } catch (e) { rows.push(['stop-reason', 'FAIL', String(e.message).slice(0, 140)]) }
  }
  // ② tool calling（两段式：named tool_choice 强制；网关/模型拒绝或忽略 →
  //    回落 auto + 明示指令。判定 = 收到形状合法的 tool_calls）
  try {
    let t, mode = 'forced'
    try {
      t = await withTimeout(openaiProbe(base, headers, model, {
        maxTokens: 128, tools: [TOOL_DEF_OPENAI],
        toolChoice: { type: 'function', function: { name: TOOL_NAME } }
      }), `${name} tool`)
    } catch (forcedErr) {
      mode = `forced-rejected (${String(forcedErr.message).slice(0, 60)}) → auto`
      t = await withTimeout(openaiProbe(base, headers, model, {
        maxTokens: 128, tools: [TOOL_DEF_OPENAI],
        messages: [
          { role: 'system', content: SYS },
          { role: 'user', content: `What is the weather in Tokyo? You MUST call the ${TOOL_NAME} tool.` }
        ]
      }), `${name} tool(auto)`)
    }
    if (t.finish !== 'tool_calls' && (t.toolCalls ?? []).length === 0 && mode === 'forced') {
      mode += ' → auto (forced yielded no call)'
      t = await withTimeout(openaiProbe(base, headers, model, {
        maxTokens: 128, tools: [TOOL_DEF_OPENAI],
        messages: [
          { role: 'system', content: SYS },
          { role: 'user', content: `What is the weather in Tokyo? You MUST call the ${TOOL_NAME} tool.` }
        ]
      }), `${name} tool(auto)`)
    }
    const calls = t.toolCalls ?? []
    const okShape = calls.length > 0 && calls[0].name === TOOL_NAME &&
      (() => { try { JSON.parse(calls[0].args || '{}'); return true } catch { return false } })()
    rows.push(['tool-call', okShape ? 'PASS' : 'FAIL',
      `[${mode}] finish=${t.finish} calls=${calls.length}${calls[0] ? ` name=${calls[0].name} args=${(calls[0].args || '').slice(0, 60)}` : ''}${okShape ? '' : ` text=${t.content.trim().slice(0, 40)}`}`])
  } catch (e) { rows.push(['tool-call', 'FAIL', String(e.message).slice(0, 140)]) }
  // ④ cache evidence（同一前缀连发两次，读第二次的 usage）
  try {
    const msgs = [
      { role: 'system', content: CACHE_PREFIX },
      { role: 'user', content: 'Repeat the magic word only.' }
    ]
    await withTimeout(openaiProbe(base, headers, model, { maxTokens: 16, messages: msgs }), `${name} cache#1`)
    const second = await withTimeout(openaiProbe(base, headers, model, { maxTokens: 16, messages: msgs }), `${name} cache#2`)
    const cached = cachedTokensOf(second.usage)
    rows.push(['cache-hit', cached > 0 ? 'PASS' : 'WARN',
      `cached=${cached ?? 'n/a'} of prompt=${second.usage?.prompt_tokens ?? '?'}`])
  } catch (e) { rows.push(['cache-hit', 'FAIL', String(e.message).slice(0, 140)]) }
  return rows
}

// ── Anthropic-format probes ──

async function anthropicProbe(base, headers, model, { maxTokens = 64, stream = true, tools = null, toolChoice = null, messages = null, system = SYS } = {}) {
  const body = { model, max_tokens: maxTokens, stream, system, messages: messages ?? [{ role: 'user', content: Q }] }
  if (tools) { body.tools = tools; body.tool_choice = toolChoice ?? { type: 'auto' } }
  const res = await fetch(base.replace(/\/$/, '') + '/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const lines = await sseLines(res)
  let blocks = 0, text = '', stopReason = null, usage = {}, toolUse = null, curType = null
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    let ev
    try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
    if (ev.type === 'message_start') usage.input = ev.message?.usage?.input_tokens
    else if (ev.type === 'content_block_start') { blocks++; curType = ev.content_block?.type ?? null; if (curType === 'tool_use') toolUse = { id: ev.content_block.id, name: ev.content_block.name, args: '' } }
    else if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta') text += ev.delta.text
      if (ev.delta?.type === 'input_json_delta' && toolUse) toolUse.args += ev.delta.partial_json
    }
    else if (ev.type === 'message_delta') { stopReason = ev.delta?.stop_reason ?? stopReason; usage.output = ev.usage?.output_tokens ?? usage.output }
  }
  return { blocks, text, stopReason, usage, toolUse }
}

async function smokeAnthropic(name, base, headers, model) {
  const rows = []
  let first
  try {
    first = await withTimeout(anthropicProbe(base, headers, model), `${name} SSE`)
    rows.push(['SSE', first.blocks >= 1 && first.text.length >= 0 ? 'PASS' : 'FAIL',
      `${first.blocks} blocks, ${first.text.trim().length} chars, in=${first.usage.input ?? '?'} out=${first.usage.output ?? '?'}`])
  } catch (e) { rows.push(['SSE', 'FAIL', String(e.message).slice(0, 140)]); first = null }
  if (first) {
    try {
      const tiny = await withTimeout(anthropicProbe(base, headers, model, { maxTokens: 1 }), `${name} stop-reason`)
      const ok = first.stopReason === 'end_turn' && tiny.stopReason === 'max_tokens'
      rows.push(['stop-reason', ok ? 'PASS' : 'FAIL', `natural=${first.stopReason} length-capped=${tiny.stopReason}`])
    } catch (e) { rows.push(['stop-reason', 'FAIL', String(e.message).slice(0, 140)]) }
  }
  try {
    let t, mode = 'forced'
    try {
      t = await withTimeout(anthropicProbe(base, headers, model, {
        maxTokens: 128, tools: [TOOL_DEF_ANTHROPIC], toolChoice: { type: 'tool', name: TOOL_NAME }
      }), `${name} tool`)
    } catch (forcedErr) {
      mode = `forced-rejected (${String(forcedErr.message).slice(0, 60)}) → auto`
      t = await withTimeout(anthropicProbe(base, headers, model, {
        maxTokens: 128, tools: [TOOL_DEF_ANTHROPIC],
        messages: [{ role: 'user', content: `What is the weather in Tokyo? You MUST call the ${TOOL_NAME} tool.` }]
      }), `${name} tool(auto)`)
    }
    if (t.stopReason !== 'tool_use' && !t.toolUse && mode === 'forced') {
      mode += ' → auto (forced yielded no call)'
      t = await withTimeout(anthropicProbe(base, headers, model, {
        maxTokens: 128, tools: [TOOL_DEF_ANTHROPIC],
        messages: [{ role: 'user', content: `What is the weather in Tokyo? You MUST call the ${TOOL_NAME} tool.` }]
      }), `${name} tool(auto)`)
    }
    const okShape = t.toolUse?.name === TOOL_NAME &&
      (() => { try { JSON.parse(t.toolUse.args || '{}'); return true } catch { return false } })()
    rows.push(['tool-call', okShape ? 'PASS' : 'FAIL',
      `[${mode}] stop=${t.stopReason} tool=${t.toolUse?.name ?? 'none'} args=${(t.toolUse?.args || '').slice(0, 60)}`])
  } catch (e) { rows.push(['tool-call', 'FAIL', String(e.message).slice(0, 140)]) }
  try {
    const msgs = [{ role: 'user', content: 'Repeat the magic word only.' }]
    const sys = CACHE_PREFIX
    await withTimeout(anthropicProbe(base, headers, model, { maxTokens: 16, messages: msgs, system: sys }), `${name} cache#1`)
    const second = await withTimeout(anthropicProbe(base, headers, model, { maxTokens: 16, messages: msgs, system: sys }), `${name} cache#2`)
    rows.push(['cache-hit', 'WARN', `usage fields reported: in=${second.usage.input ?? '?'} (cache_read字段网关侧可能不回填，人工核对 response dump)`])
  } catch (e) { rows.push(['cache-hit', 'FAIL', String(e.message).slice(0, 140)]) }
  return rows
}

// ── main ──

const settings = JSON.parse(readFileSync(SETTINGS, 'utf-8'))
const providers = settings.providers ?? []
for (const prov of providers) {
  const { key, note } = resolveKey(prov.apiKey)
  const headers = { ...(prov.headers ?? {}) }
  for (const [k, v] of Object.entries(headers)) {
    const m = typeof v === 'string' ? v.match(/^\$\{([A-Z0-9_]+)\}$/) : null
    if (m) headers[k] = process.env[m[1]] ?? ''
  }
  const auth = prov.apiFormat === 'anthropic' ? { 'x-api-key': key } : { authorization: `Bearer ${key}` }
  for (const m of prov.models ?? []) {
    const label = `${prov.name}/${m.model}`
    if (filters.length && !filters.some(f => `${prov.name} ${prov.id} ${m.model} ${m.id}`.toLowerCase().includes(f.toLowerCase()))) continue
    if (!key) { results.push({ label, fmt: prov.apiFormat, rows: [['ALL', 'SKIP', note]] }); continue }
    console.log(`\n◆ ${label}  (${prov.apiFormat} → ${prov.baseURL})`)
    let rows
    try {
      rows = prov.apiFormat === 'anthropic'
        ? await smokeAnthropic(label, prov.baseURL, { ...headers, ...auth }, m.model)
        : await smokeOpenai(label, prov.baseURL, { ...headers, ...auth }, m.model)
    } catch (e) {
      rows = [['ALL', 'FAIL', String(e.message).slice(0, 140)]]
    }
    for (const [item, verdict, evidence] of rows) {
      if (verdict === 'FAIL') failures++
      console.log(`  [${verdict.padEnd(4)}] ${item.padEnd(11)} ${evidence}`)
    }
    results.push({ label, fmt: prov.apiFormat, rows })
  }
}

console.log(`\n── ${results.length} model(s) smoked, ${failures} FAIL(s) ──`)
console.log('note: app-level 对账（llm-requests/ 当日转储对）仍需在 App 内跑一轮真实会话取得；本探针是 wire 层四项的直证。')
process.exit(failures > 0 ? 1 : 0)
