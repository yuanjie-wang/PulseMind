// Probe body — runs INSIDE the Electron main process (bundled by the driver).
// Requires the REAL heal module; the whole point is to exercise the shipped
// decision logic on a real blind tab, not a reimplementation of it.
//
// Flow note: the second CDP client connects while the first is still alive —
// the one (re)adopt shape Electron+Playwright support deterministically. A
// connect AFTER the previous client closed/died hangs in Playwright's
// connectOverCDP init when a composited WebContentsView page target exists —
// an upstream interop defect, reproduced and documented in AGENTS.md; the
// app's heal serves every path where the (re)connect itself succeeds.
const { app, BrowserWindow, WebContentsView } = require('electron')
const http = require('node:http')
const { existsSync, readFileSync, mkdtempSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const healModule = require('../src/main/browser/oopif-heal')
const { healOopifBlindPage, missingFrameUrls } = healModule

const MARKER_KEY = '__pulsemindAgentTab'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let checks = 0
const check = async (label, fn) => {
  await fn()
  checks++
  console.log('  ok  ' + label)
}
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(`${msg ?? 'assert'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}
const ok = (v, msg) => {
  if (!v) throw new Error(msg ?? 'expected truthy')
}

const H = { 'content-type': 'text/html; charset=utf-8' }
const server = http.createServer((req, res) => {
  if (req.url === '/child') {
    res.writeHead(200, H)
    res.end('<html><body><button id="inner" onclick="window.__ic=(window.__ic||0)+1">跨域按钮</button></body></html>')
    return
  }
  if (req.url === '/plain') {
    res.writeHead(200, H)
    res.end('<html><body><button id="only" onclick="window.__oc=(window.__oc||0)+1">普通按钮</button></body></html>')
    return
  }
  res.writeHead(200, H)
  res.end('<html><body><main><button id="outer" onclick="window.__oc=(window.__oc||0)+1">外层按钮</button></main>'
    + `<iframe src="http://127.0.0.1:${server.address().port}/child"></iframe></body></html>`)
})

app.commandLine.appendSwitch('remote-debugging-port', '0')
app.setPath('userData', mkdtempSync(join(tmpdir(), 'pm-probe-appview-oopif-')))

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

async function connect(tag, timeoutMs = 15000) {
  const { chromium } = require('playwright-core')
  let cdpPort = null
  for (let i = 0; i < 40 && !cdpPort; i++) {
    cdpPort = devToolsPort()
    if (!cdpPort) await sleep(250)
  }
  ok(cdpPort, 'DevToolsActivePort appeared')
  const t0 = Date.now()
  const b = await Promise.race([
    chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`),
    sleep(timeoutMs).then(() => { throw new Error(`connect ${tag} HUNG >${timeoutMs}ms`) }),
  ])
  console.log(`  (${tag} connected in ${Date.now() - t0}ms)`)
  return b
}

async function findPageByToken(context, token, deadlineMs = 10000) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      try {
        const marker = await page.evaluate(`window[${JSON.stringify(MARKER_KEY)}]`)
        if (marker === token) return page
      } catch {
        /* not ours, or not ready */
      }
    }
    await sleep(100)
  }
  throw new Error('token page not found')
}

/** Match a view to its Playwright page by a transient main-world tag — the
 *  same move healAdoptedViews uses (the newTab marker dies at first goto). */
async function findPageByTag(context, view) {
  const tag = `probe_${Math.random().toString(36).slice(2)}`
  await view.webContents.executeJavaScript(`window.__pmHealTag = ${JSON.stringify(tag)}`, true)
  try {
    for (const page of context.pages()) {
      const seen = await page.evaluate('window.__pmHealTag').catch(() => undefined)
      if (seen === tag) return page
    }
  } finally {
    void view.webContents.executeJavaScript('delete window.__pmHealTag', true).catch(() => {})
  }
  throw new Error('tag page not found')
}

/** The faithful newTab order: connect (done by caller) → sandboxed view →
 *  about:blank → marker → findPageByToken → goto(url). `dock` controls
 *  whether the view is composited into a window (only a docked view can
 *  pass click actionability). */
async function makeTab(browser, url, dock) {
  // The window is created only when docking — a BrowserWindow's own renderer
  // is a page target too, and a target that appears between two connectOverCDP
  // calls is what wedges the second connect upstream. Docking AFTER all
  // connects is safe (pure compositor, no CDP involvement).
  const win = dock ? new BrowserWindow({ width: 1000, height: 800, show: false }) : null
  const view = new WebContentsView({ webPreferences: { sandbox: true, backgroundThrottling: false } })
  if (dock) {
    win.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 1000, height: 800 })
  }
  await view.webContents.loadURL('about:blank')
  const token = 'tok_' + Math.random().toString(36).slice(2)
  await view.webContents.executeJavaScript(`${MARKER_KEY} = ${JSON.stringify(token)}`, true)
  const page = await findPageByToken(browser.contexts()[0], token)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await sleep(800)
  return { win, view, token, page, dock }
}

async function snapshotHas(page, needle) {
  const tree = await page.locator('html').ariaSnapshotJSON({ mode: 'ai' })
  return JSON.stringify(tree).includes(needle)
}

