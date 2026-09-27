/**
 * Terminal limits end-to-end probe (PLAN-coding-contract P0-2, 验证门): the REAL
 * terminal service under ELECTRON_RUN_AS_NODE (temp-HOME sandboxed, guardHome).
 *
 *  1. a chatty foreground process (continuous output, past the idle timeout)
 *     is killed at the wall clock with the wall-clock death reason;
 *  2. a silent foreground process still dies at the idle timeout — the new
 *     timer did not eat the old behavior;
 *  3. svcExecSync output beyond 1MB truncates (and kills) — plan item 4b;
 *  4. an explicit timeout (3600s) does NOT raise the wall clock (ruling D2:
 *     absolute cap) — death reason = wall-clock, long before the hour;
 *  5. background processes are NOT touched by the wall clock (P0-3 #13):
 *     still alive past the cap, no timers on that path.
 *
 * The probe runs the wall clock at 5s via the service's PM_WALL_CLOCK_MAX_MS
 * seam (set BEFORE the module import; production never sets it — the shipped
 * cap is 900s, asserted by tests/coding-contract.test.ts on the source).
 *
 * Usage: node scripts/probe-terminal-limits.mjs
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = process.env.PM_REPO ?? process.cwd()

const results = []
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`)
}

function guardHome(dataDir) {
  const home = process.env.PM_HOME
  if (!home) throw new Error('PM_HOME is not set — refusing to run against the real ~/.pulsemind')
  if (!dataDir.startsWith(home)) throw new Error(`DATA_DIR outside PM_HOME — refusing`)
}

async function phaseMain() {
  // Probe seam FIRST — the service reads it once at module init.
  const WALL = 5_000
  process.env.PM_WALL_CLOCK_MAX_MS = String(WALL)
  const { svcExecuteCommand, svcExecSync, svcExecuteBackground, WALL_CLOCK_MAX_MS } = await import('../src/main/services/terminal')
  const { DATA_DIR } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)

  check('probe seam active (wall clock at 5s)', WALL_CLOCK_MAX_MS === WALL, `${WALL_CLOCK_MAX_MS}ms`)

  const sink = () => {
    const ev = { out: [], exits: [], errors: [], emit: null }
    ev.emit = {
      output: (id, type, data) => ev.out.push({ id, type, data }),
      exit: (id, code, signal) => ev.exits.push({ id, code, signal }),
      error: (id, message) => ev.errors.push({ id, message }),
    }
    return ev
  }

  // svcExecuteCommand is fire-and-forget (resolves with the processId at
  // spawn) — every case waits for the exit EVENT itself.
  const waitForExit = async (ev, ms) => {
    const start = Date.now()
    while (ev.exits.length === 0 && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 100))
    return Date.now() - start
  }

  // ① chatty foreground process → wall-clock death (not idle)
  {
    const ev = sink()
    await svcExecuteCommand('while true; do echo tick; sleep 0.2; done', undefined, 60_000, ev.emit)
    const elapsed = await waitForExit(ev, WALL + 10_000)
    const wallText = ev.out.find((o) => o.data.includes('wall-clock'))
    const idleText = ev.out.find((o) => o.data.includes('with no output'))
    check('chatty process terminated', ev.exits.length > 0, `${elapsed}ms`)
    check('death reason is the wall-clock, not idle', !!wallText && !idleText, (wallText?.data ?? '').trim())
    check('termination arrives near the wall clock (±4s)', Math.abs(elapsed - WALL) < 4_000, `${elapsed}ms vs ${WALL}ms`)
  }

  // ② silent foreground process → idle timeout still works
  {
    const ev = sink()
    await svcExecuteCommand('sleep 30', undefined, 2_000, ev.emit)
    const elapsed = await waitForExit(ev, 15_000)
    const idleText = ev.out.find((o) => o.data.includes('with no output'))
    check('silent process still dies at the idle timeout', ev.exits.length > 0 && !!idleText && elapsed < 10_000, `${elapsed}ms`)
  }

  // ③ svcExecSync output cap (#4b)
  {
    const start = Date.now()
    const result = await svcExecSync('yes pm-probe-filler', undefined, 30_000)
    const elapsed = Date.now() - start
    check('svcExecSync output truncates at 1MB', result.output.length <= 1024 * 1024 + 64 && result.output.includes('[Output limit exceeded: 1MB]'), `${result.output.length} bytes in ${elapsed}ms`)
    check('svcExecSync process was killed (did not ride the idle window)', elapsed < 20_000, `${elapsed}ms`)
  }

  // ④ explicit timeout cannot raise the wall clock (D2)
  {
    const ev = sink()
    await svcExecuteCommand('while true; do echo tick; sleep 0.2; done', undefined, 3600_000, ev.emit)
    const elapsed = await waitForExit(ev, WALL + 10_000)
    const wallText = ev.out.find((o) => o.data.includes('wall-clock'))
    check('timeout=3600s still dies at the wall clock', ev.exits.length > 0 && !!wallText, `${elapsed}ms`)
    check('…near the short wall clock, not the requested hour', elapsed < 60_000, `${elapsed}ms`)
  }

  // ⑤ background processes are immune to the wall clock (P0-3 #13)
  {
    const start = Date.now()
    const { pid } = await svcExecuteBackground('while true; do echo tick; sleep 0.2; done', undefined)
    await new Promise((r) => setTimeout(r, WALL + 3_000))
    const elapsed = Date.now() - start
    let alive = false
    try { process.kill(pid, 0); alive = true } catch { alive = false }
    check('background process outlives the wall clock', alive, `pid=${pid} after ${elapsed}ms`)
    if (alive) process.kill(pid, 'SIGKILL')
  }
}

// ── runner (probe-docx-edit recipe) ──
async function launcher() {
  const entry = process.argv[1]
  const require = createRequire(entry)
  const electronBin = require('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) throw new Error('electron binary missing — run npm install')
  const work = mkdtempSync(join(tmpdir(), 'pm-term-probe-run-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
    external: ['better-sqlite3', 'esbuild', 'playwright-core', 'chromium-bidi', 'unzipper', '@aws-sdk/client-s3', 'exceljs'],
    plugins: [{ name: 'electron-stub', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'pm-electron-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'pm-electron-stub' }, () => ({
        contents: `module.exports = { app: { isPackaged: false, getAppPath: () => ${JSON.stringify(REPO_ROOT)} } }`, loader: 'js' }))
    } }],
    logLevel: 'warning',
  })
  const home = mkdtempSync(join(tmpdir(), 'pm-home-term-'))
  const report = join(work, 'main.json')
  const res = spawnSync(electronBin, [bundle], {
    cwd: REPO_ROOT, stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PM_REPO: REPO_ROOT, PM_HOME: home, PM_REPORT: report, HOME: home, NODE_PATH: join(REPO_ROOT, 'node_modules') },
  })
  let payload = { checks: [] }
  if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
  const failed = payload.checks.filter((c) => !c.pass).length + (res.status !== 0 ? 1 : 0)
  console.log(`\n${payload.checks.length - failed}/${payload.checks.length} checks passed`)
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
}

if (process.env.ELECTRON_RUN_AS_NODE === '1') {
  phaseMain()
    .then(() => {
      if (process.env.PM_REPORT) writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }, null, 2))
      process.exit(results.every((r) => r.pass) ? 0 : 1)
    })
    .catch((err) => {
      console.error('phase failed:', err)
      if (process.env.PM_REPORT) writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }, null, 2))
      process.exit(1)
    })
} else {
  launcher()
}
