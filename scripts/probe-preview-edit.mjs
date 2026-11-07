/**
 * Preview pane editing probe (PLAN-preview-edit T4; real Chromium, real mouse).
 *
 * Mounts the production WorkspacePane (tab strip + tree | address bar + PreviewPane)
 * over a
 * stubbed electronAPI that serves fixture files and records writeFile calls,
 * then drives the whole edit story the way a user now would (2026-10-25
 * layout: the preview's own toolbar is gone — 编辑/保存 ride the address bar's
 * 更多 menu, the dirty dot sits next to the address path):
 *
 *   1. typing makes the file dirty (the orange dot beside the address path —
 *      and on the file's tab chip, 2026-10-30);
 *   2. menu-save and ⌘S both write — with the CRLF line endings and BOM
 *      restored from the ORIGINAL file, not the editor's LF (2026-10-31: the
 *      editor is now CodeMirror — doc text is read through the view seam
 *      `window.__pmPreviewCM`, since contenteditable renders one div per
 *      line and textContent would lose the newlines);
 *   3. switching files and back keeps the draft;
 *   4. an external change meets a dirty draft as a two-choice banner
 *      (保留我的修改 / 重新加载 both behave), and a clean draft refreshes
 *      WITHOUT remounting the editor (the CM external-value sync replaces
 *      the doc in place — DOM node survives);
 *   5. image tabs get no edit entry (disabled menu item); an oversized file
 *      refuses to edit;
 *   6. saving an html bumps the iframe key (the frame really remounts);
 *   7. a rejected write (path jail) surfaces the error as a toast;
 *   8. mount cost of the CM instance on ~32KB / ~83KB code files — since
 *      PLAN-codemirror-view (2026-11-01) the VIEW half mounts it first and
 *      the 编辑 flip is a same-node reconfigure (both halves measured);
 *      the 1MB edit gate stays until these numbers say otherwise.
 *
 * Usage: node scripts/probe-preview-edit.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-preview-edit-')), 'harness.js')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { buildAntdTheme } from './src/renderer/src/theme/tokens'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { usePreviewPaneStore } from './src/renderer/src/stores/previewPaneStore'
import { makeDraftFromDisk } from './src/renderer/src/stores/preview-edit'
import { WorkspacePane } from './src/renderer/src/components/workbench/WorkspacePane'
import { previewCmHasFocus, openPreviewSearchPanel } from './src/renderer/src/components/preview/preview-cm-seam'

let root = null
window.__mount = () => {
  if (root) root.unmount()
  // The app always paints under the palette sheet (main.tsx applies it pre-
  // React) — without it every var() in component styles is invalid at
  // computed-value time and nukes whole declarations (observed: an outline
  // shorthand collapsing to '3px none').
  installThemeVars()
  applyThemeAttr('light')
  usePreviewPaneStore.getState().setWorkspaceDir('/w')
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider theme={buildAntdTheme('light')}>
      <TranslationProvider initialLocale="zh">
        <WorkspacePane conversationId={undefined} />
      </TranslationProvider>
    </ConfigProvider>
  )
  return true
}
window.__store = usePreviewPaneStore
window.__makeDraft = makeDraftFromDisk
// review_20261103 高4: AppLayout 的 ⌘F fork 通过 seam 问「预览编辑器持焦吗」
// ——应用菜单加速器先吃掉键，searchKeymap 自己的 ⌘F 永远到不了。
window.__pmSeam = { hasFocus: previewCmHasFocus, open: openPreviewSearchPanel }
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
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
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')

// Perf fixtures: pySource-like TS modules at ~32KB (the view mode's highlight
// cap) and ~200KB (2× the old full-render tax territory).
function tsSource(units) {
  const header = [
    "import { join } from 'node:path'",
    "import type { Stage } from './types'",
    '',
    'export const VERSION = "1.0.0"',
    '',
  ]
  const unit = (i) => [
    `/** Validates stage ${i} of the pipeline. */`,
    `export function stage${i}Validate(config: Stage): boolean {`,
    `  const name = \`stage-${i}\``,
    `  if (config.retries < 0) {`,
    `    console.warn("negative retries for", name)`,
    `    return false`,
    `  }`,
    `  return config.tags.every((t) => t.startsWith("a")) && config.timeout > 0`,
    `}`,
    '',
    `export async function stage${i}Run(payload: Record<string, string>, config: Stage): Promise<Stage> {`,
    `  const out = { ...payload, stage: "${i}", ok: true }`,
    `  for (const [key, value] of Object.entries(payload).sort()) {`,
    `    out[key] = typeof value === "string" ? value.repeat(config.retries + 1) : value`,
    `  }`,
    `  await Promise.resolve()`,
    `  return out as unknown as Stage`,
    `}`,
    '',
  ]
  return [...header, ...Array.from({ length: units }, (_, i) => unit(i).join('\n'))].join('\n')
}
const PY32 = tsSource(20)
const PY200 = tsSource(125)

