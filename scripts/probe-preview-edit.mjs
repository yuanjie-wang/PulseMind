/**
 * Preview pane editing probe (PLAN-preview-edit T4; real Chromium, real mouse).
 *
 * Mounts the production WorkspacePane (address bar + tree + PreviewPane) over a
 * stubbed electronAPI that serves fixture files and records writeFile calls,
 * then drives the whole edit story the way a user now would (2026-10-25
 * layout: the preview's own toolbar is gone — 编辑/保存 ride the address bar's
 * 更多 menu, the dirty dot sits next to the address path):
 *
 *   1. typing makes the file dirty (the orange dot beside the address path);
 *   2. menu-save and ⌘S both write — with the CRLF line endings and BOM
 *      restored from the ORIGINAL file, not the textarea's LF;
 *   3. switching files and back keeps the draft;
 *   4. an external change meets a dirty draft as a two-choice banner
 *      (保留我的修改 / 重新加载 both behave), and a clean draft refreshes
 *      WITHOUT remounting the editor;
 *   5. image tabs get no edit entry (disabled menu item); an oversized file
 *      refuses to edit;
 *   6. saving an html bumps the iframe key (the frame really remounts);
 *   7. a rejected write (path jail) surfaces the error as a toast.
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

await page.addScriptTag({
  content: `window.__files = {
    '/w/a.md': '# 标题\\r\\n正文\\r\\n',
    '/w/b.md': '# B\\n\\n内容\\n',
    '/w/c.html': '<html><body><p>hi</p></body></html>',
    '/w/pic.png': 'PNGBYTES',
    '/w/huge.md': '# big\\n' + 'x'.repeat(1024 * 1024 + 100),
    '/w/deny.md': '# deny\\n',
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

const textarea = () => page.locator('textarea')
const row = (p) => page.locator(`.pm-ws-row[data-ws-path="${p}"] .pm-ws-name`)
const openFile = async (p) => {
  await row(p).click()
  await page.waitForFunction((pp) => window.__store.getState().activeByConversation['__draft__'] === pp, p)
}
const addressPath = () => page.locator('[data-ws-address-path]').innerText()
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
check('…and the preview renders the file (no tab strip anywhere)', (await page.locator('.pm-preview-tabstrip').count()) === 0 && (await page.getByText('标题').first().isVisible()))

/* ── 1. Typing makes the file dirty; the textarea shows the file text. ── */
await menuClick('编辑')
await textarea().waitFor()
const initial = await textarea().inputValue()
check('edit mode shows the file source (CRLF normalized to LF for the textarea)', initial === '# 标题\n正文\n', JSON.stringify(initial))
const dotBefore = await page.locator('span[title="未保存的修改"]').count()
await textarea().click()
await textarea().press('End')
await page.keyboard.type('# 尾注')
const dotAfter = await page.locator('span[title="未保存的修改"]').count()
check('typing flips the dirty dot beside the address path', dotBefore === 0 && dotAfter === 1, `dots ${dotBefore}→${dotAfter}`)

/* ── 2. Menu save writes with CRLF restored. ── */
await menuClick('保存')
await page.waitForTimeout(120)
let calls = await page.evaluate(() => window.__writeCalls)
check(
  'menu save writes the edited content with the original CRLF endings',
  calls.length === 1 && calls[0].filePath === '/w/a.md' && calls[0].content === '# 标题\r\n正文\r\n# 尾注',
  JSON.stringify(calls[0]),
)
check('…and the save clears the dirty dot', (await page.locator('span[title="未保存的修改"]').count()) === 0)

/* ── 3. ⌘S saves too (the editor's own keyboard path). ── */
await textarea().click()
await page.keyboard.press('End')
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
await textarea().click()
await textarea().press('End')
await page.keyboard.type('DRAFT-MARK')
await openFile('/w/b.md')
await menuClick('编辑') // b.md starts in view mode — edit mode is per file
await textarea().waitFor()
check('the other file opens with its own text', (await textarea().inputValue()).startsWith('# B'), '')
await openFile('/w/a.md')
await textarea().waitFor()
check('switching back restores the draft (D4: store survives remount)', (await textarea().inputValue()).includes('DRAFT-MARK'), '')

/* ── 5. Conflict banner: dirty draft + external change (D7). ── */
await openFile('/w/a.md')
await textarea().waitFor()
await page.evaluate(() => {
  const st = window.__store.getState()
  const entry = st.drafts['/w/a.md'] ?? window.__makeDraft(window.__files['/w/a.md'])
  st.setDraft('/w/a.md', { ...entry, content: '我的本地修改\n' })
  window.__files['/w/a.md'] = 'agent 改过的\r\n'
  st.bumpReload('/w/a.md')
})
await page.getByText('文件已被外部修改').waitFor()
check('an external change over a dirty draft raises the conflict banner', true)
check('…and the draft text is still on show (not clobbered)', (await textarea().inputValue()) === '我的本地修改\n', JSON.stringify(await textarea().inputValue()))
await page.getByText('保留我的修改').click()
check('保留我的修改 clears the banner and keeps the draft', (await page.locator('.ant-modal-confirm, div[style*="fff7e6"]').count()) === 0 && (await textarea().inputValue()) === '我的本地修改\n', '')

await page.evaluate(() => {
  const st = window.__store.getState()
  st.markExternalChange('/w/a.md')
})
await page.getByText('文件已被外部修改').waitFor()
await page.getByText('重新加载').click()
await page.waitForTimeout(120)
check('重新加载 discards the draft and shows the disk text', (await textarea().inputValue()) === 'agent 改过的\n', JSON.stringify(await textarea().inputValue()))

/* ── 6. A CLEAN draft refreshes without remounting the editor. ── */
await page.evaluate(() => {
  const st = window.__store.getState()
  st.setDraft('/w/a.md', window.__makeDraft(window.__files['/w/a.md']))
})
const nodeBefore = await page.evaluate(() => {
  window.__taNode = document.querySelector('textarea')
  return !!window.__taNode
})
await page.evaluate(() => {
  window.__files['/w/a.md'] = 'agent 静默改的\n'
  window.__store.getState().bumpReload('/w/a.md')
})
await page.waitForTimeout(150)
const stayed = await page.evaluate(() => document.querySelector('textarea') === window.__taNode)
const adopted = await textarea().inputValue()
check('a clean draft refreshes silently (editor NOT remounted)', nodeBefore && stayed, `same node=${stayed}`)
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
let iframe = await page.evaluate(() => { window.__frame = document.querySelector('iframe'); return !!window.__frame })
await menuClick('保存')
await page.waitForTimeout(150)
const frameReplaced = await page.evaluate(() => document.querySelector('iframe') !== window.__frame)
check('an html file renders its iframe', iframe)
check('…and saving remounts the frame (key={reloadTick}, D5)', frameReplaced, `replaced=${frameReplaced}`)

/* ── 10. A rejected write surfaces the error (D9). ── */
await openFile('/w/deny.md')
await menuClick('编辑')
await textarea().waitFor()
await textarea().click()
await page.keyboard.press('End')
await page.keyboard.type('x')
await page.evaluate(() => { window.__deny['/w/deny.md'] = '路径被拒绝：~/.ssh 属于受保护目录' })
await menuClick('保存')
await page.getByText('路径被拒绝').waitFor()
check('a rejected save shows the error as a toast (D9)', true)

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
await browser.close()
process.exit(failed.length ? 1 : 0)
