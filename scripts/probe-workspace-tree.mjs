/**
 * 工作区 tree probe (PLAN-workbench W15; real Chromium, real mouse).
 *
 * Mounts the production WorkbenchPane (hence the real WorkspaceTree) with the
 * real stores over a stubbed electronAPI serving a fixture directory tree, and
 * drives the two things the user asked for (2026-09-17):
 *
 *   「文件夹展开状态需要在用使用期间进行缓存，避免每次切换 tab 还要重新展开」
 *   「悬停在文件夹或文件上时，需要展示功能按钮：复制、删除」
 *
 *   1. expanding a folder reveals the next level, nested to depth 3;
 *   2. switching the workbench tab really unmounts the tree, and coming back
 *      restores the deep rows with NO clicks — including after 刷新's remount;
 *   3. the hover actions are invisible until the pointer is on the row, and the
 *      row's geometry is identical either way (reserved space, no reflow);
 *   4. 复制路径 puts the absolute path on the clipboard for a file and a folder,
 *      without expanding the folder or opening a preview tab;
 *   5. clicking a file name still opens its 文件预览 tab;
 *   6. 删除 asks first (cancel does nothing at all), then removes the row with
 *      one deletePath call, drops a folder's whole subtree from the expansion
 *      cache, keeps the row and shows the reason when main refuses, closes the
 *      deleted file's preview tab — unless it holds unsaved edits.
 *
 * Why a browser: vitest here is node-env — no layout, no hover, no clipboard,
 * no antd. Every fact above is a fact about what is on screen.
 *
 * Usage: node scripts/probe-workspace-tree.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-ws-tree-')), 'harness.js')
const CONV = 'conv_probe'
const ROOT = '/w'

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { WorkbenchPane } from './src/renderer/src/components/workbench/WorkbenchPane'
import { useWorkbenchStore } from './src/renderer/src/stores/workbenchStore'
import { usePreviewPaneStore } from './src/renderer/src/stores/previewPaneStore'
import { useWorkspaceTreeStore } from './src/renderer/src/stores/workspaceTreeStore'
import { makeDraftFromDisk } from './src/renderer/src/stores/preview-edit'

const CONV = ${JSON.stringify(CONV)}
let root = null
window.__stores = { workbench: useWorkbenchStore, preview: usePreviewPaneStore, tree: useWorkspaceTreeStore }
window.__makeDraft = makeDraftFromDisk
window.__mount = () => {
  if (root) root.unmount()
  useWorkbenchStore.setState({ openByConversation: { [CONV]: true }, activeTab: 'workspace' })
  usePreviewPaneStore.getState().setWorkspaceDir(${JSON.stringify(ROOT)})
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <TranslationProvider initialLocale="zh">
        <WorkbenchPane
          conversationId={CONV}
          chatAreaWidth={900}
          plan={null}
          browserPane={{ visible: false, width: 420, conversationId: CONV, tabs: [] }}
          onBrowserAction={() => {}}
          onBrowserWidth={() => {}}
        />
      </TranslationProvider>
    </ConfigProvider>
  )
  return true
}
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

// Served over 127.0.0.1 (a secure context): navigator.clipboard needs one, and
// the copy checks read the REAL clipboard back.
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><html><body style="margin:0"><div id="root" style="position:relative;width:1200px;height:820px"></div></body></html>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const context = await browser.newContext({ viewport: { width: 1200, height: 820 } })
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN })
const page = await context.newPage()
page.on('pageerror', (err) => console.log('  [page error]', err.message))
await page.goto(`${ORIGIN}/`)
await page.bringToFront()

await page.addScriptTag({
  content: `window.__dirs = {
    '/w': [{ name: 'a', path: '/w/a', isDir: true }, { name: 'b.txt', path: '/w/b.txt', isDir: false },
           { name: 'c.md', path: '/w/c.md', isDir: false }, { name: 'd', path: '/w/d', isDir: true },
           { name: 'e.txt', path: '/w/e.txt', isDir: false }],
    '/w/a': [{ name: 'sub', path: '/w/a/sub', isDir: true }, { name: 'x.txt', path: '/w/a/x.txt', isDir: false }],
    '/w/a/sub': [{ name: 'deep.txt', path: '/w/a/sub/deep.txt', isDir: false }],
    '/w/d': [{ name: 'z.txt', path: '/w/d/z.txt', isDir: false }],
  };
  window.__listed = [];
  window.__deleteCalls = [];
  window.__denyDelete = {};
  window.electronAPI = new Proxy({}, { get: (_t, key) =>
    key === 'listDir' ? (p) => {
      window.__listed.push(p);
      const entries = window.__dirs[p];
      return Promise.resolve(entries === undefined ? null : { entries });
    }
    : key === 'deletePath' ? (p) => {
      window.__deleteCalls.push(p);
      const reason = window.__denyDelete[p];
      return Promise.resolve(reason ? { success: false, error: reason } : { success: true });
    }
    : key === 'readFile' ? () => Promise.resolve(null)
    : key === 'getFileStat' ? () => Promise.resolve(null)
    : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
    : /^on[A-Z]/.test(key) ? () => () => {}
    : () => Promise.resolve(undefined) })`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

/* ── helpers ── */
const row = (p) => page.locator(`.pm-ws-row[data-ws-path="${p}"]`)
const nameOf = (p) => row(p).locator('.pm-ws-name')
const actionsOf = (p) => row(p).locator('.pm-ws-actions')
const copyBtn = (p) => row(p).locator('button[title="复制路径"]')
const delBtn = (p) => row(p).locator('button[title="删除"]')
const tab = (label) => page.getByText(label, { exact: true }).first()
const cache = () => page.evaluate((d) => window.__stores.tree.getState().expandedByDir[d] ?? [], ROOT)
const listed = () => page.evaluate(() => window.__listed.slice())
const deleteCalls = () => page.evaluate(() => window.__deleteCalls.slice())
const tabs = () => page.evaluate((k) => (window.__stores.preview.getState().tabsByConversation[k] ?? []).map((t) => t.path), CONV)
const drafts = () => page.evaluate(() => Object.keys(window.__stores.preview.getState().drafts))
const activeTab = () => page.evaluate(() => window.__stores.workbench.getState().activeTab)
const clipboard = () => page.evaluate(() => navigator.clipboard.readText())
const hover = async (p) => {
  await row(p).hover()
}
/** The confirm dialog's two answers. Selected by class, not by role name:
 *  antd separates two-CJK-character labels (取消 → 取 消), so the accessible
 *  name is not the string the user reads. */