await page.addScriptTag({
  content: `window.__files = {
    '/w/a.md': '# 标题\\r\\n正文\\r\\n',
    '/w/b.md': '# B\\n\\n内容\\n',
    '/w/c.html': '<html><body><p>hi</p></body></html>',
    '/w/pic.png': 'PNGBYTES',
    '/w/huge.md': '# big\\n' + 'x'.repeat(1024 * 1024 + 100),
    '/w/deny.md': '# deny\\n',
    '/w/diff.txt': '# 标题\\n正文\\n',
    '/w/perf32.ts': ${JSON.stringify(PY32)},
    '/w/perf200.ts': ${JSON.stringify(PY200)},
  };
  window.__writeCalls = [];
  window.__deny = {};
  window.electronAPI = new Proxy({}, { get: (_t, key) =>
    key === 'listDir' ? (p) => {
      if (p !== '/w') return Promise.resolve(null)
      const entries = Object.keys(window.__files).map((path) => ({
        name: path.slice(path.lastIndexOf('/') + 1), path, isDir: false,
      }))
      return Promise.resolve({ entries })
    }
    : key === 'readFile' ? (p) => {
      const text = window.__files[p]
      return Promise.resolve(text === undefined ? null : text)
    }
    : key === 'writeFile' ? ({ filePath, content }) => {
      window.__writeCalls.push({ filePath, content })
      const reason = window.__deny[filePath]
      return Promise.resolve(reason ? { success: false, error: reason } : { success: true })
    }
    : key === 'getFileStat' ? () => Promise.resolve({ size: 10, mtime: '2026-09-16T00:00:00Z' })
    : key === 'openFolder' ? () => Promise.resolve()
    : key === 'deletePath' ? () => Promise.resolve({ success: true })
    : key === 'showSaveDialog' ? () => Promise.resolve({ canceled: true })
    : key === 'copyFile' ? () => Promise.resolve()
    : /^on[A-Z]/.test(key) ? () => () => {}
    : () => Promise.resolve(undefined) })`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

/** The CM editor's contenteditable (one div per line inside — doc text only
 *  readable through the view seam). */
const cmContent = () => page.locator('[data-pm-cm-editor] [contenteditable="true"]')
/** Null-safe: across a file switch the old view's seam is deleted before the
 *  new one is registered — callers poll. */
const docText = () => page.evaluate(() => (window.__pmPreviewCM ? window.__pmPreviewCM.state.doc.toString() : null))
/** Caret to doc end: a click into a tall editor lands mid-content, and the
 *  old textarea's "click below the text" trick has no CM equivalent. Typing
 *  itself stays a real keyboard event. */
const caretToEnd = () => page.evaluate(() => {
  const view = window.__pmPreviewCM
  view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true })
})
const row = (p) => page.locator(`.pm-ws-row[data-ws-path="${p}"] .pm-ws-name`)
const openFile = async (p) => {
  await row(p).click()
  await page.waitForFunction((pp) => window.__store.getState().activeByConversation['__draft__'] === pp, p)
}
const addressPath = () => page.locator('[data-ws-address-path]').innerText()
/** The pane BODY trails the active path through bursts (2026-10-31 连发去抖:
 *  rapid switches coalesce into one render) — assertions on displayed content
 *  poll for the expected value instead of pinning immediacy. */
const waitDocText = async (pred) => {
  for (let i = 0; i < 20; i++) {
    const v = await docText()
    if (v !== null && pred(v)) return v
    await page.waitForTimeout(100)
  }
  return (await docText()) ?? ''
}
/** Open the 更多 menu and click one item by its exact label. */
const menuClick = async (label) => {
  await page.locator('[data-ws-more]').click()
  await page.getByRole('menuitem', { name: label, exact: true }).waitFor()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
  await page.waitForTimeout(60)
}
const menuDisabled = async (label) => {
  await page.locator('[data-ws-more]').click()
  const item = page.getByRole('menuitem', { name: label, exact: true })
  await item.waitFor()
  const disabled = await item.getAttribute('aria-disabled')
  await page.keyboard.press('Escape')
  return disabled === 'true'
}

await page.evaluate(() => window.__mount())
await page.locator('.pm-ws-tree').waitFor()
await openFile('/w/a.md')

/* ── 0. The address bar names the selection; the preview shows the file. ── */
check('the address bar shows the selected file’s absolute path', (await addressPath()) === '/w/a.md', await addressPath())
await page.getByText('标题').first().waitFor({ timeout: 2000 }).catch(() => {})
check(
  '…and the preview renders the file (the preview body itself carries no strip — the tab strip lives up in WorkspacePane)',
  (await page.locator('.pm-preview-tabstrip').count()) === 0 &&
    (await page.locator('[data-ws-tabstrip]').count()) === 1 &&
    (await page.getByText('标题').first().isVisible()),
)

