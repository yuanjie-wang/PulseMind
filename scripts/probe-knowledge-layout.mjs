/**
 * Knowledge-center rail probe (real Chromium).
 *
 * The knowledge center is now two columns: the LEFT rail lists knowledge bases
 * and its selection IS the scope — the right side (table, stats, search,
 * import target, compile/rebuild) only ever sees the selected base. The old
 * layout listed every base's files flat under a detached「导入到」dropdown,
 * which is exactly what this replaces. What the layers below vitest can't see:
 *
 *   - SCOPE is a data flow. Clicking a rail entry must change the baseId the
 *     table's query carries (asserted against the recorded IPC args), the rows
 *     rendered, the stats line, and every maintenance action — jsdom has no
 *     click model and vitest here is node-env, so only a real browser with a
 *     stubbed IPC surface can watch the scope travel.
 *   - the RAIL is geometry + paint: 200px column with the rule, the 默认 tag
 *     on the undeletable first entry, per-base hue dots, hover-revealed ⋯,
 *     and the dashed 新建知识库 card closing the rail (the same recipe as the
 *     welcome page's 新建项目 card).
 *   - the CRUD is interaction: create selects the new base; rename goes
 *     through the ⋯ menu (svcRenameBase had NO entry before the rail); delete
 *     says the honest thing — the files are deleted WITH the base (the store
 *     really deletes them; the old confirm claimed they fall back to the
 *     default base) — and deleting the selected base falls the selection back.
 *
 * What is mounted is the production `CentersPage` (knowledge branch) with the
 * production `KnowledgeManager` behind a stubbed `window.electronAPI` whose
 * knowledge endpoints implement the real scoping semantics, plus the real
 * navigationStore (the selection rides `view.knowledgeBaseId`) and the real
 * i18n. No Electron, no LLM, no user data.
 *
 * Usage: node scripts/probe-knowledge-layout.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-knowledge-rail-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-knowledge-rail-shots')

const HARNESS = `
// The knowledge center is migrated onto the theme sheet (PLAN-dark-mode
// M3/T4), so the page needs the variable table injected before it renders —
// without it every var() computes to nothing and the readings fall back to
// the UA. Light is pinned explicitly here; dark belongs to probe-theme-dark.
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'

installThemeVars()
applyThemeAttr('light')
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import CentersPage from './src/renderer/src/components/centers/CentersPage'
import { KnowledgeManager } from './src/renderer/src/knowledge/KnowledgeManager'
import { useNavigationStore } from './src/renderer/src/stores/navigationStore'

const NOW = new Date().toISOString()
/** Mutable fixtures — the CRUD endpoints below mutate them like the store would. */
window.__bases = [
  { id: 'default', name: '默认知识库', colorHue: 210, createdAt: NOW, fileCount: 2 },
  { id: 'kb_a', name: '产品资料', colorHue: 20, createdAt: NOW, fileCount: 3 },
  { id: 'kb_b', name: '会议记录', colorHue: 120, createdAt: NOW, fileCount: 1 },
]
const file = (baseId, title, status) => ({
  id: 'kf_' + baseId + '_' + title, baseId, title,
  filePath: 'bases/' + baseId + '/raw/' + title + '.md',
  sourceType: 'file', sourceUrl: null, sourcePath: '/tmp/' + title + '.md',
  convId: null, contentHash: null, status, createdAt: NOW, compiledAt: null, wikiOutputs: null,
})
window.__files = [
  file('default', '默认库文件甲', 'compiled'),
  file('default', '默认库文件乙', 'raw'),
  file('kb_a', '产品手册', 'raw'),
  file('kb_a', '规格书', 'compiled'),
  file('kb_a', '常见问题', 'raw'),
  file('kb_b', '周会纪要', 'raw'),
]

const countFor = (id) => window.__files.filter((f) => f.baseId === id).length
const syncCounts = () => { for (const b of window.__bases) b.fileCount = countFor(b.id) }

