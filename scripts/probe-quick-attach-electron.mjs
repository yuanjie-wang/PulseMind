/**
 * Quick-attach under REAL Electron — the runtime contract its sibling probe
 * (`probe-input-paste-drop.mjs`) can only stub. That probe is green on synthetic
 * events; the shipped feature still did nothing, because two runtime facts live
 * underneath it and no Chromium harness can see either:
 *
 *   1. Electron 33 removed the runtime `File.path` — a REAL pasted/dropped File
 *      reads `undefined` there (the ambient `interface File { path: string }`
 *      in electron.d.ts still declares it, so TypeScript accepted the old
 *      `if (file.path)` while every real file fell through to a silent
 *      `continue`. That WAS 「粘贴/拖拽后没有引用」);
 *   2. the only remaining source is `webUtils.getPathForFile`, which must
 *      survive the trip through contextBridge under the app's exact
 *      `sandbox: true` webPreferences.
 *
 * So this probe loads the REAL preload (esbuild of `src/preload/index.ts`,
 * bundled like `scripts/build.js` does: only `electron` external) into a
 * fixture window whose webPreferences are verbatim the app's, mounts the REAL
 * InputArea, and drives REAL trusted paste commands: the main process writes
 * the OS clipboard (`public.file-url` for a file — macOS; `clipboard.write`
 * for images/text) and calls `webContents.paste()`. Consequences of going
 * trusted, which is the whole point of paying for Electron here:
 *
 *   - a capture-phase recorder sees the actual File — `path` (expect
 *     NO_PATH_PROP) and the bridge resolution, both read synchronously before
 *     dispatch (a DataTransfer read AFTER the event returns is emptied —
 *     measured);
 *   - `e.defaultPrevented` and the textarea's value are the real default
 *     action: a file paste leaves the input empty, a plain-text paste lands
 *     its text — the 1:1 observable the untrusted Chromium probe can only
 *     approximate via dispatchEvent()'s return;
 *   - `isTrusted` itself is assertable.
 *
 * The drop half uses a File with a genuine disk backing made the only way a
 * driver can: `page.setInputFiles` (CDP hands the File real backing, unlike
 * `new File()`), then synthetic drag events hand it to the composer — event
 * MECHANICS (highlight, stopPropagation, depth counter) stay owned by the
 * Chromium probe; what is new here is a REAL-backed File resolving through
 * the REAL bridge.
 *
 * Fixture main registers only the five channels the composer's paste/drop path
 * invokes (`file:stat`, `expert:list`, `util:save-base64-image`,
 * `app:get-platform-info`, dialog pair defensively) with honest local handlers
 * — main-side handler logic is not under test; no LLM, no user data (userData
 * is redirected into the work dir).
 *
 * Non-vacuity: against the pre-fix InputArea (the `if (file.path)` shape) the
 * file-paste chip check cannot pass — File.path is undefined and nothing else
 * resolves it. Measured, recorded in `_task/20260924/PLAN-quick-attach.md`.
 *
 * Platform: the `public.file-url` file-paste case is macOS; elsewhere it prints
 * SKIP (image / file:// text / plain text / drop cases are cross-platform).
 *
 * Usage: node scripts/probe-quick-attach-electron.mjs
 */
import { build } from 'esbuild'
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const IS_MAC = process.platform === 'darwin'
const WORK = mkdtempSync(join(tmpdir(), 'pm-quick-attach-electron-'))

// 1x1 transparent PNG — the bytes the image-paste hands to saveBase64Image;
// the probe asserts main received them verbatim (raw base64, no data: prefix).
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// Fixture files: names carry a SPACE so the %20 decode path is exercised too.
const ABS_REF = join(WORK, 'ref two.pdf')
const ABS_URL = join(WORK, 'url case.pdf')
const ABS_DROP = join(WORK, 'dropped file.pdf')
for (const p of [ABS_REF, ABS_URL, ABS_DROP]) writeFileSync(p, '%PDF-1.4 fixture\n')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { InputArea } from './src/renderer/src/components/chat/InputArea'
import { installFileDropGuard } from './src/renderer/src/utils/file-drop-guard'

installThemeVars()
applyThemeAttr('light')