/* ── 1. Typing makes the file dirty; the editor shows the file text. ── */
await menuClick('编辑')
await cmContent().waitFor()
const initial = await docText()
check('edit mode shows the file source (CRLF normalized to LF in the CM doc)', initial === '# 标题\n正文\n', JSON.stringify(initial))
check('…and the editor is highlighted (markdown grammar mounted)', (await page.locator('[data-pm-cm-editor][data-pm-cm-lang="markdown"]').count()) === 1, '')
// Scoped to the address bar: since 2026-10-30 the tab chip carries its own
// unsaved dot too, so a page-wide count would read 2 (asserted separately in
// probe-workspace-tree §19).
// 2026-10-30 用户裁定：地址栏不带脏点——脏态由 ⋯ 菜单的 保存 项表达
// （disabled: !dirty）。打字前保存置灰，打字后可用。
const addrDots = () => page.locator('[data-ws-address] span[title="未保存的修改"]').count()
check('the address bar carries no dirty dot (2026-10-30 裁定，脏态归 ⋯ 菜单)', (await addrDots()) === 0)
check('…and 保存 is disabled while clean', (await menuDisabled('保存')) === true)
await cmContent().click()
await caretToEnd()
await page.keyboard.type('# 尾注')
check('typing enables 保存 (the dirty state lives in the ⋯ menu now)', (await menuDisabled('保存')) === false)

/* ── 2. Menu save writes with CRLF restored. ── */
await menuClick('保存')
await page.waitForTimeout(120)
let calls = await page.evaluate(() => window.__writeCalls)
check(
  'menu save writes the edited content with the original CRLF endings',
  calls.length === 1 && calls[0].filePath === '/w/a.md' && calls[0].content === '# 标题\r\n正文\r\n# 尾注',
  JSON.stringify(calls[0]),
)
check('…and the save disables 保存 again', (await menuDisabled('保存')) === true)

/* ── 3. ⌘S saves too (the editor's own keyboard path). ── */
await cmContent().click()
await caretToEnd()
await page.keyboard.type('!')
await page.keyboard.press('Meta+S')
await page.waitForTimeout(120)
calls = await page.evaluate(() => window.__writeCalls)
check(
  '⌘S saves through the same write path (CRLF preserved)',
  calls.length === 2 && calls[1].content.endsWith('!'),
  JSON.stringify(calls[1]?.content?.slice(-12)),
)

/* ── 4. Switching files and back keeps the draft. ── */
await cmContent().click()
await caretToEnd()
await page.keyboard.type('DRAFT-MARK')
await openFile('/w/b.md')
await menuClick('编辑') // b.md starts in view mode — edit mode is per file
await cmContent().waitFor()
check('the other file opens with its own text', (await waitDocText((v) => v.startsWith('# B'))).startsWith('# B'), '')
await openFile('/w/a.md')
await cmContent().waitFor()
check('switching back restores the draft (D4: store survives remount)', (await waitDocText((v) => v.includes('DRAFT-MARK'))).includes('DRAFT-MARK'), '')

/* ── 5. Conflict banner: dirty draft + external change (D7). ── */
await openFile('/w/a.md')
await cmContent().waitFor()
await page.evaluate(() => {
  const st = window.__store.getState()
  const entry = st.drafts['/w/a.md'] ?? window.__makeDraft(window.__files['/w/a.md'])
  st.setDraft('/w/a.md', { ...entry, content: '我的本地修改\n' })
  window.__files['/w/a.md'] = 'agent 改过的\r\n'
  st.bumpReload('/w/a.md')
})
await page.getByText('文件已被外部修改').waitFor()
check('an external change over a dirty draft raises the conflict banner', true)
check('…and the draft text is still on show (not clobbered)', (await waitDocText((v) => v === '我的本地修改\n')) === '我的本地修改\n', JSON.stringify(await docText()))
await page.getByText('保留我的修改').click()
check('保留我的修改 clears the banner and keeps the draft', (await page.locator('.ant-modal-confirm, div[style*="fff7e6"]').count()) === 0 && (await docText()) === '我的本地修改\n', '')

await page.evaluate(() => {
  const st = window.__store.getState()
  st.markExternalChange('/w/a.md')
})
await page.getByText('文件已被外部修改').waitFor()
await page.getByText('重新加载').click()
await page.waitForTimeout(120)
check('重新加载 discards the draft and shows the disk text', (await waitDocText((v) => v === 'agent 改过的\n')) === 'agent 改过的\n', JSON.stringify(await docText()))

