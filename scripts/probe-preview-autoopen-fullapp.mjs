/**
 * FULL-APP reproduction of the preview white screen (user report 2026-10-29).
 *
 * Every isolated experiment passes (protocol, URL shape, timing, remount
 * storms, http origin, the real component chain over real IPC — see
 * probe-preview-autoopen*.mjs). This probe reproduces the one thing they all
 * lack: the REAL application — dev-mode Vite renderer, the real main bundle
 * from the night of the report (out/ is not rebuilt), the real engine executing
 * a real `write` tool through a fake OpenAI-wire LLM, the real session event
 * stream, the real preload — and watches what the auto-opened preview iframe
 * actually shows.
 *
 * The fake LLM speaks the OpenAI SSE wire: turn 1 returns a `write` tool_call
 * for a ~30KB html file into the session workspace (path parsed from the
 * request's own system prompt, like the real model does), turn 2 ends the run.
 *
 * Usage: node scripts/probe-preview-autoopen-fullapp.mjs
 */
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = mkdtempSync(join(tmpdir(), 'pm-fullapp-'))
const HOME = join(WORK, 'home')
mkdirSync(join(HOME, '.pulsemind'), { recursive: true })

const FAKE_PORT = 17899 + Math.floor(Math.random() * 500)
const MODEL_ID = 'fake-model-1'

const HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>金融九问 · 一页纸</title><style>
:root{--ink:#101c2c;--red:#c7000b}
body{margin:0;padding:28px 20px;background:#fff;color:var(--ink);font-family:-apple-system,"PingFang SC",sans-serif}
h1{color:var(--red)} .card{border:1px solid #e4e9f0;border-radius:10px;padding:14px;margin:10px 0;background:#f7f9fc}
</style></head><body><h1>金融九问 · 一页纸精华（全栈探针）</h1>
${Array.from({ length: 120 }, (_, i) => `<div class="card"><b>问 ${i + 1}</b>：这一段是探针生成的正文内容，用于确认预览帧渲染了真实文档。</div>`).join('\n')}
</body></html>`

const argsJson = JSON.stringify({ file_path: '__WS__/金融九问-demo.html', content: HTML })

// Bundle the REAL protocol handler so the app's main process can require it
// through a logging wrapper.
await build({
  entryPoints: [join(REPO_ROOT, 'src/main/preview/serve-preview.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  outfile: join(WORK, 'serve-preview.cjs'), logLevel: 'silent',
})

// ── fake OpenAI-wire LLM ──
import { createServer } from 'node:http'
const seenToolResult = new Set()
const fakeLlm = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let payload = {}
    try { payload = JSON.parse(body || '{}') } catch { /* ignore */ }
    const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0
    const msgs = Array.isArray(payload.messages) ? payload.messages : []
    // The workspace rides the state block — the FINAL message, not the system.
    const allText = msgs.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    const wsMatch = allText.match(/- Workspace: (\S+)/)
    const toolMsg = msgs.find((m) => m.role === 'tool')
    const chunk = (delta, finish) => JSON.stringify({
      id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'fake',
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    })
    const sse = (lines) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const l of lines) res.write(`data: ${l}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }
    if (hasTools && toolMsg) {
      seenToolResult.add('done')
      sse([chunk({ role: 'assistant', content: '已完成：html 文件已写入工作区。' }, 'stop')])
    } else if (hasTools) {
      const args = argsJson.replace('__WS__', wsMatch ? wsMatch[1] : HOME)
      console.log(`  [fake-llm] issuing write → ${args.length} chars of args (ws=${wsMatch ? wsMatch[1] : '???'})`)
      sse([
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_write_1', type: 'function', function: { name: 'write', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }),
        chunk({}, 'tool_calls'),
      ])
    } else {
      sse([chunk({ role: 'assistant', content: '好的。' }, 'stop')])
    }
  })
})
await new Promise((r) => fakeLlm.listen(FAKE_PORT, '127.0.0.1', r))

// ── BISECT: minimal harness page (the REAL index.html CSP meta) on a plain
// http server. Pointing ELECTRON_RENDERER_URL here keeps the real main bundle,
// real preload and real window, and swaps ONLY the renderer bundle out. ──
const indexHtmlReal = readFileSync(join(REPO_ROOT, 'src/renderer/index.html'), 'utf-8')
const CSP_META = indexHtmlReal.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)[0]
writeFileSync(join(WORK, 'bisect.html'), `<!DOCTYPE html><html><head><meta charset="UTF-8">${CSP_META}</head>
<body style="margin:0"><div id="root"></div></body></html>`)
const bisectServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(readFileSync(join(WORK, 'bisect.html')))
})
await new Promise((r) => bisectServer.listen(FAKE_PORT + 1, '127.0.0.1', r))
const BISECT = process.argv.includes('--bisect')

