// Main-process timing curves (PLAN-long-task-perf M0-T2) — no LLM, no UI.
//
// Drives the REAL `saveConversation` (synchronous SQLite write, suspect B6)
// and the REAL `AgentSessionManagerImpl.emitMessages` + the tool_status diff
// pass (the every-notify full-history scan, suspect B1) against a real
// database, over growing message counts, and prints the cost curve the plan
// asks for. The perf gate (perf-log) is switched on with PM_PERF=1 so the
// production `[perf]` lines appear alongside the probe's own table.
//
// Recipe: probe-conversation-teardown's — main-side modules bundled with
// esbuild (platform node) and run by the Electron binary under
// ELECTRON_RUN_AS_NODE (better-sqlite3 is Electron-ABI), `electron` aliased to
// a stub, HOME redirected to a temp dir.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'pm-perf-timers-'))
const home = join(work, 'home')
const require = createRequire(join(root, 'package.json'))
const source = `
import assert from 'node:assert/strict'

async function main() {
  if (process.env.HOME !== ${JSON.stringify(home)}) throw new Error('Unsafe HOME')
  const { DATA_DIR, ensureDataDir } = await import('./src/main/storage/index')
  if (!DATA_DIR.startsWith(process.env.HOME + '/')) throw new Error('Unsafe DATA_DIR')
  ensureDataDir()
  const { initializeDatabase } = await import('./src/main/storage/database')
  await initializeDatabase()
  const { saveConversation } = await import('./src/main/storage/conversation.db')
  const { AgentSessionManagerImpl } = await import('./src/main/agent/session-manager')

  const AT = '2026-09-20T10:00:00.000Z'
  const WORD = '主进程计时填充词句，'
  const fill = (n) => WORD.repeat(Math.ceil(n / WORD.length)).slice(0, n)

  // A realistic long-task conversation: ~1.7KB per message on average
  // (assistant prose + thinking, tool rounds, occasional big tool_result).
  function buildMessages(n) {
    const out = []
    let i = 0
    while (out.length < n) {
      out.push({ id: 'u' + i, role: 'user', createdAt: AT, contentBlocks: [{ type: 'text', text: '第' + i + '轮：' + fill(40) }] })
      out.push({ id: 'a' + i, role: 'assistant', createdAt: AT, contentBlocks: [
        { type: 'thinking', thinking: fill(1500) },
        { type: 'text', text: fill(900 + (i % 5) * 400) },
      ] })
      out.push({ id: 't' + i + 'a', role: 'assistant', createdAt: AT, contentBlocks: [
        { type: 'tool_use', id: 'tu' + i + 'r', name: 'read', input: { file_path: '/w/f' + i + '.ts' }, status: 'completed', exitCode: 0, output: fill(1200) },
        { type: 'tool_use', id: 'tu' + i + 'w', name: 'write', input: { file_path: '/w/o' + i + '.md', content: fill(800) }, status: 'completed', exitCode: 0, output: 'ok' },
      ] })
      out.push({ id: 't' + i + 'r', role: 'user', createdAt: AT, contentBlocks: [
        { type: 'tool_result', tool_use_id: 'tu' + i + 'r', content: fill(1400) },
        { type: 'tool_result', tool_use_id: 'tu' + i + 'w', content: 'ok' },
      ] })
      i++
    }
    return out.slice(0, n)
  }
  const bytesOf = (msgs) => msgs.reduce((n, m) => n + JSON.stringify(m.contentBlocks ?? []).length, 0)

  const timeIt = (fn) => {
    const t0 = performance.now()
    fn()
    return performance.now() - t0
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

  console.log('=== saveConversation 曲线（全量 UPSERT，同步主线程） ===')
  for (const n of [50, 100, 200, 400, 800, 1600]) {
    const msgs = buildMessages(n)
    const conv = { id: 'perf_conv_' + n, title: 'perf', createdAt: AT, updatedAt: AT, messages: msgs, type: 'normal' }
    timeIt(() => saveConversation(conv)) // warm-up (statements prepare, page cache)
    const runs = []
    for (let k = 0; k < 5; k++) runs.push(timeIt(() => saveConversation(conv)))
    console.log('msgs=' + String(n).padStart(5) + '  bytes≈' + String(Math.round(bytesOf(msgs) / 1024)).padStart(6) + 'KB  median ' + median(runs).toFixed(1) + 'ms  (min ' + Math.min(...runs).toFixed(1) + ')')
  }

  console.log('=== emitMessages / tool_status diff 曲线（每 notify 全历史扫描，B1） ===')
  const manager = new AgentSessionManagerImpl()
  const t = manager
  for (const n of [50, 100, 200, 400, 800, 1600, 3200]) {
    const msgs = buildMessages(n)
    // first call seeds the registries (cold: every block stringified), then
    // re-send the SAME list with one appended message — the streaming steady
    // state the notify loop actually repeats.
    timeIt(() => t.emitMessages('perf_s_' + n, msgs))
    const next = [...msgs, { id: 'new1', role: 'assistant', createdAt: AT, contentBlocks: [{ type: 'text', text: fill(200) }] }]
    const runs = []
    for (let k = 0; k < 5; k++) {
      // Re-send with a NEW final message each time (the append the diff sees);
      // registry grows by one per call — close enough to the per-notify shape.
      next.push({ id: 'pad' + k, role: 'user', createdAt: AT, contentBlocks: [{ type: 'text', text: fill(20) }] })
      runs.push(timeIt(() => t.emitMessages('perf_s_' + n, next)))
    }
    console.log('msgs=' + String(n).padStart(5) + '  bytes≈' + String(Math.round(bytesOf(msgs) / 1024)).padStart(6) + 'KB  append-notify median ' + median(runs).toFixed(2) + 'ms')
  }

  console.log('=== 同一会话每 notify 的量级换算 ===')
  console.log('（80ms 合并拍 × 6 会话满载时，上表单次成本 × 12.5 拍/s 即每秒主线程占比）')
  console.log('PASS: perf timers curves captured')
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1) })
`
try {
  const bundle = join(work, 'probe.cjs')
  await build({
    stdin: { contents: source, resolveDir: root, loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    plugins: [{ name: 'esm-stubs', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `module.exports={app:{isPackaged:false,getAppPath:()=>${JSON.stringify(root)}}}`, loader: 'js',
      }))
      // main-host pulls the office exporters, whose `marked` is ESM-only and
      // cannot be require()d from the CJS bundle (the same ERR_REQUIRE_ESM the
      // M0 plan records for probe-message-result-roundtrip). The emitMessages
      // curve never renders markdown, so a stub stands in for the module.
      b.onResolve({ filter: /^marked$/ }, () => ({ path: 'marked', namespace: 'stub' }))
      b.onLoad({ filter: /marked/, namespace: 'stub' }, () => ({
        contents: 'module.exports={marked:()=>"",Marked:function(){},markedInstance:{}}', loader: 'js',
      }))
    } }],
  })
  const run = spawnSync(require('electron'), [bundle], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: join(root, 'node_modules'), PM_PERF: '1' },
  })
  if (run.error) throw run.error
  process.exitCode = run.status === 0 ? 0 : 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
