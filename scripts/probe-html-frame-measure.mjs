// ── Electron-only fact check for the HTML preview's measurement channel ──
// The preview iframe is sandboxed + opaque-origin; the renderer-side webFrame
// tree does not see it at all (probed 2026-10-06), but the MAIN process's
// WebFrameMain does. This probe drives the REAL measurePreviewFrame module in
// a real Electron window against a self-made fixture — nothing outside the
// repo is read.
//
// Usage: node scripts/probe-html-frame-measure.mjs
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runDir = mkdtempSync(join(tmpdir(), 'pm-frame-measure-'))
const OUT = join(runDir, 'probe-main.cjs')
const fixtureDir = mkdtempSync(join(tmpdir(), 'pm-frame-fixture-'))
const results = []
function check(name, pass, detail) {
  results.push(pass)
  console.log(`${pass ? '✓' : '✗ FAIL'} ${name}${pass ? '' : `  [${detail}]`}`)
}

writeFileSync(
  join(fixtureDir, 'fixture.html'),
  '<!doctype html><html><body style="margin:0">' +
    '<div class="slide" style="width:960px;height:540px;background:#10243e"></div>' +
    '<div class="slide" style="width:960px;height:540px;background:#3e1024"></div>' +
    '</body></html>',
)

const src = `
import { app, BrowserWindow, protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { measurePreviewFrame } from '${process.cwd()}/src/main/preview/frame-measure'

const FIXTURE_DIR = ${JSON.stringify(fixtureDir)}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' }

app.whenReady().then(async () => {
  protocol.handle('local-file', async (request) => {
    const p = decodeURIComponent(new URL(request.url).pathname)
    return new Response(await readFile(p), { headers: { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' } })
  })

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  })
  // Two fixed 960x540 slides: the natural size a fluid page cannot report.
  const fixture = join(FIXTURE_DIR, 'fixture.html')
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html><body style="margin:0">' +
    '<iframe id="f" name="deckframe" sandbox="allow-scripts" src="local-file://' + fixture + '" ' +
    'style="display:block;width:800px;height:600px;border:none"></iframe></body></html>'
  ))
  // The frame registers asynchronously; poll like the app's first fit click does.
  let host = null
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    host = win.webContents
    const seen = await measurePreviewFrame(host, 'deckframe')
    if (seen) break
  }

  const out = {}
  out.metrics = await measurePreviewFrame(host, 'deckframe')
  // centerX: viewport 800, content 960 → overflow 160 → scrollLeft parks at 80.
  await measurePreviewFrame(host, 'deckframe', true)
  const frame = host.mainFrame.frames.find((f) => f.name === 'deckframe')
  out.scrollLeft = frame ? await frame.executeJavaScript('document.documentElement.scrollLeft') : null
  out.missing = await measurePreviewFrame(host, 'no-such-frame')
  console.log('PROBE_RESULT ' + JSON.stringify(out))
  app.quit()
})
`

await build({
  stdin: { contents: src, resolveDir: process.cwd(), loader: 'ts', sourcefile: 'probe-main.ts' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: OUT,
  logLevel: 'warning',
})

const run = spawnSync(join(process.cwd(), 'node_modules', '.bin', 'electron'), [OUT], { encoding: 'utf8', timeout: 60000 })
const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('PROBE_RESULT '))
if (!line) {
  console.log('✗ FAIL the probe main produced no result')
  console.log((run.stdout ?? '').slice(-800), (run.stderr ?? '').slice(-800))
  process.exit(1)
}
const out = JSON.parse(line.slice('PROBE_RESULT '.length))

check('the sandboxed local-file frame reports its natural size (960×1080)', out.metrics?.width === 960 && out.metrics?.height === 1080, JSON.stringify(out.metrics))
check('centerX parks the inner scroll at the middle of the overflow (80)', out.scrollLeft === 80, String(out.scrollLeft))
check('an unknown frame name answers null', out.missing === null, JSON.stringify(out.missing))

rmSync(fixtureDir, { recursive: true, force: true })
rmSync(runDir, { recursive: true, force: true })
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED')
process.exit(results.every(Boolean) ? 0 : 1)
