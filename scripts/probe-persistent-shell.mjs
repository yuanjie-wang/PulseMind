/**
 * Persistent shell end-to-end probe (review P0-1, 2026-10-28): the REAL
 * terminal service under ELECTRON_RUN_AS_NODE (temp-HOME sandboxed, guardHome),
 * driven inside a session sandbox context the way the agent host drives it.
 *
 * Acceptance from the review, verbatim:
 *   A. three consecutive commands keep the cwd after a `cd`;
 *   B. `export FOO=1` is visible to the next command;
 *   (C. the existing suite does not regress — npm test, outside this probe.)
 *
 * Plus the side-effect list from the design pass:
 *   routing (no session / Windows-style kill switch → per-command spawn),
 *   exit codes, `exit` → rebuild at the same cwd with env gone (+ notice),
 *   stdin pinned (`cat` returns), idle / wall-clock / 1MB cap keep their
 *   notices and rebuild, kill button, serialization within one engine vs
 *   parallelism across engines (shell keys), cwd isolation across engines,
 *   large-output integrity (no loss to the fd-3 drain race), UTF-8, a cwd-less
 *   background command inheriting the shell's cwd, session reap killing every
 *   shell of the session and clearing the cwd memory.
 *
 * Wall clock runs at 3s via PM_WALL_CLOCK_MAX_MS (set BEFORE the import).
 *
 * Usage: node scripts/probe-persistent-shell.mjs
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  if (!dataDir.startsWith(home)) throw new Error('DATA_DIR outside PM_HOME — refusing')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function phaseMain() {
  const WALL = 3_000
  process.env.PM_WALL_CLOCK_MAX_MS = String(WALL)
  const { svcExecuteCommand, svcExecuteBackground, svcKillCommand, svcReapSessionShells, WALL_CLOCK_MAX_MS } = await import('../src/main/services/terminal')
  const { sessionSandbox } = await import('../src/main/sandbox/session-context')
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  // The real startup sequence (main/index.ts): ensureDataDir → initializeDatabase —
  // every exec writes an audit row, so the store must be live.
  ensureDataDir()
  const { initializeDatabase } = await import('../src/main/storage/database')
  await initializeDatabase()
  check('probe seam active (wall clock at 3s)', WALL_CLOCK_MAX_MS === WALL, `${WALL_CLOCK_MAX_MS}ms`)

  // macOS: tmpdir() is /var/… → /private/var/…. A shell SPAWNED at a path
  // reports getcwd() (physical) while `cd` keeps the logical spelling, so every
  // path comparison goes through realpath. Production paths are not symlinked;
  // the model sees whatever `pwd` prints either way.
  const rp = (p) => { try { return realpathSync(p) } catch { return p } }
  const samePath = (a, b) => rp(a) === rp(b)

  const ws = mkdtempSync(join(process.env.PM_HOME, 'ws-'))
  mkdirSync(join(ws, 'sub'))
  mkdirSync(join(ws, 'other'))
  const sessionId = 'probe-session'
  const ctx = { sessionId, workspaceDir: ws, execAllowlist: new Set(), backgroundPids: new Set() }

  // One sink per command; the run helper resolves on the exit EVENT (the
  // service resolves with the processId as soon as the command is on the wire).
  function run(command, { key = 'conv-P', cwd, timeoutMs, session = true, noWait = false } = {}) {
    const ev = { stdout: '', stderr: '', exit: null, error: null, processId: null, startedAt: Date.now(), exitedAt: null }
    const emit = {
      output: (id, type, data) => { if (type === 'stdout') ev.stdout += data; else ev.stderr += data },
      exit: (id, code, signal) => { ev.exit = { code, signal }; ev.exitedAt = Date.now() },
      error: (id, message) => { ev.error = message },
    }
    const call = () => svcExecuteCommand(command, cwd, timeoutMs, emit, key)
    const started = session ? sessionSandbox.run(ctx, call) : call()
    ev.done = (async () => {
      ev.processId = await started
      if (noWait) return ev
      const deadline = Date.now() + 30_000
      while (!ev.exit && Date.now() < deadline) await sleep(20)
      return ev
    })()
    ev.waitExit = async (ms = 30_000) => {
      const deadline = Date.now() + ms
      while (!ev.exit && Date.now() < deadline) await sleep(20)
      return ev
    }
    return ev
  }
  const out = (ev) => ev.stdout.trim()

  // ── A/B: the review's acceptance ──
  console.log('\n[acceptance]')
  {
    const a = await run(`cd ${JSON.stringify(join(ws, 'sub'))}`).done
    const b = await run('pwd').done
    const c = await run('pwd').done
    check('A. cd persists into the 2nd command', a.exit?.code === 0 && out(b) === join(ws, 'sub'), out(b))
    check('A. …and the 3rd (three consecutive commands)', out(c) === join(ws, 'sub'), out(c))
    const d = await run('export PM_PROBE_FOO=1').done
    const e = await run('echo "foo=$PM_PROBE_FOO"').done
    check('B. export persists into the next command', d.exit?.code === 0 && out(e) === 'foo=1', out(e))
    check('B. a plain completion carries no restart notice', !e.stderr.includes('session shell'), JSON.stringify(e.stderr))
  }

  // ── routing ──
  console.log('\n[routing]')
  {
    const a = await run(`cd ${JSON.stringify(join(ws, 'other'))}`, { session: false }).done
    const b = await run('pwd', { session: false }).done
    check('no session → per-command spawn: cd does NOT persist (cwd = HOME default)', a.exit?.code === 0 && samePath(out(b), process.env.PM_HOME), out(b))
    process.env.PM_PERSISTENT_SHELL = '0'
    const c = await run(`cd ${JSON.stringify(join(ws, 'other'))}`, { key: 'conv-KS' }).done
    const d = await run('pwd', { key: 'conv-KS' }).done
    delete process.env.PM_PERSISTENT_SHELL
    check('PM_PERSISTENT_SHELL=0 → per-command spawn even inside a session (cwd = workspace)', c.exit?.code === 0 && samePath(out(d), ws), out(d))
    const e = await run('pwd').done
    check('the persistent shell of conv-P was untouched by both', out(e) === join(ws, 'sub'), out(e))
  }

  // ── exit codes / explicit cwd / rebuild ──
  console.log('\n[exit codes · cwd param · rebuild]')
  {
    const a = await run('false').done
    check('non-zero exit code is reported (false → 1)', a.exit?.code === 1 && a.exit.signal === null, JSON.stringify(a.exit))
    const b = await run('pwd', { cwd: join(ws, 'other') }).done
    const c = await run('pwd').done
    check('explicit cwd runs there AND moves the shell for good', out(b) === join(ws, 'other') && out(c) === join(ws, 'other'), `${out(b)} / ${out(c)}`)
    // Outside the workspace on purpose: a missing cwd INSIDE it is materialized
    // by ensureWorkspaceCwd (the per-command path did the same) and would run.
    const d = await run('echo RAN', { cwd: '/nonexistent-pm-probe/dir' }).done
    check('bad explicit cwd (outside the workspace) → exit 1, command not run, cd error on stderr', d.exit?.code === 1 && !d.stdout.includes('RAN') && /No such file/.test(d.stderr), JSON.stringify(d.stderr.trim()))
    const d2 = await run('pwd', { cwd: join(ws, 'fresh', 'deep') }).done
    check('a missing cwd INSIDE the workspace is materialized and used (ensureWorkspaceCwd parity)', d2.exit?.code === 0 && samePath(out(d2), join(ws, 'fresh', 'deep')), out(d2))
    await run(`cd ${JSON.stringify(join(ws, 'sub'))} && export PM_PROBE_FOO=1`).done
    const e = await run('exit 7').done
    check('`exit 7` → code 7 + restart notice naming the code', e.exit?.code === 7 && e.stderr.includes('exited (code=7)'), JSON.stringify(e.stderr.trim()))
    const f = await run('pwd; echo "foo=[$PM_PROBE_FOO]"').done
    const fl = out(f).split('\n')
    check('rebuild resumes at the last cwd, exported env is gone', samePath(fl[0], join(ws, 'sub')) && fl[1] === 'foo=[]', JSON.stringify(out(f)))
  }

  // ── stdin pinned ──
  console.log('\n[stdin]')
  {
    const a = await run('cat; echo after', { timeoutMs: 5_000 }).done
    check('`cat` returns at once (stdin = /dev/null), not by idle timeout', a.exit?.code === 0 && out(a) === 'after' && a.exitedAt - a.startedAt < 2_000, `${a.exitedAt - a.startedAt}ms`)
  }

  // ── timers / kill / cap ──
  console.log('\n[idle · wall · kill · cap]')
  {
    const a = await run('sleep 30', { timeoutMs: 1_200 }).done
    const dt = a.exitedAt - a.startedAt
    check('idle timeout kills a silent command with the idle notice', a.exit?.code === null && a.exit.signal === 'SIGTERM' && a.stderr.includes('with no output'), `${dt}ms`)
    check('…near the idle window, with the restart notice', dt < 5_000 && a.stderr.includes('was restarted'), `${dt}ms`)
    const b = await run('pwd').done
    check('next command rebuilds the shell at the same cwd', samePath(out(b), join(ws, 'sub')), out(b))

    const c = await run('while true; do echo tick; sleep 0.2; done', { timeoutMs: 60_000 }).done
    const dtc = c.exitedAt - c.startedAt
    check('chatty command dies at the wall clock (SIGKILL, wall notice, not idle)', c.exit?.code === null && c.exit.signal === 'SIGKILL' && c.stderr.includes('wall-clock') && !c.stderr.includes('with no output'), `${dtc}ms`)
    check('…near 3s', Math.abs(dtc - WALL) < 2_500, `${dtc}ms vs ${WALL}ms`)
    check('…its output streamed before death', c.stdout.includes('tick'), `${c.stdout.length} bytes`)

    const d = run('sleep 30', { timeoutMs: 60_000, noWait: true })
    await d.done
    await sleep(150)
    svcKillCommand(d.processId)
    await d.waitExit(5_000)
    check('svcKillCommand(processId) kills the in-flight command (code null, SIGTERM)', d.exit?.code === null && d.exit.signal === 'SIGTERM', JSON.stringify(d.exit))
    const e = await run('echo alive').done
    check('…and the shell comes back for the next command', out(e) === 'alive', out(e))

    const f = await run('yes pm-probe-filler', { timeoutMs: 30_000 }).done
    check('1MB cap: killed with the cap notice, kept head ≤ 1MB', f.stderr.includes('Output limit exceeded: 1MB') && f.stdout.length <= 1024 * 1024 && f.stdout.length > 500_000, `${f.stdout.length} bytes`)
    const g = await run('echo alive2').done
    check('…shell rebuilt after the cap kill', out(g) === 'alive2', out(g))
  }

  // ── serialization within an engine, parallelism across engines ──
  console.log('\n[serialization · isolation]')
  {
    const a = run('sleep 0.7; echo A', { noWait: true })
    const b = run('echo B', { noWait: true })
    await Promise.all([a.done, b.done])
    await Promise.all([a.waitExit(), b.waitExit()])
    check('same engine: the 2nd command waits for the 1st (B exits after A)', a.exit?.code === 0 && b.exit?.code === 0 && b.exitedAt >= a.exitedAt, `A@${a.exitedAt - a.startedAt}ms B@${b.exitedAt - b.startedAt}ms`)
    check('…and the pids differ (per-command processId facade)', a.processId !== b.processId)

    const p = run('sleep 0.7; echo P', { key: 'conv-P', noWait: true })
    const s = run('echo S', { key: 'sub-S', noWait: true })
    await Promise.all([p.done, s.done])
    await Promise.all([p.waitExit(), s.waitExit()])
    check('different engines run in parallel (sub-agent S exits before parent P)', s.exit?.code === 0 && p.exit?.code === 0 && s.exitedAt < p.exitedAt, `P@${p.exitedAt - p.startedAt}ms S@${s.exitedAt - s.startedAt}ms`)
    const sp = await run('pwd', { key: 'sub-S' }).done
    const pp = await run('pwd', { key: 'conv-P' }).done
    check('cwd is per engine: the sub-agent starts at the workspace, the parent is still in sub/', samePath(out(sp), ws) && samePath(out(pp), join(ws, 'sub')), `${out(sp)} / ${out(pp)}`)
  }

  // ── data integrity ──
  console.log('\n[integrity]')
  {
    const a = await run('seq 1 100000').done
    const expected = Array.from({ length: 100000 }, (_, i) => String(i + 1)).join('\n') + '\n'
    check('large output arrives whole (no loss to the fd-3 / stdout read race)', a.exit?.code === 0 && a.stdout === expected, `${a.stdout.length} bytes vs ${expected.length}`)
    const b = await run("printf '中文→ok\\n'; printf 'err→\\n' 1>&2").done
    check('UTF-8 is intact on both streams', out(b) === '中文→ok' && b.stderr.trim() === 'err→', JSON.stringify([out(b), b.stderr.trim()]))
    const c = await run('echo one; sleep 0.3; echo two').done
    check('streaming across a pause stays ordered', out(c) === 'one\ntwo', JSON.stringify(out(c)))
  }

  // ── background inherits the shell cwd ──
  console.log('\n[background]')
  {
    const logDir = join(DATA_DIR, 'tmp', 'proc-logs')
    const readLog = async (pid) => {
      const p = join(logDir, `${pid}.log`)
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        if (existsSync(p) && readFileSync(p, 'utf8').includes('[exited')) return readFileSync(p, 'utf8')
        await sleep(30)
      }
      return existsSync(p) ? readFileSync(p, 'utf8') : ''
    }
    const logCwd = (log) => (log.trim().split('\n')[1] ?? '')
    const bg = await sessionSandbox.run(ctx, () => svcExecuteBackground('pwd', undefined, 'conv-P'))
    const log = await readLog(bg.pid)
    check('cwd-less background command starts where the engine shell is (sub/)', samePath(logCwd(log), join(ws, 'sub')) && log.includes('[exited code=0]'), JSON.stringify(logCwd(log)))
    const bg2 = await sessionSandbox.run(ctx, () => svcExecuteBackground('pwd', join(ws, 'other'), 'conv-P'))
    const log2 = await readLog(bg2.pid)
    check('explicit cwd still wins for background', samePath(logCwd(log2), join(ws, 'other')), JSON.stringify(logCwd(log2)))
    const bg3 = await sessionSandbox.run(ctx, () => svcExecuteBackground('pwd', undefined, 'conv-NEVER'))
    const log3 = await readLog(bg3.pid)
    check('an engine whose shell never ran falls back to the workspace', samePath(logCwd(log3), ws), JSON.stringify(logCwd(log3)))
  }

  // ── reap ──
  console.log('\n[reap]')
  {
    const p = await run('echo $$', { key: 'conv-P' }).done
    const s = await run('echo $$', { key: 'sub-S' }).done
    const pidP = Number(out(p)); const pidS = Number(out(s))
    const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
    check('both engine shells are alive before the reap', pidP > 0 && pidS > 0 && alive(pidP) && alive(pidS), `${pidP} ${pidS}`)
    svcReapSessionShells(sessionId)
    const deadline = Date.now() + 4_000
    while ((alive(pidP) || alive(pidS)) && Date.now() < deadline) await sleep(30)
    check('svcReapSessionShells kills the parent AND the sub-agent shell', !alive(pidP) && !alive(pidS))
    const q = await run('pwd', { key: 'conv-P' }).done
    check('after the reap a new command rebuilds at the WORKSPACE (cwd memory cleared)', samePath(out(q), ws), out(q))
    const q2 = await run('echo $$', { key: 'conv-P' }).done
    svcReapSessionShells(sessionId)
    await sleep(300)
    check('…and that fresh shell is a different process', Number(out(q2)) !== pidP && Number(out(q2)) > 0, out(q2))
  }

  rmSync(ws, { recursive: true, force: true })
}

// ── runner (probe-terminal-limits recipe) ──
async function launcher() {
  const entry = process.argv[1]
  const require = createRequire(entry)
  const electronBin = require('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) throw new Error('electron binary missing — run npm install')
  const work = mkdtempSync(join(tmpdir(), 'pm-pshell-probe-run-'))
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
  const home = mkdtempSync(join(tmpdir(), 'pm-home-pshell-'))
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
