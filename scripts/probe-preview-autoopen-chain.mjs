/**
 * Preview auto-open against the REAL component chain (user report 2026-10-29:
 * 生成 html 后自动打开工作区预览白屏，重启后手动打开就正常).
 *
 * The isolated probe (probe-preview-autoopen.mjs) proved the protocol, URL
 * construction, Chinese filenames, write-then-mount timing and remount storms
 * all deliver the document — in a hand-rolled harness. What it did NOT cover
 * is the production RENDER CHAIN: the auto path mounts the whole WorkbenchPane
 * body (closed → open) in the same commit that PreviewContent and the iframe
 * mount, driven from a real `ipcRenderer.on` agent-event callback with
 * openFile+bumpReload, while the manual path (tree click, works after restart)
 * swaps PreviewContent into an ALREADY-MOUNTED pane. This probe drives the
 * REAL WorkbenchPane → WorkspacePane → PreviewPane → PreviewContent →
 * HtmlPreview tree, the REAL stores, the REAL usePreviewPaneSync (over a real
 * IPC channel, like production), the REAL svcReadFile guard and the REAL
 * local-file protocol — and compares both paths.
 *
 * Usage: node scripts/probe-preview-autoopen-chain.mjs
 */
import { _electron as electron } from 'playwright-core'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = mkdtempSync(join(tmpdir(), 'pm-preview-chain-'))
// Temp HOME so every app data dir (db, audit, settings) the bundled services
// touch lands in the sandbox, never the user's ~/.pulsemind.
const HOME = join(WORK, 'home')
mkdirSync(HOME, { recursive: true })
const WS = join(WORK, 'workspace', '20261029000035')
mkdirSync(WS, { recursive: true })

// ── 1. bundles ──
// Main side: the real protocol handler, the real file services, the real
// frame-measure channel.
await build({
  stdin: {
    contents: `
export { serveLocalFile } from '${join(REPO_ROOT, 'src/main/preview/serve-preview.ts')}'
export { svcReadFile, svcListDir } from '${join(REPO_ROOT, 'src/main/services/file-ops.ts')}'
export { measurePreviewFrame } from '${join(REPO_ROOT, 'src/main/preview/frame-measure.ts')}'
`,
    resolveDir: REPO_ROOT, loader: 'ts', sourcefile: 'probe-main-entry.ts',
  },
  bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  outfile: join(WORK, 'probe-main.cjs'), logLevel: 'silent',
  // The probe uses svcReadFile/svcListDir only; stub the two imports that drag
  // the world in behind them (audit-store → better-sqlite3; read-cache →
  // markitdown/unzipper/playwright) — neither path runs for a plain read.
  plugins: [{
    name: 'stub-heavy-storage',
    setup(b) {
      b.onLoad({ filter: /src[\\/]main[\\/]storage[\\/](audit-store|read-cache)\.ts$/ }, (args) => (
        args.path.endsWith('audit-store.ts')
          ? { contents: 'export const auditStore = { record() {} }', loader: 'ts' }
          : { contents: 'export async function getOrConvert() { return null }', loader: 'ts' }
      ))
    },
  }],
  external: ['electron'],
})
await build({
  entryPoints: [join(REPO_ROOT, 'src/shared/preview/local-file-url.ts')],
  bundle: true, platform: 'browser', format: 'iife', globalName: 'PmLocalFileUrl',
  outfile: join(WORK, 'local-file-url.js'), logLevel: 'silent',
})
// Renderer side: the REAL component chain.
const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from '${REPO_ROOT}/src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from '${REPO_ROOT}/src/renderer/src/theme/dom'
import { WorkbenchPane } from '${REPO_ROOT}/src/renderer/src/components/workbench/WorkbenchPane'
import { usePreviewPaneSync } from '${REPO_ROOT}/src/renderer/src/hooks/usePreviewPaneSync'
import { usePreviewPaneStore } from '${REPO_ROOT}/src/renderer/src/stores/previewPaneStore'
import { useWorkbenchStore } from '${REPO_ROOT}/src/renderer/src/stores/workbenchStore'

const CONV = 'conv_probe'
const WS = '${WS.replace(/\\/g, '/')}'

