// Probe body — drives the PRODUCT screenshot helper (`captureAppViewScreenshot`)
// against a real Electron WebContentsView stamped with the pane zoom
// (346px pane / 1280 design width ≈ 0.27). Also captures the old Playwright
// shape on the same page as the negative control.
//
// Run: node scripts/probe-appview-screenshot.mjs
const { app, BrowserWindow, WebContentsView } = require('electron')
const http = require('node:http')
const { existsSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { captureAppViewScreenshot } = require('../src/main/browser/app-view-screenshot')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = join(tmpdir(), 'pm-appview-shot-probe')
mkdirSync(OUT, { recursive: true })

const VIEW_W = 346
const VIEW_H = 195
const ZOOM = VIEW_W / 1280
const SCROLL_CSS = 600

const H = { 'content-type': 'text/html; charset=utf-8' }
const server = http.createServer((req, res) => {
  res.writeHead(200, H)
  res.end(`<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box} html,body{margin:0;padding:0;background:#fff}
    .top{height:40px;background:#e00403}
    #marker{margin-top:560px;margin-left:200px;width:200px;height:100px;background:#00a000}
    .blue{margin-top:300px;height:40px;background:#2932e1}
    .filler{height:1600px;width:100%;background:#fafafa}
    .last{height:60px;background:#ff9900}
  </style></head><body>
    <div class="top"></div>
    <div id="marker"></div>
    <div class="blue"></div>
    <div class="filler"></div>
    <div class="last"></div>
    <script>window.__probeReady = true</script>
  </body></html>`)
})

app.commandLine.appendSwitch('remote-debugging-port', '0')
app.setPath('userData', mkdtempSync(join(tmpdir(), 'pm-probe-appview-shot-')))

function devToolsPort() {
  try {
    const file = join(app.getPath('userData'), 'DevToolsActivePort')
    if (!existsSync(file)) return null
    const port = Number(readFileSync(file, 'utf-8').split('\n')[0]?.trim())
    return Number.isFinite(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function save(name, buf) {
  const file = join(OUT, `${name}.png`)
  writeFileSync(file, buf)
  console.log(`RESULT ${JSON.stringify({ name, value: { file, ...pngSize(buf) } })}`)
}

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/page`

  // Connect BEFORE any window exists: a composited window/target created
  // before connectOverCDP wedges Playwright's init on this Electron build.
  let cdpPort = null
  for (let i = 0; i < 40 && !cdpPort; i++) {
    cdpPort = devToolsPort()
    if (!cdpPort) await sleep(250)
  }
  if (!cdpPort) throw new Error('no DevToolsActivePort')
  const { chromium } = require('playwright-core')
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
  const context = browser.contexts()[0]

  const win = new BrowserWindow({ width: 1000, height: 800, show: true })
  const view = new WebContentsView({ webPreferences: { sandbox: true, backgroundThrottling: false } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 10, y: 10, width: VIEW_W, height: VIEW_H })
  await view.webContents.loadURL(url)
  view.webContents.setZoomFactor(ZOOM)
  await sleep(300)
  view.webContents.setZoomFactor(ZOOM)
  await sleep(500)

  let page = null
  for (const p of context.pages()) {
    if ((await p.evaluate('location.href').catch(() => '')).includes('127.0.0.1')) {
      page = p
      break
    }
  }
  if (!page) throw new Error('probe page not found')

  const zoom = view.webContents.getZoomFactor()
  console.log(
    `META ${JSON.stringify({
      zoom,
      bounds: view.getBounds(),
      dpr: await page.evaluate('devicePixelRatio'),
      layout: await page.evaluate('({w:innerWidth,h:innerHeight})'),
      content: await page.evaluate('({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight})'),
    })}`,
  )

  // Negative control: the old product shape (Playwright over connectOverCDP).
  save('OLD_plain_playwright', await page.screenshot())

  // The fix: viewport, selector, full page — all through the real helper.
  save('NEW_plain', await captureAppViewScreenshot(page, { zoom }))

  // Background tabs are folded to 0×0 bounds by the dock. The capture must
  // still be the page, not a 0-sized raster.
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  await sleep(300)
  save(
    'FOLDED_plain',
    await captureAppViewScreenshot(page, { zoom: view.webContents.getZoomFactor() }),
  )
  view.setBounds({ x: 10, y: 10, width: VIEW_W, height: VIEW_H })
  await sleep(300)

  await page.evaluate(`window.scrollTo(0, ${SCROLL_CSS})`)
  await sleep(300)
  console.log(`SCROLLED ${JSON.stringify({ scroll: await page.evaluate('({x:scrollX,y:scrollY})'), box: await page.locator('#marker').boundingBox() })}`)
  save('NEW_selector', await captureAppViewScreenshot(page, { zoom, selector: '#marker' }))

  save('NEW_fullPage', await captureAppViewScreenshot(page, { zoom, fullPage: true }))

  await browser.close().catch(() => {})
  server.close()
  win.destroy()
  console.log('DONE')
  app.quit()
})

process.on('uncaughtException', (err) => {
  console.error('PROBE ERROR', err)
  app.exit(1)
})
