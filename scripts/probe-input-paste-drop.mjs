/**
 * Quick-attach probe: paste / drag-drop files into the composer (real Chromium).
 *
 * The feature (PLAN-quick-attach, 2026-09-24): paste a Finder-copied file, a
 * clipboard screenshot, or a `file://` URL — or drag any of them from the OS —
 * and they land as the SAME attachment chips the file-picker buttons fill, so
 * `buildMessage` emits the usual `[file:]` / `[folder:]` markers. Everything
 * else about the composer must be untouched: plain-text paste still pastes
 * (i.e. is NOT default-prevented), a text-only drag is not claimed, and the
 * reuse sites (routine run / form assist / tool studio, `features` without
 * `attachments`) get neither.
 *
 * Playwright cannot create a real OS file drag or a real clipboard image, so
 * every event here is synthesized: `new DataTransfer()` carrying JS-built
 * `File`s, then `new ClipboardEvent('paste', { clipboardData })` /
 * `new DragEvent(…)` with the transfer, dispatched at the real components.
 * A JS-built File has no disk backing either, so each file spec carries its
 * path in ONE of two shapes, mirroring how it arrives in the real app —
 * `spec.bridgePath` sets NO `.path` (an Electron 33 File has none: the
 * runtime `File.path` was removed, and reading it is exactly what silently
 * dropped every paste until this feature's fix — only the stub's
 * `getPathForFile`, the simulated preload webUtils bridge, can resolve it);
 * `spec.path` sets the legacy `.path` expando, for which the stub answers
 * `''`, so ONLY InputArea's `|| file.path` fallback can deliver it. Each
 * half of `A || B` therefore fails its own cases if removed, and
 * `__pathCalls` records every consultation (including `hasPath`, the
 * Electron-33 fact). A screenshot blob marks neither: the bridge returns
 * `''` and the image branch runs. Two consequences worth
 * knowing while reading the assertions:
 *
 *   - an UNTRUSTED paste never performs its default action, so "the text
 *     landed in the textarea" is not observable here — the observable that
 *     maps 1:1 onto the trusted case is `dispatchEvent()`'s return: false
 *     means OUR code called preventDefault (and blocked the insertion), true
 *     means the browser is free to insert. Same for the window guard: a
 *     prevented drop is the exact thing that stops a trusted drop's
 *     file:// navigation;
 *   - `FileReader`/`saveBase64Image` are real paths through the stub, so the
 *     screenshot case measures the base64 actually handed over (raw, no
 *     `data:` prefix — main's `compressBase64` would Buffer.from it as-is).
 *
 * Non-vacuity is mostly built in: the window guard is uninstalled and
 * reinstalled inside the probe (its own baseline is measured), and the
 * stopPropagation contract is measured on BOTH sides in one run — the
 * attachments-off composer dispatches the same file drag WITHOUT
 * stopPropagation and its event does reach a window-level spy, while the live
 * composer's dragenter/dragover/drop never do. Source mutations are recorded
 * in `_task/20260924/PLAN-quick-attach.md`: removing InputArea's `onPaste`
 * interception fails the paste section; removing a drag handler's
 * `stopPropagation` fails the window-spy checks (the gated positive control
 * proves the spy counts); removing `installFileDropGuard` fails the body-drop
 * check.
 *
 * Two measured facts about the instruments worth keeping: Chromium honors the
 * `DragEvent`/`ClipboardEvent` init dicts (`ev.dataTransfer === dt`), and it
 * IGNORES `dropEffect` writes on a synthetic DataTransfer with no live drag
 * session (`dt.dropEffect = 'copy'` reads back `'none'`) — so `dropEffect`
 * itself is not assertable here; "did the event reach window" is the
 * observable that maps onto it.
 *
 * No Electron, no LLM, no extension: `window.electronAPI` is a recording
 * stub, so this cannot touch a real session. What the stub CANNOT prove is
 * the runtime itself (a real File having no `.path`, webUtils through the
 * real contextBridge, trusted paste default actions) — that contract has a
 * sibling probe: `node scripts/probe-quick-attach-electron.mjs`.
 *
 * Usage: node scripts/probe-input-paste-drop.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-quick-attach-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-quick-attach-shots')

// PNG magic — the bytes the screenshot paste hands to saveBase64Image; the
// expected raw base64 is computed here and compared inside the page.
const PNG_BYTES = [137, 80, 78, 71, 13, 10, 26, 10]
const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { InputArea } from './src/renderer/src/components/chat/InputArea'
import { installFileDropGuard } from './src/renderer/src/utils/file-drop-guard'

// main.tsx boot order: the variable sheet, then the attribute (a surface that
// reads var(--pm-*) with no sheet measures a page the app never renders).
installThemeVars()
applyThemeAttr('light')

// Recording stub: getFileStat routes by whether the basename carries a dot
// (the probe's paths obey that: /tmp/docs is the directory case), and
// saveBase64Image accepts everything and parks it at a fixed tmp path whose
// stat then says "file". expertList answers [] so InputArea's mount effect
// resolves a list rather than undefined (experts.filter would throw).
window.__statCalls = []
window.__saved = []
window.__pathCalls = []
window.electronAPI = new Proxy({}, {
  get: (_t, key) => {
    if (key === 'expertList') return () => Promise.resolve([])
    // The simulated preload bridge (real code: webUtils.getPathForFile).
    // Answers ONLY spec.bridgePath — the header's two-shapes rule. This must
    // be an explicit branch, NOT the proxy's default: that default returns a
    // truthy Promise, which would silently satisfy "bridge || file.path" and
    // hide a broken bridge call.
    if (key === 'getPathForFile') return (f) => {
      const entry = { name: f.name, hasPath: !!f.path, bridge: f.__bridgePath ?? '' }
      window.__pathCalls.push(entry)
      return entry.bridge
    }
    if (key === 'getFileStat') return (p) => {
      window.__statCalls.push(p)
      const base = p.split('/').pop()
      return Promise.resolve({ size: 10, birthtime: '2026-01-01T00:00:00.000Z', mtime: '2026-01-01T00:00:00.000Z', isDirectory: !base.includes('.') })
    }
    if (key === 'saveBase64Image') return (d) => {
      window.__saved.push(d)
      return Promise.resolve({ success: true, path: '/tmp/pm-shot.jpg' })
    }
    return () => Promise.resolve(undefined)
  },
})

// App.tsx installs the same guard once; kept handleable so the probe can take
// its own before/after baseline without a second page.
window.__installGuard = () => { window.__uninstallGuard = installFileDropGuard(window) }
window.__uninstallGuard = installFileDropGuard(window)

// A window-level SPY on the same three event names the guard listens to. The
// composer's contract is "dragenter/dragover/drop stopPropagation at the React
// root, so the guard's later bubble-phase dropEffect='none' write never runs"
// — and the only way to observe THAT (Chromium ignores dropEffect writes on a
// synthetic DataTransfer with no live drag session: measured,
// "dt.dropEffect = 'copy'" reads back "none") is to count whether the event
// reaches window at all. The gated (attachments-off) composer is the built-in
// positive control: same dispatch, no stopPropagation, spy increments.
window.__winSpy = { dragenter: 0, dragover: 0, drop: 0 }
for (const t of ['dragenter', 'dragover', 'drop']) {
  window.addEventListener(t, () => { window.__winSpy[t]++ })
}
window.__spy = () => Object.assign({}, window.__winSpy)

/** Synthesized paste at a case's textarea. files: [{name, path?, bridgePath?,
 *  bytes?, mime?}] — bridgePath resolves ONLY through the getPathForFile
 *  stub (Electron-33 shape), path ONLY through the legacy .path fallback
 *  (see the header); text: string | null (sets text/plain). Returns false
 *  when default was prevented — i.e. when quick-attach claimed the event. */
