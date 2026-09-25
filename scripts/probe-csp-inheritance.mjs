/**
 * CSP inheritance under the REAL renderer policy (review 2026-09-25 P1,
 * item 7: `script-src` loses 'unsafe-inline').
 *
 * The migration of three faces — the index.html boot script (→ external
 * platform-boot.js), the HTML artifact cards and the tool-studio previews
 * (both → `local-file:` URLs over tmp copies) — rests on claims about CSP
 * inheritance that reading the spec suggests but only a real Chromium can
 * CONFIRM, because the whole feature breaks silently if they hold the other
 * way:
 *
 *   1. an inline <script> on the parent page does NOT run (the negative
 *      control — without it every "child ran" pass below could also mean
 *      "the CSP was never applied");
 *   2. an external classic script under `script-src 'self'` DOES run, and
 *      platform-boot.js stamps data-platform (the boot face);
 *   3. a srcdoc iframe inherits the parent CSP → its inline script is
 *      BLOCKED (this is exactly why the cards left srcdoc);
 *   4. a local-file: iframe (the app's custom protocol) does NOT inherit it
 *      → the artifact cards, the tool-studio previews and HtmlPreview all
 *      keep running their inline JS, under the card's own `sandbox` string.
 *
 * History, measured on an earlier run and NOT re-asserted here: a blob: iframe
 * was the first migration and it FAILED — the child FIRED its load event and
 * still refused its inline script (the creator's policy applies to blob:),
 * i.e. blob: inherits exactly like srcdoc. `frame-src` no longer carries
 * blob:, so the harness can no longer load such a frame at all; when blob:
 * next comes up as an idea, that run is the answer.
 *
 * Honesty details: the CSP is parsed out of the REAL src/renderer/index.html
 * (edit that file and this probe judges your edit), the harness page IS that
 * file with only the main.tsx entry swapped for the probe's collector, the
 * local-file protocol is registered the way src/main/index.ts registers it
 * (`protocol.handle`, no privileged registration), and each child frame
 * carries the exact sandbox string its production counterpart ships.
 *
 * Usage: node scripts/probe-csp-inheritance.mjs
 */
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = mkdtempSync(join(tmpdir(), 'pm-csp-inheritance-'))