// NO electronAPI stub — the REAL preload owns window.electronAPI (including
// getPathForFile over webUtils). The recorder captures each paste
// SYNCHRONOUSLY in the capture phase (a DataTransfer read after dispatch
// returns is emptied — measured), then a document-bubble listener stamps
// defaultPrevented after React's own handler has run (document bubbles after
// the React root container).
window.__lastPaste = null
window.__lastImageFile = null
document.addEventListener('paste', (e) => {
  const cd = e.clipboardData
  const files = Array.from(cd ? cd.files : [])
  const rec = { trusted: e.isTrusted, count: files.length, prevented: null, files: [] }
  for (const f of files) {
    let via = null
    try { via = window.electronAPI.getPathForFile(f) } catch (err) { via = 'THREW: ' + err.message }
    rec.files.push({ name: f.name, type: f.type, path: f.path === undefined ? 'NO_PATH_PROP' : f.path, viaBridge: via })
    if (f.type && f.type.startsWith('image/')) window.__lastImageFile = f
  }
  window.__lastPaste = rec
}, true)
document.addEventListener('paste', (e) => {
  if (window.__lastPaste) window.__lastPaste.prevented = e.defaultPrevented
}, false)

window.__installGuard = () => { window.__uninstallGuard = installFileDropGuard(window) }
window.__uninstallGuard = installFileDropGuard(window)

// A real-backed File, the only way a driver can make one: set files on an
// <input> (CDP gives them genuine disk backing, unlike new File()), then hand
// it to synthetic drag events — the same File shape an OS drag delivers.
window.__setupInput = () => {
  if (document.getElementById('__filein')) return
  const i = document.createElement('input')
  i.type = 'file'
  i.id = '__filein'
  i.style.display = 'none'
  document.body.appendChild(i)
}
window.__dropFromInput = (cid) => {
  const f = document.getElementById('__filein').files[0]
  if (!f) return { error: 'no file on input' }
  const dt = new DataTransfer()
  dt.items.add(f)
  const root = document.querySelector('[data-case=' + cid + ']')
  const el = root.querySelector('.ant-sender')
  const out = { steps: {} }
  for (const type of ['dragenter', 'dragover', 'drop']) {
    let ev = null
    try { ev = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }) } catch (e) { ev = null }
    if (!ev) ev = new MouseEvent(type, { bubbles: true, cancelable: true })
    if (!ev.dataTransfer) Object.defineProperty(ev, 'dataTransfer', { value: dt })
    out.steps[type] = el.dispatchEvent(ev) // false = claimed (our handler preventDefault'd)
  }
  out.fPath = f.path === undefined ? 'NO_PATH_PROP' : f.path
  try { out.viaBridge = window.electronAPI.getPathForFile(f) } catch (e) { out.viaBridge = 'THREW: ' + e.message }
  return out
}

/** Attachment chips as the user counts them — same rule as the sibling probe. */
window.__chips = (cid) => {
  const root = document.querySelector('[data-case=' + cid + ']')
  const all = [...root.querySelectorAll('span')].filter((s) => {
    if (!s.querySelector('.anticon-close')) return false
    if (!s.querySelector('.anticon-file') && !s.querySelector('.anticon-folder')) return false
    const name = [...s.children].find((c) => c.tagName === 'SPAN' && !c.className.includes('anticon'))
    return !!name
  })
  return all.filter((s) => !all.some((o) => o !== s && s.contains(o))).map((s) => {
    const name = [...s.children].find((c) => c.tagName === 'SPAN' && !c.className.includes('anticon'))
    return { kind: s.querySelector('.anticon-folder') ? 'folder' : 'file', name: name.textContent }
  })
}
window.__value = (cid) => document.querySelector('[data-case=' + cid + '] textarea').value
window.__focusIsTextarea = (cid) => document.activeElement === document.querySelector('[data-case=' + cid + '] textarea')