/* ── 6. A CLEAN draft refreshes without remounting the editor. ── */
await page.evaluate(() => {
  const st = window.__store.getState()
  st.setDraft('/w/a.md', window.__makeDraft(window.__files['/w/a.md']))
})
const nodeBefore = await page.evaluate(() => {
  window.__cmNode = document.querySelector('[data-pm-cm-editor]')
  return !!window.__cmNode
})
await page.evaluate(() => {
  window.__files['/w/a.md'] = 'agent 静默改的\n'
  window.__store.getState().bumpReload('/w/a.md')
})
await page.waitForTimeout(150)
const stayed = await page.evaluate(() => document.querySelector('[data-pm-cm-editor]') === window.__cmNode)
const adopted = await waitDocText((v) => v === 'agent 静默改的\n')
check('a clean draft refreshes silently (editor NOT remounted; doc replaced in place)', nodeBefore && stayed, `same node=${stayed}`)
check('…and adopts the new disk text', adopted === 'agent 静默改的\n', JSON.stringify(adopted))

/* ── 7. Image files expose a disabled edit entry. ── */
await openFile('/w/pic.png')
await page.waitForTimeout(80)
check('image files carry a disabled 编辑 item (read-only, D1)', (await menuDisabled('该类型不支持编辑')) === true)

/* ── 8. An oversized file refuses to edit. ── */
await openFile('/w/huge.md')
await page.waitForTimeout(200)
check('>1MB disables the 编辑 item (D8)', (await menuDisabled('该类型不支持编辑')) === true)

/* ── 9. Saving an html bumps the iframe key (frame remounts). ── */
await openFile('/w/c.html')
await page.evaluate(() => {
  const st = window.__store.getState()
  const entry = st.drafts['/w/c.html'] ?? window.__makeDraft(window.__files['/w/c.html'])
  st.setDraft('/w/c.html', { ...entry, content: '<html><body><p>edited</p></body></html>' })
})
for (let i = 0; i < 15 && !(await page.evaluate(() => !!document.querySelector('iframe'))); i++) await page.waitForTimeout(100)
let iframe = await page.evaluate(() => { window.__frame = document.querySelector('iframe'); return !!window.__frame })
await menuClick('保存')
await page.waitForTimeout(150)
const frameReplaced = await page.evaluate(() => document.querySelector('iframe') !== window.__frame)
check('an html file renders its iframe', iframe)
check('…and saving remounts the frame (key={reloadTick}, D5)', frameReplaced, `replaced=${frameReplaced}`)

/* ── 10. A rejected write surfaces the error (D9). ── */
await openFile('/w/deny.md')
await menuClick('编辑')
await cmContent().waitFor()
await cmContent().click()
await caretToEnd()
await page.keyboard.type('x')
await page.evaluate(() => { window.__deny['/w/deny.md'] = '路径被拒绝：~/.ssh 属于受保护目录' })
await menuClick('保存')
await page.getByText('路径被拒绝').waitFor()
check('a rejected save shows the error as a toast (D9)', true)

/* ── 11. The text halves share ONE CM instance (PLAN-codemirror-view). ──
 * The VIEW half mounts the lazy editor first (read-only shape, probe seam
 * live, doc text readable); 编辑 reconfigures the SAME node — scroll, undo
 * history and drafts survive the flip. */
await page.evaluate(() => { window.__cmNode = null })
// Playwright serializes the predicate — closure vars don't travel; minLen
// rides as the arg (perf32 needs >1KB, perf200 >100KB to tell the hosts
// apart across a switch).
const viewReady = (minLen) => {
  const host = document.querySelector('[data-pm-cm-editor]')
  const view = window.__pmPreviewCM
  return !!host && host.getAttribute('data-pm-cm-mode') === 'view' &&
    !host.querySelector('[contenteditable="true"]') && !!view && view.state.doc.length > minLen
}
await page.locator(`.pm-ws-row[data-ws-path="/w/perf32.ts"] .pm-ws-name`).click()
const v32t0 = Date.now()
await page.waitForFunction((pp) => window.__store.getState().activeByConversation['__draft__'] === pp, '/w/perf32.ts')
await page.waitForFunction(viewReady, 1000, { timeout: 10000 })
const view32 = Date.now() - v32t0
check('text view renders through the CM instance (mode=view, no contenteditable — no cursor)', true)
check('…and the view doc text is the file source (the probe seam is live in view too)',
  ((await docText()) ?? '').startsWith("import { join } from 'node:path'"), '')