window.__paste = (cid, files, text) => {
  const ta = document.querySelector('[data-case=' + cid + '] textarea')
  const dt = new DataTransfer()
  for (const spec of files) {
    const f = new File([new Uint8Array(spec.bytes || [1, 2, 3])], spec.name, { type: spec.mime || 'application/octet-stream' })
    if (spec.path) f.path = spec.path
    if (spec.bridgePath) f.__bridgePath = spec.bridgePath
    dt.items.add(f)
  }
  if (text !== null && text !== undefined) dt.setData('text/plain', text)
  let ev = null
  try { ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }) } catch (e) { ev = null }
  if (!ev) ev = new Event('paste', { bubbles: true, cancelable: true })
  if (!ev.clipboardData) Object.defineProperty(ev, 'clipboardData', { value: dt })
  return ta.dispatchEvent(ev)
}

/** Synthesized drag event. which: 'card' | 'textarea'; kind: 'files' | 'text'.
 *  Returns { notPrevented, dropEffect, types }. */
window.__drag = (cid, type, which, kind, spec) => {
  const root = document.querySelector('[data-case=' + cid + ']')
  const el = which === 'textarea' ? root.querySelector('textarea') : root.querySelector('.ant-sender')
  const dt = new DataTransfer()
  if (kind === 'files') {
    const f = new File([new Uint8Array([9, 9, 9])], spec.name, { type: spec.mime || 'application/octet-stream' })
    if (spec.path) f.path = spec.path
    if (spec.bridgePath) f.__bridgePath = spec.bridgePath
    dt.items.add(f)
  } else {
    dt.setData('text/plain', spec.text || 'dragged text')
  }
  let ev = null
  try { ev = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }) } catch (e) { ev = null }
  if (!ev) ev = new MouseEvent(type, { bubbles: true, cancelable: true })
  if (!ev.dataTransfer) Object.defineProperty(ev, 'dataTransfer', { value: dt })
  const notPrevented = el.dispatchEvent(ev)
  return { notPrevented, dropEffect: dt.dropEffect, types: Array.from(dt.types) }
}

