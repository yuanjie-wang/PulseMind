/**
 * Sidebar conversation time-groups probe (real Chromium).
 *
 * The 对话 tab no longer reads as one flat stream: the loose (non-project)
 * conversations are grouped 置顶 → 今天 → 昨天 → 更早, by the LOCAL calendar
 * day of each conversation's last update (ConversationRows `groupByDate`, fed
 * by ConversationSidebar; the project tab keeps its own per-project groups).
 * What only a real DOM can see:
 *
 *   - the ORDER. Group headers and their rows interleave in one column — a
 *     header that renders above the wrong rows, or a row that leaks out of its
 *     section, is a document-order fact.
 *   - the CALENDAR-DAY boundary. 昨天 23:00 sits less than 24h behind a probe
 *     run at any hour, yet must read 昨天 — an elapsed-24h bucketing shows it
 *     under 今天. The fixture is anchored to today's midnight, so it holds no
 *     matter when the probe runs.
 *   - the TAB boundary. The grouping belongs to the 对话 tab only; switching
 *     to 项目 must paint project headers and not a single time-group header.
 *   - the PAGING. Each block starts at 10 rows plus a 显示更多 button that
 *     loads 10 more per click (置顶 renders whole) — a slice is visible in
 *     source, but "the click lands and the other blocks stay put" needs a
 *     real mouse and a real DOM count.
 *
 * The mounted surface is the production AppLayout/ConversationSidebar/
 * ConversationRows behind a stubbed electronAPI — no Electron, no LLM.
 *
 * Usage: node scripts/probe-sidebar-time-groups.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-sidebar-groups-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-sidebar-groups-shots')

// Timestamps are computed at probe runtime and interpolated into the stub, so
// the fixtures cannot go stale. today-1min is 今天 at any hour of the day
// (barring a midnight crossing mid-run); midnight-1h is 昨天 23:00 — inside
// 24h of elapsed time, which is exactly the case calendar-day bucketing exists
// for; midnight-3d is safely 更早.
const MIDNIGHT = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() })()
const iso = (ms) => new Date(ms).toISOString()
const STAMPS = {
  todayEarly: iso(Date.now() - 60_000),
  todayLate: iso(Date.now() - 2 * 3_600_000),
  yesterdayLate: iso(MIDNIGHT - 3_600_000),
  earlier: iso(MIDNIGHT - 3 * 86_400_000),
}

const CONVERSATIONS = [
  { key: 'earlier_a', label: '更早的会话', updatedAt: STAMPS.earlier },
  { key: 'yesterday_late', label: '昨晚的会话', updatedAt: STAMPS.yesterdayLate },
  { key: 'today_b', label: '今天较早的会话', updatedAt: STAMPS.todayLate },
  { key: 'pin_a', label: '置顶的会话', pinned: true, updatedAt: STAMPS.earlier },
  { key: 'today_a', label: '刚才的会话', updatedAt: STAMPS.todayEarly },
  { key: 'no_stamp', label: '没有时间戳的会话' },
]

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import { buildAntdTheme } from './src/renderer/src/theme/tokens'

let root = null
const mount = (node) => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider theme={buildAntdTheme('light')}>
      <SettingsProvider>
        <TranslationProvider initialLocale={window.__probeLocale}>
          {node}
        </TranslationProvider>
      </SettingsProvider>
    </ConfigProvider>
  )
}

window.__selected = []
window.__mountSidebar = ({ locale = 'zh', conversations = [] } = {}) => {
  window.__probeLocale = locale
  window.__selected = []
  mount(
    <AppLayout
      conversations={conversations}
      activeConversationKey=""
      totalSessions={conversations.length}
      autoCleanup={true}
      onCreateNew={() => {}}
      onDeleteConversation={() => {}}
      onRenameConversation={() => {}}
      onSelectConversation={(key) => { window.__selected.push(key) }}
      onTogglePinConversation={() => {}}
    />
  )
  return true
}

// One entry per painted section, in document order: the header's bucket and
// label, and the row keys INSIDE that section (its wrapper's direct rows).
window.__readGroups = () =>
  [...document.querySelectorAll('[data-conv-group]')].map((header) => ({
    bucket: header.getAttribute('data-conv-group'),
    label: header.textContent.trim(),
    rows: [...header.parentElement.querySelectorAll(':scope > [data-conv-row]')]
      .map((row) => row.getAttribute('data-conv-row')),
  }))

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
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
if (process.env.PROBE_DEV) page.on('console', (m) => console.log('  [console]', m.text()))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({
  content: `window.electronAPI = new Proxy({}, { get: (_t, key) =>
    key === 'getWindowControls' ? () => ({ side: 'left', inset: 70 })
      : key === 'getPlatformInfo' ? () => Promise.resolve({ platform: 'darwin' })
      : key === 'projectList' ? () => Promise.resolve([
          { id: 'p1', name: 'Alpha', workspaceDir: '/tmp/alpha', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z' },
        ])
      : key === 'getSettings' ? () => Promise.resolve({
          activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '',
          workspaceDir: '', autoCleanup: true, locale: window.__probeLocale || 'zh',
        })
      : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
      : /^on[A-Z]/.test(key) ? () => () => {}
      : () => Promise.resolve(undefined) })`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

const listTab = (label) => page.locator('.sidebar-list-tab', { hasText: label })

/* ── The grouped 对话 tab ───────────────────────────────────────────────── */