check('~32KB code file: CM view mount < 1000ms (lazy chunk + first parse)', view32 < 1000, `view=${view32}ms`)
await page.evaluate(() => { window.__cmNode = document.querySelector('[data-pm-cm-editor]'); return true })
const f32t0 = Date.now()
await menuClick('编辑')
await cmContent().waitFor({ timeout: 10000 })
const flip32 = Date.now() - f32t0
const kept32 = await page.evaluate(() => document.querySelector('[data-pm-cm-editor]') === window.__cmNode)
check('view→edit flip reconfigures in place (the CM node survives — the unification claim)', kept32, `same node=${kept32}`)
check('…and the flip is a reconfigure, not a mount (< 600ms)', flip32 < 600, `flip=${flip32}ms`)
await cmContent().click()
await caretToEnd()
const base32 = await page.evaluate(() => window.__pmPreviewCM.state.doc.length)
const t32 = Date.now()
await page.keyboard.type('0123456789')
await page.waitForFunction((base) => window.__pmPreviewCM.state.doc.length > base, base32)
check('~32KB code file: 10-char typing round-trip < 400ms', Date.now() - t32 < 400, `typing=${Date.now() - t32}ms`)
await menuClick('预览') // back to view; the draft rides the store until the next switch
await page.waitForTimeout(60)

await page.locator(`.pm-ws-row[data-ws-path="/w/perf200.ts"] .pm-ws-name`).click()
const v200t0 = Date.now()
await page.waitForFunction((pp) => window.__store.getState().activeByConversation['__draft__'] === pp, '/w/perf200.ts')
try {
  await page.waitForFunction(viewReady, 50000, { timeout: 10000 })
} catch (err) {
  const dump = await page.evaluate(() => ({
    host: !!document.querySelector('[data-pm-cm-editor]'),
    mode: document.querySelector('[data-pm-cm-editor]')?.getAttribute('data-pm-cm-mode') ?? null,
    editable: !!document.querySelector('[data-pm-cm-editor] [contenteditable="true"]'),
    seam: !!window.__pmPreviewCM,
    docLen: window.__pmPreviewCM ? window.__pmPreviewCM.state.doc.length : -1,
    addr: document.querySelector('[data-ws-address-path]')?.textContent ?? null,
  }))
  console.log('  [perf200 dump]', JSON.stringify(dump))
  throw err
}
const view200 = Date.now() - v200t0
// 夹具实情：tsSource(125) 实测 83KB（旧探针的「~200KB」标签从未对过账，
// dump 抓出 docLen=83302）——标签按实数落。
check('~83KB code file: CM view mount < 1500ms (viewport rendering, not full-doc DOM)', view200 < 1500, `view=${view200}ms`)
await menuClick('编辑')
await cmContent().waitFor({ timeout: 10000 })
await cmContent().click()
await caretToEnd()
const base200 = await page.evaluate(() => window.__pmPreviewCM.state.doc.length)
const t200 = Date.now()
await page.keyboard.type('0123456789')
await page.waitForFunction((base) => window.__pmPreviewCM.state.doc.length > base, base200)
check('~83KB code file: 10-char typing round-trip < 400ms', Date.now() - t200 < 400, `typing=${Date.now() - t200}ms`)
await menuClick('预览')
await page.waitForTimeout(60)

/* ── 12. Search + completion (user 2026-11-01, reversing the weak-IDE ruling
 * for these two). ⌘F must work while READING: the view content carries
 * tabindex so the keymap reaches it even without contenteditable; typing in
 * view stays inert (read-only state). Completion lives in the edit group only. */
await page.locator(`.pm-ws-row[data-ws-path="/w/perf32.ts"] .pm-ws-name`).click()
await page.waitForFunction((pp) => window.__store.getState().activeByConversation['__draft__'] === pp, '/w/perf32.ts')
await page.waitForFunction(viewReady, 1000, { timeout: 10000 })
await page.locator('[data-pm-cm-editor] .cm-content').click()
const lenBeforeType = await page.evaluate(() => window.__pmPreviewCM.state.doc.length)
await page.keyboard.type('ZZZ')
await page.waitForTimeout(80)
check('view mode: typing is inert (read-only state, no contenteditable)',
  (await page.evaluate(() => window.__pmPreviewCM.state.doc.length)) === lenBeforeType, '')
