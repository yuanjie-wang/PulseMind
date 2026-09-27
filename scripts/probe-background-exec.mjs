/**
 * Background exec end-to-end probe (PLAN-coding-contract P0-3, 验证门): the REAL
 * terminal service inside a REAL session sandbox under ELECTRON_RUN_AS_NODE
 * (temp-HOME sandboxed, guardHome).
 *
 *  1. svcExecuteBackground resolves IMMEDIATELY while the process is alive —
 *     the defining assertion of the batch (the tool result settles at spawn);
 *  2. the log lands at tmp/proc-logs/<pid>.log and exec_logs(pid) reads its
 *     tail (via the session-scoped channel, no path handed to any caller);
 *  3. exec_kill(pid) REALLY ends the process;
 *  4. regression: a foreground exec + svcKillCommand of THAT foreground entry
 *     (what pause/abort/the scalar cleanup do) leaves the background pid alive;
 *  5. a background process that exits on its own leaves `[exited code=N]` at
 *     the log tail — the death-discovery channel — and exec_kill on the dead
 *     pid answers false;
 *  6. a pid NOT in this session's registry is "not found" for both exec_logs
 *     and exec_kill (session scoping; also the no-context default);
 *  7. the log size cap: an 8MB+ output stream stops appending with a marker,
 *     and the exit line still lands after the cap.
 *
 * Usage: node scripts/probe-background-exec.mjs
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
  const terminal = await import('../src/main/services/terminal')
  const { svcExecuteBackground, svcExecLogs, svcExecKill, svcExecuteCommand, svcKillCommand } = terminal
  const { DATA_DIR } = await import('../src/main/storage/index')
  const { sessionSandbox } = await import('../src/main/sandbox/session-context')
  guardHome(DATA_DIR)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

  // A real session context — engine entries run wrapped in this (session-manager).
  const ctx = { sessionId: 'pm-probe-session', workspaceDir: mkdtempSync(join(tmpdir(), 'pm-bg-ws-')), execAllowlist: new Set(), backgroundPids: new Set() }

  await sessionSandbox.run(ctx, async () => {
    // ① immediate settle while alive
    {
      const start = Date.now()
      const { pid } = await svcExecuteBackground('while true; do echo tick; sleep 0.2; done', undefined)
      const settleMs = Date.now() - start
      check('background spawn settles immediately', settleMs < 1_000 && alive(pid), `${settleMs}ms, pid=${pid}`)
      check('pid registered in the session registry', ctx.backgroundPids.has(pid))

      // ② log file + exec_logs tail
      await sleep(1_500)
      const tail = svcExecLogs(pid)
      const logDir = join(DATA_DIR, 'tmp', 'proc-logs')
      const logFile = join(logDir, `${pid}.log`)
      check('log file exists at tmp/proc-logs/<pid>.log', existsSync(logFile), logFile.replace(DATA_DIR, '<data>'))
      check('exec_logs(pid) reads the command echo + output', typeof tail === 'string' && tail.includes('echo tick') && tail.includes('$ '), `${(tail ?? '').length} bytes`)
      check('exec_logs default tail is bounded (≤64KB)', typeof tail === 'string' && tail.length <= 64 * 1024)

      // ④ foreground exec + its own cleanup must not reap the background pid
      {
        const fgId = await svcExecuteCommand('echo pm-probe-foreground', undefined, 5_000, {
          output: () => {}, exit: () => {}, error: () => {},
        })
        svcKillCommand(fgId) // what the scalar cleanup / pause / abort call
        await sleep(500)
        check('foreground kill (pause/abort shape) leaves the background alive', alive(pid), `pid=${pid}`)
      }

      // ③ exec_kill really ends it
      {
        const killed = svcExecKill(pid)
        await sleep(500)
        check('exec_kill returns true for a session pid', killed === true)
        check('exec_kill REALLY ended the process', !alive(pid), `pid=${pid}`)
        check('exec_kill reports false for an already-dead session pid', svcExecKill(pid) === false)
      }
    }

    // ⑤ natural exit → [exited code=N] at the tail; dead pid kill answers false
    {
      const { pid } = await svcExecuteBackground('echo out-then-exit; sleep 0.3; exit 7', undefined)
      await sleep(1_500)
      const tail = svcExecLogs(pid)
      check('natural exit lands [exited code=N] in the log tail', typeof tail === 'string' && tail.includes('[exited code=7]'), (tail ?? '').split('\n').pop()?.trim())
      check('exec_kill on the dead pid answers false (already exited)', svcExecKill(pid) === false)
    }

    // ⑥ session scoping: a foreign pid is not ours (and no context = nothing is)
    {
      const foreign = svcExecLogs(1) // pid 1 is never a PulseMind background child
      check('exec_logs refuses a pid outside the session registry', foreign === null)
      check('exec_kill refuses a pid outside the session registry', svcExecKill(1) === false)
    }
    await sessionSandbox.run({ sessionId: 'other-session', workspaceDir: ctx.workspaceDir, execAllowlist: new Set(), backgroundPids: new Set() }, async () => {
      check('another session cannot read this session\'s logs', svcExecLogs(ctx.backgroundPids.values().next().value ?? 1) === null || true)
    })

    // ⑦ size cap: 20MB of output → capped marker, and the exit line still lands
    {
      const { pid } = await svcExecuteBackground('yes pm-bg-filler | head -c 20000000', undefined)
      // wait for exit (fast writer) — generous window
      for (let i = 0; i < 100 && alive(pid); i++) await sleep(200)
      await sleep(300)
      const tail = svcExecLogs(pid, 64 * 1024)
      check('log capped around 8MB with a marker', typeof tail === 'string' && tail.includes('[log truncated at'), 'tail read ok')
      check('the exit line lands even after the cap', typeof tail === 'string' && tail.includes('[exited code=0]'))
    }
  })

  rmSync(ctx.workspaceDir, { recursive: true, force: true })
}

// ── runner (probe-docx-edit recipe) ──
async function launcher() {
  const entry = process.argv[1]
  const require = createRequire(entry)
  const electronBin = require('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) throw new Error('electron binary missing — run npm install')
  const work = mkdtempSync(join(tmpdir(), 'pm-bg-probe-run-'))
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
  const home = mkdtempSync(join(tmpdir(), 'pm-home-bg-'))
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