const SCOPE_LOG = []   // every listAdvanced opts the pane sent
const OP_LOG = []      // base CRUD / move calls, [name, ...args]
window.__scopes = () => JSON.parse(JSON.stringify(SCOPE_LOG))
window.__ops = () => JSON.parse(JSON.stringify(OP_LOG))
window.__openedDirs = []

window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {}
    const k = String(key)
    if (k === 'knowledgeListBases') { syncCounts(); return Promise.resolve(JSON.parse(JSON.stringify(window.__bases))) }
    if (k === 'knowledgeListAdvanced') {
      const opts = args[0] || {}
      SCOPE_LOG.push({ baseId: opts.baseId ?? null, status: opts.status ?? null })
      let items = window.__files
      if (opts.baseId !== undefined) items = items.filter((f) => f.baseId === opts.baseId)
      if (opts.status) items = items.filter((f) => f.status === opts.status)
      items = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return Promise.resolve({ items: JSON.parse(JSON.stringify(items)), total: items.length, page: opts.page || 1, pageSize: opts.pageSize || 50 })
    }
    if (k === 'knowledgeGetStats') {
      const baseId = args[0]
      const inScope = baseId ? window.__files.filter((f) => f.baseId === baseId) : window.__files
      const raw = inScope.filter((f) => f.status === 'raw').length
      return Promise.resolve({ total: inScope.length, raw, compiled: inScope.length - raw, wikiFileCount: inScope.length * 2 })
    }
    if (k === 'knowledgeListFiles') return Promise.resolve(JSON.parse(JSON.stringify(window.__files)))
    if (k === 'knowledgeCreateBase') {
      const id = 'kb_new'
      if (window.__bases.some((b) => b.name === args[0])) return Promise.reject(new Error('知识库已存在: ' + args[0]))
      window.__bases.push({ id, name: args[0], colorHue: 300, createdAt: NOW, fileCount: 0 })
      OP_LOG.push(['createBase', args[0]])
      return Promise.resolve({ id, name: args[0], colorHue: 300, createdAt: NOW, fileCount: 0 })
    }
    if (k === 'knowledgeRenameBase') {
      const b = window.__bases.find((x) => x.id === args[0])
      if (!b) return Promise.reject(new Error('知识库不存在'))
      b.name = args[1]
      OP_LOG.push(['renameBase', args[0], args[1]])
      return Promise.resolve(JSON.parse(JSON.stringify(b)))
    }
    if (k === 'knowledgeDeleteBase') {
      if (args[0] === 'default') return Promise.reject(new Error('默认知识库不可删除'))
      window.__bases = window.__bases.filter((b) => b.id !== args[0])
      window.__files = window.__files.filter((f) => f.baseId !== args[0])
      OP_LOG.push(['deleteBase', args[0]])
      return Promise.resolve(undefined)
    }
    if (k === 'knowledgeSetFileBase' || k === 'knowledgeSetFilesBase') {
      const ids = k === 'knowledgeSetFileBase' ? [args[0]] : args[0]
      for (const id of ids) {
        const f = window.__files.find((x) => x.id === id)
        if (f) f.baseId = args[1]
      }
      OP_LOG.push([k, ids, args[1]])
      return Promise.resolve(k === 'knowledgeSetFileBase' ? {} : ids.length)
    }
    if (k === 'knowledgeGetWikiDir') { window.__openedDirs.push(args[0]); return Promise.resolve('/tmp/wiki/' + (args[0] || 'default')) }
    if (k === 'getDataPaths') return Promise.resolve({ knowledgeDir: '/tmp/pm-knowledge' })
    if (k === 'openFolder') { window.__openedDirs.push('fs:' + args[0]); return Promise.resolve(undefined) }
    if (k === 'showOpenDialog') return Promise.resolve({ canceled: true, filePaths: [] })
    if (k === 'getSettings') return Promise.resolve({ knowledge: { autoCompile: false } })
    return Promise.resolve(undefined)
  },
})

