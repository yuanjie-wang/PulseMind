/**
 * HTML element-edit probe (PLAN-html-element-edit M6; real Chromium, real mouse).
 *
 * Mounts the production PreviewPane + PreviewContent + ElementEditPanel over
 * a stubbed electronAPI, and replaces each `local-file://…` iframe with a
 * srcdoc twin built by the PRODUCTION transforms (buildPreviewCopy over the
 * fixture, PICKER_SCRIPT injected) so the real picker runs inside a real
 * opaque-origin frame. The stubbed writeFile updates the fixture map — that
 * IS the disk — so a reload re-reads what was written.
 *
 *   1. clicking an element in the frame selects it (pmPath, breadcrumb);
 *   2. a font-size edit patches the file at the RIGHT bytes and the frame
 *      re-renders without a reload;
 *   3. undo restores the original file bytes and remounts the frame;
 *   4. the AI run applies a replacement (SSE stub) and reloads+reselects;
 *   5. an AI that returns a whole document is refused, file untouched;
 *   6. a script-generated element is refused with the generated-content
 *      reason (no source span, D6 — smart resolve cannot match it either);
 *   6b. a STATIC element whose live pmPath shifted (a script inserted a
 *      sibling before it) still edits: the content fallback locates its true
 *      source span and the patch verifies at the source path;
 *   6c. double-click on a text element enters in-place contenteditable
 *       editing and Enter commits it to the file (D7);
 *   6d. double-click on a script-generated text element stays read-only and
 *       names the cause — the parent arbitrates before the frame may edit;
 *   6e. a click INSIDE the text mid-edit is a caret move, not a reselect —
 *       without the picker's editing guard it cleared `editing` and the
 *       commit died in exitEditing's early-return (「无法直接编辑文字」,
 *       measured 2026-09-18);
 *   6f. a pure-text div edits directly: 文本 field commit + double-click
 *       in-place commit (the container case had NO text entry at all);
 *   6g. a p with inline children keeps 就地编辑 (no 文本 field — replace
 *       would flatten the markup) and the commit preserves the <strong>;
 *   7. a strict-CSP meta page still gets a live picker (D2: strip before
 *      inject);
 *   8. an `<a>` click does not navigate (D10);
 *   9. the source editor entry is still there (D2 advanced hatch).
 *
 * Usage: node scripts/probe-html-element-edit.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-html-edit-')), 'harness.js')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { buildAntdTheme } from './src/renderer/src/theme/tokens'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import { usePreviewPaneStore } from './src/renderer/src/stores/previewPaneStore'
import { useHtmlEditStore, consumeFailure } from './src/renderer/src/stores/htmlEditStore'
import { WorkspacePane } from './src/renderer/src/components/workbench/WorkspacePane'
import { buildPreviewCopy } from './src/shared/preview/html-inject'
import { PICKER_SCRIPT } from './src/main/preview/picker-source.generated'

window.__previewNonces = {}
window.__buildFrameDoc = (url) => {
  const m = /^local-file:\\/\\/([^?#]*)?(\\?[^#]*)?/.exec(url)
  const raw = m && m[1] ? decodeURIComponent(m[1]) : '/'
  const query = (m && m[2]) || ''
  const preview = query.includes('pmPreview=1')
  // M10: the per-mount nonce arrives through the main-process registry (the
  // renderer's registerPreviewNonce stub fills this map) — never the URL.
  const nonce = window.__previewNonces[raw]
  const text = window.__files[raw]
  if (text === undefined) return '<body><p style="color:red">404 ' + raw + '</p></body>'
  return preview ? buildPreviewCopy(text, PICKER_SCRIPT, nonce) : text
}

// React sets iframe src as an attribute — rewrite local-file:// to a srcdoc
// twin built by the production transforms. sandbox="allow-scripts" keeps the
// frame opaque-origin, exactly like the app's real cross-origin frame.
const origSet = Element.prototype.setAttribute
Element.prototype.setAttribute = function (name, value) {
  if (this.tagName === 'IFRAME' && name === 'src' && typeof value === 'string' && value.startsWith('local-file://')) {
    return origSet.call(this, 'srcdoc', window.__buildFrameDoc(value))
  }
  return origSet.call(this, name, value)
}

let root = null
window.__mount = () => {
  if (root) root.unmount()
  usePreviewPaneStore.getState().setWorkspaceDir('/w')
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider theme={buildAntdTheme('light')}>
      <SettingsProvider>
        <TranslationProvider initialLocale="zh">
          <WorkspacePane conversationId={undefined} />
        </TranslationProvider>
      </SettingsProvider>
    </ConfigProvider>
  )
  return true
}
window.__store = usePreviewPaneStore
window.__editStore = useHtmlEditStore
window.__consumeFailure = consumeFailure
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome120',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.PROBE_DEV ? 'development' : 'production'), __APP_VERSION__: '"0.0.0-probe"' },
  loader: { '.css': 'text', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
page.on('console', (msg) => {
  if (msg.type() === 'warning' || msg.type() === 'error') console.log('  [console]', msg.text().slice(0, 300))
})
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))

// The fake LLM: an OpenAI-shaped SSE endpoint answering the element-edit task
// with a JSON {html} payload (and, on demand, a whole document — refused).
await page.route('**/chat/completions', async (route) => {
  if (route.request().method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    } })
    return
  }
  const body = route.request().postDataJSON()
  const user = JSON.stringify(body?.messages ?? [])
  const replyDoc = user.includes('返整篇') 
    ? '{"html": "<!DOCTYPE html><html><body>整篇</body></html>"}'
    : '{"html": "<h1 style=\\"color: purple; font-size: 40px\\" id=\\"t\\">AI 改的标题</h1>"}'
  const payload = { id: 'probe', choices: [{ delta: { content: replyDoc }, index: 0 }] }
  await route.fulfill({
    contentType: 'text/event-stream',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`,
  })
})

await page.goto('http://pm-probe.local/')

const FIXTURE = [
  '<!DOCTYPE html>',
  '<html><head><title>Probe</title></head>',
  '<body style="margin:24px">',
  '<div id="hero" class="hero">',
  '<h1 style="color: blue; font-size: 16px" id="t">Hello</h1>',
  '<p>intro paragraph</p>',
  '<a href="http://pm-probe.local/nav">a link away</a>',
  '<div style="height:1200px"></div>',
  '<div id="textdiv" style="font-size:16px">容器里的纯文本</div>',
  '<p id="rich">带 <strong>加粗</strong> 的段落</p>',
  '</div>',
  '<script>document.body.appendChild(Object.assign(document.createElement("div"), {id: "made-by-js", textContent: "runtime"}));',
  'document.body.appendChild(Object.assign(document.createElement("p"), {id: "made-p", textContent: "runtime paragraph"}))</script>',
  '</body></html>',
].join('\n')

// A static page whose LIVE tree disagrees with the source: the script
// inserts a sibling BEFORE #hero, so every later sibling's pmPath index
// shifts by one. Clicking the h1 reports div:nth-child(2); the source has
// it at nth-child(1). Only the content fallback can place it.
const SHIFT_FIXTURE = [
  '<!DOCTYPE html>',
  '<html><head><title>Shift</title></head>',
  '<body style="margin:24px">',
  '<div id="hero"><h1 id="st">Static Title</h1><p>shift page body</p></div>',
  '<script>document.body.insertAdjacentHTML("afterbegin", \'<div id="injected">injected</div>\')</script>',
  '</body></html>',
].join('\n')

const CSP_FIXTURE = [
  '<!DOCTYPE html>',
  '<html><head>',
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'">',
  '<title>Strict</title></head>',
  '<body><h1 id="strict-head">strict page</h1></body>',
  '</html>',
].join('\n')

// The fake LLM's two possible answers, JSON-encoded ONCE here so the page
// script receives plain literals (no quoting survives two languages badly).
// The element reply is a JSON TEXT whose html value carries escaped quotes —
// hence the doubled backslashes at this (mjs) level.
const AI_REPLY_ELEMENT = '{"html": "<h1 style=\\"color: purple; font-size: 40px\\" id=\\"t\\">AI 改的标题</h1>"}'
const AI_REPLY_DOCUMENT = '{"html": "<!DOCTYPE html><html><body>整篇</body></html>"}'

await page.addScriptTag({
  content: `window.__files = {
    '/w/page.html': ${JSON.stringify(FIXTURE)},
    '/w/strict.html': ${JSON.stringify(CSP_FIXTURE)},
    '/w/shift.html': ${JSON.stringify(SHIFT_FIXTURE)},
  };
  window.__writeCalls = [];
  window.__deny = {};
  // The renderer's LLM adapters stream through the MAIN process (apiFetchStream
  // + on* events), not page fetch — the fake LLM lives here. Answers the
  // element-edit task with a JSON {html}; a whole document on demand (refused).
  window.__streamSubs = { chunk: [], error: [], done: [] };
  window.__fakeLlm = (optsBody) => {
    const wantsDoc = optsBody.includes('返整篇')
    const reply = wantsDoc ? ${JSON.stringify(AI_REPLY_DOCUMENT)} : ${JSON.stringify(AI_REPLY_ELEMENT)}
    const payload = { id: 'probe', choices: [{ delta: { content: reply }, index: 0 }] }
    return 'data: ' + JSON.stringify(payload) + '\\n\\ndata: [DONE]\\n\\n'
  };
  window.electronAPI = new Proxy({}, { get: (_t, key) =>
    key === 'readFile' ? (p) => {
      const text = window.__files[p]
      return Promise.resolve(text === undefined ? null : text)
    }
    : key === 'writeFile' ? ({ filePath, content, expectContent }) => {
      // The stub IS the disk: writes update the fixture map so reloads see
      // them — and it enforces the same expectContent freshness contract the
      // real main side does (M6), refusing on a mismatch.
      if (expectContent !== undefined && window.__files[filePath] !== undefined && window.__files[filePath] !== expectContent) {
        window.__writeCalls.push({ filePath, content, refused: true })
        return Promise.resolve({ success: false, error: 'file changed on disk since it was read — re-read and retry（文件已被外部修改，请刷新后重试）' })
      }
      if (!window.__deny[filePath]) window.__files[filePath] = content
      window.__writeCalls.push({ filePath, content })
      const reason = window.__deny[filePath]
      return Promise.resolve(reason ? { success: false, error: reason } : { success: true })
    }
    : key === 'getSettings' ? () => Promise.resolve({
        activeProfileId: 'p1',
        profiles: [{ id: 'p1', provider: 'openai', apiKey: 'probe-key', baseURL: 'http://llm.probe/v1', model: 'probe-model', maxTokens: 2048 }],
        locale: 'zh',
      })
    : key === 'apiFetchStream' ? (requestId, url, opts) => {
        const bodyText = typeof opts?.body === 'string' ? opts.body : JSON.stringify(opts?.body ?? '')
        const sse = window.__fakeLlm(bodyText)
        setTimeout(() => {
          for (const cb of window.__streamSubs.chunk) cb({ requestId, data: sse })
          for (const cb of window.__streamSubs.done) cb({ requestId })
        }, 40)
        return Promise.resolve({ requestId })
      }
    : key === 'onApiStreamChunk' ? (cb) => { window.__streamSubs.chunk.push(cb); return () => {} }
    : key === 'onApiStreamError' ? (cb) => { window.__streamSubs.error.push(cb); return () => {} }
    : key === 'onApiStreamDone' ? (cb) => { window.__streamSubs.done.push(cb); return () => {} }
    : key === 'getFileStat' ? () => Promise.resolve({ size: 10, mtime: '2026-09-16T00:00:00Z' })
    : key === 'listDir' ? (p) => {
        if (p !== '/w') return Promise.resolve(null)
        const entries = Object.keys(window.__files).map((path) => ({
          name: path.slice(path.lastIndexOf('/') + 1), path, isDir: false,
        }))
        return Promise.resolve({ entries })
      }
    : key === 'registerPreviewNonce' ? ({ filePath, nonce }) => {
        window.__previewNonces[filePath] = nonce
        return Promise.resolve()
      }
    : key === 'openFolder' ? () => Promise.resolve()
    : key === 'showSaveDialog' ? () => Promise.resolve({ canceled: true })
    : key === 'copyFile' ? () => Promise.resolve()
    : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
    : /^on[A-Z]/.test(key) ? () => () => {}
    : () => Promise.resolve(undefined) })`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

const frame = () => page.frameLocator('iframe')
const openFile = (path) => page.evaluate((p) => window.__store.getState().openFile(null, p), path)
// The element/source toggles live in the address bar's 更多 menu now (the
// preview's own toolbar is gone, 2026-10-25).
const menuClick = async (label) => {
  await page.locator('[data-ws-more]').click()
  await page.getByRole('menuitem', { name: label, exact: true }).waitFor()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
  await page.waitForTimeout(60)
}
const enterElementMode = () => menuClick('元素编辑')
const enterSourceMode = () => menuClick('编辑')

await page.evaluate(() => window.__mount())
await openFile('/w/page.html')
await page.waitForTimeout(150)
await enterElementMode()
await frame().locator('h1#t').waitFor()

/* ── 1. Click-select: real mouse on the h1 → panel shows the breadcrumb. ── */
await frame().locator('h1#t').click()
await page.getByText('div#hero', { exact: false }).first().waitFor()
let sel = await page.evaluate(() => window.__editStore.getState().sessions['/w/page.html']?.selection)
check('clicking the h1 selects it (pmPath + tag land in the store)', sel && sel.pmPath === 'html>body:nth-child(2)>div:nth-child(1)>h1:nth-child(1)' && sel.tag === 'h1', JSON.stringify(sel?.pmPath))
check('…and the AI row is present for every element', (await page.locator('input[placeholder="想怎么改？用一句话描述"]').count()) === 1)

/* ── 2. Font-size edit: file bytes at the right span + live re-render. ── */
const writeCountBefore = await page.evaluate(() => window.__writeCalls.length)
await page.locator('label:has-text("字号") input').first().fill('32')
await page.locator('label:has-text("字号") input').first().press('Enter')
await page.waitForTimeout(250)
const calls = await page.evaluate(() => window.__writeCalls)
const fontSizeCall = calls[writeCountBefore]
check(
  'font-size 32 patches the file at the h1 start tag (byte-exact)',
  !!fontSizeCall && fontSizeCall.content.includes('<h1 style="color: blue; font-size: 32px" id="t">'),
  JSON.stringify(fontSizeCall?.content?.match(/<h1[^>]*>/)?.[0]),
)
const liveSize = await frame().locator('h1#t').evaluate((el) => el.style.fontSize)
check('…the live DOM re-rendered without a reload', liveSize === '32px', JSON.stringify(liveSize))

/* ── 3. Undo: original bytes back, frame remounts. ── */
const undoEnabled = page.locator('span[title="撤销"]:not([style*="cursor: default"])')
await undoEnabled.click()
await page.waitForTimeout(300)
const undoCall = (await page.evaluate(() => window.__writeCalls)).at(-1)
check('undo writes the original file bytes back', undoCall?.content === (await page.evaluate(() => window.__files['/w/page.html'])) && undoCall.content.includes('<h1 style="color: blue; font-size: 16px" id="t">Hello'), '')

/* ── 4. AI edit: SSE stub answers {html}; apply + reload + reselect. ── */
await frame().locator('h1#t').click()
await page.locator('input[placeholder="想怎么改？用一句话描述"]').fill('改成紫色 40px')
await page.getByText('运行', { exact: true }).click()
await page.waitForTimeout(600)
const aiCall = (await page.evaluate(() => window.__writeCalls)).at(-1)
check(
  'AI edit applied: file bytes replaced at the element span',
  !!aiCall && aiCall.content.includes('<h1 style="color: purple; font-size: 40px" id="t">AI 改的标题</h1>'),
  JSON.stringify(aiCall?.content?.match(/<h1[^>]*>AI[^<]*/)?.[0]),
)
await frame().locator('h1#t').waitFor()
sel = await page.evaluate(() => window.__editStore.getState().sessions['/w/page.html']?.selection)
check('…the frame reloaded and RESELECTED the edited element (same pmPath)', sel && sel.pmPath === 'html>body:nth-child(2)>div:nth-child(1)>h1:nth-child(1)' && (await frame().locator('h1#t').textContent()) === 'AI 改的标题', JSON.stringify(sel?.pmPath))

/* ── 5. AI returns a whole document → refused, file untouched. ── */
const writesBeforeRefusal = await page.evaluate(() => window.__writeCalls.length)
await page.locator('input[placeholder="想怎么改？用一句话描述"]').fill('返整篇文档')
await page.getByText('运行', { exact: true }).click()
await page.getByText('整篇文档', { exact: false }).first().waitFor()
check('an AI answer shaped like a whole document is refused with the reason shown', (await page.evaluate(() => window.__writeCalls.length)) === writesBeforeRefusal)

/* ── 6. Script-generated element: no source span, no content match → refuse (D6). ── */
await frame().locator('#made-by-js').click()
await page.waitForTimeout(200)
const jsSel = await page.evaluate(() => window.__editStore.getState().sessions['/w/page.html']?.selection)
check('the runtime-created div is selectable in the frame', jsSel && jsSel.pmPath.includes('made-by-js') === false && jsSel.pmPath.includes('div:nth-child(3)'), JSON.stringify(jsSel?.pmPath))
const writesBeforeJs = await page.evaluate(() => window.__writeCalls.length)
await page.locator('label:has-text("内边距") input').first().fill('8')
await page.locator('label:has-text("内边距") input').first().press('Enter')
await page.waitForTimeout(300)
check('editing it refuses to write (脚本生成元素没有源码)', (await page.evaluate(() => window.__writeCalls.length)) === writesBeforeJs)
await page.getByText('该元素不在文件源码中').waitFor()
check('…and the refusal names the generated-content cause as a toast', true)
// The field still holds the refused value — a later blur would re-commit it.
// Clear it so the next sections see no stray blur-commit toasts.
await page.locator('label:has-text("内边距") input').first().fill('')
await page.locator('label:has-text("内边距") input').first().press('Enter')

/* ── 6d. Double-click on a GENERATED text element must not open the editor. ── */
// Section 6's refusal bumped the reload (afterDirectEdit) — the frame
// remounts, and a click racing the remount dies on the new frame's
// source gate. Wait for the fresh frame before driving it.
await frame().locator('#made-p').waitFor()
await page.waitForTimeout(300)
await frame().locator('#made-p').click()
await page.waitForTimeout(300)
const madeSel = await page.evaluate(() => window.__editStore.getState().sessions['/w/page.html']?.selection)
check('the runtime-created p selects (text category)', madeSel && madeSel.tag === 'p' && madeSel.text === 'runtime paragraph', JSON.stringify(madeSel?.text))
await page.waitForTimeout(300)
const madeEditable = await frame().locator('#made-p').evaluate((el) => el.isContentEditable)
check('double-click on the generated text element does NOT enter in-place editing', madeEditable === false)
// The arbitration toast: count matching notice TEXTS so the section-6 toast
// (identical copy, still on screen) cannot satisfy this vacuously.
// Deterministic toast check: let every earlier toast expire (antd keeps
// them ~3s), then the ONLY acceptable notice after the dblclick is the
// arbitration reason.
await page.waitForFunction(() => document.querySelectorAll('.ant-message-notice').length === 0, { timeout: 8000 })
await frame().locator('#made-p').dblclick()
await page.getByText('该元素不在文件源码中').waitFor({ timeout: 3000 })
check('…and the arbitration explains why (the reason is toasted)', true)

/* ── 6b. A shifted live path still edits via the content fallback. ── */
await openFile('/w/shift.html')
await page.waitForTimeout(150)
await enterElementMode()
await frame().locator('h1#st').waitFor()
await frame().locator('h1#st').click()
await page.waitForTimeout(200)
const shiftSel = await page.evaluate(() => window.__editStore.getState().sessions['/w/shift.html']?.selection)
check('the shifted h1 reports its LIVE path (div:nth-child(2) — the script shifted it)', shiftSel && shiftSel.pmPath === 'html>body:nth-child(2)>div:nth-child(2)>h1:nth-child(1)', JSON.stringify(shiftSel?.pmPath))
const writesBeforeShift = await page.evaluate(() => window.__writeCalls.length)
await page.locator('label:has-text("字号") input').first().fill('28')
await page.locator('label:has-text("字号") input').first().press('Enter')
await page.waitForTimeout(300)
const shiftCalls = await page.evaluate(() => window.__writeCalls)
const shiftCall = shiftCalls[shiftCalls.length - 1]
check(
  'the shifted element STILL edits: patched at its true source span (content fallback)',
  shiftCalls.length === writesBeforeShift + 1 && shiftCall.content.includes('<div id="hero"><h1 id="st" style="font-size: 28px">'),
  JSON.stringify(shiftCall?.content?.match(/<div id="hero">.{0,60}/)?.[0]),
)
const liveShift = await frame().locator('h1#st').evaluate((el) => el.style.fontSize)
check('…and the live DOM re-rendered (frame message rides the live path)', liveShift === '28px', JSON.stringify(liveShift))

/* ── 6c. Double-click on a static text element edits in place (D7). ── */
await openFile('/w/page.html')
await page.waitForTimeout(150)
await page.evaluate(() => {
  window.__store.getState().setPreviewMode('/w/page.html', 'element')
  window.__store.getState().bumpReload('/w/page.html')
})
await frame().locator('h1#t').waitFor()
await frame().locator('h1#t').click()
await page.waitForTimeout(150)
await frame().locator('h1#t').dblclick()
await page.waitForTimeout(300)
const inPlaceEditable = await frame().locator('h1#t').evaluate((el) => el.isContentEditable)
check('double-click on the static h1 enters in-place editing (contenteditable)', inPlaceEditable === true)
const writesBeforeInPlace = await page.evaluate(() => window.__writeCalls.length)
const frameCtxEdit = await (await page.locator('iframe').elementHandle()).contentFrame()
await frameCtxEdit.evaluate(() => {
  const h1 = document.getElementById('t')
  h1.focus()
  // Place the caret at the end of the existing text.
  const range = document.createRange()
  range.selectNodeContents(h1)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
})
await page.keyboard.type(' (edited)')
await page.keyboard.press('Enter')
await page.waitForTimeout(400)
const inPlaceCalls = await page.evaluate(() => window.__writeCalls)
const inPlaceCall = inPlaceCalls[inPlaceCalls.length - 1]
// The h1 carries section 4's AI replacement text at this point.
check(
  'the in-place commit wrote the typed text into the file (D7)',
  inPlaceCalls.length === writesBeforeInPlace + 1 && inPlaceCall.content.includes('>AI 改的标题 (edited)</h1>'),
  JSON.stringify(inPlaceCall?.content?.match(/<h1[^>]*>[^<]*/)?.[0]),
)
const h1StillEditable = await frame().locator('h1#t').evaluate((el) => el.isContentEditable)
const h1TextNow = await frame().locator('h1#t').textContent()
check('…the editor closed on Enter and the frame kept the text (no reload)', h1StillEditable === false && h1TextNow === 'AI 改的标题 (edited)', JSON.stringify(h1TextNow))

/* ── 6e. A click INSIDE the text mid-edit is a caret move, not a reselect. ── */
// Measured 2026-09-18 (「无法直接编辑文字」): without the picker's editing
// guard, this click ran select() → editing = false → the later Enter commit
// died in exitEditing's early-return and the file never changed — the typed
// text lived only in the live DOM until a reload discarded it.
await frame().locator('h1#t').dblclick()
await page.waitForTimeout(300)
await frame().locator('h1#t').click()
await page.waitForTimeout(150)
const midSel = await page.evaluate(() => window.__editStore.getState().sessions['/w/page.html']?.selection)
const midEditable = await frame().locator('h1#t').evaluate((el) => el.isContentEditable)
check(
  'a click inside the element mid-edit keeps editing and the selection',
  midEditable === true && midSel?.pmPath === 'html>body:nth-child(2)>div:nth-child(1)>h1:nth-child(1)',
  JSON.stringify({ editable: midEditable, pmPath: midSel?.pmPath }),
)
const frameCtx6e = await (await page.locator('iframe').elementHandle()).contentFrame()
await frameCtx6e.evaluate(() => {
  const h1 = document.getElementById('t')
  h1.focus()
  const range = document.createRange()
  range.selectNodeContents(h1)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
})
const writesBeforeMid = await page.evaluate(() => window.__writeCalls.length)
await page.keyboard.type(' 再补')
await page.keyboard.press('Enter')
await page.waitForTimeout(400)
const midCalls = await page.evaluate(() => window.__writeCalls)
const midCall = midCalls[midCalls.length - 1]
check(
  '…the caret-reposition click did NOT kill the commit (D7 still lands)',
  midCalls.length > writesBeforeMid && midCall.content.includes('>AI 改的标题 (edited) 再补</h1>'),
  JSON.stringify(midCall?.content?.match(/<h1[^>]*>[^<]*/)?.[0]),
)

/* ── 6f. A pure-text div edits directly (container case). ── */
// 2026-09-18 「无法直接编辑文字」: a div-wrapped text line had NO text entry
// at all — the panel offered style controls only and double-click did
// nothing. Both gates now reach it: the replace field and in-place editing.
await frame().locator('#textdiv').click()
await page.waitForTimeout(200)
const divTextField = await page.locator('label:has-text("文本")').count()
check('a pure-text div gets the 文本 field (container category)', divTextField === 1, JSON.stringify(divTextField))
const writesBeforeDiv = await page.evaluate(() => window.__writeCalls.length)
await page.locator('label:has-text("文本") input').first().fill('容器文本已改')
await page.locator('label:has-text("文本") input').first().press('Enter')
await page.waitForTimeout(400)
const divCalls = await page.evaluate(() => window.__writeCalls)
check(
  '…the 文本 field commit replaces the div inner at the right bytes',
  divCalls.length > writesBeforeDiv && divCalls[writesBeforeDiv].content.includes('<div id="textdiv" style="font-size:16px">容器文本已改</div>'),
  JSON.stringify(divCalls[writesBeforeDiv]?.content?.match(/<div id="textdiv"[^>]*>[^<]*/)?.[0]),
)
const divLive = await frame().locator('#textdiv').textContent()
check('…and the live div re-rendered without a reload', divLive === '容器文本已改', JSON.stringify(divLive))
await frame().locator('#textdiv').dblclick()
await page.waitForTimeout(300)
const divEditable = await frame().locator('#textdiv').evaluate((el) => el.isContentEditable)
check('double-click on the pure-text div enters in-place editing', divEditable === true)
const frameCtx6f = await (await page.locator('iframe').elementHandle()).contentFrame()
await frameCtx6f.evaluate(() => {
  const el = document.getElementById('textdiv')
  el.focus()
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
})
await page.keyboard.type(' 就地')
await page.keyboard.press('Enter')
await page.waitForTimeout(400)
const divCalls2 = await page.evaluate(() => window.__writeCalls)
check(
  '…the in-place commit on the div lands (container category, D7)',
  divCalls2.length > divCalls.length && divCalls2[divCalls2.length - 1].content.includes('>容器文本已改 就地</div>'),
  JSON.stringify(divCalls2[divCalls2.length - 1]?.content?.match(/<div id="textdiv"[^>]*>[^<]*/)?.[0]),
)

/* ── 6g. A p with inline children: 就地编辑 stays, commit keeps markup. ── */
await frame().locator('#rich').click()
await page.waitForTimeout(200)
const richTextField = await page.locator('label:has-text("文本")').count()
const richInPlaceBtn = await page.getByText('就地编辑', { exact: true }).count()
check(
  'a p with <strong> inside offers 就地编辑 but no 文本 field',
  richTextField === 0 && richInPlaceBtn === 1,
  JSON.stringify({ text: richTextField, inPlace: richInPlaceBtn }),
)
await frame().locator('#rich').dblclick()
await page.waitForTimeout(300)
const richEditable = await frame().locator('#rich').evaluate((el) => el.isContentEditable)
check('double-click on the rich p enters in-place editing (inline children kept)', richEditable === true)
const frameCtx6g = await (await page.locator('iframe').elementHandle()).contentFrame()
await frameCtx6g.evaluate(() => {
  const el = document.getElementById('rich')
  el.focus()
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
})
await page.keyboard.type(' 就地改')
await page.keyboard.press('Enter')
await page.waitForTimeout(400)
const richCalls = await page.evaluate(() => window.__writeCalls)
check(
  '…the commit keeps the <strong> and appends only the typed text',
  richCalls[richCalls.length - 1].content.includes('<p id="rich">带 <strong>加粗</strong> 的段落 就地改</p>'),
  JSON.stringify(richCalls[richCalls.length - 1]?.content?.match(/<p id="rich">.{0,40}/)?.[0]),
)

/* ── 7. Strict-CSP page: the picker still runs (meta stripped pre-inject). ── */
await openFile('/w/strict.html')
await page.waitForTimeout(150)
await enterElementMode()
await frame().locator('h1#strict-head').waitFor()
await frame().locator('h1#strict-head').click()
await page.waitForTimeout(200)
sel = await page.evaluate(() => window.__editStore.getState().sessions['/w/strict.html']?.selection)
check('a meta-CSP page still selects elements (picker alive behind strict CSP)', sel && sel.pmPath === 'html>body:nth-child(2)>h1:nth-child(1)', JSON.stringify(sel?.pmPath))

/* ── 8. `<a>` click does not navigate the frame (D10). ── */
await openFile('/w/page.html')
await page.waitForTimeout(150)
await page.evaluate(() => {
  window.__store.getState().setPreviewMode('/w/page.html', 'element')
  window.__store.getState().bumpReload('/w/page.html')
})
await frame().locator('h1#t').waitFor()
await frame().locator('a').click()
await page.waitForTimeout(300)
const stillThere = await frame().locator('h1#t').count()
// The frame is opaque-origin: read its URL through Playwright's frame list,
// not through contentWindow (cross-origin forbids it).
const frameUrl = page.frames().find((f) => f.url().includes('srcdoc') || f !== page.mainFrame())?.url()
check('an in-frame link click is blocked (no navigation, picker survives)', stillThere === 1 && frameUrl === 'about:srcdoc', JSON.stringify(frameUrl))

/* ── 9. Reload keeps selection + scroll. ── */
await frame().locator('h1#t').click()
await page.waitForTimeout(150)
// Opaque-origin frame: drive and read the scroll inside the frame's own JS
// context (Playwright Frame), never through cross-origin contentWindow.
const frameHandle = await page.locator('iframe').elementHandle()
const frameCtx = await frameHandle.contentFrame()
await frameCtx.evaluate(() => window.scrollTo(0, 180))
await page.evaluate(() => window.__editStore.getState().setScroll('/w/page.html', 180))
await page.waitForTimeout(250)
await page.evaluate(() => window.__store.getState().bumpReload('/w/page.html'))
await page.waitForTimeout(700)
const frameCtx2 = await (await page.locator('iframe').elementHandle()).contentFrame()
const scrollAfter = await frameCtx2.evaluate(() => window.scrollY)
sel = await page.evaluate(() => window.__editStore.getState().sessions['/w/page.html']?.selection)
check('after a reload the scroll position is restored', scrollAfter === 180, JSON.stringify(scrollAfter))
check('…and the selection survives across the reload', sel && sel.pmPath === 'html>body:nth-child(2)>div:nth-child(1)>h1:nth-child(1)', JSON.stringify(sel?.pmPath))

/* ── 9b. The page's own scripts cannot forge pm:* messages (M9). ── */
// The frame is opaque-origin but its page scripts share the picker's realm:
// they post with the SAME event.source the real picker has. What they do not
// have is the nonce (the picker scrubbed its script tag at boot) — a forged
// select must not move the store and a forged commit-text must not write.
const writesBeforeForge = await page.evaluate(() => window.__writeCalls.length)
const forged = await frameCtx2.evaluate(async () => {
  window.parent.postMessage({ type: 'pm:select', pmPath: 'html>body:nth-child(2)>p:nth-child(2)', tag: 'p', rect: { x: 0, y: 0, w: 1, h: 1 }, text: 'forged', ancestors: [], computed: {}, nonce: 'forged' }, '*')
  window.parent.postMessage({ type: 'pm:commit-text', pmPath: 'html>body:nth-child(2)>div:nth-child(1)>h1:nth-child(1)', html: '<h1>owned</h1>', nonce: 'forged' }, '*')
  await new Promise((resolve) => setTimeout(resolve, 250))
  return {
    scriptTagLeft: document.getElementById('pm-picker-script') !== null,
    pickerHostAlive: document.getElementById('pm-picker-host') !== null,
  }
})
sel = await page.evaluate(() => window.__editStore.getState().sessions['/w/page.html']?.selection)
const writesAfterForge = await page.evaluate(() => window.__writeCalls.length)
check('a forged pm:select/pm:commit-text (right source, wrong nonce) lands nowhere', sel && sel.pmPath === 'html>body:nth-child(2)>div:nth-child(1)>h1:nth-child(1)' && writesAfterForge === writesBeforeForge, JSON.stringify({ sel: sel?.pmPath, writes: writesAfterForge }))
check('the picker script tag is scrubbed from the frame (nonce unreadable), overlay intact', !forged.scriptTagLeft && forged.pickerHostAlive, JSON.stringify(forged))

/* ── 10. The source editor entry is still reachable (D2 advanced hatch,
          via the address bar's 更多 menu). ── */
await enterSourceMode()
await page.locator('textarea').waitFor()
check('the advanced source editor still opens for html', (await page.locator('textarea').inputValue()).includes('<h1 style="color: purple'), '')

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
await browser.close()
process.exit(failed.length ? 1 : 0)