const cancelBtn = () => page.locator('.ant-modal-confirm-btns .ant-btn:not(.ant-btn-primary)')
const okBtn = () => page.locator('.ant-modal-confirm-btns .ant-btn-primary')
/** Open the row's delete confirm and answer it. */
async function clickDelete(p, answer) {
  await hover(p)
  await delBtn(p).click()
  await (answer === 'ok' ? okBtn() : cancelBtn()).click()
  await page.waitForTimeout(180)
}

await page.evaluate(() => window.__mount())
await page.locator('.pm-ws-tree').waitFor()

/* ── 1. The root level renders, one row per entry. ── */
check('the tree renders the workspace root (5 rows, folders and files)', (await page.locator('.pm-ws-row').count()) === 5, `${await page.locator('.pm-ws-row').count()} rows`)
check('a folder row shows its name', (await nameOf('/w/a').innerText()) === 'a')
check('nothing below the root is fetched before it is expanded', !(await listed()).includes('/w/a'), JSON.stringify(await listed()))

/* ── 2. Expanding is a click, and it cascades to depth 3. ── */
await nameOf('/w/a').click()
await row('/w/a/x.txt').waitFor()
check('clicking a folder row reveals its level', await row('/w/a/x.txt').isVisible())
await nameOf('/w/a/sub').click()
await row('/w/a/sub/deep.txt').waitFor()
check('…and the level below that (depth 3)', await row('/w/a/sub/deep.txt').isVisible())
check('both expansions are cached under this workspace dir', JSON.stringify(await cache()) === JSON.stringify(['/w/a', '/w/a/sub']), JSON.stringify(await cache()))