function Case({ id, features }) {
  return (
    <div data-case={id} style={{ position: 'relative', background: '#fff', fontFamily: 'system-ui' }}>
      <InputArea
        layout="inline"
        features={features}
        isRequesting={false} isStreaming={false} isAwaitingApproval={false} isAwaitingInput={false}
        hasMessages={true}
        onSendMessage={(v) => { window.__sent = v }}
        onCancel={() => {}}
        onChangeApprovalMode={() => {}}
      />
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <TranslationProvider>
    <div style={{ width: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 32 }}>
      <Case id="paste" />
      <Case id="off" features={{ modelPicker: true, authorization: true }} />
    </div>
  </TranslationProvider>
)
window.__ready = true
`

const FIXTURE_MAIN = `
// Fixture main for probe-quick-attach-electron.mjs: the channels the composer's
// paste/drop path invokes, with honest local handlers (main-side handler logic
// is NOT under test — the renderer's contract is). No LLM, no user data.
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')
const { mkdirSync, statSync, writeFileSync } = require('node:fs')
const os = require('node:os')

app.setPath('userData', join(__dirname, 'ud'))

ipcMain.handle('file:stat', (_e, p) => {
  try {
    const s = statSync(p)
    return { size: s.size, birthtime: s.birthtime.toISOString(), mtime: s.mtime.toISOString(), isDirectory: s.isDirectory() }
  } catch {
    return null
  }
})
ipcMain.handle('expert:list', () => [])
ipcMain.handle('app:get-platform-info', () => ({ platform: process.platform, platformName: process.platform, release: os.release(), arch: process.arch, ripgrepPath: null }))
ipcMain.handle('dialog:show', () => ({ value: null, cancelled: true }))
ipcMain.handle('dialog:show-open', () => ({ filePaths: [], canceled: true }))
ipcMain.handle('util:save-base64-image', (_e, b64) => {
  global.__savedB64 = global.__savedB64 || []
  global.__savedB64.push(b64)
  const dir = join(__dirname, 'saved')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'screenshot_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.png')
  writeFileSync(p, Buffer.from(b64, 'base64'))
  return { success: true, path: p }
})

