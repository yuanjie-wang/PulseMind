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
 *   6. a script-generated element is refused (no source span, D6);
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
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import { usePreviewPaneStore } from './src/renderer/src/stores/previewPaneStore'
import { useHtmlEditStore, consumeFailure } from './src/renderer/src/stores/htmlEditStore'
import { PreviewPane } from './src/renderer/src/components/preview/PreviewPane'
import { buildPreviewCopy } from './src/shared/preview/html-inject'
import { PICKER_SCRIPT } from './src/main/preview/picker-source.generated'

window.__buildFrameDoc = (url) => {
  const m = /^local-file:\\/\\/([^?#]*)?(\\?[^#]*)?/.exec(url)
  const raw = m && m[1] ? decodeURIComponent(m[1]) : '/'
  const query = (m && m[2]) || ''
  const preview = query.includes('pmPreview=1')
  const nonceMatch = /[?&]pmNonce=([^&#]+)/.exec(query)
  const nonce = nonceMatch ? decodeURIComponent(nonceMatch[1]) : undefined
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
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <SettingsProvider>
        <TranslationProvider initialLocale="zh">
          <PreviewPane conversationId={undefined} />
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
  '</div>',
  '<script>document.body.appendChild(Object.assign(document.createElement("div"), {id: "made-by-js", textContent: "runtime"}))</script>',
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
    : key === 'openFolder' ? () => Promise.resolve()
    : key === 'showSaveDialog' ? () => Promise.resolve({ canceled: true })
    : key === 'copyFile' ? () => Promise.resolve()
    : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
    : /^on[A-Z]/.test(key) ? () => () => {}
    : () => Promise.resolve(undefined) })`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

const elementToggle = () => page.locator('div[title="元素编辑"]')
const sourceToggle = () => page.locator('div[title="编辑"]')
const frame = () => page.frameLocator('iframe')
const openFile = (path) => page.evaluate((p) => window.__store.getState().openFile(null, p), path)

await page.evaluate(() => window.__mount())
await openFile('/w/page.html')
await page.waitForTimeout(150)
await elementToggle().click()
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

/* ── 6. Script-generated element: no source span → refuse (D6). ── */
await frame().locator('#made-by-js').click()
await page.waitForTimeout(200)
const jsSel = await page.evaluate(() => window.__editStore.getState().sessions['/w/page.html']?.selection)
check('the runtime-created div is selectable in the frame', jsSel && jsSel.pmPath.includes('made-by-js') === false && jsSel.pmPath.includes('div:nth-child(3)'), JSON.stringify(jsSel?.pmPath))
const writesBeforeJs = await page.evaluate(() => window.__writeCalls.length)
await page.locator('label:has-text("内边距") input').first().fill('8')
await page.locator('label:has-text("内边距") input').first().press('Enter')
await page.waitForTimeout(300)
check('editing it refuses to write (脚本生成元素没有源码)', (await page.evaluate(() => window.__writeCalls.length)) === writesBeforeJs)
await page.getByText('源码中找不到该路径对应的元素').waitFor()
check('…and the refusal names the cause as a toast', true)

/* ── 7. Strict-CSP page: the picker still runs (meta stripped pre-inject). ── */
await openFile('/w/strict.html')
await page.waitForTimeout(150)
await elementToggle().click()
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

/* ── 10. The source editor entry is still on the toolbar (D2). ── */
await sourceToggle().click()
await page.locator('textarea').waitFor()
check('the advanced source editor still opens for html', (await page.locator('textarea').inputValue()).includes('<h1 style="color: purple'), '')

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
await browser.close()
process.exit(failed.length ? 1 : 0)