await page.evaluate((convs) => window.__mountSidebar({ conversations: convs }), CONVERSATIONS)
await page.waitForSelector('[data-conv-group]')

const groups = await page.evaluate(() => window.__readGroups())
const bucketOf = (key) => groups.find((g) => g.rows.includes(key))?.bucket

check('four sections paint in order 置顶→今天→昨天→更早',
  groups.map((g) => g.bucket).join(',') === 'pinned,today,yesterday,earlier',
  groups.map((g) => g.bucket).join(','))
check('every section carries its zh label', groups.map((g) => g.label).join('/') === '置顶/今天/昨天/更早', groups.map((g) => g.label).join('/'))

check('the pinned conversation floats to 置顶', bucketOf('pin_a') === 'pinned', String(bucketOf('pin_a')))
check('recent conversations land in 今天', bucketOf('today_a') === 'today' && bucketOf('today_b') === 'today',
  `${bucketOf('today_a')}/${bucketOf('today_b')}`)
check('today reads newest-first inside its section',
  JSON.stringify(groups.find((g) => g.bucket === 'today')?.rows) === JSON.stringify(['today_a', 'today_b']),
  JSON.stringify(groups.find((g) => g.bucket === 'today')?.rows))
// The load-bearing one: 昨晚 23:00 is less than 24h behind a run at ANY hour —
// elapsed-time bucketing calls it 今天, calendar-day bucketing keeps it 昨天.
check('昨晚 (under 24h ago) stays in 昨天, not 今天', bucketOf('yesterday_late') === 'yesterday', String(bucketOf('yesterday_late')))
check('three days back lands in 更早', bucketOf('earlier_a') === 'earlier', String(bucketOf('earlier_a')))
check('a missing updatedAt degrades to 更早, never crashes the section', bucketOf('no_stamp') === 'earlier', String(bucketOf('no_stamp')))

await shotSidebar()

async function shotSidebar() {
  await page.locator('.ant-layout-sider').screenshot({ path: join(SHOTS, 'zh-grouped.png') }).catch(() => page.screenshot({ path: join(SHOTS, 'zh-grouped.png') }))
}

// A row inside a section is still the old row: clicking opens the conversation.
await page.locator('[data-conv-row="today_a"]').click()
check('clicking a grouped row still selects it', (await page.evaluate(() => window.__selected)).join(',') === 'today_a')

/* ── Empty buckets are dropped, not painted empty ───────────────────────── */