window.__nav = () => {
  const v = useNavigationStore.getState().view
  return { kind: v.kind, knowledgeBaseId: v.knowledgeBaseId ?? null }
}
window.__km = new KnowledgeManager()

let root = null
window.__mount = ({ locale = 'zh' } = {}) => {
  useNavigationStore.getState().navigate({ kind: 'knowledge' })
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <AntdApp>
        <TranslationProvider initialLocale={locale}>
          <div style={{ width: 1100, height: 640 }}>
            <CentersPage knowledgeManager={window.__km} />
          </div>
        </TranslationProvider>
      </AntdApp>
    </ConfigProvider>
  )
  return true
}

const box = (el) => {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
}

/** One rail entry: identity, paint, and whether its ⋯ exists. */
window.__item = (id) => {
  const el = document.querySelector('[data-base-item="' + id + '"]')
  if (!el) return null
  const cs = getComputedStyle(el)
  const dot = el.querySelector('[data-base-dot]')
  const tag = el.querySelector('[data-base-default-tag]')
  const actions = el.querySelector('[data-base-actions]')
  return {
    name: el.textContent.trim(),
    selected: el.hasAttribute('data-base-selected'),
    bg: cs.backgroundColor,
    dotColor: dot ? getComputedStyle(dot).backgroundColor : null,
    tagText: tag ? tag.textContent.trim() : null,
    hasActions: !!actions,
    actionsOpacity: actions ? getComputedStyle(actions).opacity : null,
    count: (el.textContent.match(/\\d+$/) || [''])[0],
  }
}

window.__rail = () => {
  const el = document.querySelector('[data-knowledge-base-list]')
  if (!el) return null
  const cs = getComputedStyle(el)
  const items = [...el.querySelectorAll('[data-base-item]')].map((i) => i.getAttribute('data-base-item'))
  return { box: box(el), width: cs.width, borderRight: cs.borderRightWidth + ' ' + cs.borderRightStyle + ' ' + cs.borderRightColor, order: items }
}

window.__table = () => {
  const rows = [...document.querySelectorAll('.knowledge-table .ant-table-tbody .ant-table-row')]
  const placeholder = document.querySelector('.knowledge-table .ant-table-placeholder')
  return {
    titles: rows.map((tr) => tr.querySelectorAll('td')[2]?.querySelector('span')?.textContent.trim()),
    emptyText: placeholder ? placeholder.textContent.trim() : null,
  }
}

window.__stats = () => document.querySelector('[data-knowledge-stats]')?.textContent.trim() ?? null

window.__newCard = () => {
  const b = document.querySelector('[data-base-new]')
  if (!b) return null
  const cs = getComputedStyle(b)
  return { tag: b.tagName, type: b.getAttribute('type'), text: b.textContent.trim(), box: box(b),
    border: cs.borderTopStyle + ' ' + cs.borderTopWidth + ' ' + cs.borderTopColor, color: cs.color }
}

/** The titled modal (create/rename) — not Modal.confirm, which has no title. */
window.__modal = () => {
  const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.querySelector('.ant-modal-title'))
  if (!m) return null
  return {
    title: m.querySelector('.ant-modal-title')?.textContent ?? '',
    value: m.querySelector('input')?.value ?? null,
    placeholder: m.querySelector('input')?.placeholder ?? null,
    okText: m.querySelector('.ant-modal-footer .ant-btn-primary')?.textContent.trim() ?? null,
  }
}
window.__setModalInput = (value) => {
  const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.querySelector('.ant-modal-title'))
  const input = m?.querySelector('input')
  if (!input) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}
window.__confirm = () => {
  const m = document.querySelector('.ant-modal-confirm')
  if (!m) return null
  return {
    title: m.querySelector('.ant-modal-confirm-title')?.textContent ?? '',
    content: m.querySelector('.ant-modal-confirm-content')?.textContent ?? '',
  }
}
/** Visible (non-hidden) antd dropdown menu items, topmost container last. */
window.__menuItems = () => {
  const menus = [...document.querySelectorAll('.ant-dropdown')].filter((d) => !d.classList.contains('ant-dropdown-hidden'))
  const m = menus[menus.length - 1]
  if (!m) return []
  return [...m.querySelectorAll('.ant-dropdown-menu-item')].map((i) => ({ text: i.textContent.trim(), danger: i.classList.contains('ant-dropdown-menu-item-danger') }))
}
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome114',
  outfile: OUT,
  tsconfig: 'tsconfig.web.json',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1100, height: 640 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
