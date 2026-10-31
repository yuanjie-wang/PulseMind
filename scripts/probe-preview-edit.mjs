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
 *   8. mount cost of the CM editor on ~32KB / ~200KB code files (the 1MB
 *      edit gate stays until this number says otherwise).
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
import { usePreviewPaneStore } from './src/renderer/src/stores/previewPaneStore'
import { makeDraftFromDisk } from './src/renderer/src/stores/preview-edit'
import { WorkspacePane } from './src/renderer/src/components/workbench/WorkspacePane'

let root = null
window.__mount = () => {
  if (root) root.unmount()
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

/* ── 11. CM mount cost on real-size code files (informs the 1MB gate). ── */
const mountCost = async (p) => {
  await openFile(p)
  const t0 = Date.now()
  await menuClick('编辑')
  await cmContent().waitFor({ timeout: 10000 })
  const ms = Date.now() - t0
  // A typing latency sample: 10 chars through the real key pipeline.
  await cmContent().click()
  await caretToEnd()
  const baseLen = await page.evaluate(() => window.__pmPreviewCM.state.doc.length)
  const t1 = Date.now()
  await page.keyboard.type('0123456789')
  await page.waitForFunction((base) => window.__pmPreviewCM.state.doc.length > base, baseLen)
  const typingMs = Date.now() - t1
  // Leave edit mode (the toggle reads 查看 while editing; the draft is
  // dropped with the file switch that follows).
  await menuClick('预览')
  await page.waitForTimeout(60)
  return { mountMs: ms, typingMs }
}
const m32 = await mountCost('/w/perf32.ts')
check('~32KB code file: CM edit mount < 1000ms (was ~128ms of Prism full-render for VIEW)', m32.mountMs < 1000, JSON.stringify(m32))
check('~32KB code file: 10-char typing round-trip < 400ms', m32.typingMs < 400, `typing=${m32.typingMs}ms`)
const m200 = await mountCost('/w/perf200.ts')
check('~200KB code file: CM edit mount < 1500ms (viewport rendering, not full-doc DOM)', m200.mountMs < 1500, JSON.stringify(m200))
check('~200KB code file: 10-char typing round-trip < 400ms', m200.typingMs < 400, `typing=${m200.typingMs}ms`)

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
await browser.close()
process.exit(failed.length ? 1 : 0)