// STAMPS lives on the Node side of the wire — evaluate arguments are how a
// fixture timestamp crosses into the page.
await page.evaluate((stamp) => window.__mountSidebar({
  conversations: [{ key: 'only_today', label: '仅有今天', updatedAt: stamp }],
}), STAMPS.todayEarly)
await page.waitForSelector('[data-conv-group="today"]')
const sparse = await page.evaluate(() => window.__readGroups())
check('a list with one today conversation paints exactly one section',
  sparse.length === 1 && sparse[0].bucket === 'today' && sparse[0].rows.join(',') === 'only_today',
  JSON.stringify(sparse))

/* ── The English locale reads its own labels ────────────────────────────── */

await page.evaluate((convs) => window.__mountSidebar({ locale: 'en', conversations: convs }), CONVERSATIONS)
await page.waitForSelector('[data-conv-group]')
const en = await page.evaluate(() => window.__readGroups())
check('EN labels: Pinned/Today/Yesterday/Earlier',
  en.map((g) => g.label).join('/') === 'Pinned/Today/Yesterday/Earlier', en.map((g) => g.label).join('/'))

/* ── The 项目 tab keeps its own grouping ────────────────────────────────── */

await page.evaluate((convs) => window.__mountSidebar({ conversations: convs }), CONVERSATIONS)
await page.waitForSelector('[data-conv-group]')
await listTab('项目').click()
await page.waitForSelector('div[data-project-header="p1"]')
const projectTab = await page.evaluate(() => ({
  groups: document.querySelectorAll('[data-conv-group]').length,
  projects: document.querySelectorAll('[data-project-header]').length,
}))
check('项目 tab paints project headers and zero time-group headers',
  projectTab.groups === 0 && projectTab.projects >= 1, JSON.stringify(projectTab))
await page.locator('.ant-layout-sider').screenshot({ path: join(SHOTS, 'zh-projects-tab.png') })
await listTab('对话').click()
await page.waitForSelector('[data-conv-group="today"]')
check('back on 对话 tab the groups return', (await page.evaluate(() => window.__readGroups())).length === 4)

/* ── 显示更多: every block pages at 10, 置顶 aside ─────────────────────── */

// Timestamps are pinned to CALENDAR day, never elapsed time: MIDNIGHT + k min
// is 今天 whatever hour the probe runs at (a future stamp is still today's
// day), MIDNIGHT - k h is 昨天. Keys go newest-first, so t0 is the first row.
const PAGED = [
  ...Array.from({ length: 25 }, (_, i) => ({
    key: `pg_today_${i}`, label: `今天会话 ${i}`, updatedAt: iso(MIDNIGHT + (25 - i) * 60_000)
  })),
  ...Array.from({ length: 12 }, (_, i) => ({
    key: `pg_pin_${i}`, label: `置顶会话 ${i}`, pinned: true,
    updatedAt: iso(MIDNIGHT - (i + 1) * 86_400_000)
  })),
  ...Array.from({ length: 3 }, (_, i) => ({
    key: `pg_y_${i}`, label: `昨天会话 ${i}`, updatedAt: iso(MIDNIGHT - 3_600_000 - i * 60_000)
  })),
]

const readPaged = () => page.evaluate(() => ({
  groups: [...document.querySelectorAll('[data-conv-group]')].map((h) => ({
    bucket: h.getAttribute('data-conv-group'),
    rows: [...h.parentElement.querySelectorAll(':scope > [data-conv-row]')]
      .map((r) => r.getAttribute('data-conv-row')),
  })),
  // EVERY button, not the first: one per block is the per-block contract.
  mores: [...document.querySelectorAll('[data-conv-more]')].map((m) => ({
    block: m.getAttribute('data-conv-more'), text: m.textContent
  })),
}))

await page.evaluate((convs) => window.__mountSidebar({ conversations: convs }), PAGED)
await page.waitForSelector('[data-conv-more="today"]')