await page.keyboard.press('Meta+F')
await page.locator('.cm-panel.cm-search').waitFor({ timeout: 3000 })
check('view mode: ⌘F opens the search panel (content is focusable via tabindex)', true)
// 2026-11-02: panel i18n + checkbox centering. The harness mounts
// TranslationProvider initialLocale="zh", so the panel must speak Chinese —
// the button labels and the placeholder all ride state.phrase().
{
  const panelText = await page.locator('.cm-panel.cm-search').innerText()
  const zhOk = ['下一处', '上一处', '全部', '区分大小写', '正则', '全字匹配'].every((w) => panelText.includes(w))
  const placeholder = await page.locator('.cm-panel.cm-search input[name="search"]').getAttribute('placeholder')
  check('…panel labels ride the zh phrases (buttons + Find placeholder)', zhOk && placeholder === '查找', `placeholder=${placeholder}`)
  const centering = await page.evaluate(() => {
    const label = document.querySelector('.cm-panel.cm-search label')
    const box = label?.querySelector('input[type=checkbox]')
    if (!label || !box) return { ok: false, display: null }
    const ls = getComputedStyle(label)
    const lb = box.getBoundingClientRect()
    // The checkbox's vertical center must sit within 2px of the label's
    // text line box center (inline-flex + align-items center).
    const lt = label.getBoundingClientRect()
    const textCenter = lt.top + lt.height / 2
    return {
      // display blockifies to `flex` when the label is itself a flex item of
      // the round-2 panel row — the internal centering is what matters.
      ok: ['inline-flex', 'flex'].includes(ls.display) && ls.alignItems === 'center' && Math.abs(lb.top + lb.height / 2 - textCenter) <= 2,
      display: ls.display, offset: +(lb.top + lb.height / 2 - textCenter).toFixed(1),
    }
  })
  check('…checkbox labels are vertically centered (inline-flex + align-items)', centering.ok, `display=${centering.display} offset=${centering.offset}px`)
  // Dark mode (2026-11-02 round 3): CM's baseTheme paints .cm-button a LIGHT
  // gradient via background-image — the editor root is always cm-light (no
  // {dark:true} theme exists), so the gradient rode over the card color and
  // glared in dark. background-COLOR alone does not override it. Flip the
  // palette attr (the sheet carries both blocks) and read computed styles.
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  const darkBtn = await page.evaluate(() => {
    const b = document.querySelector('.cm-panel.cm-search button[name="next"]')
    const cs = getComputedStyle(b)
    return { img: cs.backgroundImage, bg: cs.backgroundColor }
  })
  check('dark mode: 下一处 button wears the dark card, no light gradient', darkBtn.img === 'none' && darkBtn.bg === 'rgb(38, 38, 38)', JSON.stringify(darkBtn))
  check('dark mode: 下一处 button wears the dark card, no light gradient', darkBtn.img === 'none' && darkBtn.bg === 'rgb(38, 38, 38)', JSON.stringify(darkBtn))
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
}
// The panel commits the query on keyup/change — fill() only fires `input`,
// so type for real (the field is focused by openSearchPanel).
await page.keyboard.type('stage0Validate')
await page.waitForFunction(() => document.querySelectorAll('.cm-searchMatch').length >= 1, undefined, { timeout: 3000 })
const matches = await page.evaluate(() => document.querySelectorAll('.cm-searchMatch').length)
check('…and the query highlights its match in the viewport', matches >= 1, `matches=${matches}`)
await page.keyboard.press('Escape')
await page.waitForFunction(() => !document.querySelector('.cm-panel.cm-search'), undefined, { timeout: 3000 })
check('…and Escape closes the panel', true)

await menuClick('编辑')
await cmContent().waitFor({ timeout: 10000 })
await cmContent().click()
await caretToEnd()
await page.keyboard.type('\nstage0V')
await page.locator('.cm-tooltip-autocomplete').waitFor({ timeout: 3000 })
const option = await page.evaluate(() => [...document.querySelectorAll('.cm-tooltip-autocomplete li')].map((li) => li.textContent || '').find((t) => t.includes('stage0Validate')) ?? null)
check('edit mode: typing pops the completion tooltip with the in-scope symbol', option !== null, `option=${JSON.stringify(option)}`)
await page.keyboard.press('Escape')
await page.waitForTimeout(80)
check('…and Escape dismisses it', (await page.evaluate(() => !!document.querySelector('.cm-tooltip-autocomplete'))) === false)
await menuClick('预览')
await page.waitForTimeout(60)

/* ── 13. Agent-change review diff (2026-11-01 pivot): after an agent
 * write/edit lands, the VIEW half highlights what the AGENT changed —
 * pre-change base vs the fresh disk text, read-only, NO accept/reject
 * controls. The user's own typing earns no diff (user ruling). The probe
 * drives the store the way usePreviewPaneSync does (the harness mounts
 * WorkspacePane, not ChatView's sync): loadedTexts is already recorded by
 * the real read path, then spec + bumpReload. ── */