// ── 1. the REAL index.html + the REAL platform-boot.js ──
const indexHtml = readFileSync(join(REPO_ROOT, 'src/renderer/index.html'), 'utf-8')
const cspMatch = indexHtml.match(/Content-Security-Policy" content="([^"]+)"/)
if (!cspMatch) {
  console.error('FAIL  index.html carries no CSP meta')
  process.exit(1)
}
const CSP = cspMatch[1]
const hasUnsafeInlineScriptSrc = /script-src[^;]*'unsafe-inline'/.test(CSP)
const hasFrameLocalFile = /frame-src[^;]*\blocal-file:/.test(CSP)
const hasFrameBlob = /frame-src[^;]*\bblob:/.test(CSP)

// The harness page is production index.html with ONLY the module entry
// swapped for the collector — CSP meta, platform-boot tag and stylesheet all
// come through byte-identical.
const pageHtml = indexHtml.replace(
  /<script type="module" src="\.\/src\/main\.tsx"><\/script>/,
  `<script>window.__inlineSentinel = true</script><script src="./harness.js"></script>`,
)
if (pageHtml === indexHtml) {
  console.error('FAIL  could not find the main.tsx entry in index.html (probe needs its swap point)')
  process.exit(1)
}
writeFileSync(join(WORK, 'index.html'), pageHtml)
copyFileSync(join(REPO_ROOT, 'src/renderer/public/platform-boot.js'), join(WORK, 'platform-boot.js'))

const childPath = join(WORK, 'child.html').replace(/\\/g, '/')
writeFileSync(
  join(WORK, 'child.html'),
  '<!doctype html><html><body><p>child</p><script>try{parent.postMessage({k:"localfile"},"*")}catch(e){}</script></body></html>',
)

// ── 2. the collector (external — it must itself pass `script-src 'self'`) ──
const HARNESS = `
// Every child reports by postMessage; absence after the grace window reads as
// "blocked by CSP". window.__done is the probe's wait handle.
;(function () {
  var results = {
    boot: typeof document.documentElement.dataset.platform,
    inlineSentinel: typeof window.__inlineSentinel,
    srcdoc: 'blocked',
    localfile: 'blocked',
    load: { srcdoc: false, localfile: false },
  }
  var sandboxCard = 'allow-scripts allow-popups allow-forms allow-modals' // HtmlArtifactCard

  window.addEventListener('message', function (e) {
    var k = e.data && e.data.k
    if (k === 'srcdoc') results.srcdoc = 'ran'
    if (k === 'localfile') results.localfile = 'ran'
  })

  // (3) srcdoc: inherits the parent CSP → inline script must be blocked.
  var a = document.createElement('iframe')
  a.setAttribute('sandbox', sandboxCard)
  a.setAttribute('srcdoc', '<scr' + 'ipt>try{parent.postMessage({k:"srcdoc"},"*")}catch(e){}</scr' + 'ipt>')
  a.addEventListener('load', function () { results.load.srcdoc = true })
  document.body.appendChild(a)

  // (4) local-file: custom protocol with the CARD's exact sandbox — the
  // artifact cards and the tool studio are the migrated consumers here.
  var c = document.createElement('iframe')
  c.setAttribute('sandbox', sandboxCard)
  c.addEventListener('load', function () { results.load.localfile = true })
  c.src = 'local-file://' + '__CHILD_PATH__'
  document.body.appendChild(c)

  setTimeout(function () { window.__results = results; window.__done = true }, 2500)
})()
`
writeFileSync(join(WORK, 'harness.js'), HARNESS.replace('__CHILD_PATH__', JSON.stringify(childPath).slice(1, -1)))

// ── 3. fixture main: protocol registration the way the app does it ──
const FIXTURE_MAIN = `
const { app, BrowserWindow, protocol } = require('electron')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
app.setPath('userData', join(__dirname, 'ud'))
app.whenReady().then(() => {
  // Same shape as src/main/index.ts: a plain custom scheme, no privileged
  // registration — the property under test is that such a scheme does not
  // inherit the embedder's CSP.
  protocol.handle('local-file', (request) => {
    const u = new URL(request.url)
    // Windows: local-file://C:/x → hostname is the drive letter.
    const p = decodeURIComponent((u.hostname && /^[a-z]:$/i.test(u.hostname) ? u.hostname : '') + u.pathname)
    try {
      return new Response(readFileSync(p), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    } catch (e) {
      return new Response('not found', { status: 404 })
    }
  })
  const win = new BrowserWindow({
    width: 900, height: 700, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  })
  win.loadFile(join(__dirname, 'index.html'))
})
`
writeFileSync(join(WORK, 'main.js'), FIXTURE_MAIN)

// ── 4. run ──
const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

let electronApp = null
try {
  check("CSP script-src carries NO 'unsafe-inline'", !hasUnsafeInlineScriptSrc, hasUnsafeInlineScriptSrc ? CSP : undefined)
  check('frame-src carries local-file: (cards, tool studio, preview pane)', hasFrameLocalFile, hasFrameLocalFile ? undefined : CSP)
  check('frame-src carries NO blob: (blob frames died with the measured inheritance)', !hasFrameBlob, hasFrameBlob ? CSP : undefined)

  electronApp = await electron.launch({
    executablePath: require('electron'),
    args: [join(WORK, 'main.js')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  })
  const page = await electronApp.firstWindow()
  page.setDefaultTimeout(20000)
  page.on('pageerror', (err) => console.log('  [page error]', err.message))
  // Function form, not the string form: this page's CSP has no 'unsafe-eval'
  // (measured — the string form refuses to run here, which is the point).
  await page.waitForFunction(() => window.__done === true, undefined, { timeout: 20000 })
  const r = await page.evaluate(() => window.__results)

  const loadNote = `loads=${JSON.stringify(r.load)}`
  check('platform-boot.js ran under script-src self (dataset.platform stamped)', r.boot === 'string', `boot=${JSON.stringify(r.boot)}`)
  check('parent inline script did NOT run (CSP active on the page itself)', r.inlineSentinel === 'undefined', `sentinel=${r.inlineSentinel}`)
  check('srcdoc child inline script BLOCKED (srcdoc inherits — why the cards left it)', r.srcdoc === 'blocked', `${r.srcdoc}, ${loadNote}`)
  check('local-file: child inline script RAN (artifact/tool-studio/preview migration holds)', r.localfile === 'ran', `${r.localfile}, ${loadNote}`)
} catch (err) {
  check('probe run to completion', false, String((err && err.message) || err).slice(0, 300))
} finally {
  if (electronApp) await electronApp.close().catch(() => {})
}

const failed = results.filter((x) => !x.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
