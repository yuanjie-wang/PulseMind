// ── Real-Electron probe for the hook browser primitive (ctx.browser.open) ──
//
// vitest here is stub-Electron (tests/stubs/electron.ts records loadURL /
// destroy), so this probe is the only REAL GUI evidence for the login-flow
// window: a real BrowserWindow actually opens, actually navigates, and
// actually dies. Recipe follows probe-quick-attach-electron.mjs — esbuild the
// real src/main/hook-browser.ts (electron external) into a fixture main, run
// it under Playwright's _electron with a temp userData dir (never the user's
// data), and drive main directly via electronApp.evaluate (no renderer page
// of our own — the app under test creates the windows).
//
// The login page is a LOCAL http server in the fixture main (no network, no
// dependence on any real service). Checks (~4):
//   1. open() creates exactly one real window that navigates to the URL
//   2. options honored: 700x500 bounds + title (a /hang route that never
//      responds keeps document.title from replacing the constructor title)
//   3. javascript: / file: rejected by the shared scheme gate, zero windows
//   4. close() destroys the window, isDestroyed() is true, second close idempotent
import { build } from 'esbuild'
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const WORK = mkdtempSync(join(tmpdir(), 'pm-hook-browser-'))

// Fixture main: a scratch userData, a local login page, and the REAL
// primitive bundled by esbuild below. No BrowserWindow of its own — every
// window the probe sees was made by openBuiltInWindow.
const FIXTURE_MAIN = `
const { app } = require('electron')
const http = require('node:http')
const { join } = require('node:path')

// No renderer page ever exists here, and windows close mid-probe: without a
// listener Electron's default is to QUIT on the last close.
app.on('window-all-closed', () => {})
app.setPath('userData', join(__dirname, 'ud'))

const { openBuiltInWindow } = require('./hook-browser.cjs')

app.whenReady().then(async () => {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/hang')) return // never respond: keeps the
    // constructor title in place for the options check below
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>Login Probe</title><p>login page</p>')
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = srv.address().port
  global.__open = openBuiltInWindow
  global.__loginUrl = 'http://127.0.0.1:' + port + '/login'
  global.__hangUrl = 'http://127.0.0.1:' + port + '/hang'
  global.__ready = true
})
`

await build({
  entryPoints: ['src/main/hook-browser.ts'],
  outfile: join(WORK, 'hook-browser.cjs'),
  bundle: true, minify: false, platform: 'node', target: 'node20', format: 'cjs',
  external: ['electron'], tsconfig: 'tsconfig.node.json',
})
writeFileSync(join(WORK, 'main.js'), FIXTURE_MAIN)

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

