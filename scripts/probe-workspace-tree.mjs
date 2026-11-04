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
 *      row's geometry is identical either way (overlay, no reflow);
 *      (复制路径 was removed 2026-10-31, user: 去掉复制路径的按钮 — the old
 *      clipboard checks went with it);
 *   5. clicking a file name previews it BESIDE the tree in the same 工作区
 *      view (the standalone 文件预览 tab is gone, 2026-10-25): the address bar
 *      sits INSIDE the preview column, directly above the preview, and names
 *      the FILE ON SCREEN — not the tree selection (2026-10-30 裁定) — while
 *      carrying 打开 + a 更多 menu holding 编辑/保存/刷新; the tree shrinks to
 *      make room and the preview area is always on screen;
 *   6. the selected row (file AND folder) paints the app's grey-on-ink pair —
 *      灰底黑字, not the black-on-white DirectoryTree defaults derive;
 *   7. 搜索 walks the whole workspace recursively (a depth-3 hit needs no
 *      expansion), paints the matched substring and previews the clicked hit;
 *      clearing the query restores the browsing tree untouched;
 *   8. 删除 asks first (cancel does nothing at all), then removes the row with
 *      one deletePath call, drops a folder's whole subtree from the expansion
 *      cache, keeps the row and shows the reason when main refuses, closes the
 *      deleted file's preview tab — unless it holds unsaved edits;
 *   (9/10 removed 2026-11-01, user: 交互逻辑变了 — the reveal walk (an opened
 *      file auto-expanded the lazy tree to its row; a folded ancestor under an
 *      active selection re-expanded) is gone. The expansion cache only answers
 *      user clicks now; an agent-opened preview of an unlisted folder simply
 *      does not highlight in the tree.);
 *   11. 「在系统中打开」 is the row's Finder exit (files in their default app,
 *       folders in Finder) — added 2026-10-30, when the address bar stopped
 *       speaking for the tree selection; the click must not select/expand the
 *       row and must not disturb the previewed file;
 *   12. the FILE TAB STRIP (2026-10-30 裁定: it took the row the address bar
 *       used to hold): one chip per open preview, spanning the WHOLE pane
 *       above the tree column and above the address bar, click-to-front (the
 *       address bar follows), unsaved dot, session-change dot from the same
 *       ledger, closing a dirty chip asks first, the 32px row survives the
 *       empty set, and beyond the cap the chips scroll rather than squash.
 *
 * Why a browser: vitest here is node-env — no layout, no hover,
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
import { buildAntdTheme } from './src/renderer/src/theme/tokens'
import { buildThemeCss } from './src/renderer/src/theme/palette'
import { WorkbenchPane } from './src/renderer/src/components/workbench/WorkbenchPane'
import { useWorkbenchStore } from './src/renderer/src/stores/workbenchStore'
import { usePreviewPaneStore } from './src/renderer/src/stores/previewPaneStore'
import { useWorkspaceTreeStore } from './src/renderer/src/stores/workspaceTreeStore'
import { useSessionFileChangesStore } from './src/renderer/src/stores/sessionFileChangesStore'
import { makeDraftFromDisk } from './src/renderer/src/stores/preview-edit'