page.on('console', (msg) => { if (msg.type() === 'error') console.log('  [console]', msg.text().slice(0, 300)) })
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready === true)

await page.evaluate(() => window.__mount({ locale: 'zh' }))
await page.waitForSelector('[data-base-item="default"]')
await page.waitForTimeout(250)

const ev = (fn, ...args) => page.evaluate(fn, ...args)

// ── 1 · the rail: geometry, order, the 默认 tag, hue dots, counts ──
const rail = await ev(() => window.__rail())
check('the rail is a 200px column with the rule',
  !!rail && rail.width === '200px' && rail.borderRight.startsWith('1px solid'),
  rail ? `${rail.width} / ${rail.borderRight}` : 'no rail')
check('rail order is default first, then creation order',
  !!rail && JSON.stringify(rail.order) === JSON.stringify(['default', 'kb_a', 'kb_b']),
  rail ? rail.order.join(' | ') : 'no rail')
const defItem = await ev(() => window.__item('default'))
check('the default entry carries the 默认 tag and NO ⋯ menu',
  !!defItem && defItem.tagText === '默认' && defItem.hasActions === false,
  defItem ? `tag=${defItem.tagText} actions=${defItem.hasActions}` : 'no item')
check('the default entry wears its hue dot',
  !!defItem && defItem.dotColor !== null && defItem.dotColor !== 'rgba(0, 0, 0, 0)',
  defItem?.dotColor)
const counts = {}
for (const id of ['default', 'kb_a', 'kb_b']) counts[id] = (await ev((x) => window.__item(x), id))?.count
check('counts render from the store (2 / 3 / 1)',
  counts.default === '2' && counts.kb_a === '3' && counts.kb_b === '1',
  `${counts.default}/${counts.kb_a}/${counts.kb_b}`)

// ── 2 · selection IS the scope ──
check('initial selection is the default base (no view param needed)',
  (await ev(() => window.__item('default')))?.selected === true && (await ev(() => window.__nav())).knowledgeBaseId === null,
  JSON.stringify(await ev(() => window.__nav())))
const t0 = await ev(() => window.__table())
check('the table shows ONLY the default base\'s files',
  JSON.stringify(t0.titles) === JSON.stringify(['默认库文件甲', '默认库文件乙']),
  t0.titles.join(' | '))
check('the stats line is scoped (default: 2/1/4)',
  (await ev(() => window.__stats())) === '2/1/4',
  await ev(() => window.__stats()))

await page.click('[data-base-item="kb_a"]')
await page.waitForTimeout(300)
check('clicking a base writes view.knowledgeBaseId',
  (await ev(() => window.__nav())).knowledgeBaseId === 'kb_a',
  JSON.stringify(await ev(() => window.__nav())))
check('the table\'s query now carries baseId=kb_a',
  (await ev(() => window.__scopes())).at(-1)?.baseId === 'kb_a',
  JSON.stringify((await ev(() => window.__scopes())).at(-1)))
const t1 = await ev(() => window.__table())
check('the table shows ONLY kb_a\'s files (isolation)',
  JSON.stringify(t1.titles) === JSON.stringify(['产品手册', '规格书', '常见问题']),
  t1.titles.join(' | '))
check('the stats line follows the selection (kb_a: total/compiled/wiki = 3/1/6)',
  (await ev(() => window.__stats())) === '3/1/6',
  await ev(() => window.__stats()))