installThemeVars()
applyThemeAttr('light')

function Probe() {
  usePreviewPaneSync(CONV, WS)
  return (
    <WorkbenchPane
      conversationId={CONV}
      chatAreaWidth={900}
      plan={null}
      highlightPlanNodeId={null}
      browserPane={{ visible: false, width: 0, conversationId: null, tabs: [] }}
      onBrowserAction={() => {}}
      onBrowserWidth={() => {}}
    />
  )
}
createRoot(document.getElementById('root')).render(
  <ConfigProvider>
    <TranslationProvider initialLocale="zh">
      <Probe />
    </TranslationProvider>
  </ConfigProvider>,
)

window.__stores = { preview: usePreviewPaneStore, workbench: useWorkbenchStore }
// The manual path, driven exactly like WorkspaceTree's onSelect: store call
// from a plain task (a click handler is the same context).
window.__manualOpen = (path) => {
  const s = usePreviewPaneStore.getState()
  s.openFile(CONV, path)
  return s.tabsByConversation[CONV]?.length ?? -1
}
window.__resetPanes = () => {
  const p = usePreviewPaneStore.getState()
  for (const t of p.tabsByConversation[CONV] ?? []) p.closeTab(CONV, t.path)
  useWorkbenchStore.getState().setOpen(CONV, false)
  return true
}
window.__paneState = () => {
  const p = usePreviewPaneStore.getState()
  return {
    open: !!useWorkbenchStore.getState().openByConversation[CONV],
    active: p.activeByConversation[CONV] ?? null,
    tick: p.reloadTicks[p.activeByConversation[CONV] ?? ''] ?? 0,
  }
}
window.__ready = true
`
await build({
  stdin: { contents: HARNESS, resolveDir: REPO_ROOT, loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome120',
  outfile: join(WORK, 'harness-bundle.js'), tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0-probe"' },
  loader: { '.css': 'text', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning', treeShaking: false,
})

// ── 2. the real index.html (CSP meta byte-identical), entry swapped ──
const indexHtml = readFileSync(join(REPO_ROOT, 'src/renderer/index.html'), 'utf-8')
const pageHtml = indexHtml
  .replace(/<script type="module" src="\.\/src\/main\.tsx"><\/script>/, '<script src="./harness-bundle.js"></script>')
if (pageHtml === indexHtml) { console.error('FAIL  no main.tsx entry in index.html'); process.exit(1) }
writeFileSync(join(WORK, 'index.html'), pageHtml)
copyFileSync(join(REPO_ROOT, 'src/renderer/public/platform-boot.js'), join(WORK, 'platform-boot.js'))

// ── 3. fixture main ──
writeFileSync(join(WORK, 'main.js'), `
const { app, BrowserWindow, protocol, ipcMain } = require('electron')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const svc = require('./probe-main.cjs')
app.setPath('userData', join(__dirname, 'ud'))
app.whenReady().then(() => {
  protocol.handle('local-file', (request) => svc.serveLocalFile(request))
  ipcMain.handle('pm:readFile', (_e, p) => svc.svcReadFile(p))
  ipcMain.handle('pm:listDir', (_e, p) => svc.svcListDir(p))
  ipcMain.handle('pm:measure', (e, name, centerX) => svc.measurePreviewFrame(e.sender, name, centerX === true))
  const win = new BrowserWindow({
    width: 1280, height: 720, show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
    },
  })
  globalThis.__pmWin = win
  win.loadFile(join(__dirname, 'index.html'))
})
`)

// ── 4. fixture preload: the production electronAPI surface, real where it
//      matters, over real IPC channels ──
writeFileSync(join(WORK, 'preload-src.ts'), `
import { contextBridge, ipcRenderer } from 'electron'
const api: Record<string, unknown> = {
  readFile: (p: string) => ipcRenderer.invoke('pm:readFile', p),
  listDir: (p: string) => ipcRenderer.invoke('pm:listDir', p),
  measurePreviewFrame: (name: string, centerX?: boolean) => ipcRenderer.invoke('pm:measure', name, centerX === true),
  onAgentSessionEvent: (cb: (ev: { sessionId: string; data: unknown }) => void) => {
    const listener = (_e: unknown, payload: { sessionId: string; data: unknown }) => cb(payload)
    ipcRenderer.on('pm:agent-event', listener)
    return () => { ipcRenderer.removeListener('pm:agent-event', listener) }
  },
  agentSessionEngineCall: () => Promise.resolve(null),
  deletePath: () => Promise.resolve({ success: false }),
  openFolder: () => Promise.resolve({ success: false }),
  statPath: () => Promise.resolve(null),
}
// contextBridge copies values across worlds — a Proxy target made expose
// fail silently (page saw no electronAPI at all), so expose a plain object.
// Every method the mounted component graph can touch in this fixture; a
// missing one throws synchronously inside an effect and React tears down the
// whole root (FileInfoBar's getFileStat taught this the hard way).
const noop = () => Promise.resolve(undefined)
for (const k of ['getFileStat', 'statPath', 'readFileBinary', 'writeFile', 'convertFileToMarkdown',
  'deletePath', 'openFolder', 'registerPreviewNonce', 'agentSessionEngineCall', 'saveBase64Image',
  'copyFileToTmp', 'copyFile', 'browserHistoryQuery', 'browserHistoryClear', 'browserFavoriteQuery',
  'browserFavoriteRemove', 'browserFavoriteList', 'browserFavoriteHas', 'browserFavoriteAdd',
  'listSkills', 'listMcpServers', 'listTools', 'getSettings']) api[k] = noop