/** A drag straight at document.body (outside every case), for the guard. */
window.__bodyDrop = (kind) => {
  const dt = new DataTransfer()
  if (kind === 'files') {
    const f = new File([new Uint8Array([7])], 'stray.pdf', { type: 'application/pdf' })
    f.path = '/tmp/stray.pdf'
    dt.items.add(f)
  } else {
    dt.setData('text/plain', 'nope')
  }
  let ev = null
  try { ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }) } catch (e) { ev = null }
  if (!ev) ev = new MouseEvent('drop', { bubbles: true, cancelable: true })
  if (!ev.dataTransfer) Object.defineProperty(ev, 'dataTransfer', { value: dt })
  return document.body.dispatchEvent(ev)
}

/** Attachment chips as the user counts them: a span carrying a file/folder
 *  icon AND a close affordance, innermost-first (a wrapping span would have
 *  every chip's text, so name equality alone double-counts). */
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
    return {
      kind: s.querySelector('.anticon-folder') ? 'folder' : 'file',
      name: name.textContent,
    }
  })
}
window.__hint = (cid) => {
  const el = document.querySelector('[data-case=' + cid + '] [data-drop-hint]')
  return el ? el.textContent : null
}
window.__border = (cid) => getComputedStyle(document.querySelector('[data-case=' + cid + '] .ant-sender')).borderStyle
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
    <div style={{ width: 1000, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 32 }}>
      <Case id="paste" />
      <Case id="drag" />
      <Case id="off" features={{ modelPicker: true, authorization: true }} />
    </div>
  </TranslationProvider>
)
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning', treeShaking: false,
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction('window.__ready === true')

const ev = (fn, ...args) => page.evaluate(fn, ...args)
const paste = (cid, files, text) => page.evaluate(([c, f, t]) => window.__paste(c, f, t), [cid, files, text ?? null])
const drag = (cid, type, which, kind, spec) => page.evaluate(([c, ty, w, k, s]) => window.__drag(c, ty, w, k, s), [cid, type, which, kind, spec])
const chips = (cid) => page.evaluate((c) => window.__chips(c), cid)
const hint = (cid) => page.evaluate((c) => window.__hint(c), cid)
const border = (cid) => page.evaluate((c) => window.__border(c), cid)
const value = (cid) => page.evaluate((c) => window.__value(c), cid)
const waitChips = (cid, n) => page.waitForFunction(([c, k]) => window.__chips(c).length >= k, [cid, n])
const waitChipsNamed = (cid, name, k) => page.waitForFunction(([c, nm, k2]) => window.__chips(c).filter((x) => x.name === nm).length >= k2, [cid, name, k])
const statCalls = () => page.evaluate(() => window.__statCalls.slice())
const savedB64 = () => page.evaluate(() => window.__saved.slice())
const pathCalls = () => page.evaluate(() => window.__pathCalls.slice())
const dragCase = { bridgePath: '/tmp/dropped.pdf', name: 'dropped.pdf' }