// ── 3 · moving a row out of the base is the cross-base channel ──
await page.hover('.knowledge-table .ant-table-tbody .ant-table-row')
const moveBtn = await page.locator('.knowledge-table .ant-table-tbody .ant-table-row .anticon-group').first()
await moveBtn.click()
await page.waitForTimeout(200)
const moveItems = await ev(() => window.__menuItems())
check('the row\'s move menu lists the OTHER bases only (current excluded)',
  JSON.stringify(moveItems.map((m) => m.text).sort()) === JSON.stringify(['会议记录', '默认知识库']),
  moveItems.map((m) => m.text).join(' | '))
await page.locator('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item', { hasText: '默认知识库' }).last().click()
await page.waitForTimeout(300)
const t2 = await ev(() => window.__table())
check('moving a file out shrinks the scoped list (3 → 2)',
  JSON.stringify(t2.titles) === JSON.stringify(['规格书', '常见问题']),
  t2.titles.join(' | '))

// ── 4 · the toolbar ⋯ menu: compile-all rides the selection ──
await page.locator('.ant-btn .anticon-more').first().click()
await page.waitForTimeout(200)
const moreItems = await ev(() => window.__menuItems())
check('the ⋯ menu carries 编译全部/打开目录/重建/重置 (the old toolbar buttons, folded)',
  JSON.stringify(moreItems.map((m) => m.text)) === JSON.stringify(['编译全部（当前库）', '打开知识库目录', '重建 Wiki（当前库）', '重置知识库']),
  moreItems.map((m) => m.text).join(' | '))
check('重置知识库 is the danger item (it is the one global action)',
  moreItems.find((m) => m.text === '重置知识库')?.danger === true,
  String(moreItems.find((m) => m.text === '重置知识库')?.danger))
await page.locator('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item', { hasText: '编译全部（当前库）' }).last().click()
await page.waitForTimeout(300)
// The queue's refresh re-queries the table right after, so the compile query
// is asserted by PRESENCE, not by being the last entry.
check('compile-all queried the CURRENT base\'s raw files only',
  (await ev(() => window.__scopes())).some((s) => s.baseId === 'kb_a' && s.status === 'raw'),
  JSON.stringify(await ev(() => window.__scopes())))
check('the detached 导入到 select is gone',
  (await page.locator('[data-testid="knowledge-import-target"]').count()) === 0
    && !(await page.content()).includes('导入到：'),
  'legacy control must not render')

// ── 5 · the ⋯ rail menu: hover reveal, rename ──
const kbA = await ev(() => window.__item('kb_a'))
check('a user base exposes the ⋯ menu, hidden until hover',
  kbA?.hasActions === true && kbA.actionsOpacity === '0',
  `has=${kbA?.hasActions} opacity=${kbA?.actionsOpacity}`)
await page.hover('[data-base-item="kb_a"]')
await page.waitForTimeout(250)
const kbAHover = await ev(() => window.__item('kb_a'))
check('hover reveals the ⋯ menu',
  kbAHover?.actionsOpacity === '1',
  `opacity=${kbAHover?.actionsOpacity}`)
await page.click('[data-base-menu="kb_a"]')
await page.waitForTimeout(200)
const railMenu = await ev(() => window.__menuItems())
check('the rail ⋯ menu is 重命名 + 删除知识库(danger) — rename finally has an entry',
  JSON.stringify(railMenu.map((m) => m.text)) === JSON.stringify(['重命名', '删除知识库'])
    && railMenu.find((m) => m.text === '删除知识库')?.danger === true,
  railMenu.map((m) => m.text).join(' | '))
await page.locator('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item', { hasText: '重命名' }).last().click()
await page.waitForTimeout(250)
const renameModal = await ev(() => window.__modal())
check('rename opens the titled modal, prefilled',
  renameModal?.title === '重命名知识库' && renameModal?.value === '产品资料',
  renameModal ? `${renameModal.title} / ${renameModal.value}` : 'no modal')