let st = await readPaged()
const rowsOf = (bucket) => st.groups.find((g) => g.bucket === bucket)?.rows ?? []
check('今天 starts at its first 10 rows, newest first',
  rowsOf('today').length === 10 && rowsOf('today')[0] === 'pg_today_0' && rowsOf('today')[9] === 'pg_today_9',
  JSON.stringify(rowsOf('today')))
check('its 显示更多 sits under the block and names the 15 hidden',
  st.mores.length === 1 && st.mores[0].block === 'today' && st.mores[0].text === '显示更多（还有 15 条）',
  JSON.stringify(st.mores))
check('置顶 is exempt: all 12 pins render, no button covers them',
  rowsOf('pinned').length === 12 && rowsOf('pinned')[0] === 'pg_pin_0', String(rowsOf('pinned').length))
check('a block that fits (昨天, 3 rows) gets no button',
  rowsOf('yesterday').length === 3, String(rowsOf('yesterday').length))

await page.locator('[data-conv-more="today"]').click()
st = await readPaged()
check('one click loads the next 10 (10 → 20)',
  rowsOf('today').length === 20 && st.mores[0]?.text === '显示更多（还有 5 条）',
  `${rowsOf('today').length} / ${st.mores[0]?.text}`)
await page.locator('[data-conv-more="today"]').click()
st = await readPaged()
check('the next click loads the rest and the button goes (25, none left)',
  rowsOf('today').length === 25 && st.mores.length === 0,
  `${rowsOf('today').length} / ${st.mores.length}`)
check('the clicks never touched the sibling blocks',
  rowsOf('pinned').length === 12 && rowsOf('yesterday').length === 3,
  `${rowsOf('pinned').length}/${rowsOf('yesterday').length}`)

await page.evaluate((convs) => window.__mountSidebar({ locale: 'en', conversations: convs }), PAGED)
await page.waitForSelector('[data-conv-more="today"]')
const enMore = (await page.locator('[data-conv-more="today"]').textContent()).trim()
check('EN label: Show more (15 left)', enMore === 'Show more (15 left)', enMore)

/* ── The project tab pages each project block the same way ──────────────── */

const PROJECT_CONVS = [
  ...Array.from({ length: 15 }, (_, i) => ({
    key: `proj_${i}`, label: `项目会话 ${i}`, projectId: 'p1',
    updatedAt: iso(MIDNIGHT + (15 - i) * 60_000)
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    key: `proj_pin_${i}`, label: `项目置顶 ${i}`, projectId: 'p1', pinned: true,
    updatedAt: iso(MIDNIGHT - (i + 1) * 86_400_000)
  })),
]
const readProjectBlock = () => page.evaluate(() => {
  const wrap = document.querySelector('[data-project-header="p1"]')?.parentElement
  return {
    rows: [...(wrap?.querySelectorAll('[data-conv-row]') || [])].map((r) => r.getAttribute('data-conv-row')),
    mores: [...document.querySelectorAll('[data-conv-more]')].map((m) => m.getAttribute('data-conv-more')),
  }
})

// These conversations belong to p1, so the 对话 tab shows nothing of them —
// straight to 项目, which is where its own block paging lives.
await page.evaluate((convs) => window.__mountSidebar({ conversations: convs }), PROJECT_CONVS)
await page.waitForSelector('.sidebar-list-tab')
await listTab('项目').click()
await page.waitForSelector('div[data-project-header="p1"]')

let pb = await readProjectBlock()
check('project block pages too: 2 pins whole + 10 of 15, one flat button',
  pb.rows.length === 12 && pb.rows[0] === 'proj_pin_0' && pb.mores.join(',') === 'flat',
  JSON.stringify(pb))
await page.locator('[data-conv-more="flat"]').click()
pb = await readProjectBlock()
check('its click loads the remaining 5 (2 pins + 15, no button)',
  pb.rows.length === 17 && pb.mores.length === 0, JSON.stringify(pb))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ''}`)
console.log(`screenshots: ${SHOTS}`)
process.exit(failed.length ? 1 : 0)