// ── settings for the temp HOME ──
writeFileSync(join(HOME, '.pulsemind', 'settings.json'), JSON.stringify({
  theme: 'light', locale: 'zh', persona: '', myName: '', soul: '', yourName: '',
  activeProfileId: MODEL_ID, lastUsedProfileId: MODEL_ID,
  providers: [{
    id: 'fake-provider', name: 'Fake', apiFormat: 'openai',
    baseURL: `http://127.0.0.1:${FAKE_PORT}/v1`, apiKey: 'test-key',
    models: [{ id: MODEL_ID, model: 'fake-model', name: 'Fake Model', maxTokens: 8192, contextLength: 65536 }],
  }],
}))

// ── vite (dev renderer), the way npm run dev starts it ──
const vite = spawn(join(REPO_ROOT, 'node_modules/.bin/vite'), ['--port', '5173', '--strictPort', '--config', '/tmp/pm-vite-nowatch.config.mts'], {
  cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
})
const viteLog = []
vite.stdout.on('data', (d) => viteLog.push(String(d)))
vite.stderr.on('data', (d) => viteLog.push(String(d)))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let viteUp = false
for (let i = 0; i < 60 && !viteUp; i++) {
  await wait(500)
  try {
    const r = await fetch('http://localhost:5173/')
    if (r.ok) viteUp = true
  } catch { /* not yet */ }
}
if (!viteUp) {
  console.error('FAIL  vite did not come up:\n' + viteLog.slice(-20).join(''))
  vite.kill(); fakeLlm.close(); process.exit(1)
}
console.log('vite up on :5173')

const WRAP_MAIN = [
  "const electron = require('electron')",
  "const fs = require('node:fs')",
  "const origHandle = electron.protocol.handle.bind(electron.protocol)",
  "let appHandler = null",
  "let registered = null",
  "electron.protocol.handle = (scheme, handler) => {",
  "  if (scheme !== 'local-file') return origHandle(scheme, handler)",
  "  appHandler = handler",
  "  console.log('[wrap] app registered its local-file handler')",
  "  return origHandle(scheme, async (request) => {",
  "    console.log('[handler:app] ->', request.url.slice(0, 110))",
  "    const res = await handler(request)",
  "    console.log('[handler:app] <-', res.status)",
  "    return res",
  "  })",
  "}",
  "globalThis.__pmSetHandler = (mode, filePath) => {",
  "  try { electron.protocol.unhandle('local-file') } catch {}",
  "  registered = null",
  "  if (mode === 'app') {",
  "    if (!appHandler) return 'no-app-handler'",
  "    origHandle('local-file', appHandler); registered = 'app'",
  "    return 'app-restored'",
  "  }",
  "  const handler = async (request) => {",
  "    console.log('[handler:' + mode + '] ->', request.url.slice(0, 110))",
  "    if (mode === 'string') return new Response(fs.readFileSync(filePath, 'utf-8'), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })",
  "    if (mode === 'buffer') return new Response(fs.readFileSync(filePath), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })",
  "    if (mode === 'bufferSmall') return new Response(fs.readFileSync(filePath).subarray(0, 2048), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })",
  "    return new Response('<!DOCTYPE html><html><body>stub-ok</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })",
  "  }",
  "  origHandle('local-file', handler)",
  "  registered = mode",
  "  return 'set-' + mode",
  "}",
  "require(process.env.PM_APP_ENTRY)",
].join('\n')

// Self-test mode: no Playwright/CDP at all. The wrapper drives the main
// window itself — create a local-file iframe, write the outcome to a file.
if (process.env.PM_SELFTEST) {
  const { BrowserWindow } = electron
  const testUrl = process.env.PM_SELFTEST_URL
  const resultFile = process.env.PM_SELFTEST_OUT
  setTimeout(() => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('http'))
    if (!w) { fs.writeFileSync(resultFile, JSON.stringify({ error: 'no window' })); electron.app.exit(3) }
    w.webContents.executeJavaScript(\`(async () => {
      const t = document.createElement('iframe')
      t.setAttribute('sandbox', 'allow-scripts')
      const ev = new Promise((res) => { t.addEventListener('load', () => res('load'), { once: true }) })
      t.src = \\`local-file://\\${process.env.PM_SELFTEST_TARGET}\\`
      document.body.appendChild(t)
      return await Promise.race([ev, new Promise((res) => setTimeout(() => res('timeout'), 5000))])
    })()", false).then((r) => {
      fs.writeFileSync(resultFile, JSON.stringify({ result: r }))
      electron.app.exit(0)
    }).catch((e) => {
      fs.writeFileSync(resultFile, JSON.stringify({ error: String(e).slice(0, 200) }))
      electron.app.exit(4)
    })
  }, Number(process.env.PM_SELFTEST_DELAY || '8000'))
  void testUrl
}
writeFileSync(join(WORK, 'wrap-main.cjs'), WRAP_MAIN)

