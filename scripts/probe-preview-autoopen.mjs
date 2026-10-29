/**
 * HTML preview auto-open — does the sandboxed local-file: iframe deliver the
 * file when it is mounted the instant a write lands?
 *
 * User report (2026-10-29): 生成 html 后自动打开侧边窗口预览总是白屏，重启后
 * 就好了. The HtmlPreview iframe paints its own `background:#fff`, so a white
 * pane means the frame mounted and its navigation delivered nothing. The
 * auto-open shape differs from a post-restart click in exactly one way: the
 * iframe is mounted in the same event turn the write completes, and then
 * remounted (key flip) on every follow-up write of the same file. This probe
 * replays those shapes against the REAL protocol handler (serve-preview.ts
 * bundled verbatim), the REAL url constructor (localFileUrl), the REAL
 * renderer CSP (index.html), the exact iframe attributes HtmlPreview ships,
 * and the real generated file with its Chinese name.
 *
 * Usage: node scripts/probe-preview-autoopen.mjs
 */
import { _electron as electron } from 'playwright-core'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const require = createRequire(import.meta.url)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = mkdtempSync(join(tmpdir(), 'pm-preview-autoopen-'))

// ── 1. real modules, bundled ──
await build({
  entryPoints: [join(REPO_ROOT, 'src/main/preview/serve-preview.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  outfile: join(WORK, 'serve-preview.cjs'), logLevel: 'silent',
})
await build({
  entryPoints: [join(REPO_ROOT, 'src/shared/preview/local-file-url.ts')],
  bundle: true, platform: 'browser', format: 'iife', globalName: 'PmLocalFileUrl',
  outfile: join(WORK, 'local-file-url.js'), logLevel: 'silent',
})

// ── 2. the REAL index.html with the module entry swapped for the harness ──
const indexHtml = readFileSync(join(REPO_ROOT, 'src/renderer/index.html'), 'utf-8')
const pageHtml = indexHtml.replace(
  /<script type="module" src="\.\/src\/main\.tsx"><\/script>/,
  `<script src="./local-file-url.js"></script><script src="./harness.js"></script>`,
)
if (pageHtml === indexHtml) { console.error('FAIL  no main.tsx entry in index.html'); process.exit(1) }
writeFileSync(join(WORK, 'index.html'), pageHtml)
copyFileSync(join(REPO_ROOT, 'src/renderer/public/platform-boot.js'), join(WORK, 'platform-boot.js'))

// Harness: mount/unmount iframes the way HtmlPreview does. Each slot is a
// 400×500 box; the iframe carries HtmlPreview's exact attributes.
writeFileSync(join(WORK, 'harness.js'), `
;(function () {
  var loads = {}
  window.__loads = loads
  window.pmMount = function (slot, url, key) {
    var box = document.getElementById(slot)
    if (!box) {
      box = document.createElement('div')
      box.id = slot
      box.style.cssText = 'display:inline-block;width:400px;height:500px;overflow:hidden;border:1px solid #999;margin:4px;vertical-align:top'
      document.body.appendChild(box)
    }
    box.innerHTML = ''
    var f = document.createElement('iframe')
    f.name = ':r' + slot + key + ':'
    f.setAttribute('sandbox', 'allow-scripts')
    f.title = 'preview'
    f.style.cssText = 'display:block;width:100%;height:100%;border:none;background:#fff;zoom:1'
    f.addEventListener('load', function () { loads[slot + ':' + key] = true })
    f.src = url
    box.appendChild(f)
    return f.name
  }
  window.pmUnmount = function (slot) {
    var box = document.getElementById(slot)
    if (box) box.innerHTML = '<div style="padding:24px;text-align:center;font-size:12px">…</div>'
  }
  window.__ready = true
})()
`)

// ── 3. fixture main: protocol wired EXACTLY like src/main/index.ts ──
writeFileSync(join(WORK, 'main.js'), `
const { app, BrowserWindow, protocol } = require('electron')
const { join } = require('node:path')
const { serveLocalFile } = require('./serve-preview.cjs')
app.setPath('userData', join(__dirname, 'ud'))
app.whenReady().then(() => {
  protocol.handle('local-file', (request) => serveLocalFile(request))
  const win = new BrowserWindow({
    width: 1300, height: 600, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false },
  })
  if (process.env.PM_PROBE_URL) win.loadURL(process.env.PM_PROBE_URL)
  else win.loadFile(join(__dirname, 'index.html'))
})
`)
// Dev mode (the user's failing runs): the renderer is served by Vite over
// http://localhost — load the same harness from an http origin.
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8' }
const httpServer = createServer((req, res) => {
  const p = join(WORK, req.url === '/' ? 'index.html' : req.url.split('?')[0])
  try { const b = readFileSync(p); res.writeHead(200, { 'content-type': MIME[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream' }); res.end(b) }
  catch { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => httpServer.listen(0, '127.0.0.1', r))
const HTTP_ORIGIN = `http://127.0.0.1:${httpServer.address().port}/`
const ORIGIN_MODE = process.argv.includes('--file') ? 'file' : 'http'
const ORIGIN_HOST = process.argv.includes('--localhost') ? 'localhost' : '127.0.0.1'
const PICKED_ORIGIN = ORIGIN_MODE === 'http' ? HTTP_ORIGIN.replace('127.0.0.1', ORIGIN_HOST) : 'file://'
console.log(`origin: ${PICKED_ORIGIN}`)

// ── 4. fixtures ──
const REAL = join(homedir(), '.pulsemind/workspace/20261029000035/金融九问-一页纸精华.html')
const realBytes = existsSync(REAL) ? readFileSync(REAL, 'utf-8') : null
const synthetic = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>探针页</title>
<style>body{margin:0;padding:24px;font-family:sans-serif;background:#fff}h1{color:#c7000b}</style></head>
<body><h1>金融九问 · 探针</h1>${'<p>段落内容，用于确认帧确实渲染了文档正文。</p>'.repeat(40)}</body></html>`
const WS = join(WORK, 'workspace', '20261029000035')
mkdirSync(WS, { recursive: true })
const cnPath = join(WS, '金融九问-一页纸精华.html')
const asciiPath = join(WS, 'report.html')
const writeLikeTool = (p, text) => writeFileSync(p, text, { mode: 0o600 })

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let electronApp = null
try {
  electronApp = await electron.launch({
    executablePath: require('electron'),
    args: [join(WORK, 'main.js')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', ...(ORIGIN_MODE === 'http' ? { PM_PROBE_URL: HTTP_ORIGIN } : {}) },
  })
  const page = await electronApp.firstWindow()
  page.setDefaultTimeout(20000)
  page.on('pageerror', (err) => console.log('  [page error]', err.message))
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text()) })
  await page.waitForFunction(() => window.__ready === true)

  const url = (p) => page.evaluate((pp) => window.PmLocalFileUrl.localFileUrl(pp), p)

  // Read the frame's body through the MAIN process channel — the same
  // WebFrameMain.executeJavaScript route measurePreviewFrame uses, so a
  // failure here is also a failure of the zoom/fit channel.
  const bodyViaMain = (frameName) => electronApp.evaluate(async ({ BrowserWindow }, name) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents
    const find = (fr) => { if (fr.name === name) return fr; for (const c of fr.frames) { const h = find(c); if (h) return h } }
    const fr = find(wc.mainFrame)
    if (!fr) return { found: false }
    try {
      const raw = await fr.executeJavaScript('JSON.stringify({u:location.href,t:document.title,n:document.body?document.body.innerText.length:-1,rs:document.readyState})', false)
      return { found: true, ...JSON.parse(raw) }
    } catch (e) { return { found: true, error: String(e && e.message || e) } }
  }, frameName)

  const settle = async (frameName, slot, key) => {
    for (let i = 0; i < 30; i++) {
      const r = await bodyViaMain(frameName)
      if (r.found && r.rs === 'complete' && r.n > 0) return r
      await sleep(100)
    }
    const r = await bodyViaMain(frameName)
    r.loadFired = await page.evaluate(([s, k]) => !!window.__loads[s + ':' + k], [slot, key])
    return r
  }

  // S1 — auto-open shape: file lands, iframe mounts in the next turn.
  writeLikeTool(cnPath, synthetic)
  const u1 = await url(cnPath)
  const n1 = await page.evaluate(([u]) => window.pmMount('s1', u, 1), [u1])
  const r1 = await settle(n1, 's1', 1)
  check('S1 auto-open (Chinese name, mount right after write) delivers the document', r1.n > 100, JSON.stringify(r1))

  // S2 — follow-up writes: the model rewrote the file 7× in 80s; each one
  // flips PreviewContent to loading (iframe unmounts) then remounts with a
  // new key once the re-read lands.
  let n2 = null
  for (let k = 1; k <= 4; k++) {
    writeLikeTool(cnPath, synthetic.replace('探针页', `探针页 v${k}`))
    await page.evaluate(() => window.pmUnmount('s2'))
    await sleep(30)
    n2 = await page.evaluate(([u, kk]) => window.pmMount('s2', u, kk), [u1, k])
    await sleep(60)
  }
  const r2 = await settle(n2, 's2', 4)
  check('S2 remount storm (4 rewrites, unmount/remount each) ends on a delivered document', r2.n > 100 && r2.t === '探针页 v4', JSON.stringify(r2))

  // S3 — restart shape (control): file existed for a while, mount later.
  writeLikeTool(asciiPath, synthetic)
  await sleep(1500)
  const u3 = await url(asciiPath)
  const n3 = await page.evaluate(([u]) => window.pmMount('s3', u, 1), [u3])
  const r3 = await settle(n3, 's3', 1)
  check('S3 control (ASCII name, mount 1.5s after write) delivers the document', r3.n > 100, JSON.stringify(r3))

  // S4 — the real file at its real path (read-only), real bytes.
  if (realBytes) {
    const u4 = await url(REAL)
    const n4 = await page.evaluate(([u]) => window.pmMount('s4', u, 1), [u4])
    const r4 = await settle(n4, 's4', 1)
    check('S4 real 金融九问 file at its real path delivers the document', r4.n > 100, JSON.stringify(r4).slice(0, 300))
  } else {
    console.log('  skip  S4 — real file not present')
  }

  // S5 — HtmlPreview's mount effect fires measurePreviewFrame(centerX) the
  // moment the iframe is in the DOM (navigation not yet committed), and again
  // on load. Replay that: mount, then IMMEDIATELY run the main-side script
  // against the still-navigating frame, several times, then check delivery.
  const parkScript = `(() => { const el = document.documentElement; const over = el.scrollWidth - el.clientWidth; if (over > 0) el.scrollLeft = over / 2; return JSON.stringify({ w: el.scrollWidth, h: el.scrollHeight }) })()`
  const measureNow = (frameName) => electronApp.evaluate(async ({ BrowserWindow }, [name, script]) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents
    const find = (fr) => { if (fr.name === name) return fr; for (const c of fr.frames) { const h = find(c); if (h) return h } }
    const fr = find(wc.mainFrame)
    if (!fr) return 'no-frame'
    try { return await fr.executeJavaScript(script, false) } catch (e) { return 'err:' + String(e && e.message || e) }
  }, [frameName, parkScript])
  writeLikeTool(join(WS, 'measured.html'), synthetic.replace('探针页', '探针页 measured'))
  const u5 = await url(join(WS, 'measured.html'))
  const n5 = await page.evaluate(([u]) => window.pmMount('s5', u, 1), [u5])
  const early = []
  for (let i = 0; i < 6; i++) { early.push(await measureNow(n5)); await sleep(5) }
  const r5 = await settle(n5, 's5', 1)
  const late = await measureNow(n5)
  check('S5 main-side executeJavaScript during navigation does not blank the frame', r5.n > 100 && r5.t === '探针页 measured', `early=${JSON.stringify(early)} late=${JSON.stringify(late)} final=${JSON.stringify(r5)}`)

  await sleep(500)
  const shot = join(WORK, 'shot.png')
  await page.screenshot({ path: shot })
  console.log(`  screenshot: ${shot}`)
} catch (err) {
  check('probe run to completion', false, String((err && err.stack) || err).slice(0, 600))
} finally {
  if (electronApp) await electronApp.close().catch(() => {})
  httpServer.close()
}

const failed = results.filter((x) => !x.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