/* ── 3. Leaving the tab unmounts the tree; coming back restores it. ── */
await tab('文件预览').click()
await page.waitForFunction(() => !document.querySelector('.pm-ws-tree'))
check('another workbench tab really unmounts the tree (not just hides it)', (await page.locator('.pm-ws-tree').count()) === 0)
await tab('工作区').click()
await page.locator('.pm-ws-tree').waitFor()
await row('/w/a/sub/deep.txt').waitFor()
check('switching back reopens the cached folders with no clicks', await row('/w/a/sub/deep.txt').isVisible())
check('…including the intermediate level', await row('/w/a/x.txt').isVisible())
check('the cache is untouched by the round trip', JSON.stringify(await cache()) === JSON.stringify(['/w/a', '/w/a/sub']), JSON.stringify(await cache()))

/* ── 4. 刷新 re-reads the tree and the expansion survives its remount. ── */
const deepReads = async () => (await listed()).filter((p) => p === '/w/a/sub').length
const readsBefore = await deepReads()
await page.evaluate(() => {
  document.querySelector('.pm-ws-tree').__probeTag = 'old'
})
await page.locator('button[aria-label="刷新"]').click()
await page.waitForFunction(() => {
  const el = document.querySelector('.pm-ws-tree')
  return el && !el.__probeTag
})
await row('/w/a/sub/deep.txt').waitFor()
check('刷新 remounts the tree (a fresh element)', true)
check('…and the deep rows are open again after it', await row('/w/a/sub/deep.txt').isVisible())
check('refresh re-reads the cached levels from disk', (await deepReads()) === readsBefore + 1, `${readsBefore} → ${await deepReads()}`)

/* ── 5. Hover reveals 复制路径 / 删除 on folders AND files. ── */
const visOf = (p) => actionsOf(p).evaluate((el) => getComputedStyle(el).visibility)
check('the actions are invisible before the pointer arrives', (await visOf('/w/a')) === 'hidden')
const boxBefore = await nameOf('/w/a').boundingBox()
await hover('/w/a')
check('hovering a folder row reveals them', (await visOf('/w/a')) === 'visible')
const boxAfter = await nameOf('/w/a').boundingBox()
check(
  'the row does not reflow on hover (the buttons had their space reserved)',
  Math.abs(boxBefore.x - boxAfter.x) < 0.5 && Math.abs(boxBefore.width - boxAfter.width) < 0.5,
  `${JSON.stringify(boxBefore)} → ${JSON.stringify(boxAfter)}`,
)
await hover('/w/b.txt')
check('a file row has them too', (await visOf('/w/b.txt')) === 'visible')
check('both buttons are on the row', (await copyBtn('/w/c.md').count()) === 1 && (await delBtn('/w/c.md').count()) === 1)

/* ── 6. 复制路径 writes the absolute path — file and folder. ── */
await hover('/w/b.txt')
await copyBtn('/w/b.txt').click()
await page.getByText('已复制路径').first().waitFor()
check('复制路径 on a file puts its absolute path on the clipboard', (await clipboard()) === '/w/b.txt', await clipboard())
check('…without opening a preview tab', JSON.stringify(await tabs()) === '[]', JSON.stringify(await tabs()))
await hover('/w/d')
await copyBtn('/w/d').click()
await page.waitForTimeout(120)
check('复制路径 on a folder copies the folder path', (await clipboard()) === '/w/d', await clipboard())
check('…without expanding it', JSON.stringify(await cache()) === JSON.stringify(['/w/a', '/w/a/sub']), JSON.stringify(await cache()))