api.getSettings = () => Promise.resolve({ activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '', workspaceDir: '', autoCleanup: true, locale: 'zh' })
api.onBrowserPaneUpdate = () => () => {}
contextBridge.exposeInMainWorld('electronAPI', api)
`)
await build({
  entryPoints: [join(WORK, 'preload-src.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['electron'],
  outfile: join(WORK, 'preload.cjs'), logLevel: 'silent',
})

// ── 5. run ──
const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Fire a write the way production orders it: tool_start (input known) →
 *  tool executes on disk → tool_status completed. */
async function fireWrite(page, id, path, content, append) {
  await page.evaluate(() => undefined) // flush
  await electronApp.evaluate(({ BrowserWindow }, [sid, payload]) => {
    BrowserWindow.getAllWindows()[0].webContents.send('pm:agent-event', { sessionId: sid, data: payload })
  }, ['conv_probe', { type: 'tool_start', toolUseId: id, name: 'write', input: { file_path: path, content: '(omitted)', append: !!append } }])
  await sleep(60)
  writeFileSync(path, content, append ? { flag: 'a' } : undefined)
  await electronApp.evaluate(({ BrowserWindow }, [sid, payload]) => {
    BrowserWindow.getAllWindows()[0].webContents.send('pm:agent-event', { sessionId: sid, data: payload })
  }, ['conv_probe', { type: 'tool_status', updates: [{ messageId: 'm_' + id, toolUseId: id, status: 'completed' }] }])
}

/** The document the frame actually shows, read through the REAL measure
 *  channel (the app's own zoom lever) — n = body text length. */
async function frameBody(page, urlPrefix) {
  const fr = page.frames().find((f) => f.url().startsWith(urlPrefix))
  if (!fr) return { found: false }
  try {
    const r = await fr.evaluate(() => ({ t: document.title, n: document.body ? document.body.innerText.length : -1, rs: document.readyState }))
    return { found: true, ...r }
  } catch (e) {
    return { found: true, error: String(e).slice(0, 120) }
  }
}
async function measureViaMain(frameName) {
  return electronApp.evaluate(({ BrowserWindow }, name) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents
    const find = (fr) => { if (fr.name === name) return fr; for (const c of fr.frames) { const h = find(c); if (h) return h } }
    const fr = find(wc.mainFrame)
    if (!fr) return { found: false }
    return fr.executeJavaScript('JSON.stringify({n: document.body ? document.body.innerText.length : -1, rs: document.readyState})', false)
      .then((raw) => ({ found: true, ...JSON.parse(raw) }))
      .catch((e) => ({ found: true, error: String(e).slice(0, 120) }))
  }, frameName)
}

let electronApp = null
try {
  electronApp = await electron.launch({
    executablePath: require('electron'),
    args: [join(WORK, 'main.js')],
    env: { ...process.env, HOME, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  })
  electronApp.process().stderr.on('data', (d) => console.log('  [main stderr]', String(d).slice(0, 400)))
  const page = await electronApp.firstWindow()
  page.setDefaultTimeout(20000)
  page.on('pageerror', (err) => console.log('  [page error]', err.message))
  await page.waitForFunction(() => window.__ready === true)
  await page.waitForTimeout(300)

  const settle = async (prefix) => {
    for (let i = 0; i < 40; i++) {
      const r = await frameBody(page, prefix)
      if (r.found && r.rs === 'complete' && r.n > 0) return r
      await sleep(100)
    }
    return frameBody(page, prefix)
  }

  // ── A1: the AUTO path. Workbench closed. One write → open+tick in the same
  //      IPC callback. ──
  const htmlPath = join(WS, '金融九问-一页纸精华.html')
  const synthetic = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>链路探针</title>
<style>body{margin:0;padding:24px;font-family:sans-serif}h1{color:#c7000b}</style></head>
<body><h1>金融九问 · 自动打开链路探针</h1>${'<p>正文段落，确认帧真的渲染了文档。</p>'.repeat(40)}</body></html>`
  console.log('== A1 自动路径（工作台冷挂载）==')
  await fireWrite(page, 'u1', htmlPath, synthetic, false)
  await page.waitForTimeout(400)
  console.log('  pane:', JSON.stringify(await page.evaluate(() => window.__paneState())))
  const a1 = await settle('local-file://')
  check('A1 auto-open delivers the document into the iframe', a1.n > 100, JSON.stringify(a1))

  // ── A2: append storm like the real session (1 full + 3 appends in ~80s) ──
  console.log('== A2 追加写入风暴 ==')
  await page.evaluate(() => window.__resetPanes())
  await page.waitForTimeout(200)
  const finalBody = synthetic.replace('链路探针', '链路探针 final')
  await fireWrite(page, 'u2', htmlPath, synthetic.slice(0, synthetic.indexOf('</head>') + 7), false)
  await fireWrite(page, 'u3', htmlPath, '<body><h1>金融九问 · 追加中</h1>', true)
  await fireWrite(page, 'u4', htmlPath, finalBody.slice(synthetic.indexOf('<body>') + 6, synthetic.indexOf('</body>')), true)
  await fireWrite(page, 'u5', htmlPath, '</body></html>', true)
  await page.waitForTimeout(600)
  console.log('  pane:', JSON.stringify(await page.evaluate(() => window.__paneState())))
  const a2 = await settle('local-file://')
  check('A2 append sequence (4 writes) ends on the complete document', a2.n > 100, JSON.stringify(a2))

  // ── A3: the MANUAL path (works after restart per the user). Workbench
  //      open with no tabs (the tree is showing), then a click-style open. ──
  console.log('== A3 手动路径（工作台已开，树点击）==')
  await page.evaluate(() => window.__resetPanes())
  await page.evaluate(() => window.__stores.workbench.getState().openTab('conv_probe', 'workspace'))
  await page.waitForTimeout(300)
  const before = await measureViaMain('none-such')
  await page.evaluate((p) => window.__manualOpen(p), htmlPath)
  await page.waitForTimeout(400)
  const a3 = await settle('local-file://')
  check('A3 manual open (pane already mounted) delivers the document', a3.n > 100, JSON.stringify(a3))
  check('A3 negative control: no such frame reads as not-found', before.found === false, JSON.stringify(before))

  await page.waitForTimeout(400)
  await page.screenshot({ path: join(WORK, 'shot.png') })
  console.log(`  screenshot: ${join(WORK, 'shot.png')}`)
} catch (err) {
  check('probe run to completion', false, String((err && err.stack) || err).slice(0, 800))
} finally {
  if (electronApp) await electronApp.close().catch(() => {})
}
try { rmSync(HOME, { recursive: true, force: true }) } catch { /* temp */ }

const failed = results.filter((x) => !x.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