await page.locator('.pm-ws-row[data-ws-path="/w/diff.txt"] .pm-ws-name').click()
await page.waitForFunction((pp) => window.__store.getState().activeByConversation['__draft__'] === pp, '/w/diff.txt')
await page.waitForFunction(() => {
  const host = document.querySelector('[data-pm-cm-editor]')
  return !!host && host.getAttribute('data-pm-cm-mode') === 'view' && !!window.__pmPreviewCM && window.__pmPreviewCM.state.doc.toString().startsWith('# 标题')
}, undefined, { timeout: 10000 })
check('view loads the file through the CM instance (loadedTexts recorded by the real read path)',
  (await page.evaluate((p) => window.__store.getState().loadedTexts[p] === '# 标题\n正文\n', '/w/diff.txt')) === true)
// The agent edit lands: disk changes, the sync snapshots the pre-change
// loadedText into the base AT EVENT time (the reload's own read would
// overwrite it) and resets the explicit hide.
await page.evaluate(() => {
  const st = window.__store.getState()
  window.__files['/w/diff.txt'] = '# 标题\n正文已改写\n新增一行\n'
  st.setAgentDiffBase('/w/diff.txt', st.loadedTexts['/w/diff.txt'])
  st.setDiffVisible('/w/diff.txt', true)
  st.bumpReload('/w/diff.txt')
})
await page.waitForFunction(() => document.querySelectorAll('.cm-changedLine').length >= 1, undefined, { timeout: 3000 })
check('an agent change auto-shows the review diff in VIEW mode (自动显示)', true)
check('…with no accept/reject controls (mergeControls: false, user ruling)',
  (await page.evaluate(() => document.querySelectorAll('.cm-deletedChunk button').length)) === 0)
await menuClick('隐藏改动')
await page.waitForTimeout(150)
check('⋯ 隐藏改动 drops the review diff', (await page.locator('.cm-changedLine').count()) === 0)
await menuClick('显示改动')
await page.waitForTimeout(150)
check('…显示改动 brings it back (the base survives the toggle)', (await page.locator('.cm-changedLine').count()) >= 1)
// Edit mode NEVER mounts the merge — the user's own typing earns no diff.
await menuClick('编辑')
await cmContent().waitFor({ timeout: 10000 })
check('edit mode drops the review diff (user typing is diff-free)', (await page.locator('.cm-changedLine').count()) === 0)
await cmContent().click()
await caretToEnd()
await page.keyboard.type('我的输入')
await page.waitForTimeout(200)
check('…typing in edit mode shows no markers either', (await page.locator('.cm-changedLine').count()) === 0)
// Saving clears the base (the user's own text replaced the disk): back in
// view, nothing highlights even though the store draft adoption re-reads.
await page.keyboard.press('Meta+S')
await page.waitForTimeout(200)
await menuClick('预览')
await page.waitForTimeout(150)
check('a save clears the review base — view shows no diff afterwards', (await page.locator('.cm-changedLine').count()) === 0)
check('…and the base map is clean', (await page.evaluate(() => Object.keys(window.__store.getState().agentDiffBases).length)) === 0)

/* ── ⋯菜单的 搜索/替换（2026-11-02 round 2）：真实菜单链路 ──
 * view 态点 替换 → 翻 source（park 意图）→ 面板带替换行打开；替换真正落
 * doc 并经 onChange 进草稿。顺带钉面板 row 居中（flex）、关闭钮命中面、
 * 命中高亮的橙色描边（round 2 的 #1/#4/#6）。 */
