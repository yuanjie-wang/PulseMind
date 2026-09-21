// Per-loop-iteration fixed cost (PLAN-long-task-perf follow-up) — no LLM, no UI.
//
// The closed long-task plan measured the "every notify" and "every turn's save"
// layers (B1/B6). This probe measures the layer underneath them: the work
// `AgentEngine.prepareLoopRequest` redoes on EVERY tool-loop iteration of a
// single turn — which is where a long unattended task actually spends its time.
//
// Everything is the REAL implementation, not a replica:
//   - `ContextCompactor` (contextTokens / nanoCompact / lightCompact /
//     hardTruncate) — imported from src/renderer/src/agent/engine, which has
//     only a type-only import, so it bundles without a host
//   - `stripToolResultImages` — the function AgentEngine.ts calls per request
//     (extracted to src/renderer/src/agent/strip-tool-results.ts for exactly
//     this: measuring the real thing)
//   - the git subprocess `buildGitContext` runs (status). The redundant
//     `rev-parse --is-inside-work-tree` precheck it ALSO used to run is still
//     measured, in section D, purely as the delta that removing it recovered.
//   - the SQLite queries behind `MemoryManager.buildMemoryContext`'s four IPC
//
// Recipe: probe-perf-timers.mjs' — esbuild bundle (platform node) run by the
// Electron binary under ELECTRON_RUN_AS_NODE (better-sqlite3 is Electron-ABI),
// `electron` aliased to a stub, HOME redirected to a temp dir so nothing here
// touches the user's ~/.pulsemind.
//
// MEASUREMENT HYGIENE — read before quoting any number:
//   * Every bench prints `min` and `p50`. `min` is the honest estimate of a
//     synchronously-executed stretch; p50 carries GC pauses from earlier phases.
//     The summary in F sums `min`s for that reason.
//   * The 校准 block at the top exists to expose the environment: this machine
//     makes node's own `fs.openSync` cost ~34ms for ANY file (verified on
//     /etc/hosts, workspace, home and temp files alike) while spawning `cat` —
//     which opens and reads the very same file — costs 1.3ms. That is a
//     property of this measurement runtime, NOT of the app, so `readFileSync`
//     rows must not be quoted as application cost. Subprocess rows are fine:
//     the spawn floor is measured right next to them.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'pm-loop-perf-'))
const home = join(work, 'home')
const require = createRequire(join(root, 'package.json'))
const source = `
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

async function main() {
  if (process.env.HOME !== ${JSON.stringify(home)}) throw new Error('Unsafe HOME')
  const { DATA_DIR, ensureDataDir } = await import('./src/main/storage/index')
  if (!DATA_DIR.startsWith(process.env.HOME + '/')) throw new Error('Unsafe DATA_DIR')
  ensureDataDir()
  const { initializeDatabase } = await import('./src/main/storage/database')
  await initializeDatabase()
  const { saveConversation, listConversationsForMemory } = await import('./src/main/storage/conversation.db')
  const { saveMemory, listMemories } = await import('./src/main/storage/memory.db')
  const { ContextCompactor } = await import('./src/renderer/src/agent/engine/context-compactor')
  const { stripToolResultImages } = await import('./src/renderer/src/agent/strip-tool-results')

  const AT = '2026-09-20T10:00:00.000Z'
  const WORD = '主进程计时填充词句，'
  const fill = (n) => WORD.repeat(Math.ceil(n / WORD.length)).slice(0, n)
  const hr = () => Number(process.hrtime.bigint()) / 1e6

  // bench returns the samples; callers read min (robust) / p50 (GC-inclusive).
  function bench(fn, runs) {
    fn()
    const out = []
    for (let k = 0; k < (runs || 15); k++) { const s = hr(); fn(); out.push(hr() - s) }
    out.sort((a, b) => a - b)
    return out
  }
  const p50 = (a) => a[Math.floor(a.length / 2)]
  const M = {}   // name -> min ms, the numbers F sums
  const Mrow = (name, samples) => { M[name] = samples[0]; return samples }
  const row = (label, samples, suffix) => console.log(
    label.padEnd(46) + ' min ' + samples[0].toFixed(2).padStart(7) + 'ms   p50 ' + p50(samples).toFixed(2).padStart(7) + 'ms' + (suffix || ''))
  const fmt = (v, w) => String(v).padStart(w)

  // ── Fixture: same shape as probe-perf-timers (comparable numbers), with the
  // tool_result content kind parameterised so the image-strip cost is separable
  // from the parse-and-reserialize cost every tool_result pays. ──
  const IMAGE_PAYLOAD = JSON.stringify({ ok: true, mime: 'image/jpeg', data: '/9j/' + 'A'.repeat(40000) })
  function toolResultContent(kind, i) {
    if (kind === 'image') return IMAGE_PAYLOAD
    if (kind === 'json') return JSON.stringify({ ok: true, path: '/w/f' + i + '.ts', lines: 120, text: fill(1200) })
    return fill(1400) // plain text: JSON.parse throws, stripImageData runs on the string
  }
  function buildMessages(n, kind) {
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
        { type: 'tool_result', tool_use_id: 'tu' + i + 'r', tool_result_id: 'tr' + i + 'r', content: toolResultContent(kind, i) },
        { type: 'tool_result', tool_use_id: 'tu' + i + 'w', tool_result_id: 'tr' + i + 'w', content: 'ok' },
      ] })
      i++
    }
    return out.slice(0, n)
  }
  const bytesOf = (msgs) => msgs.reduce((n, m) => n + JSON.stringify(m.contentBlocks || []).length, 0)
  const kb = (msgs) => Math.round(bytesOf(msgs) / 1024)

  // ═══ 校准：把测量环境本身量出来，好知道哪些行可以引用 ═══
  console.log('=== 校准（测量的地板，不是应用行为） ===')
  row('spawn /usr/bin/true（进程创建地板）', bench(() => execFileSync('/usr/bin/true', [], { stdio: 'ignore' }), 20))
  row('spawn /bin/cat package.json（子进程读文件）', bench(() => execFileSync('/bin/cat', ['package.json'], { stdio: 'ignore' }), 20))
  const calibFile = join(DATA_DIR, 'calib.txt')
  writeFileSync(calibFile, fill(8000), 'utf-8')
  row('本进程 readFileSync 8KB', bench(() => readFileSync(calibFile, 'utf-8'), 20), '  ← 视环境而定，勿当应用开销')

  // ═══ D. buildGitContext 的 git 子进程（每 loop 迭代 1 次）═══
  // The redundant 'rev-parse --is-inside-work-tree' precheck was removed
  // (system-prompt-builder.ts buildGitContext) — 'status' already reports
  // isRepo. It is still measured, as a DELTA REFERENCE: it is the number this
  // path used to pay on top of 'status', per iteration.
  console.log('=== D. git 子进程（buildGitContext 每迭代 1 次：只有 status） ===')
  const repo = process.env.PM_PROBE_REPO
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  const sIsRepo = bench(() => git(['rev-parse', '--is-inside-work-tree']), 20)
  const sStatus = Mrow('gitStatus', bench(() => git(['status', '--porcelain']), 20))
  row('git status --porcelain（现每迭代唯一一次）', sStatus)
  row('git rev-parse --is-inside-work-tree（已移除，仅作差量参照）', sIsRepo)
  console.log('  buildGitContext 现合计: ' + sStatus[0].toFixed(1) + 'ms / 迭代 (min)')
  console.log('  移除前为 ' + (sIsRepo[0] + sStatus[0]).toFixed(1) + 'ms → 每迭代省 ' +
    sIsRepo[0].toFixed(1) + 'ms（-' + Math.round(100 * sIsRepo[0] / (sIsRepo[0] + sStatus[0])) + '%）')

  // ═══ E. buildMemoryContext 的 4 次 IPC 背后的 SQLite/文件 ═══
  console.log('=== E. 记忆/会话查询的 DB 侧（buildMemoryContext 每迭代 4 次 IPC） ===')
  const MEM_N = 500
  const CONV_N = 300
  for (let i = 0; i < MEM_N; i++) saveMemory('mem' + i, '记忆条目 ' + i + '：' + fill(80), 'fact', 'general', null)
  for (let i = 0; i < CONV_N; i++) {
    const day = String((i % 28) + 1).padStart(2, '0')
    const stamp = '2026-09-' + day + 'T08:00:00.000Z'
    saveConversation({ id: 'c' + i, title: '会话 ' + i, createdAt: stamp, updatedAt: stamp, messages: [], type: 'normal' })
  }
  const mdPath = join(DATA_DIR, 'memory', 'MEMORY.md')
  mkdirSync(join(DATA_DIR, 'memory'), { recursive: true })
  writeFileSync(mdPath, '# MEMORY\\n' + fill(8000), 'utf-8')
  row('listMemories（全表 ' + MEM_N + ' 条, 无 LIMIT）', Mrow('listMemories', bench(() => listMemories(), 20)))
  row('listConversationsForMemory ×2', Mrow('listConvMem', bench(() => {
    listConversationsForMemory({ afterTime: '2026-09-19T09:59:00.000Z', beforeTime: '2026-09-20T09:59:00.000Z' })
    listConversationsForMemory({ beforeTime: '2026-09-19T09:59:00.000Z', limit: 50 })
  }, 20)))
  row('MEMORY.md readFileSync（8KB）', Mrow('readMemoryMd', bench(() => readFileSync(mdPath, 'utf-8'), 20)))
  console.log('  注：SQLite 连接常开，故无反复 open 开销；readFileSync 一行受上述环境异常影响')

  // ═══ A. stripToolResultImages — 每迭代对全历史跑一次 ═══
  console.log('=== A. stripToolResultImages（真实函数；每 loop 迭代对全历史跑一次） ===')
  const N = [50, 100, 200, 400, 800, 1600]
  for (const kind of ['text', 'json', 'image']) {
    for (const n of N) {
      const msgs = buildMessages(n, kind)
      const s = bench(() => msgs.map(stripToolResultImages), 10)
      if (n === 800 && kind === 'text') M.strip = s[0]
      console.log('  kind=' + kind.padEnd(5) + ' msgs=' + fmt(n, 5) + '  bytes≈' + fmt(kb(msgs), 6) + 'KB  min ' + s[0].toFixed(2).padStart(6) + 'ms  p50 ' + p50(s).toFixed(2).padStart(6) + 'ms')
    }
  }

  // ═══ B. 压缩管线 — 真实 ContextCompactor，每迭代一遍 ═══
  const CTX = 128000
  const compactor = new ContextCompactor({ runHistorySummary: async () => 'stub summary', getMessages: () => [] })
  const FIXED_OVERHEAD = compactor.estimateTokens([{ id: 'x', role: 'user', createdAt: AT, contentBlocks: [{ type: 'text', text: fill(18000) }] }])
  console.log('=== B. 压缩管线（真实 ContextCompactor；每 loop 迭代一遍；fixedOverhead≈' + FIXED_OVERHEAD + ' tokens, contextLength=' + CTX + '） ===')
  for (const n of N) {
    const msgs = buildMessages(n, 'text')
    const sCtx = bench(() => compactor.contextTokens(msgs, FIXED_OVERHEAD), 10)
    const sNano = bench(() => compactor.nanoCompact(msgs), 10)
    const nano = compactor.nanoCompact(msgs)
    const sLight = bench(() => compactor.lightCompact(nano, CTX, FIXED_OVERHEAD), 10)
    const light = compactor.lightCompact(nano, CTX, FIXED_OVERHEAD)
    const sHard = bench(() => compactor.hardTruncate(light, CTX, FIXED_OVERHEAD), 10)
    if (n === 800) { M.ctx = sCtx[0]; M.nano = sNano[0]; M.light = sLight[0]; M.hard = sHard[0] }
    const total = sCtx[0] + sNano[0] + sLight[0] + sHard[0]
    console.log('  msgs=' + fmt(n, 5) + '  bytes≈' + fmt(kb(msgs), 6) + 'KB  ctx ' + sCtx[0].toFixed(2) +
      ' + nano ' + sNano[0].toFixed(2) + ' + light ' + sLight[0].toFixed(2) + (light === nano ? '(早退)' : '(全路径)') +
      ' + hard ' + sHard[0].toFixed(2) + (light === nano ? '' : (sHard[0] > 1 ? '(全路径)' : '(快退)')) +
      '  = ' + total.toFixed(2) + 'ms')
  }

  // ═══ C. 日志用 JSON.stringify(body) ═══
  console.log('=== C. 日志用 JSON.stringify(body)（每 loop 迭代一次，只为一行日志） ===')
  const TOOLS = Array.from({ length: 24 }, (_, i) => ({
    name: 'tool_' + i, description: fill(600), input_schema: { type: 'object', properties: { path: { type: 'string' } } },
  }))
  for (const n of [200, 800, 1600]) {
    const msgs = buildMessages(n, 'text').map(stripToolResultImages)
    const body = { model: 'deepseek-chat', messages: msgs, tools: TOOLS, system_prompt: fill(20000), stream: true }
    const s = bench(() => JSON.stringify(body).length, 10)
    if (n === 800) M.body = s[0]
    console.log('  msgs=' + fmt(n, 5) + '  bodyLen≈' + fmt(Math.round(JSON.stringify(body).length / 1024), 6) + 'KB  min ' + s[0].toFixed(2).padStart(6) + 'ms  p50 ' + p50(s).toFixed(2).padStart(6) + 'ms')
  }

  // ═══ F. 合计 —— 用各相位的 min，避免后段 GC 污染 ═══
  const perIter = M.strip + M.ctx + M.nano + M.light + M.hard + M.body + M.gitStatus + M.listMemories + M.listConvMem
  console.log('=== F. 单次 loop 迭代固定开销合计（msgs=800 ≈' + kb(buildMessages(800, 'text')) + 'KB, MEM=' + MEM_N + ', CONV=' + CONV_N + '） ===')
  const line = (l, v, note) => console.log('  ' + l.padEnd(24) + fmt(v.toFixed(2), 8) + ' ms' + (note ? '   ' + note : ''))
  line('图片剥离', M.strip)
  line('压缩管线 合计', M.ctx + M.nano + M.light + M.hard)
  line('  其中 lightCompact', M.light, '← 唯一超线性项')
  line('日志 body 序列化', M.body)
  line('git 子进程 ×1（status）', M.gitStatus, '← 最大单项（已从 ×2 省下 ' + sIsRepo[0].toFixed(1) + 'ms/迭代）')
  line('记忆/会话 SQLite', M.listMemories + M.listConvMem)
  console.log('  ' + '─'.repeat(46))
  line('每迭代合计', perIter, '（另加 ~6 次 IPC 往返；不含 readFileSync）')
  for (const iters of [10, 30, 50]) {
    console.log('  一个 turn ' + fmt(iters, 3) + ' 次迭代  ' + fmt((perIter * iters / 1000).toFixed(2), 8) + ' s 纯固定开销')
  }

  console.log('PASS: loop-iteration cost curve captured')
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
    } }],
  })
  const run = spawnSync(require('electron'), [bundle], {
    cwd: root, stdio: 'inherit',
    env: {
      ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: join(root, 'node_modules'), PM_PERF: '1', PM_PROBE_REPO: root,
    },
  })
  if (run.error) throw run.error
  process.exitCode = run.status === 0 ? 0 : 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