console.log('── 粘贴：Finder 复制的文件（Electron 33 形态：无 File.path，只靠 getPathForFile 桥）──')
const p1 = await paste('paste', [{ name: 'report.pdf', bridgePath: '/tmp/report.pdf' }], null)
check('文件粘贴被接管（default prevented）', p1 === false, `dispatchEvent=${p1}`)
await waitChips('paste', 1)
const c1 = await chips('paste')
console.log(`  [measured] chips=${JSON.stringify(c1)}`)
check('落成文件 chip（文件夹图标判别正确）', c1.length === 1 && c1[0].kind === 'file' && c1[0].name === 'report.pdf', JSON.stringify(c1[0]))
check('输入框文本未被插入', (await value('paste')) === '', `value="${await value('paste')}"`)
check('路径经过 getFileStat 路由', (await statCalls()).includes('/tmp/report.pdf'))
const pc1 = await pathCalls()
console.log(`  [measured] pathCalls=${JSON.stringify(pc1)}`)
check('getPathForFile 被咨询且解析到桥路径（File 本身无 .path）',
  pc1.some((x) => x.name === 'report.pdf' && x.hasPath === false && x.bridge === '/tmp/report.pdf'),
  JSON.stringify(pc1))

console.log('── 粘贴：文件夹 ──')
await paste('paste', [{ name: 'docs', path: '/tmp/docs' }], null)
await waitChips('paste', 2)
const c2 = await chips('paste')
// The header renders selectedFolders BEFORE selectedFiles (markup order), so
// chip indexes shift once a folder exists — assert by name+kind, never index.
check('目录路径落成文件夹 chip', c2.some((x) => x.kind === 'folder' && x.name === 'docs'), JSON.stringify(c2))
const pc2 = await pathCalls()
check('文件夹案例走的是回退：桥返回空串、.path 生效',
  pc2.some((x) => x.name === 'docs' && x.hasPath === true && x.bridge === ''), JSON.stringify(pc2.slice(-2)))

console.log('── 粘贴：剪贴板截图（无 path 的图片 blob）──')
const p3 = await paste('paste', [{ name: 'shot.png', bytes: PNG_BYTES, mime: 'image/png' }], null)
check('图片 blob 粘贴也被接管', p3 === false)
await waitChips('paste', 3)
const c3 = await chips('paste')
const saved = await savedB64()
console.log(`  [measured] saveBase64Image called ${saved.length}x, first=${(saved[0] || '').slice(0, 24)}…`)
check('截图落到 tmp 路径的 chip', c3.some((x) => x.kind === 'file' && x.name === 'pm-shot.jpg'), JSON.stringify(c3))
check('saveBase64Image 收到裸 base64（无 data: 前缀）', saved.length === 1 && !saved[0].startsWith('data:') && saved[0] === PNG_B64, `len=${saved[0]?.length}`)

console.log('── 粘贴：file:// 文本 ──')
const p4 = await paste('paste', [], 'file:///tmp/notes/a%20b.pdf')
check('file:// 文本被接管', p4 === false, `dispatchEvent=${p4}`)
await waitChipsNamed('paste', 'a b.pdf', 1)
check('解码后落成 chip（%20 → 空格）', (await chips('paste')).some((x) => x.name === 'a b.pdf'))
check('file:// 文本没有同时插进输入框', (await value('paste')) === '')

console.log('── 粘贴：普通文本不被拦截 ──')
const beforePlain = (await chips('paste')).length
const p5 = await paste('paste', [], 'hello world')
check('普通文本保持默认行为（未被 preventDefault）', p5 === true, `dispatchEvent=${p5}`)
await page.waitForTimeout(120)
check('普通文本不产生 chip', (await chips('paste')).length === beforePlain, `chips ${beforePlain} → ${(await chips('paste')).length}`)