await openFile('/w/diff.txt')
// viewReady gates on doc.length > 1000 (the perf fixtures' bar) — diff.txt
// is 7 chars; wait on the mount + view-mode attr directly.
await page.waitForFunction(() => {
  const host = document.querySelector('[data-pm-cm-editor]')
  return !!host && host.getAttribute('data-pm-cm-mode') === 'view' && !!window.__pmPreviewCM
}, undefined, { timeout: 10000 })
await menuClick('查找替换')
await page.locator('.cm-panel.cm-search input[name="replace"]').waitFor({ timeout: 3000 })
const flippedMode = await page.evaluate(() => document.querySelector('[data-pm-cm-editor]')?.getAttribute('data-pm-cm-mode'))
check('menu 查找替换 in view mode flips to source — panel carries the replace row', flippedMode === 'edit', `mode=${flippedMode}`)
// openSearchPanel focuses the search field — type the needle, then the
// replacement, then drive the real 替换 button. CJK rides insertText (no
// keyup → no panel commit): the replace-field click blurs the search field
// and its `change` commits the needle; the button click likewise commits
// the replacement before the handler runs.
await page.keyboard.type('标题')
await page.locator('.cm-panel.cm-search input[name="replace"]').click()
await page.keyboard.type('替换后')
// CM's replace rhythm: the first 替换 SELECTS the match, the second (selection
// already on the match) replaces it.
await page.locator('.cm-panel.cm-search button[name="replace"]').click()
await page.locator('.cm-panel.cm-search button[name="replace"]').click()
await page.waitForFunction(() => window.__pmPreviewCM.state.doc.toString().includes('替换后'), undefined, { timeout: 3000 })
const draftHas = await page.evaluate(() => (window.__store.getState().drafts['/w/diff.txt']?.content ?? '').includes('替换后'))
check('…replacement lands in the doc AND rides the draft pipeline (onChange)', draftHas)
// Row centering: input / buttons / labels share one center line (flex).
const align = await page.evaluate(() => {
  const panel = document.querySelector('.cm-panel.cm-search')
  const cs = getComputedStyle(panel)
  const c = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }
  const input = panel.querySelector('input[name="search"]')
  const btn = panel.querySelector('button[name="next"]')
  const label = panel.querySelector('label')
  return {
    flex: cs.display === 'flex' && cs.flexWrap === 'wrap' && cs.alignItems === 'center',
    spread: Math.max(Math.abs(c(input) - c(btn)), Math.abs(c(input) - c(label)), Math.abs(c(btn) - c(label))),
  }
})
check('panel rows are flex-centered (input/buttons/labels one center line)', align.flex && align.spread <= 2, `spread=${align.spread.toFixed(1)}px`)
const closeBox = await page.evaluate(() => {
  const r = document.querySelector('.cm-panel.cm-search button[name="close"]').getBoundingClientRect()
  return `${Math.round(r.width)}x${Math.round(r.height)}`
})
check('close button is a real hit target (≥20px square)', (() => { const [w, h] = closeBox.split('x').map(Number); return w >= 20 && h >= 20 })(), closeBox)
// Match outline (round-2 #6): the replacement above consumed the only match —
// search a fresh needle so a live match exists, then read the outline.
await page.locator('.cm-panel.cm-search input[name="search"]').click()
await page.keyboard.press('Meta+A')
await page.keyboard.type('正文')
// CJK rides insertText (no keyup → no panel commit); Enter's keyup commits.
await page.keyboard.press('Enter')
await page.waitForFunction(() => document.querySelectorAll('.cm-searchMatch').length >= 1, undefined, { timeout: 3000 })
const outline = await page.evaluate(() => {
  const cs = getComputedStyle(document.querySelector('.cm-searchMatch'))
  return `${cs.outlineWidth} ${cs.outlineStyle}`
})
check('match highlight wears the warn outline rectangle', outline === '1px solid', `outline=${outline}`)
await page.keyboard.press('Escape')
await page.waitForFunction(() => !document.querySelector('.cm-panel.cm-search'), undefined, { timeout: 3000 })
// Merged entry in source mode: direct open (panel already carries the
// replace row) — no second flip.
await menuClick('查找替换')
await page.locator('.cm-panel.cm-search').waitFor({ timeout: 3000 })
check('menu 查找替换 in source mode opens the panel directly', true)
await page.keyboard.press('Escape')
await page.waitForFunction(() => !document.querySelector('.cm-panel.cm-search'), undefined, { timeout: 3000 })

// ── §menu-fork: AppLayout 的 ⌘F 分流（review_20261103 高4）─────────────────
// 应用菜单加速器（mac）/ before-input fallback（win+linux）在渲染层任何
// keymap 之前吃掉 ⌘F，所以主窗里 searchKeymap 自己的 ⌘F 不可达——AppLayout
// 收到 open-search 时按「预览编辑器是否持焦」分流到 seam。这里在真 CM 实例
// 上钉 seam 的焦点语义与 fork 出口；加速器先吃键这一前提是 Electron 原生
// 行为，普通 Chromium 探不到（也是本批既有 ⌘F 检查在探针里一直绿的原因）。
await page.locator('.cm-content').click()
await page.waitForTimeout(80)
const seamFocused = await page.evaluate(() => window.__pmSeam.hasFocus())
check('CM 持焦时 seam 报告持焦（AppLayout fork 的条件）', seamFocused === true, `hasFocus=${seamFocused}`)
const forkFired = await page.evaluate(() => window.__pmSeam.open())
await page.locator('.cm-panel.cm-search').waitFor({ timeout: 3000 })
check('fork 出口：seam open 打开搜索面板（聚焦时 ⌘F = CM 面板）', forkFired === true, `open=${forkFired}`)
await page.keyboard.press('Escape')
await page.waitForFunction(() => !document.querySelector('.cm-panel.cm-search'), undefined, { timeout: 3000 })
await page.evaluate(() => {
  if (document.activeElement) document.activeElement.blur()
  document.body.focus()
})
await page.waitForTimeout(80)
const seamBlurred = await page.evaluate(() => window.__pmSeam.hasFocus())
check('焦点移出编辑器后 seam 报告失焦（⌘F 仍 = 导航搜索页）', seamBlurred === false, `hasFocus=${seamBlurred}`)

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
await browser.close()
process.exit(failed.length ? 1 : 0)