/* ── 7. Clicking a file name still opens the preview tab. ── */
await nameOf('/w/b.txt').click()
await page.waitForFunction((k) => (window.__stores.preview.getState().tabsByConversation[k] ?? []).length > 0, CONV)
check('clicking a file name opens its 文件预览 tab', JSON.stringify(await tabs()) === '["/w/b.txt"]', JSON.stringify(await tabs()))
check('…and the workbench flips to that tab', (await activeTab()) === 'files')
check('…which unmounts the tree', (await page.locator('.pm-ws-tree').count()) === 0)
await tab('工作区').click()
await row('/w/a/sub/deep.txt').waitFor()
check('…and back on 工作区 the expansion is still there', await row('/w/a/sub/deep.txt').isVisible())

/* ── 8. 删除 asks first, and 取消 does nothing at all. ── */
await hover('/w/e.txt')
await delBtn('/w/e.txt').click()
await page.getByText('文件「e.txt」将被删除。').waitFor()
check('删除 asks before it acts, naming the file', true)
await cancelBtn().click()
await page.waitForTimeout(180)
check('取消 sends no deletePath', JSON.stringify(await deleteCalls()) === '[]', JSON.stringify(await deleteCalls()))
check('…and leaves the row alone', (await row('/w/e.txt').count()) === 1)

/* ── 9. Confirming deletes exactly that path and drops its row. ── */
await clickDelete('/w/e.txt', 'ok')
check('confirming sends one deletePath for that path', JSON.stringify(await deleteCalls()) === '["/w/e.txt"]', JSON.stringify(await deleteCalls()))
check('…and the row is gone', (await row('/w/e.txt').count()) === 0)
await page.getByText('已删除「e.txt」').first().waitFor()
check('…with a toast naming what went', true)

/* ── 10. A refused delete keeps the row and says why. ── */
await page.evaluate(() => {
  window.__denyDelete['/w/b.txt'] = '路径被拒绝：/w/b.txt 属于受保护目录'
})
await clickDelete('/w/b.txt', 'ok')
check('a refused delete still leaves the row in the tree', (await row('/w/b.txt').count()) === 1)
await page.getByText('路径被拒绝').first().waitFor()
check('…and shows the reason main gave', true)
check('…and its preview tab is untouched', JSON.stringify(await tabs()) === '["/w/b.txt"]', JSON.stringify(await tabs()))

/* ── 11. A successful delete closes the deleted file's clean preview tab. ── */
await page.evaluate(() => {
  delete window.__denyDelete['/w/b.txt']
})
await clickDelete('/w/b.txt', 'ok')
check('the row goes', (await row('/w/b.txt').count()) === 0)
check('…and the preview tab of the deleted file closes with it', JSON.stringify(await tabs()) === '[]', JSON.stringify(await tabs()))

/* ── 12. …but a tab holding unsaved edits stays (edits are never dropped). ── */
await page.evaluate((k) => {
  const s = window.__stores.preview.getState()
  s.openFile(k, '/w/a/x.txt')
  s.setDraft('/w/a/x.txt', { ...window.__makeDraft('orig'), content: 'edited' })
}, CONV)
await tab('工作区').click()
await row('/w/a/x.txt').waitFor()
await clickDelete('/w/a/x.txt', 'ok')
check('the deleted file’s row goes', (await row('/w/a/x.txt').count()) === 0)
check('…but its tab stays because the draft is dirty', JSON.stringify(await tabs()) === '["/w/a/x.txt"]', JSON.stringify(await tabs()))
check('…and so does the draft', JSON.stringify(await drafts()) === '["/w/a/x.txt"]', JSON.stringify(await drafts()))

/* ── 13. Deleting a folder takes its subtree and its cached keys. ── */
await hover('/w/a')
await delBtn('/w/a').click()
await page.getByText('文件夹「a」及其中的全部内容将被删除。').waitFor()
check('a folder delete says what it will take with it', true)
await okBtn().click()
await page.waitForTimeout(180)
check('the folder row is gone', (await row('/w/a').count()) === 0)
check('…and so is everything that was open under it', (await row('/w/a/sub/deep.txt').count()) === 0)
check(
  '…and both keys left the expansion cache (a remount cannot re-expand a ghost)',
  JSON.stringify(await cache()) === '[]',
  JSON.stringify(await cache()),
)

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
await browser.close()
server.close()
process.exit(failed.length ? 1 : 0)