console.log('── 粘贴：同一路径去重 ──')
await paste('paste', [{ name: 'dup.pdf', path: '/tmp/dup.pdf' }], null)
await waitChipsNamed('paste', 'dup.pdf', 1)
await paste('paste', [{ name: 'dup.pdf', path: '/tmp/dup.pdf' }], null)
await page.waitForTimeout(150)
const dupCount = (await chips('paste')).filter((x) => x.name === 'dup.pdf').length
check('同一路径粘贴两次只有一枚 chip', dupCount === 1, `count=${dupCount}`)

console.log('── attachments 关闭的复用站点（features 不含 attachments）──')
const o1 = await paste('off', [{ name: 'x.pdf', path: '/tmp/x.pdf' }], null)
check('关闭时粘贴完全放行（不接管）', o1 === true, `dispatchEvent=${o1}`)
await page.waitForTimeout(120)
check('关闭时粘贴不落 chip', (await chips('off')).length === 0)
await drag('off', 'dragenter', 'card', 'files', { name: 'x.pdf', path: '/tmp/x.pdf' })
check('关闭时拖拽不高亮（无提示 pill）', (await hint('off')) === null)
check('关闭时拖拽不接管（边框保持 solid）', (await border('off')) === 'solid')
// Built-in positive control for the spy below: the GATED composer's handler
// returns early (no stopPropagation), so the same file drag must reach window.
const offSpyBefore = await ev(() => window.__spy())
await drag('off', 'dragover', 'card', 'files', { name: 'x.pdf', path: '/tmp/x.pdf' })
const offSpyAfter = await ev(() => window.__spy())
check('（对照）关闭态的 dragover 冒泡到 window — 证明监听器有效', offSpyAfter.dragover === offSpyBefore.dragover + 1, `dragover ${offSpyBefore.dragover} → ${offSpyAfter.dragover}`)

console.log('── 拖拽：高亮 + stopPropagation 挡住 window guard ──')
const spyB = await ev(() => window.__spy())
const dEnter = await drag('drag', 'dragenter', 'card', 'files', dragCase)
check('文件拖入 → 提示 pill 出现', (await hint('drag')) === '松开添加为引用', `hint=${await hint('drag')}`)
check('文件拖入 → 输入卡边框变 dashed', (await border('drag')) === 'dashed', `border=${await border('drag')}`)
const dOver = await drag('drag', 'dragover', 'card', 'files', dragCase)
console.log(`  [measured] dragover notPrevented=${dOver.notPrevented} types=${JSON.stringify(dOver.types)} enterTypes=${JSON.stringify(dEnter.types)}`)
check('dragover 被 preventDefault（允许放置）', dOver.notPrevented === false)
// The load-bearing contract, on its observable: dragenter/dragover must die at
// the React root, or the window guard's bubble-phase handler runs right after
// ours and writes dropEffect='none' over our 'copy' (forbidden cursor
// mid-drag). dropEffect itself cannot be read back synthetically — see the
// spy's comment — so "did window see it" IS the check. The off-case above is
// the same dispatch without stopPropagation, and it did.
const spyA = await ev(() => window.__spy())
console.log(`  [measured] spy ${JSON.stringify(spyB)} → ${JSON.stringify(spyA)}`)
check('composer 的 dragenter/dragover 不冒泡到 window（stopPropagation 生效）',
  spyA.dragenter === spyB.dragenter && spyA.dragover === spyB.dragover,
  `dragenter Δ${spyA.dragenter - spyB.dragenter} dragover Δ${spyA.dragover - spyB.dragover}`)
mkdirSync(SHOTS, { recursive: true })
await page.screenshot({ path: join(SHOTS, 'drag-highlight.png') })