await ev(() => window.__setModalInput('资料库v2'))
await page.locator('.ant-modal-footer .ant-btn-primary').click()
await page.waitForTimeout(350)
check('保存 calls renameBase with the edited name and the rail re-renders it',
  (await ev(() => window.__ops())).some((o) => o[0] === 'renameBase' && o[1] === 'kb_a' && o[2] === '资料库v2')
    && (await ev(() => window.__item('kb_a')))?.name.includes('资料库v2'),
  JSON.stringify((await ev(() => window.__ops())).filter((o) => o[0] === 'renameBase')))

// ── 6 · create: dashed card, selects the new base, empty scoped table ──
const newCard = await ev(() => window.__newCard())
check('the 新建知识库 card closes the rail as a real dashed <button>',
  !!newCard && newCard.tag === 'BUTTON' && newCard.type === 'button'
    && newCard.text.includes('新建知识库') && newCard.border.startsWith('dashed'),
  newCard ? `${newCard.tag} / ${newCard.border}` : 'no card')
await page.click('[data-base-new]')
await page.waitForTimeout(250)
const createModal = await ev(() => window.__modal())
check('create opens the titled modal with the 40-char placeholder',
  createModal?.title === '新建知识库' && (createModal?.placeholder ?? '').includes('40'),
  createModal ? `${createModal.title} / ${createModal.placeholder}` : 'no modal')
await ev(() => window.__setModalInput('竞品分析'))
await page.locator('.ant-modal-footer .ant-btn-primary').click()
await page.waitForTimeout(400)
check('创建 lands in the store AND the new base becomes the selection',
  (await ev(() => window.__ops())).some((o) => o[0] === 'createBase' && o[1] === '竞品分析')
    && (await ev(() => window.__nav())).knowledgeBaseId === 'kb_new',
  JSON.stringify(await ev(() => window.__nav())))
const t3 = await ev(() => window.__table())
check('the fresh base\'s table is EMPTY (scoped, not showing other bases)',
  t3.titles.length === 0 && t3.emptyText !== null,
  `rows=${t3.titles.length} empty="${t3.emptyText}"`)
await page.screenshot({ path: join(SHOTS, 'rail-zh.png') })

// ── 7 · delete: the honest confirm, selection falls back ──
await page.click('[data-base-menu="kb_new"]')
await page.waitForTimeout(200)
await page.locator('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item', { hasText: '删除知识库' }).last().click()
await page.waitForTimeout(250)
const delConfirm = await ev(() => window.__confirm())
check('the delete confirm tells the truth: the files go WITH the base',
  delConfirm?.title === '删除知识库'
    && delConfirm?.content.includes('竞品分析')
    && delConfirm?.content.includes('将一并删除'),
  delConfirm ? delConfirm.content : 'no confirm')
await page.locator('.ant-modal-confirm-btns .ant-btn-primary').click()
await page.waitForTimeout(400)
check('selection fell back to the default base',
  (await ev(() => window.__nav())).knowledgeBaseId === 'default',
  JSON.stringify(await ev(() => window.__nav())))
check('the deleted base is gone from the rail',
  (await ev(() => window.__item('kb_new'))) === null,
  'kb_new must not render')
const t4 = await ev(() => window.__table())
check('default\'s scoped list (incl. the file moved in earlier) is untouched',
  JSON.stringify(t4.titles) === JSON.stringify(['默认库文件甲', '默认库文件乙', '产品手册']),
  t4.titles.join(' | '))

// ── 8 · EN locale ──
await ev(() => window.__mount({ locale: 'en' }))
await page.waitForSelector('[data-base-item="default"]')
await page.waitForTimeout(300)
const enCard = await ev(() => window.__newCard())
const enDef = await ev(() => window.__item('default'))
check('EN: the rail translates (Default tag, New Knowledge Base card)',
  enDef?.tagText === 'Default' && enCard?.text.includes('New Knowledge Base'),
  `${enDef?.tagText} / ${enCard?.text}`)
await page.screenshot({ path: join(SHOTS, 'rail-en.png') })

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed · shots in ${SHOTS}`)
process.exit(failed.length === 0 ? 0 : 1)