let electronApp = null
try {
  electronApp = await electron.launch({
    executablePath: require('electron'),
    args: [join(WORK, 'main.js')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  })

  // The fixture has no window, so firstWindow() would hang — poll the main
  // process itself until the local login server is listening.
  const ready = await electronApp.evaluate(async () => {
    const t0 = Date.now()
    while (!global.__ready && Date.now() - t0 < 10000) {
      await new Promise((r) => setTimeout(r, 50))
    }
    return Boolean(global.__ready)
  })
  check('fixture 就绪（本地登录页在听）', ready, ready ? undefined : '10s 内 global.__ready 未置位')

  console.log('── open()：真开窗并导航到目标 URL ──')
  const r1 = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const before = BrowserWindow.getAllWindows().length
    global.__h1 = await global.__open(global.__loginUrl)
    const wins = BrowserWindow.getAllWindows()
    const win = wins[wins.length - 1]
    // open() resolves once navigation STARTED — poll for the landed URL.
    const t0 = Date.now()
    while (win.webContents.getURL() !== global.__loginUrl && Date.now() - t0 < 10000) {
      await new Promise((r) => setTimeout(r, 50))
    }
    return {
      delta: BrowserWindow.getAllWindows().length - before,
      url: win.webContents.getURL(),
      expected: global.__loginUrl,
      destroyed: win.isDestroyed(),
      // sandbox/contextIsolation off would mean node reachable from the
      // login page — the whole point of a login WINDOW is it stays a page.
      prefs: win.webContents.getLastWebPreferences
        ? { sandbox: win.webContents.getLastWebPreferences().sandbox, contextIsolation: win.webContents.getLastWebPreferences().contextIsolation }
        : null,
    }
  })
  console.log(`  [measured] ${JSON.stringify(r1)}`)
  check('open：恰一窗，webContents.getURL() 是目标 URL',
    r1.delta === 1 && r1.url === r1.expected && !r1.destroyed,
    JSON.stringify({ delta: r1.delta, url: r1.url }))
  check('open：webPreferences 沙箱化（sandbox + contextIsolation）',
    r1.prefs === null || (r1.prefs.sandbox === true && r1.prefs.contextIsolation === true),
    r1.prefs ? JSON.stringify(r1.prefs) : 'getLastWebPreferences 不可用，跳过')

  console.log('── options：700x500 + title ──')
  const r2 = await electronApp.evaluate(async ({ BrowserWindow }) => {
    // Select the new window by ID difference: getAllWindows() order is not
    // creation order (measured — wins[last] here was the PREVIOUS window,
    // 1024x768 titled "Login Probe").
    const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id))
    global.__h2 = await global.__open(global.__hangUrl, { width: 700, height: 500, title: '登录 - PulseMind' })
    const win = BrowserWindow.getAllWindows().find((w) => !before.has(w.id))
    if (!win) return { found: false }
    return { found: true, bounds: win.getBounds(), title: win.getTitle() }
  })
  console.log(`  [measured] ${JSON.stringify(r2)}`)
  check('options：窗口尺寸 700x500',
    r2.found && r2.bounds.width === 700 && r2.bounds.height === 500, JSON.stringify(r2))
  check('options：title 落到窗口标题',
    r2.found && r2.title === '登录 - PulseMind', JSON.stringify(r2))

  console.log('── 非法 scheme：共享门禁拒绝且不开窗 ──')
  const r3 = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const before = BrowserWindow.getAllWindows().length
    const attempts = []
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd']) {
      try {
        await global.__open(url)
        attempts.push({ url, threw: false, msg: '' })
      } catch (err) {
        attempts.push({ url, threw: true, msg: String((err && err.message) || err) })
      }
    }
    return { attempts, delta: BrowserWindow.getAllWindows().length - before }
  })
  console.log(`  [measured] ${JSON.stringify(r3)}`)
  check('非法 scheme 抛错（javascript:/file:）',
    r3.attempts.length === 2 && r3.attempts.every((a) => a.threw),
    JSON.stringify(r3.attempts))
  check('非法 scheme 零新窗（门在建窗之前）', r3.delta === 0, `delta=${r3.delta}`)

  console.log('── close()：destroy 语义 + 幂等 ──')
  const r4 = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id))
    const h = await global.__open(global.__loginUrl)
    const win = BrowserWindow.getAllWindows().find((w) => !before.has(w.id))
    if (!win) return { found: false, secondClose: 'n/a' }
    const id = win.id
    await h.close()
    const gone = win.isDestroyed()
    let secondClose = 'resolved'
    try { await h.close() } catch { secondClose = 'threw' }
    const listed = BrowserWindow.getAllWindows().some((w) => w.id === id)
    return { found: true, gone, secondClose, listed }
  })
  console.log(`  [measured] ${JSON.stringify(r4)}`)
  check('close() 后 isDestroyed() 为真且不再在窗口列表',
    r4.found && r4.gone && !r4.listed, JSON.stringify(r4))
  check('close() 幂等（二次调用仍 resolve）', r4.found && r4.secondClose === 'resolved', r4.secondClose)

  // Shut the two probe windows before exiting (the /hang one never loaded).
  await electronApp.evaluate(async () => {
    if (global.__h1) await global.__h1.close()
    if (global.__h2) await global.__h2.close()
  })
} catch (err) {
  check('探针完整跑完（未抛异常）', false, err && err.message ? err.message : String(err))
} finally {
  if (electronApp) await electronApp.close().catch(() => {})
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed  (work dir: ${WORK})`)
process.exit(failed.length ? 1 : 0)