console.log('── 拖拽：深度计数（跨子元素不闪）──')
await drag('drag', 'dragenter', 'textarea', 'files', dragCase)
check('进入子元素仍在拖拽态', (await hint('drag')) !== null)
await drag('drag', 'dragleave', 'textarea', 'files', dragCase)
check('离开子元素不熄灭高亮（计数器 depth 仍在）', (await hint('drag')) !== null && (await border('drag')) === 'dashed')
await drag('drag', 'dragleave', 'card', 'files', dragCase)
check('离开卡片熄灭高亮', (await hint('drag')) === null, `hint=${await hint('drag')}`)
check('熄灭后边框回到 solid', (await border('drag')) === 'solid')

console.log('── 拖拽：松开落 chip + 焦点回输入框 ──')
const spyDropB = await ev(() => window.__spy())
const dDrop = await drag('drag', 'drop', 'card', 'files', dragCase)
const spyDropA = await ev(() => window.__spy())
check('drop 被接管（default prevented）', dDrop.notPrevented === false)
check('drop 也不冒泡到 window（guard 不会二次处理已认领的放置）', spyDropA.drop === spyDropB.drop, `drop Δ${spyDropA.drop - spyDropB.drop}`)
await waitChipsNamed('drag', 'dropped.pdf', 1)
check('松开落成文件 chip', (await chips('drag')).some((x) => x.name === 'dropped.pdf'))
const pc3 = await pathCalls()
check('drop 也先咨询 getPathForFile 桥（File 无 .path、只靠桥解析）',
  pc3.some((x) => x.name === 'dropped.pdf' && x.hasPath === false && x.bridge === '/tmp/dropped.pdf'),
  JSON.stringify(pc3.slice(-3)))
check('drop 后提示 pill 消失', (await hint('drag')) === null)
check('焦点回到输入框', await page.evaluate(() => window.__focusIsTextarea('drag')))

console.log('── 拖拽：同一路径去重 ──')
await drag('drag', 'drop', 'card', 'files', dragCase)
await page.waitForTimeout(150)
const dropDup = (await chips('drag')).filter((x) => x.name === 'dropped.pdf').length
check('同一路径拖两次只有一枚 chip', dropDup === 1, `count=${dropDup}`)

console.log('── 拖拽：纯文本拖拽（侧栏排序那类）不接管 ──')
const spyTextB = await ev(() => window.__spy())
const tOver = await drag('drag', 'dragover', 'card', 'text', { text: 'proj' })
const spyTextA = await ev(() => window.__spy())
console.log(`  [measured] text-only notPrevented=${tOver.notPrevented} types=${JSON.stringify(tOver.types)}`)
check('纯文本 dragover 不被接管（不 preventDefault）', tOver.notPrevented === true)
// Same observable as the file-drag section, mirrored: a NON-file drag must
// reach window (no stopPropagation — nothing was claimed), and the guard then
// ignores it because types carries no 'Files'. The dropEffect write itself is
// unobservable synthetically (see the spy comment), so "it kept bubbling" is
// the contract's readable half.
check('纯文本拖拽未被认领（照常冒泡到 window）', spyTextA.dragover === spyTextB.dragover + 1, `dragover ${spyTextB.dragover} → ${spyTextA.dragover}`)
check('纯文本拖拽不高亮', (await hint('drag')) === null && (await border('drag')) === 'solid')

console.log('── window guard：吞掉窗口任意位置的文件 drop ──')
// Own baseline: uninstall → the same drop is NOT prevented (and would navigate
// on a trusted gesture); reinstall → prevented. So the check cannot pass
// vacuously just because untrusted drops never navigate by themselves.
await ev(() => window.__uninstallGuard())
const gOff = await ev(() => window.__bodyDrop('files'))
check('（基线）guard 卸下后 body 的文件 drop 不被吞', gOff === true, `dispatchEvent=${gOff}`)
await ev(() => window.__installGuard())
const urlBefore = page.url()
const gOn = await ev(() => window.__bodyDrop('files'))
check('guard 装上后 body 的文件 drop 被吞', gOn === false, `dispatchEvent=${gOn}`)
check('页面没有被导航走', page.url() === urlBefore, page.url())
const gText = await ev(() => window.__bodyDrop('text'))
check('纯文本 drop 不被 guard 吞（只管文件）', gText === true, `dispatchEvent=${gText}`)

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