const CONV = ${JSON.stringify(CONV)}
let root = null
window.__stores = { workbench: useWorkbenchStore, preview: usePreviewPaneStore, tree: useWorkspaceTreeStore, changes: useSessionFileChangesStore }
window.__makeDraft = makeDraftFromDisk
window.__mount = () => {
  if (root) root.unmount()
  // The app's own \`--pm-*\` variables (the tree/city inks, the tab chip's wash):
  // the harness page has no palette of its own, and a var that resolves to
  // nothing would make every ink check read transparent.
  if (!document.getElementById('pm-theme-vars')) {
    const style = document.createElement('style')
    style.id = 'pm-theme-vars'
    style.textContent = buildThemeCss()
    document.head.appendChild(style)
  }
  useWorkbenchStore.setState({ openByConversation: { [CONV]: true }, activeTab: 'workspace' })
  usePreviewPaneStore.getState().setWorkspaceDir(${JSON.stringify(ROOT)})
  root = createRoot(document.getElementById('root'))
  root.render(
    // The app's theme, not antd's default blue: the tree's selected pair is
    // antd-token-borne (directoryNodeSelected*), so a bare ConfigProvider
    // would pin the wrong paint.
    <ConfigProvider theme={buildAntdTheme('light')}>
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

// Served over 127.0.0.1 (a secure context) so the page is a normal origin.
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><html><body style="margin:0"><div id="root" style="position:relative;width:1200px;height:820px"></div></body></html>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const context = await browser.newContext({ viewport: { width: 1200, height: 820 } })
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
  window.__openOsCalls = [];
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
      // The stub IS the disk: a successful delete prunes the fixture tree, so
      // a later re-list (刷新's remount restores the cached levels) cannot
      // resurrect the row.
      if (!reason) {
        const parent = p.slice(0, p.lastIndexOf('/'));
        if (window.__dirs[parent]) window.__dirs[parent] = window.__dirs[parent].filter((e) => e.path !== p);
        for (const key of Object.keys(window.__dirs)) {
          if (key === p || key.startsWith(p + '/')) delete window.__dirs[key];
        }
      }
      return Promise.resolve(reason ? { success: false, error: reason } : { success: true });
    }
    : key === 'readFile' ? () => Promise.resolve(null)
    : key === 'getFileStat' ? () => Promise.resolve(null)
    : key === 'openFolder' ? (p) => {
      window.__openOsCalls.push(p);
      return Promise.resolve(undefined);
    }
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
const addressPath = () => page.locator('[data-ws-address-path]').innerText()
/** The one selected row's paint: the treenode's background + the title's ink.
 *  DirectoryTree derives both from its own component tokens — pinned to the
 *  app's grey-on-ink selected pair, NOT the black-on-white the DirectoryTree
 *  defaults build from colorPrimary/colorTextLightSolid (2026-10-25). */
const selectedRowStyle = () =>
  page.locator('.pm-ws-tree .ant-tree-treenode-selected').evaluate((el) => {
    const wrapper = el.querySelector('.ant-tree-node-content-wrapper')
    return {
      bg: getComputedStyle(el).backgroundColor,
      ink: wrapper ? getComputedStyle(wrapper).color : null,
    }
  })
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

/* ── 2b. The selected folder is grey-on-ink, not the 黑底白字 the DirectoryTree
          defaults derive from colorPrimary + colorTextLightSolid; the address
          bar inside the preview column names the on-screen FILE, not this
          selection (2026-10-30 裁定). ── */
const folderSel = await selectedRowStyle()
check(
  'the selected folder is grey-on-ink (灰底黑字)',
  folderSel.bg === 'rgb(245, 245, 245)' && folderSel.ink === 'rgba(0, 0, 0, 0.88)',
  JSON.stringify(folderSel),
)
// Nothing is previewed yet, so the bar falls back to the workspace root: the
// selected folder must NOT walk into it any more (that entry point is the row's
// 在系统中打开 hover action now — §18).
check(
  'the address bar does NOT follow the folder selection (it names the on-screen file)',
  (await addressPath()) === '/w',
  await addressPath(),
)
check('…and still carries 打开 and 更多', (await page.locator('[data-ws-open]').count()) === 1 && (await page.locator('[data-ws-more]').count()) === 1)

/* ── 3. Leaving the tab unmounts the tree; coming back restores it. ── */
await tab('浏览器').click()
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

/* ── 5. Hover reveals 在系统中打开 / 删除 on folders AND files (复制路径 was
          removed 2026-10-31, user: 去掉复制路径的按钮). ── */
const visOf = (p) => actionsOf(p).evaluate((el) => getComputedStyle(el).visibility)
check('the actions are invisible before the pointer arrives', (await visOf('/w/a')) === 'hidden')
const boxBefore = await nameOf('/w/a').boundingBox()
await hover('/w/a')
check('hovering a folder row reveals them', (await visOf('/w/a')) === 'visible')
const boxAfter = await nameOf('/w/a').boundingBox()
check(
  'the row does not reflow on hover (the buttons float above the name — overlay, not reservation)',
  Math.abs(boxBefore.x - boxAfter.x) < 0.5 && Math.abs(boxBefore.width - boxAfter.width) < 0.5,
  `${JSON.stringify(boxBefore)} → ${JSON.stringify(boxAfter)}`,
)
await hover('/w/b.txt')
check('a file row has them too', (await visOf('/w/b.txt')) === 'visible')
check(
  'exactly the two remaining buttons are on the row (打开 + 删除, no 复制路径)',
  (await row('/w/c.md').locator('button[title="在系统中打开"]').count()) === 1 &&
    (await delBtn('/w/c.md').count()) === 1 &&
    (await copyBtn('/w/c.md').count()) === 0,
)

/* ── 7. Clicking a file name previews it beside the tree (merged view). ── */
const treeBoxFull = await page.locator('.pm-ws-tree').boundingBox()
await nameOf('/w/b.txt').click()
await page.waitForFunction((k) => (window.__stores.preview.getState().tabsByConversation[k] ?? []).length > 0, CONV)
await page.waitForFunction(() => document.querySelector('[data-ws-address-path]')?.textContent === '/w/b.txt')
check('clicking a file name registers its preview tab', JSON.stringify(await tabs()) === '["/w/b.txt"]', JSON.stringify(await tabs()))
check('…and the workbench stays on 工作区 (no separate 文件预览 tab exists)', (await activeTab()) === 'workspace')
check('…and the address bar shows the file’s path', (await addressPath()) === '/w/b.txt')
check('…and the tree stays mounted beside the preview', (await page.locator('.pm-ws-tree').count()) === 1)
// The file tab strip is back (2026-10-30 裁定) — as the pane's top row, NOT
// inside the preview body (the shape 0e3cd23 deleted).
check('…and the pane’s top row is the file tab strip', (await page.locator('[data-ws-tabstrip]').count()) === 1)
check('…with one chip for the open file', (await page.locator('.pm-ws-tab').count()) === 1)
const treeBoxSplit = await page.locator('.pm-ws-tree').boundingBox()
check(
  '…and the split is steady: the tree holds its ~40% column before and after a preview opens',
  Math.abs(treeBoxSplit.width - treeBoxFull.width) < 1 && treeBoxFull.width >= 150,
  `${Math.round(treeBoxFull.width)}px → ${Math.round(treeBoxSplit.width)}px`,
)
await row('/w/a/sub/deep.txt').waitFor()
check('…and the expansion is still there beside it', await row('/w/a/sub/deep.txt').isVisible())
const fileSel = await selectedRowStyle()
check(
  'the selected file wears the same grey-on-ink pair as a folder',
  fileSel.bg === 'rgb(245, 245, 245)' && fileSel.ink === 'rgba(0, 0, 0, 0.88)',
  JSON.stringify(fileSel),
)
/* The 更多 menu carries the preview actions the old toolbar held. */
await page.locator('[data-ws-more]').click()
await page.getByRole('menuitem', { name: '刷新' }).waitFor()
check(
  'the 更多 menu holds 编辑/保存/刷新',
  (await page.getByRole('menuitem', { name: '编辑', exact: true }).count()) === 1 &&
    (await page.getByRole('menuitem', { name: '保存' }).count()) === 1 &&
    (await page.getByRole('menuitem', { name: '刷新' }).count()) === 1,
)
await page.keyboard.press('Escape')

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
check('…and the preview area returns to its empty hint', await page.getByText('在左侧目录树中点击文件预览').isVisible())
check('…and the address bar falls back to the workspace root', (await addressPath()) === '/w', await addressPath())

/* ── 12. …but a tab holding unsaved edits stays (edits are never dropped). ── */
await page.evaluate((k) => {
  const s = window.__stores.preview.getState()
  s.openFile(k, '/w/a/x.txt')
  s.setDraft('/w/a/x.txt', { ...window.__makeDraft('orig'), content: 'edited' })
}, CONV)
await row('/w/a/x.txt').waitFor()
await clickDelete('/w/a/x.txt', 'ok')
check('the deleted file’s row goes', (await row('/w/a/x.txt').count()) === 0)
check('…but its tab stays because the draft is dirty', JSON.stringify(await tabs()) === '["/w/a/x.txt"]', JSON.stringify(await tabs()))
check('…and so does the draft', JSON.stringify(await drafts()) === '["/w/a/x.txt"]', JSON.stringify(await drafts()))
check('…and the preview keeps showing the file (address bar too)', (await addressPath()) === '/w/a/x.txt', await addressPath())

/* ── 13. 搜索 walks the whole workspace recursively; a hit previews; clearing
          restores. The query 'deep' hits a depth-3 file no expansion has been
          paid for in this state (x.txt's row is gone, /w/a/sub is collapsed in
          the search tree). Click the NAME, never the row's centre: hovering a
          row reveals its action cluster, and the centre of a deep row
          now lands on a button — which deliberately swallows the event. ── */
const searchBox = page.locator('input[aria-label="搜索文件"]')
await searchBox.fill('deep')
await page.waitForFunction(() => document.querySelectorAll('.pm-ws-hit').length > 0)
check('a nested hit surfaces without any expansion (recursive walk)', await row('/w/a/sub/deep.txt').isVisible())
check('…with the matched substring painted', (await page.locator('.pm-ws-hit').count()) >= 1 && (await page.locator('.pm-ws-hit').first().innerText()) === 'deep')
// Overlay actions (2026-10-31): on hover the buttons float over the name's
// right end, so a deep row's name CENTRE lands on a button — click the name's
// left end, the way a user clicks the text itself.
await nameOf('/w/a/sub/deep.txt').click({ position: { x: 6, y: 12 } })
await page.waitForFunction((k) => (window.__stores.preview.getState().tabsByConversation[k] ?? []).some((t) => t.path === '/w/a/sub/deep.txt'), CONV)
check('clicking the search hit previews it', JSON.stringify(await tabs()).includes('/w/a/sub/deep.txt'), JSON.stringify(await tabs()))
check('…and the address bar names it', (await addressPath()) === '/w/a/sub/deep.txt', await addressPath())
await searchBox.fill('')
await page.waitForFunction(() => document.querySelectorAll('.pm-ws-hit').length === 0)
check('clearing the query restores the browsing tree', await row('/w/a/sub/deep.txt').isVisible())
check('…with the expansion cache untouched', JSON.stringify(await cache()) === JSON.stringify(['/w/a', '/w/a/sub']), JSON.stringify(await cache()))

/* ── 14. Deleting a folder takes its subtree and its cached keys. ── */
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

/* ── 16. The tree↔preview divider is draggable (2026-10-26): the tree column
          used to be a fixed 40% share; it is now a persisted px width with a
          6px handle straddling the separator, clamped live against the row.
          The tree is LEFT-aligned and the handle rides its right edge, so the
          border FOLLOWS the pointer — rightward travel widens the tree (the
          mirrored direction belongs to right-docked panes; the first cut had
          it backwards and the handle ran away from a leftward drag). Real
          mouse throughout: a hidden, covered or pointer-events:none handle
          fails here instead of confusing a user. ── */
console.log('\n§16 目录树 ↔ 预览分隔条可拖拽')
{
  // A wide pane so the drag has room: width 540 clamps clean against the
  // 900px chat area (max 540), leaving treeMax = 540 − 240 ≈ 300.
  await page.evaluate(() => window.__stores.workbench.setState({ width: 540, treeWidth: 170 }))
  await page.waitForTimeout(120)
  const columnBox = () => page.locator('[data-pm-tree-column]').boundingBox()
  const handleBox = () => page.locator('[data-pm-tree-drag-handle]').boundingBox()
  const storedTreeWidth = () => page.evaluate(() => window.__stores.workbench.getState().treeWidth)
  const cx = (b) => b.x + b.width / 2

  let box = await columnBox()
  check('the tree column opens at the stored width', Math.abs(box.width - 170) <= 1, `w=${box.width}`)
  const handle = await handleBox()
  check('the handle straddles the separator', Math.abs(cx(handle) - (box.x + box.width)) <= 1.5, `handleCx=${cx(handle)} border=${box.x + box.width}`)
  const cursor = await page.locator('[data-pm-tree-drag-handle]').evaluate((el) => getComputedStyle(el).cursor)
  check('the handle advertises col-resize', cursor === 'col-resize', cursor)

  // Drag RIGHT 60px (from the handle's centre, where the press landed) → the
  // border follows the pointer and the tree widens to 230.
  const p0 = { x: cx(handle), y: handle.y + 200 }
  const p1 = { x: p0.x + 60, y: p0.y }
  await page.mouse.move(p0.x, p0.y)
  await page.mouse.down()
  await page.mouse.move(p1.x, p1.y, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(80)
  box = await columnBox()
  check('dragging the handle right widens the tree (border follows pointer)', Math.abs(box.width - 230) <= 1.5, `w=${box.width}`)
  // The measured box includes the column's 1px right border (nothing in this
  // app sets box-sizing: border-box globally — not in the harness page either),
  // so the store never equals the box to the pixel. Pre-existing off-by-one
  // border slip, found 2026-10-30 while re-running after the tab-strip change
  // (the stashed baseline fails it identically).
  check('…and the width persisted to the store', Math.abs((await storedTreeWidth()) - box.width) <= 1, `store=${await storedTreeWidth()} box=${box.width}`)
  // The regression assert for the reversed-direction cut: the dragged border
  // must still sit under the pointer when the drag ends.
  const h1 = await handleBox()
  check('…and the handle is still under the pointer', Math.abs(cx(h1) - p1.x) <= 1.5, `handleCx=${cx(h1)} pointer=${p1.x}`)

  // Drag right 500px more → clamped at the preview's floor: row − 240 ≈ 300.
  const h2 = await handleBox()
  await page.mouse.move(cx(h2), h2.y + 200)
  await page.mouse.down()
  await page.mouse.move(cx(h2) + 500, h2.y + 200, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(80)
  box = await columnBox()
  check('a huge rightward drag clamps at row − 240', Math.abs(box.width - 300) <= 2, `w=${box.width}`)

  // Drag left far → clamped at the tree's own floor of 150.
  const h3 = await handleBox()
  await page.mouse.move(cx(h3), h3.y + 200)
  await page.mouse.down()
  await page.mouse.move(cx(h3) - 800, h3.y + 200, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(80)
  box = await columnBox()
  check('a huge leftward drag clamps at the tree minimum 150', Math.abs(box.width - 150) <= 1.5, `w=${box.width}`)
  check('…and the clamp landed in the store too', (await storedTreeWidth()) === 150, `store=${await storedTreeWidth()}`)

  // The persisted value survives a remount (≈ restart): the store re-reads
  // its own last write, no click needed.
  await page.evaluate(() => window.__mount())
  await page.waitForTimeout(200)
  box = await columnBox()
  check('a remount restores the dragged width', Math.abs(box.width - 150) <= 1.5, `w=${box.width}`)
  await page.evaluate(() => window.__stores.workbench.setState({ width: 420, treeWidth: 180 }))
}

/* ── 18. 在系统中打开：树行的 Finder 出口（2026-10-30 裁定——地址栏只认屏上
          文件，被选中的文件夹就没了出口，出口搬到树行；同一颗按钮对文件也可
          用）。点击不得选中/展开该行，也不得打扰正在预览的文件。 ── */
await page.evaluate(() => {
  window.__openOsCalls = []
})
const listedBeforeOs = JSON.stringify(await listed())
const addrBeforeOs = await addressPath()
await hover('/w/d')
await page.locator('.pm-ws-row[data-ws-path="/w/d"] button[title="在系统中打开"]').click()
await page.waitForTimeout(120)
const osCalls = await page.evaluate(() => window.__openOsCalls.slice())
check('在系统中打开 sends one openFolder for the folder’s path', JSON.stringify(osCalls) === '["/w/d"]', JSON.stringify(osCalls))
check('…without listing anything (the click does not select/expand the row)', JSON.stringify(await listed()) === listedBeforeOs, `${listedBeforeOs} → ${JSON.stringify(await listed())}`)
// Whatever the on-screen file is at this point (§13's search-hit preview since
// the reveal walk left), the Finder exit must not disturb it.
check('…and the previewed file is untouched', (await addressPath()) === addrBeforeOs, `${addrBeforeOs} → ${await addressPath()}`)

/* ── 19. 文件页签条（2026-10-30 裁定）：跨整面板宽、在树列与地址栏之上、切页签
          联动地址栏、脏点、改动点、脏页签关闭先问、空态不塌、溢出横滑。 ── */
const stripRowBox = () => page.locator('[data-ws-tabstrip-row]').boundingBox()
const chip = (p) => page.locator(`.pm-ws-tab[data-tab-path="${p}"]`)
const closeAllTabs = () =>
  page.evaluate((k) => {
    const p = window.__stores.preview.getState()
    for (const t of p.tabsByConversation[k] ?? []) p.closeTab(k, t.path)
  }, CONV)

// Reset to a known set (the chips §7 left behind go with it).
await closeAllTabs()
await page.waitForTimeout(120)
const emptyStrip = await stripRowBox()
check('the empty strip keeps its 32px row (opening the first file cannot shift the tree)', Math.abs(emptyStrip.height - 32) <= 1, `${emptyStrip.height}px`)
check('…with the empty hint inside it', await page.getByText('未打开文件').first().isVisible())

// 19a. One file → one chip; the strip spans the pane and sits above both columns.
await nameOf('/w/c.md').click()
await chip('/w/c.md').waitFor()
const stripBox = await stripRowBox()
const paneRow = await page.locator('[data-pm-workspace-row]').boundingBox()
const treeCol = await page.locator('[data-pm-tree-column]').boundingBox()
const addrBox = await page.locator('[data-ws-address]').boundingBox()
const searchRowBox = await page.locator('input[aria-label="搜索文件"]').boundingBox()
check(
  'the strip spans the whole pane (same left/right edge as the tree+preview row)',
  Math.abs(stripBox.x - paneRow.x) <= 1 && Math.abs(stripBox.x + stripBox.width - (paneRow.x + paneRow.width)) <= 1,
  `${Math.round(stripBox.x)}..${Math.round(stripBox.x + stripBox.width)} vs ${Math.round(paneRow.x)}..${Math.round(paneRow.x + paneRow.width)}`,
)
check('…so it is wider than the tree column beside the preview', stripBox.width > treeCol.width + 20, `${Math.round(stripBox.width)}px > ${Math.round(treeCol.width)}px`)
check('…and the tree column starts below it (its search row too)', treeCol.y >= stripBox.y + stripBox.height - 1 && searchRowBox.y >= stripBox.y + stripBox.height - 1)
check('…and the address bar starts below it (inside the preview column)', addrBox.y >= stripBox.y + stripBox.height - 1 && addrBox.x >= treeCol.x + treeCol.width - 1, `addr y=${Math.round(addrBox.y)} x=${Math.round(addrBox.x)}`)
// 地址栏与目录树工具栏同高（2026-10-30 用户裁定「高度不一致」）：
// 工具栏没有锚点属性；antd Input 的 DOM 是 affix-wrapper 包 input，所以要上跳
// 两级（input → wrapper → 工具栏条）。
const treeToolbarHeight = await page.locator('input[aria-label="搜索文件"]').locator('xpath=../..').evaluate((el) => el.getBoundingClientRect().height)
check('…and matches the tree toolbar’s height', Math.abs(addrBox.height - treeToolbarHeight) <= 1, `addr=${Math.round(addrBox.height)} tree-toolbar=${Math.round(treeToolbarHeight)}`)

// 19b. A second file → second chip, newest active, house tab styling.
// The tree is lazy and the reveal walk is gone (2026-11-01, user: 交互逻辑变
// 了) — z.txt's row only exists once its folder is expanded, so open /w/d the
// way a user does: a real click on the folder row.
await nameOf('/w/d').click()
await row('/w/d/z.txt').waitFor()
await nameOf('/w/d/z.txt').click()
await chip('/w/d/z.txt').waitFor()
check('a second open file adds a second chip, in open order', JSON.stringify(await tabs()) === '["/w/c.md","/w/d/z.txt"]', JSON.stringify(await tabs()))
check('…and the newest chip is the active one', (await chip('/w/d/z.txt').getAttribute('data-active')) === 'true' && (await chip('/w/c.md').getAttribute('data-active')) === 'false')
check(
  '…wearing the house tab pair (600 + tile wash on the active chip, 400 on the other)',
  (await chip('/w/d/z.txt').evaluate((el) => getComputedStyle(el).fontWeight)) === '600' &&
    (await chip('/w/c.md').evaluate((el) => getComputedStyle(el).fontWeight)) === '400' &&
    (await chip('/w/d/z.txt').evaluate((el) => getComputedStyle(el).backgroundColor)) === 'rgb(240, 241, 244)',
  await chip('/w/d/z.txt').evaluate((el) => getComputedStyle(el).backgroundColor),
)

// 19c. Clicking the other chip brings it to the front — bar included.
await chip('/w/c.md').click()
await page.waitForFunction(() => document.querySelector('[data-ws-address-path]')?.textContent === '/w/c.md')
check('clicking a chip brings that file to the front', (await page.evaluate((k) => window.__stores.preview.getState().activeByConversation[k], CONV)) === '/w/c.md')
check('…and the address bar follows it (it names the on-screen file)', (await addressPath()) === '/w/c.md', await addressPath())
check('…and the chip roles swapped', (await chip('/w/c.md').getAttribute('data-active')) === 'true' && (await chip('/w/d/z.txt').getAttribute('data-active')) === 'false')

// 19d. Unsaved ink on the tab TEXT + the dirty-close confirm (D10).
// (2026-10-30 用户裁定「页签不要圆点，直接改文字颜色」— the state reads from
// the chip's computed color now, not from a dot's background.)
await page.evaluate(() => {
  window.__stores.preview.getState().setDraft('/w/c.md', { ...window.__makeDraft('orig'), content: 'edited' })
})
await page.waitForTimeout(120) // store 写入是同步的，React 提交不是
check('a draft turns the chip’s text the unsaved orange', (await chip('/w/c.md').evaluate((el) => getComputedStyle(el).color)) === 'rgb(250, 140, 22)',
  await chip('/w/c.md').evaluate((el) => getComputedStyle(el).color))
check('…and no dot remains anywhere on the strip', (await page.locator('[data-ws-tab-dot], [data-ws-change-dot]').count()) === 0)
await chip('/w/c.md').locator('.pm-ws-tab-close').click()
await page.locator('.ant-modal-confirm').waitFor()
check('closing a dirty chip asks first (edits are never dropped silently)', (await page.locator('.ant-modal-confirm').count()) === 1)
await cancelBtn().click()
await page.waitForTimeout(200)
check('…cancelling keeps the chip and its draft', (await page.locator('.pm-ws-tab').count()) === 2 && JSON.stringify(await drafts()) === '["/w/c.md"]', `${await page.locator('.pm-ws-tab').count()} chips, drafts ${JSON.stringify(await drafts())}`)
await chip('/w/c.md').locator('.pm-ws-tab-close').click()
await page.locator('.ant-modal-confirm').waitFor()
await okBtn().click()
await page.waitForTimeout(200)
check('…confirming closes it and drops the draft', JSON.stringify(await tabs()) === '["/w/d/z.txt"]' && JSON.stringify(await drafts()) === '[]', `${JSON.stringify(await tabs())} / ${JSON.stringify(await drafts())}`)
check('…and the remaining chip is the active one again', (await chip('/w/d/z.txt').getAttribute('data-active')) === 'true')

// 19e. Session-change ink on the tab TEXT — the tree rows' ledger, read once
// for the strip. (Dot removed 2026-10-30; the ink is the text color now.)
await page.evaluate((k) => window.__stores.changes.getState().set(k, [{ path: '/w/d/z.txt', kind: 'created' }]), CONV)
await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-tab-path="/w/d/z.txt"]')).color === 'rgb(88, 124, 12)')
check('the chip wears the session-change ink from the same ledger', (await chip('/w/d/z.txt').evaluate((el) => getComputedStyle(el).color)) === 'rgb(88, 124, 12)',
  await chip('/w/d/z.txt').evaluate((el) => getComputedStyle(el).color))
await page.evaluate((k) => window.__stores.changes.getState().drop(k), CONV)
await page.waitForTimeout(120)
check('…and drops it when the ledger does', (await chip('/w/d/z.txt').evaluate((el) => getComputedStyle(el).color)) !== 'rgb(88, 124, 12)',
  await chip('/w/d/z.txt').evaluate((el) => getComputedStyle(el).color))

// 19f. Empty set again: same row, no collapse; the pane stays open.
await closeAllTabs()
await page.waitForTimeout(150)
const emptyAgain = await stripRowBox()
check('closing the last chip leaves the same 32px row (the pane does not collapse)', Math.abs(emptyAgain.height - 32) <= 1 && (await page.locator('[data-ws-tabstrip]').count()) === 1, `${emptyAgain.height}px`)
check('…and the empty hint is back', await page.getByText('未打开文件').first().isVisible())
check('…and the preview falls back to its own empty state', await page.getByText('在左侧目录树中点击文件预览').isVisible())
check('…and the address bar falls back to the workspace root', (await addressPath()) === '/w', await addressPath())

// 19g. Overflow: beyond MAX_OPEN_TABS the chips scroll, active one revealed.
await page.evaluate((k) => {
  const p = window.__stores.preview.getState()
  for (let i = 0; i < 14; i++) p.openFile(k, `/w/wide-${i}.md`)
}, CONV)
await page.waitForFunction(() => document.querySelectorAll('.pm-ws-tab').length === 12)
check('beyond the cap the oldest chips are evicted (12 chips)', (await page.locator('.pm-ws-tab').count()) === 12, `${await page.locator('.pm-ws-tab').count()} chips`)
const overflow = await page.locator('[data-ws-tabstrip]').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
check('…and the strip scrolls instead of squashing the chips', overflow.sw > overflow.cw, `scrollWidth ${overflow.sw} > clientWidth ${overflow.cw}`)
const lastChip = await chip('/w/wide-13.md').boundingBox()
const stripScroll = await page.locator('[data-ws-tabstrip]').boundingBox()
check(
  '…with the newly opened (active) chip scrolled into view',
  lastChip.x >= stripScroll.x - 1 && lastChip.x + lastChip.width <= stripScroll.x + stripScroll.width + 1,
  `${Math.round(lastChip.x)}..${Math.round(lastChip.x + lastChip.width)} in ${Math.round(stripScroll.x)}..${Math.round(stripScroll.x + stripScroll.width)}`,
)

// 19h. MOUSE WHEEL over the strip = horizontal scroll (the trackpad's two-finger
//      swipe is native deltaX; a mouse only has deltaY, so the component converts
//      it). User question 2026-10-30: 「触控板能滑，鼠标怎么操作」 — this is the
//      measurement that answers it, and the negative control is the empty set:
//      with nothing to scroll the wheel must be left to the pane.
const wheelScrollLeft = () => page.locator('[data-ws-tabstrip]').evaluate((el) => el.scrollLeft)
await page.evaluate(() => { document.querySelector('[data-ws-tabstrip]').scrollLeft = 0 })
const wheelSpot = await page.locator('[data-ws-tabstrip]').boundingBox()
await page.mouse.move(wheelSpot.x + wheelSpot.width / 2, wheelSpot.y + wheelSpot.height / 2)
await page.mouse.wheel(0, 200)
await page.waitForTimeout(150)
const afterDown = await wheelScrollLeft()
check('a MOUSE WHEEL over the strip scrolls it horizontally (vertical delta → scrollLeft)', afterDown > 0, `scrollLeft ${afterDown}`)
await page.mouse.wheel(0, -400)
await page.waitForTimeout(150)
check('…and back (the gesture is symmetric, no rubber-banding left over)', (await wheelScrollLeft()) === 0, `scrollLeft ${await wheelScrollLeft()}`)

// …and the OS-standard gesture a mouse user reaches for: Shift + wheel. That is
// the browser's own horizontal mapping (`overflow-x: auto`), so it must work
// WITHOUT any code of ours — measured, not assumed.
await page.evaluate(() => { document.querySelector('[data-ws-tabstrip]').scrollLeft = 0 })
await page.mouse.move(wheelSpot.x + wheelSpot.width / 2, wheelSpot.y + wheelSpot.height / 2)
await page.keyboard.down('Shift')
await page.mouse.wheel(0, 200)
await page.keyboard.up('Shift')
await page.waitForTimeout(150)
check('Shift + wheel works natively (the OS-standard horizontal gesture, no code of ours)', (await wheelScrollLeft()) > 0, `scrollLeft ${await wheelScrollLeft()}`)
await page.evaluate(() => { document.querySelector('[data-ws-tabstrip]').scrollLeft = 0 })

// 19i. 两端渐隐（2026-10-30 用户裁定「两端渐隐提示」）：端头各去一边、中段两边
//      都在，而且遮罩绝不能吃点击（它盖在页签之上）。点击落点取「左端遮罩」而
//      非右端：页签的右缘是 ✕ 关闭钮（首次实测就点中了它，页签被关掉），而左缘
//      永远是标题区——那才是「点击应该穿过遮罩」的干净样本。
const fadeEdges = () =>
  page.evaluate(() => Array.from(document.querySelectorAll('[data-strip-fade]')).map((el) => el.getAttribute('data-strip-fade')).sort())
const setScrollLeft = async (v) => {
  await page.evaluate((x) => { const el = document.querySelector('[data-ws-tabstrip]'); el.scrollLeft = x === -1 ? el.scrollWidth : x }, v)
  await page.waitForTimeout(120)
}
await setScrollLeft(0)
check('at the left end only the RIGHT edge fades', JSON.stringify(await fadeEdges()) === '["right"]', JSON.stringify(await fadeEdges()))
await setScrollLeft(-1)
check('at the far right end only the LEFT edge fades', JSON.stringify(await fadeEdges()) === '["left"]', JSON.stringify(await fadeEdges()))
await page.evaluate(() => { const el = document.querySelector('[data-ws-tabstrip]'); el.scrollLeft = Math.round((el.scrollWidth - el.clientWidth) / 2) })
await page.waitForTimeout(120)
check('mid-strip BOTH edges fade', JSON.stringify(await fadeEdges()) === '["left","right"]', JSON.stringify(await fadeEdges()))

await setScrollLeft(-1)
const fadeBox = await page.locator('[data-ws-tabstrip]').boundingBox()
const fadeY = fadeBox.y + fadeBox.height / 2
// (a) the strict property: no point inside the mask's zone hit-tests to the mask.
const maskHits = await page.evaluate(
  ({ x0, y }) => {
    const out = []
    for (let dx = 2; dx <= 14; dx += 3) {
      const el = document.elementFromPoint(x0 + dx, y)
      out.push({ dx, mask: !!el?.closest?.('[data-strip-fade]'), chip: el?.closest?.('[data-tab-path]')?.getAttribute('data-tab-path') ?? null })
    }
    return out
  },
  { x0: fadeBox.x, y: fadeY },
)
check(
  'no point inside the left mask hit-tests to the mask itself (pointer-events: none)',
  maskHits.length === 5 && maskHits.every((h) => !h.mask),
  JSON.stringify(maskHits.map((h) => h.mask)),
)
// (b) end to end: a click inside the mask, on a chip's TITLE, activates that chip.
const titleUnderMask = await page.evaluate(
  ({ x0, y }) => {
    for (let dx = 2; dx <= 14; dx += 2) {
      const el = document.elementFromPoint(x0 + dx, y)
      const chip = el?.closest?.('[data-tab-path]')
      if (!chip) continue
      const close = chip.querySelector('.pm-ws-tab-close')?.getBoundingClientRect()
      if (!close || close.left > x0 + dx + 2) return { dx, path: chip.getAttribute('data-tab-path') }
    }
    return null
  },
  { x0: fadeBox.x, y: fadeY },
)
check('a chip TITLE really sits under the left mask at this scroll position', !!titleUnderMask, JSON.stringify(titleUnderMask))
const activeBefore = await page.evaluate((k) => window.__stores.preview.getState().activeByConversation[k], CONV)
await page.mouse.click(fadeBox.x + titleUnderMask.dx, fadeY)
await page.waitForTimeout(150)
const activeAfter = await page.evaluate((k) => window.__stores.preview.getState().activeByConversation[k], CONV)
check(
  '…and clicking there activates that chip (the mask does not eat clicks)',
  activeAfter === titleUnderMask.path && activeAfter !== activeBefore,
  `${activeBefore} → ${activeAfter} (under=${titleUnderMask.path})`,
)
check('…with the chip count untouched (the click was not on a close button)', (await page.locator('.pm-ws-tab').count()) === 12, `${await page.locator('.pm-ws-tab').count()} chips`)

// 19k. ▾ 快速切换（2026-10-30 用户裁定）：条最左侧的下拉列出全部已打开文件，
//      溢出/滚动到任何位置都能直达；空态置灰且弹不出空菜单。
const menuBtn = () => page.locator('[data-ws-tabstrip-menu]')
const btnBox0 = await menuBtn().boundingBox()
const stripBox0 = await page.locator('[data-ws-tabstrip]').boundingBox()
check('the strip carries the ▾ quick-switcher', (await menuBtn().count()) === 1)
check('…sitting LEFT of the chips (before the scroller)', btnBox0.x + btnBox0.width <= stripBox0.x + 1, `btn ${Math.round(btnBox0.x)}..${Math.round(btnBox0.x + btnBox0.width)} vs chips from ${Math.round(stripBox0.x)}`)
check('…as a real button with the i18n label', (await menuBtn().getAttribute('aria-label')) === '全部打开的文件', await menuBtn().getAttribute('aria-label'))
await setScrollLeft(0)
await menuBtn().click()
await page.getByRole('menuitem').first().waitFor()
check('the dropdown lists EVERY open file (12, not the visible few)', (await page.getByRole('menuitem').count()) === 12, `${await page.getByRole('menuitem').count()} items`)
// 点选一个没激活的项 → 它上屏（地址栏跟随），菜单收起。
await page.getByRole('menuitem', { name: 'wide-3.md' }).click()
// The dropdown's exit animation keeps the items in the a11y tree for a beat —
// wait it out before counting (180ms was mid-animation and counted ghosts).
await page.waitForTimeout(400)
check(
  'picking from the list brings that file to the front (address bar follows)',
  (await page.evaluate((k) => window.__stores.preview.getState().activeByConversation[k], CONV)) === '/w/wide-3.md' && (await addressPath()) === '/w/wide-3.md',
  await addressPath(),
)
check('…and the menu closed after the pick', (await page.getByRole('menuitem').count()) === 0)
// 空态：置灰且弹不出空菜单。
await closeAllTabs()
await page.waitForTimeout(150)
check('with no open file the switcher is disabled (native disabled antd clones onto the trigger)', (await menuBtn().getAttribute('disabled')) !== null)
// antd's disabled Dropdown gives the trigger a NATIVE disabled attribute, so
// Playwright's .click() would refuse it — click by coordinates, the way a user's
// dead click lands, and assert nothing opens.
const deadBox = await menuBtn().boundingBox()
await page.mouse.click(deadBox.x + deadBox.width / 2, deadBox.y + deadBox.height / 2)
await page.waitForTimeout(300)
check('…and clicking it opens no menu', (await page.getByRole('menuitem').count()) === 0, `${await page.getByRole('menuitem').count()} items`)
// The empty-state probe closed every chip — restore the overflow set the
// round-trip check below counts on.
await page.evaluate((k) => {
  const p = window.__stores.preview.getState()
  for (let i = 0; i < 14; i++) p.openFile(k, `/w/wide-${i}.md`)
}, CONV)
await page.waitForFunction(() => document.querySelectorAll('.pm-ws-tab').length === 12)

// 19j. The store is the only truth: a workbench tab round-trip keeps the chips.
await tab('浏览器').click()
await page.waitForFunction(() => !document.querySelector('[data-ws-tabstrip]'))
await tab('工作区').click()
await page.waitForFunction(() => document.querySelector('[data-ws-tabstrip]'))
check('the chips survive a workbench tab round-trip', (await page.locator('.pm-ws-tab').count()) === 12, `${await page.locator('.pm-ws-tab').count()} chips`)
await closeAllTabs()

/* ── 20. Row polish (2026-10-31, user): a name that cannot fit truncates to …
          inside the column instead of stretching past it, and the caret→icon
          gap is tight. The long file rides the refresh button in — the root
          listing only re-reads on mount/switch/refresh, so the stub gains the
          entry and the same click the user would make reveals it. ── */
await page.evaluate(() => {
  const long = 'a-very-long-workspace-file-name-that-never-fits-the-tree-column-and-must-truncate-with-ellipsis.md'
  window.__dirs['/w'].push({ name: long, path: `/w/${long}`, isDir: false })
})
await page.locator('button[aria-label="刷新"]').click()
const longPath = `/w/a-very-long-workspace-file-name-that-never-fits-the-tree-column-and-must-truncate-with-ellipsis.md`
await nameOf(longPath).waitFor()
const trunc = await nameOf(longPath).evaluate((el) => {
  const colRight = el.closest('[data-pm-tree-column]').getBoundingClientRect().right
  const nodeRight = el.closest('.ant-tree-treenode').getBoundingClientRect().right
  const nameRight = el.getBoundingClientRect().right
  return {
    clipped: el.scrollWidth > el.clientWidth,
    nodeInColumn: nodeRight <= colRight + 1,
    nameInColumn: nameRight <= colRight + 1,
    scrollW: el.scrollWidth,
    clientW: el.clientWidth,
  }
})
check(
  'a too-long name truncates (… on the name span, not an overflowing row)',
  trunc.clipped && trunc.nodeInColumn && trunc.nameInColumn,
  JSON.stringify(trunc),
)
const gap = await row('/w/d').evaluate((el) => {
  const node = el.closest('.ant-tree-treenode')
  const caret = node.querySelector('.ant-tree-switcher svg').getBoundingClientRect()
  const icon = node.querySelector('.ant-tree-iconEle svg').getBoundingClientRect()
  const sw = getComputedStyle(node.querySelector('.ant-tree-switcher'))
  const iv = getComputedStyle(node.querySelector('.ant-tree-iconEle'))
  return { gap: icon.left - caret.right, swW: sw.width, swMargin: sw.marginInlineEnd, iconW: iv.width }
})
check(
  'the caret→icon gap is tight (18px cells, no margin, no wrapper inset — ~25px on stock antd)',
  gap.gap > 0 && gap.gap < 8 && gap.swW === '18px' && gap.swMargin === '0px' && gap.iconW === '18px',
  JSON.stringify(gap),
)
const polish = await nameOf(longPath).evaluate((el) => {
  const rowEl = el.closest('.pm-ws-row')
  const acts = rowEl.querySelector('.pm-ws-actions')
  return {
    actionsPos: getComputedStyle(acts).position,
    nameRightAtRowRight: Math.abs(rowEl.getBoundingClientRect().right - el.getBoundingClientRect().right) < 2,
  }
})
check(
  'the name rides the full row — the actions block reserves no width (absolute overlay)',
  polish.actionsPos === 'absolute' && polish.nameRightAtRowRight,
  JSON.stringify(polish),
)
// A ROOT row carries no indent units — measure the step on a nested one.
const indentStep = await row('/w/d/z.txt').evaluate((el) => getComputedStyle(el.closest('.ant-tree-treenode').querySelector('.ant-tree-indent-unit')).width)
check('the indent step is 10px per level (2026-10-31 二次裁定)', indentStep === '10px', indentStep)
const maskOf = () => page.evaluate((p) => {
  const el = document.querySelector(`.pm-ws-row[data-ws-path="${p}"] .pm-ws-name`)
  const cs = getComputedStyle(el)
  return cs.maskImage || cs.webkitMaskImage || 'none'
}, longPath)
// :hover is pointer truth, not event truth — a dispatched MouseEvent never
// flips it, so this drives the REAL mouse: park it off the tree, land it on
// the long row, park it back.
await page.mouse.move(5, 400)
await page.waitForTimeout(120)
const fadeBefore = await maskOf()
await nameOf(longPath).hover()
await page.waitForTimeout(120)
const fadeDuring = await maskOf()
await page.mouse.move(5, 400)
await page.waitForTimeout(120)
const fadeAfter = await maskOf()
check(
  'the name tail fades only while the actions are up (mask mirrors visibility)',
  fadeBefore === 'none' && fadeDuring.includes('linear-gradient') && fadeAfter === 'none',
  JSON.stringify({ before: fadeBefore, during: fadeDuring.slice(0, 40), after: fadeAfter }),
)

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
await browser.close()
server.close()
process.exit(failed.length ? 1 : 0)