// ── launch the REAL app (out/ from the night of the report — not rebuilt) ──
class SkipFlow extends Error {}
let electronApp = null
let pass = 0, total = 0
const check = (name, ok, detail) => {
  total++; if (ok) pass++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
try {
  electronApp = await electron.launch({
    executablePath: require('electron'),
    args: [join(WORK, 'wrap-main.cjs')],
    env: { ...process.env, HOME, PM_APP_ENTRY: join(REPO_ROOT, 'out/main/index.js'), ELECTRON_RENDERER_URL: BISECT ? `http://localhost:${FAKE_PORT + 1}/` : 'http://localhost:5173' },
  })
  electronApp.process().stdout.on('data', (d) => {
    const t = String(d)
    if (t.includes('[handler]') || t.includes('[wrap]') || t.includes('[stub')) console.log('  ' + t.trim().slice(0, 300))
  })
  electronApp.process().stderr.on('data', (d) => {
    const s = String(d)
    if (/Error|error|Uncaught|failed/i.test(s) && !/Debugger|inspector/i.test(s)) console.log('  [main]', s.slice(0, 300))
  })
  electronApp.on('window', () => console.log('  [evt] window opened'))
  // firstWindow() is the SPLASH; wait for the renderer window (vite origin).
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    await wait(500)
    page = electronApp.windows().find((w) => w.url().startsWith('http://localhost:') && !w.url().startsWith('http://localhost:8')) ?? null
  }
  if (!page) throw new Error('renderer window never appeared; windows=' + electronApp.windows().length)
  console.log('  renderer window attached:', page.url().slice(0, 60))
  // Playwright's page.evaluate context keeps dying here (no main-frame
  // navigation logged) — drive the page via the main process instead.
  const wcExec = async (expr) => electronApp.evaluate(({ BrowserWindow }, code) => {
    const wc = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('http'))
    if (!wc) return 'no-renderer-wc'
    return wc.webContents.executeJavaScript(code, false)
  }, expr)

  page.setDefaultTimeout(30000)
  page.on('pageerror', (err) => console.log('  [pageerror]', String(err.message).slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 250))
  })
  // Every local-file: request the renderer makes, with its outcome.
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log('  [NAV ]', f.url().slice(0, 120)) })
  page.on('request', (r) => { if (r.url().startsWith('local-file://')) console.log('  [req ]', r.url().slice(0, 160)) })
  page.on('response', (r) => { if (r.url().startsWith('local-file://')) console.log('  [resp]', r.status(), r.url().slice(0, 140)) })
  page.on('requestfailed', (r) => { if (r.url().startsWith('local-file://')) console.log('  [FAIL]', r.failure()?.errorText, r.url().slice(0, 160)) })

  await page.waitForLoadState('domcontentloaded')
  await wait(2500)

  // SPLIT EXPERIMENT: does a local-file: iframe navigate on the FRESH page,
  // before any session activity?
  const fresh = await wcExec(`(async () => {
    const t = document.createElement('iframe')
    t.setAttribute('sandbox', 'allow-scripts')
    t.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:120px;z-index:99999'
    const ev = new Promise((r) => { t.addEventListener('load', () => r('load'), { once: true }) })
    t.src = 'local-file:///Users/wangyuanjie/.pulsemind/workspace/20261029000035/%E9%87%91%E8%9E%8D%E4%B9%9D%E9%97%AE-%E4%B8%80%E9%A1%B5%E7%BA%B8%E7%B2%BE%E5%8D%8E.html'
    document.body.appendChild(t)
    const out = await Promise.race([ev, new Promise((r) => setTimeout(() => r('timeout'), 4000))])
    // Controls: does ANY subframe navigation work in this page?
    const mk = (src, sandbox) => new Promise((res) => {
      const f = document.createElement('iframe')
      if (sandbox) f.setAttribute('sandbox', sandbox)
      f.style.cssText = 'position:fixed;left:0;bottom:0;width:200px;height:80px;z-index:99999'
      f.addEventListener('load', () => res('load'), { once: true })
      f.src = src
      document.body.appendChild(f)
      setTimeout(() => res('timeout'), 4000)
    })
    const httpFrame = await mk(location.origin + '/probe-frame', 'allow-scripts')
    const localNoSandbox = await mk('local-file:///Users/wangyuanjie/.pulsemind/workspace/20261029000035/%E9%87%91%E8%9E%8D%E4%B9%9D%E9%97%AE-%E4%B8%80%E9%A1%B5%E7%BA%B8%E7%B2%BE%E5%8D%8E.html', null)
    t.remove()
    return out + ' | http-frame=' + httpFrame + ' | local-nosandbox=' + localNoSandbox
  })()`).catch((e) => 'ERR:' + String(e).slice(0, 100))
  console.log('  FRESH-page local-file iframe:', fresh)
  // Handler-mode matrix, all inside the MAIN window.
  const frameTest = ` (async () => {
    const t = document.createElement('iframe')
    t.setAttribute('sandbox', 'allow-scripts')
    const ev = new Promise((res) => { t.addEventListener('load', () => res('load'), { once: true }) })
    t.src = 'local-file:///Users/wangyuanjie/.pulsemind/workspace/20261029000035/%E9%87%91%E8%9E%8D%E4%B9%9D%E9%97%AE-%E4%B8%80%E9%A1%B5%E7%BA%B8%E7%B2%BE%E5%8D%8E.html'
    document.body.appendChild(t)
    const out = await Promise.race([ev, new Promise((res) => setTimeout(() => res('timeout'), 3000))])
    t.remove()
    return out
  })() `
  const runMatrix = async (label) => {
    for (const mode of ['app', 'string', 'buffer', 'bufferSmall', 'stub']) {
      const set = await electronApp.evaluate((_e, [m, fp]) => globalThis.__pmSetHandler(m, fp), [mode, '/Users/wangyuanjie/.pulsemind/workspace/20261029000035/金融九问-一页纸精华.html'])
      await wait(300)
      const r = await wcExec(frameTest).catch((e) => 'ERR:' + String(e).slice(0, 60))
      console.log(`  [${label}] mode=${mode.padEnd(11)} iframe=${r}`)
    }
  }
  await runMatrix('will-navigate ATTACHED')
  await electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('http'))
    w.webContents.removeAllListeners('will-navigate')
  })
  await runMatrix('will-navigate REMOVED ')

  check('handler matrix ran (see mode= lines above)', true)
  await wait(500)
  throw new SkipFlow()

  // Drive the composer: type the task and send.
  const ta = page.locator('textarea').first()
  await ta.waitFor({ timeout: 20000 })
  await ta.click()
  await ta.fill('写一个金融九问的一页纸html')
  await ta.press('Enter')
  console.log('message sent, waiting for the write + auto-open…')

  // Approval gate: a held write lays out 跳过/运行 (probe-chat-approval's DOM).
  // Answer it like the user does.
  for (let i = 0; i < 60; i++) {
    const run = page.getByText('运行', { exact: true }).first()
    if (await run.isVisible().catch(() => false)) {
      console.log('  approval card visible → clicking 运行')
      await run.click().catch((e) => console.log('  click failed:', String(e).slice(0, 120)))
      break
    }
    if (page.frames().some((f) => f.url().startsWith('local-file://'))) break
    await wait(500)
  }

  // All frames' console output + every navigation event, straight from the
  // main process.
  await electronApp.evaluate(({ BrowserWindow }) => {
    const hook = () => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.webContents.__pmHooked) continue
        w.webContents.__pmHooked = true
        w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
          if (level >= 1) console.log(`[console-msg L${level}] ${String(message).slice(0, 260)} (${String(sourceId).slice(0, 60)}:${line})`)
        })
        w.webContents.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => {
          if (!isMainFrame || !url.startsWith('local-file')) console.log(`[nav-start] main=${isMainFrame} ${String(url).slice(0, 120)}`)
        })
        w.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
          console.log(`[did-fail-load] code=${code} ${desc} main=${isMainFrame} ${String(url).slice(0, 120)}`)
        })
        w.webContents.on('did-fail-provisional-load', (e, code, desc, url, isMainFrame) => {
          console.log(`[fail-provisional] code=${code} ${desc} main=${isMainFrame} ${String(url).slice(0, 120)}`)
        })
      }
    }
    hook()
    setInterval(hook, 1000)
  }).catch(() => {})

  // Watch the network layer from the MAIN process: does the local-file:
  // navigation ever reach it?
  await electronApp.evaluate(({ session }, port) => {
    const s = session.defaultSession
    s.webRequest.onBeforeRequest((details, cb) => {
      if (details.url.startsWith('local-file://')) console.log(`[webRequest] ${details.resourceType} ${details.url.slice(0, 150)}`)
      cb({})
    })
  }, FAKE_PORT)

  // Wait for a local-file: child frame that is NOT a chat artifact card (those
  // load tmp copies under /.pulsemind/tmp); the pane loads the workspace file.
  let frame = null
  for (let i = 0; i < 240; i++) {
    frame = page.frames().find((f) => f.url().startsWith('local-file://') && !f.url().includes('/tmp/'))
    if (frame) break
    await wait(500)
  }
  // Whether or not Playwright sees the frame, dump the REAL iframe element.
  const dom = await page.evaluate(() => {
    const els = [...document.querySelectorAll('iframe')]
    return els.map((f) => ({
      title: f.title, name: f.name,
      src: f.getAttribute('src'),
      baseURI: f.baseURI,
      rect: (() => { const r = f.getBoundingClientRect(); return { w: r.width, h: r.height } })(),
      sandbox: f.getAttribute('sandbox'),
      styleZoom: f.style.zoom,
    }))
  })
  console.log('  iframes in DOM:', JSON.stringify(dom, null, 1))
  const trivial = await wcExec('1+1').catch((e) => 'ERR:' + String(e).slice(0, 80))
  console.log('  trivial executeJavaScript:', trivial)
  let cspProbe = null
  for (let i = 0; i < 3 && !cspProbe; i++) {
    try { cspProbe = await wcExec(`(${cspProbeSrc.toString()})()`).catch((e) => { throw e }) } catch (e) { console.log('  [csp-probe retry]', String(e).slice(0, 80)); await wait(2000) }
  }
  function cspProbeSrc() { return (async () => {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
    // Does ANY local-file: iframe work in THIS page? Create one to the same URL.
    const src = document.querySelector('iframe[title="preview"]')?.getAttribute('src')
    const test = document.createElement('iframe')
    test.setAttribute('sandbox', 'allow-scripts')
    test.style.cssText = 'width:300px;height:200px'
    const loaded = new Promise((r) => { test.addEventListener('load', () => r('load'), { once: true }) })
    test.src = src
    document.body.appendChild(test)
    const outcome = await Promise.race([loaded, new Promise((r) => setTimeout(() => r('timeout'), 4000))])
    test.remove()
    return { csp: meta ? meta.getAttribute('content') : null, testFrame: outcome }
  })() }
  console.log('  live CSP meta:', cspProbe.csp)
  console.log('  freshly-created same-URL iframe in-page:', cspProbe.testFrame)
  check('preview iframe appeared', !!frame, frame ? frame.url().slice(0, 160) : 'no PLAYWRIGHT frame; dom=' + JSON.stringify(dom))
  if (frame) {
    let body = null
    for (let i = 0; i < 30; i++) {
      try {
        body = await frame.evaluate(() => ({ t: document.title, n: document.body ? document.body.innerText.length : -1, rs: document.readyState }))
        if (body.rs === 'complete' && body.n > 0) break
      } catch (e) { body = { error: String(e).slice(0, 120) } }
      await wait(300)
    }
    check('iframe shows the document body', !!body && body.n > 100, JSON.stringify(body))
    await page.screenshot({ path: join(WORK, 'fullapp.png') })
    console.log(`  screenshot: ${join(WORK, 'fullapp.png')}`)
  }
  await wait(1500)
  await page.screenshot({ path: join(WORK, 'fullapp-late.png') })
} catch (err) {
  if (!(err instanceof SkipFlow)) check('probe run to completion', false, String((err && err.stack) || err).slice(0, 500))
} finally {
  if (electronApp) await electronApp.close().catch(() => {})
  vite.kill('SIGTERM')
  fakeLlm.close()
  await wait(300)
}
// keep HOME for post-mortem; log the app's own startup log
const { existsSync, readFileSync: rf } = await import('node:fs')
const appLog = join(HOME, '.pulsemind', 'logs', 'main.log')
if (existsSync(appLog)) console.log('---- app main.log tail ----\n' + rf(appLog, 'utf-8').split('\n').slice(-25).join('\n'))
else console.log('---- no app main.log at', appLog)
console.log(`\n${pass}/${total} checks passed`)
process.exit(pass === total && total > 0 ? 0 : 1)