app.whenReady().then(() => {
  // Verbatim the app window's webPreferences (src/main/index.ts): sandbox:true
  // is the condition the webUtils-through-contextBridge fix was measured under
  // — drift here would silently prove a weaker claim.
  const win = new BrowserWindow({
    width: 1200, height: 900, show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  })
  win.loadFile(join(__dirname, 'page.html'))
})
`

// ── builds: the REAL preload (same recipe as scripts/build.js) + the REAL ──
// ── InputArea harness (same recipe as probe-input-paste-drop.mjs)          ──
await build({
  entryPoints: ['src/preload/index.ts'],
  outfile: join(WORK, 'preload.cjs'),
  bundle: true, minify: false, platform: 'node', target: 'node20', format: 'cjs',
  external: ['electron'], tsconfig: 'tsconfig.node.json',
})
await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: join(WORK, 'harness.js'), tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning', treeShaking: false,
})
writeFileSync(join(WORK, 'main.js'), FIXTURE_MAIN)
// Inline the harness so the page needs zero subresource loads (no route
// interception on an Electron page, no file:// script-origin questions).
const harnessSrc = readFileSync(join(WORK, 'harness.js'), 'utf8').replace(/<\/script>/g, '<\\/script>')
writeFileSync(join(WORK, 'page.html'),
  '<!doctype html><html><body style="margin:0"><div id="root"></div><script>' + harnessSrc + '</script></body></html>')

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const skip = (name, why) => console.log(`  SKIP  ${name} (${why})`)

let electronApp = null
try {
  electronApp = await electron.launch({
    executablePath: require('electron'),
    args: [join(WORK, 'main.js')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  })
  const page = await electronApp.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (err) => console.log('  [page error]', err.message))
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('  [page console]', msg.text()) })

  await page.waitForFunction('window.__ready === true')
  const ev = (fn, ...args) => page.evaluate(fn, ...args)
  const chips = (cid) => ev((c) => window.__chips(c), cid)
  const value = (cid) => ev((c) => window.__value(c), cid)
  const lastPaste = () => ev(() => window.__lastPaste)
  const resetPaste = () => ev(() => { window.__lastPaste = null })
  const focusCase = (cid) => ev((c) => { document.querySelector('[data-case=' + c + '] textarea').focus() }, cid)
  const waitChipNamed = async (cid, name) => {
    try {
      await page.waitForFunction(([c, nm]) => window.__chips(c).some((x) => x.name === nm), [cid, name])
      return true
    } catch { return false }
  }
  const waitChipRe = async (cid, re) => {
    try {
      await page.waitForFunction(([c, src]) => window.__chips(c).some((x) => new RegExp(src).test(x.name)), [cid, re])
      return true
    } catch { return false }
  }
  const paste = () => electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.paste() })

  console.log('── 真 preload ──')
  const bridge = await ev(() => ({
    gpf: typeof window.electronAPI?.getPathForFile,
    stat: typeof window.electronAPI?.getFileStat,
    expert: typeof window.electronAPI?.expertList,
  }))
  check('真 preload 暴露了 getPathForFile/getFileStat/expertList',
    bridge.gpf === 'function' && bridge.stat === 'function' && bridge.expert === 'function', JSON.stringify(bridge))

  console.log('── 粘贴：真 clipboard 文件（public.file-url → webContents.paste，受信事件）──')
  if (IS_MAC) {
    await resetPaste()
    await focusCase('paste')
    await electronApp.evaluate(({ clipboard }, url) => { clipboard.writeBuffer('public.file-url', Buffer.from(url)) }, 'file://' + encodeURI(ABS_REF))
    await paste()
    const gotRef = await waitChipNamed('paste', 'ref two.pdf')
    const rec = await lastPaste()
    console.log(`  [measured] rec=${JSON.stringify(rec)}`)
    check('粘贴事件受信（isTrusted）', rec !== null && rec.trusted === true, JSON.stringify(rec && rec.trusted))
    check('真实 File 运行时没有 .path（根因事实：旧代码在这里读到 undefined）',
      rec !== null && rec.files[0] && rec.files[0].path === 'NO_PATH_PROP', rec && rec.files[0] && rec.files[0].path)
    check('真 webUtils 桥（contextBridge + sandbox:true）解析出真实路径',
      rec !== null && rec.files[0] && rec.files[0].viaBridge === ABS_REF, rec && rec.files[0] && rec.files[0].viaBridge)
    check('chip 落地（回归主断言——修复前这里永不出现）', gotRef, gotRef ? undefined : 'waitChip 超时')
    const v = await value('paste')
    check('受信文件粘贴：文本未插入输入框', v === '', JSON.stringify(v))
  } else {
    skip('文件粘贴五项', 'macOS public.file-url only')
  }

  console.log('── 粘贴：剪贴板图片（无背书 blob → saveBase64Image 真 IPC）──')
  await resetPaste()
  await focusCase('paste')
  await electronApp.evaluate(({ clipboard, nativeImage }, b64) => {
    clipboard.write({ image: nativeImage.createFromBuffer(Buffer.from(b64, 'base64')) })
  }, PNG_B64)
  await paste()
  const gotShot = await waitChipRe('paste', '^screenshot_.*\\.png$')
  const recImg = await lastPaste()
  console.log(`  [measured] rec=${JSON.stringify(recImg)}`)
  check('图片 File 同样无 .path、桥返回空串 → 走图片分支',
    recImg !== null && recImg.count >= 1 && recImg.files[0].path === 'NO_PATH_PROP' && recImg.files[0].viaBridge === '',
    JSON.stringify(recImg && recImg.files[0]))
  check('截图落到 tmp 路径的 chip（fixture 真落盘）', gotShot, gotShot ? undefined : 'waitChip 超时')
  const savedRaw = await electronApp.evaluate(() => (global.__savedB64 || [])[0] ?? null)
  // The contract is "the pasted file's OWN bytes, raw" — not byte-equality
  // with our input constant: nativeImage decodes the PNG to a bitmap and
  // clipboard re-encodes it, so the pasted File legitimately differs from
  // PNG_B64 (measured: prefix same, full equality false). Re-read the captured
  // File through FileReader here — the same instrument InputArea uses.
  const refB64 = await ev(() => new Promise((resolve) => {
    const f = window.__lastImageFile
    if (!f) return resolve(null)
    const r = new FileReader()
    r.onload = () => { const s = String(r.result); return resolve(s.slice(s.indexOf(',') + 1)) }
    r.onerror = () => resolve('READ_ERR')
    r.readAsDataURL(f)
  }))
  check('saveBase64Image 收到裸 base64（无 data: 前缀，等于粘贴文件自身的字节）',
    typeof savedRaw === 'string' && !savedRaw.startsWith('data:') && savedRaw === refB64,
    `savedLen=${typeof savedRaw === 'string' ? savedRaw.length : String(savedRaw)} refLen=${refB64 && refB64.length} eqInput=${savedRaw === PNG_B64}`)

  console.log('── 粘贴：file:// 文本 ──')
  await resetPaste()
  await focusCase('paste')
  await electronApp.evaluate(({ clipboard }, t) => { clipboard.write({ text: t }) }, 'file://' + encodeURI(ABS_URL))
  await paste()
  const gotUrl = await waitChipNamed('paste', 'url case.pdf')
  const recUrl = await lastPaste()
  const vUrl = await value('paste')
  check('纯文本分支（无 files）', recUrl !== null && recUrl.count === 0, JSON.stringify(recUrl))
  check('file:// 文本解码落成 chip（%20 → 空格）', gotUrl, gotUrl ? undefined : 'waitChip 超时')
  check('file:// 文本未同时插入输入框', vUrl === '', JSON.stringify(vUrl))

  console.log('── 粘贴：普通文本（受信默认动作必须保留）──')
  const beforePlain = (await chips('paste')).length
  await resetPaste()
  await focusCase('paste')
  await electronApp.evaluate(({ clipboard }, t) => { clipboard.write({ text: t }) }, 'hello world')
  await paste()
  await page.waitForTimeout(200)
  const vPlain = await value('paste')
  const recPlain = await lastPaste()
  const afterPlain = (await chips('paste')).length
  check('普通文本未被拦截：文字落进输入框（value=hello world）',
    vPlain === 'hello world' && recPlain !== null && recPlain.prevented === false,
    `value=${JSON.stringify(vPlain)} prevented=${recPlain && recPlain.prevented}`)
  check('普通文本不产生 chip', afterPlain === beforePlain, `${beforePlain} → ${afterPlain}`)

  console.log('── attachments 关闭的复用站点（真事件、真闸门）──')
  await resetPaste()
  await focusCase('off')
  await electronApp.evaluate(({ clipboard, nativeImage }, b64) => {
    clipboard.write({ image: nativeImage.createFromBuffer(Buffer.from(b64, 'base64')) })
  }, PNG_B64)
  await paste()
  await page.waitForTimeout(200)
  const recOff = await lastPaste()
  const chipsOff = await chips('off')
  check('关闭时事件到达但未被接管（无 preventDefault、无 chip）',
    recOff !== null && recOff.count >= 1 && recOff.prevented === false && chipsOff.length === 0,
    `rec=${JSON.stringify(recOff)} chips=${chipsOff.length}`)

  console.log('── 拖放：input 背书的真 File → 合成 drag 事件 ──')
  await ev(() => window.__setupInput())
  await page.setInputFiles('#__filein', ABS_DROP)
  const res = await ev(() => window.__dropFromInput('paste'))
  console.log(`  [measured] drop=${JSON.stringify(res)}`)
  check('drop 三段全被接管（preventDefault）',
    res.steps && res.steps.dragenter === false && res.steps.dragover === false && res.steps.drop === false,
    JSON.stringify(res.steps))
  check('真背书 File 同样无 .path、桥解析真路径',
    res.fPath === 'NO_PATH_PROP' && res.viaBridge === ABS_DROP, JSON.stringify({ fPath: res.fPath, viaBridge: res.viaBridge }))
  const gotDrop = await waitChipNamed('paste', 'dropped file.pdf')
  check('drop 落成 chip', gotDrop, gotDrop ? undefined : 'waitChip 超时')
  const focusBack = await ev(() => window.__focusIsTextarea('paste'))
  check('drop 后焦点回输入框', focusBack === true, String(focusBack))
} catch (err) {
  check('探针完整跑完（未抛异常）', false, err && err.message ? err.message : String(err))
} finally {
  if (electronApp) await electronApp.close().catch(() => {})
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed  (work dir: ${WORK})`)
process.exit(failed.length ? 1 : 0)