function findRef(tree, name) {
  let found = null
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.name === name) found = n.ref
      if (n.children) walk(n.children.filter((c) => typeof c !== 'string'))
    }
  }
  walk(tree)
  return found
}

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '0.0.0.0', r))
  const port = server.address().port
  const parentUrl = `http://localhost:${port}/parent`
  const plainUrl = `http://localhost:${port}/plain`

  const browser1 = await connect('c1')

  // ── 1. The defect: a (re)connect adopting a surviving tab goes blind ──
  // tabU is a folded pane (the app's fold semantics: alive, not composited).
  const tabU = await makeTab(browser1, parentUrl, false)
  const browser2 = await connect('c2')
  const page2 = await findPageByTag(browser2.contexts()[0], tabU.view)

  const sawInner2 = await snapshotHas(page2, '跨域按钮')
  const tree2 = await page2.locator('html').ariaSnapshotJSON({ mode: 'ai' })
  const ref2 = findRef(tree2, '跨域按钮')
  const frames2 = page2.frames().length
  await check('缺陷复现：新连接采纳的标签页对跨域 iframe 失明（快照无内容、无编号、帧不可见）', () => {
    eq(sawInner2, false)
    eq(ref2, null)
    eq(frames2, 1)
  })
  const electronUrls = tabU.view.webContents.mainFrame.frames.map((f) => f.url)
  const pwUrls = page2.frames().map((f) => f.url)
  await check('失明判定：missingFrameUrls 指认 Playwright 看不见的帧', () => {
    eq(JSON.stringify(missingFrameUrls(electronUrls, pwUrls)), JSON.stringify([`http://127.0.0.1:${port}/child`]))
  })

  // ── 2. The heal: shipped healOopifBlindPage reloads the blind page ──
  const healed = await healOopifBlindPage(page2, electronUrls)
  await sleep(600)
  const sawInner3 = await snapshotHas(page2, '跨域按钮')
  const tree3 = await page2.locator('html').ariaSnapshotJSON({ mode: 'ai' })
  const ref3 = findRef(tree3, '跨域按钮')
  await check('修复：heal 判定需要重载并执行', () => eq(healed, true))
  await check('修复：重载后快照重新带出跨域内容与帧前缀编号', () => {
    eq(sawInner3, true)
    ok(/^f\d+e\d+$/.test(ref3 ?? ''), `frame-prefixed ref restored (got ${ref3})`)
  })
  // un-fold: the healed tab goes back on screen and must be fully actionable
  // (docking is compositor-only — no CDP reconnect involved)
  tabU.win = new BrowserWindow({ width: 1000, height: 800, show: false })
  tabU.win.contentView.addChildView(tabU.view)
  tabU.view.setBounds({ x: 0, y: 0, width: 1000, height: 800 })
  await sleep(300)
  await page2.locator(`aria-ref=${ref3}`).click({ timeout: 5000 })
  const child3 = page2.frames().find((f) => f.url().includes('/child'))
  const ic3 = child3 ? await child3.evaluate(() => window.__ic || 0) : null
  await check('修复：展开后帧内点击真实落地（控制完全恢复）', () => eq(ic3, 1))

  // ── 3. Healthy baseline (docked tab, the app's own shape) ──
  const tabD = await makeTab(browser1, parentUrl, true)
  const sawInner1 = await snapshotHas(tabD.page, '跨域按钮')
  const tree1 = await tabD.page.locator('html').ariaSnapshotJSON({ mode: 'ai' })
  const ref1 = findRef(tree1, '跨域按钮')
  const frames1 = tabD.page.frames().length
  await tabD.page.locator(`aria-ref=${ref1}`).click({ timeout: 5000 })
  const child1 = tabD.page.frames().find((f) => f.url().includes('/child'))
  const ic1 = child1 ? await child1.evaluate(() => window.__ic || 0) : null
  await check('健康基线：跨域 iframe 可见（帧前缀编号）、帧内点击真实落地', () => {
    eq(sawInner1, true)
    ok(/^f\d+e\d+$/.test(ref1 ?? ''), `frame-prefixed ref (got ${ref1})`)
    eq(frames1, 2)
    eq(ic1, 1)
  })

  // ── 4. Negative: a page with no cross-origin frames is not reloaded ──
  const tabPlain = await makeTab(browser2, plainUrl, false)
  await tabPlain.page.evaluate('window.__keep = 42')
  const healedPlain = await healOopifBlindPage(
    tabPlain.page,
    tabPlain.view.webContents.mainFrame.frames.map((f) => f.url),
  )
  const keep = await tabPlain.page.evaluate('window.__keep')
  await check('负例：无跨域帧的页面 heal 不动它（不重载、哨兵存活）', () => {
    eq(healedPlain, false)
    eq(keep, 42)
  })

  console.log('PASS: ' + checks + ' checks — app-view 跨域 iframe：健康基线 / 失明缺陷 / heal / 负例 在真实 Electron 上成立')
  browser2.close().catch(() => {})
  browser1.close().catch(() => {})
  server.close()
  app.exit(0)
}).catch((e) => {
  console.error('[probe] fatal:', (e && e.stack) || e)
  app.exit(1)
})
