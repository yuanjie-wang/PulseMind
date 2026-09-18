/**
 * Routine landing-page layout probe (real Chromium).
 *
 * 日常 • 自动化 was reorganised into two columns split by a rule (user ruling
 * 2026-09-18): the LEFT holds what the user owns and can start — 我的任务 over
 * 推荐模板 — and the RIGHT is the recent-runs list. The page's own
 * 日常 • 自动化 + 新建任务 title row is gone; 新建任务 is a dashed card closing
 * the task grid (it was a button in the 我的任务 section head until the same
 * day's follow-up ruling: 「在【日常 自动化】页面中，也同样用卡片的方式呈现
 * 新建任务按钮」, i.e. the shape the welcome page's 新建项目 card already has).
 *
 * Every one of those is a layout or interaction fact that no other layer can
 * see: vitest here is node-env (no layout engine, no mounting), and the source
 * reads the same whether the sections are stacked, overlapped or clipped. What
 * this probe actually measures:
 *
 *   - the columns: the runs column is to the RIGHT of the left column, its
 *     left border is the rule between them, and both columns run the same
 *     height (two halves, not two cards)
 *   - the stacking: 推荐模板 sits strictly BELOW 我的任务, inside the left
 *     column, and the template grid reflows rather than overflowing
 *   - the seam: NOTHING rules the two left halves apart — no border on either
 *     section and no inner divider element at the seam (user ruling
 *     2026-09-18: 「不用硬分隔…直接接壤」) — while the vertical rule against the
 *     runs column is untouched
 *   - the missing title row: the view title 日常 • 自动化 appears nowhere on
 *     the page, and 新建任务 appears exactly once — as the card that closes the
 *     task grid, in every state including the empty one, wearing the dashed
 *     recipe (and a real mouse proves its hover)
 *   - the starters: five templates, each a real <button> whose click reaches
 *     the navigation store as `routineEditing + routineTemplateId` and creates
 *     NOTHING (the whole point of a template is that it is not a routine yet)
 *   - 新建任务 from that card lands on the plain create-new form (no stale
 *     templateId) and creates nothing either, and the empty state keeps the
 *     card and the starters on screen
 *
 * What it mounts is the production `RoutineCenter` behind a stubbed
 * `window.electronAPI` and the real i18n — never a copy of the component.
 *
 * No Electron, no LLM: pure renderer components in a plain page.
 *
 * Usage: node scripts/probe-routine-layout.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-routine-layout-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-routine-layout-shots')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import RoutineCenter from './src/renderer/src/components/routine/RoutineCenter'
import RoutineEditorPage from './src/renderer/src/components/routine/RoutineEditorPage'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import { bucketRunByDate } from './src/renderer/src/utils/relative-time'
import { useNavigationStore } from './src/renderer/src/stores/navigationStore'

const NOW = Date.now()
const iso = (msAgo) => new Date(NOW - msAgo).toISOString()
const HOUR = 3600 * 1000
const DAY = 24 * HOUR
/** Local noon, N days back - calendar-anchored, so a bucket never depends on
 *  what time of day the probe happens to run. */
const noonDaysAgo = (daysAgo) => {
  const d = new Date(NOW)
  d.setDate(d.getDate() - daysAgo)
  d.setHours(12, 0, 0, 0)
  return d.getTime()
}

const ROUTINES = [
  { id: 'r_daily', name: '每日工作日报', description: '下班前整理今天的完成情况', prompt: '整理日报', enabled: true,
    schedule: { cron: '0 18 * * *' }, params: [], createdAt: iso(9 * DAY), updatedAt: iso(DAY) },
  { id: 'r_weekly', name: '每周工作周报', description: '周五汇总本周进展', prompt: '汇总周报', enabled: true,
    schedule: { cron: '30 17 * * 5' }, params: [], createdAt: iso(9 * DAY), updatedAt: iso(2 * DAY) },
  { id: 'r_manual', name: '会议纪要整理', description: '把会议记录整理成纪要', prompt: '整理纪要', enabled: false,
    params: [{ key: 'notes', label: '会议记录', default: '' }], createdAt: iso(9 * DAY), updatedAt: iso(3 * DAY) },
]

// Runs spread over the four buckets (newest first, as the IPC returns them),
// and enough of them that the right column has to scroll. Which buckets a run
// lands in is calendar-dependent — on a Monday nothing can be in 本周 but
// today — so the expected list is DERIVED from the same bucketRunByDate the
// component uses rather than hard-coded (see __expectedBuckets).
const RUN_GROUPS = [
  { daysAgo: null, count: 18, step: 20 * 60 * 1000 },
  { daysAgo: 1, count: 12, step: 20 * 60 * 1000 },
  { daysAgo: 3, count: 8, step: 20 * 60 * 1000 },
  { daysAgo: 10, count: 8, step: 20 * 60 * 1000 },
]
const RUNS = []
const BUCKET_SEEN = new Set()
for (const group of RUN_GROUPS) {
  for (let i = 0; i < group.count; i++) {
    const startedAt = group.daysAgo == null
      ? NOW - (i + 1) * group.step
      : noonDaysAgo(group.daysAgo) - i * group.step
    BUCKET_SEEN.add(bucketRunByDate(startedAt, NOW))
    RUNS.push({
      id: 'run_' + RUNS.length,
      routineId: RUNS.length % 3 === 0 ? 'r_daily' : RUNS.length % 3 === 1 ? 'r_weekly' : 'r_manual',
      status: RUNS.length === 0 ? 'running' : RUNS.length % 7 === 0 ? 'failed' : 'success',
      trigger: RUNS.length % 2 === 0 ? 'schedule' : 'manual',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(startedAt + 60 * 1000).toISOString(),
    })
  }
}
const BUCKET_ORDER = ['today', 'yesterday', 'thisWeek', 'earlier']
window.__expectedBuckets = BUCKET_ORDER.filter((b) => BUCKET_SEEN.has(b))

// More runs than the list paints (the component caps at 50 rows so a
// long-running install cannot paint an unbounded column).
window.__capRuns = []
for (let i = 0; i < 60; i++) {
  window.__capRuns.push({
    id: 'cap_' + i,
    routineId: 'r_daily',
    status: 'success',
    trigger: 'manual',
    startedAt: new Date(NOW - (i + 1) * 60 * 1000).toISOString(),
    finishedAt: new Date(NOW - i * 60 * 1000).toISOString(),
  })
}

// A task list that does NOT fit its half - the lower half must still sit
// directly under it (nothing may be pushed off screen, and the task half takes
// the overflow by scrolling on its own).
window.__manyRoutines = []
for (let i = 0; i < 12; i++) {
  window.__manyRoutines.push({
    id: 'many_' + i,
    name: '任务 ' + (i + 1),
    description: '第 ' + (i + 1) + ' 个日常任务的说明文字，占两行高度。',
    prompt: '执行任务 ' + (i + 1),
    enabled: i % 2 === 0,
    schedule: i % 3 === 0 ? { cron: '0 18 * * *' } : undefined,
    params: [],
    createdAt: new Date(NOW - 9 * 86400000).toISOString(),
    updatedAt: new Date(NOW - i * 3600000).toISOString(),
  })
}

window.__calls = []
const EMPTY_LISTS = ['expertList', 'projectList', 'listConversations', 'knowledgeListFiles', 'toolList', 'skillList', 'recallMemories']
window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    // Subscribe-style APIs must answer with a cleanup function, not a Promise.
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {}
    window.__calls.push({ method: String(key), args })
    if (key === 'routineList') return Promise.resolve(window.__routines ?? ROUTINES)
    if (key === 'routineRuns') return Promise.resolve(window.__runs ?? RUNS)
    if (EMPTY_LISTS.includes(String(key))) return Promise.resolve([])
    // The editor mounts the real SettingsProvider, which loads settings.json.
    if (key === 'getSettings') {
      return Promise.resolve({ activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '',
        yourName: '', workspaceDir: '', autoCleanup: false, locale: window.__locale ?? 'zh' })
    }
    return Promise.resolve(undefined)
  },
})

window.__opened = null
let root = null
window.__mount = ({ locale = 'zh', routines = null, runs = null } = {}) => {
  window.__routines = routines
  window.__runs = runs
  window.__locale = locale
  useNavigationStore.getState().navigate({ kind: 'routines' })
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <AntdApp>
        <TranslationProvider initialLocale={locale}>
          <div id="view" style={{ height: '100vh' }}>
            <RoutineCenter />
          </div>
        </TranslationProvider>
      </AntdApp>
    </ConfigProvider>
  )
  return true
}

/** Mount the real editor with a template id — the hop the landing page's
 *  template cards hand over to (nothing about the prefill is visible from the
 *  landing page itself). */
window.__mountEditor = ({ templateId, locale = 'zh' } = {}) => {
  window.__locale = locale
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider initialLocale={locale}>
            <div id="view" style={{ height: '100vh' }}>
              <RoutineEditorPage templateId={templateId} />
            </div>
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
  return true
}

/** What the editor's form holds — the values a prefilled template must have
 *  written (read from the DOM properties, not attributes: React sets those). */
window.__form = () => ({
  inputs: [...document.querySelectorAll('input')].map((i) => ({ type: i.type, value: i.value, placeholder: i.placeholder || '' })),
  textareas: [...document.querySelectorAll('textarea')].map((t) => t.value),
  switchOn: !!document.querySelector('.ant-switch-checked'),
  text: document.body.innerText,
})

window.__view = () => useNavigationStore.getState().view

/** One element's box + the border/overflow facts the layout claims. */
const box = (el) => {
  if (!el) return null
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  return {
    left: r.left, right: r.right, top: r.top, bottom: r.bottom,
    width: r.width, height: r.height,
    borderLeftWidth: cs.borderLeftWidth, borderLeftColor: cs.borderLeftColor,
    borderTopWidth: cs.borderTopWidth, borderBottomWidth: cs.borderBottomWidth,
    overflowY: cs.overflowY, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
  }
}

/** Any full-width horizontal rule painted ON the seam between the left
 *  column's two halves — the section's own border or an inner divider element
 *  alike. The ruling is that the halves abut directly (「不用硬分隔…直接接壤」),
 *  so this list must stay empty; the width filter keeps card edges (a third of
 *  the column, and never at the seam in these fixtures) out of it. */
const seamRules = (tasks, templates) => {
  if (!tasks || !templates) return []
  const column = tasks.parentElement
  const seam = templates.getBoundingClientRect().top
  const columnWidth = column.getBoundingClientRect().width
  const out = []
  for (const el of column.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    if (cs.borderTopWidth === '0px' && cs.borderBottomWidth === '0px') continue
    const r = el.getBoundingClientRect()
    if (r.width < columnWidth * 0.8) continue
    const atSeam =
      (cs.borderTopWidth !== '0px' && Math.abs(r.top - seam) <= 1) ||
      (cs.borderBottomWidth !== '0px' && Math.abs(r.bottom - seam) <= 1)
    if (atSeam) out.push(el.tagName.toLowerCase() + ' ' + cs.borderTopWidth + '|' + cs.borderBottomWidth)
  }
  return out
}

window.__layout = () => {
  const tasks = document.querySelector('[data-section="tasks"]')
  const templates = document.querySelector('[data-section="templates"]')
  const runs = document.querySelector('[data-section="runs"]')
  const cards = [...document.querySelectorAll('.routine-card')]
  const buttons = [...document.querySelectorAll('.routine-template')]
  const grid = buttons[0] ? buttons[0].parentElement : null
  const runsScroller = runs ? runs.querySelector('div[style*="overflow-y"]') : null
  return {
    view: box(document.getElementById('view')),
    tasks: box(tasks),
    templates: box(templates),
    runs: box(runs),
    seamRules: seamRules(tasks, templates),
    tasksScroller: tasks ? box(tasks.querySelector('div[style*="overflow-y"]')) : null,
    templatesScroller: templates ? box(templates.querySelector('div[style*="overflow-y"]')) : null,
    runsScroller: box(runsScroller),
    grid: box(grid),
    cardCount: cards.length,
    cardBox: cards[0] ? box(cards[0]) : null,
    cardTops: cards.map((c) => c.getBoundingClientRect().top),
    // The last card and the 推荐模板 title, i.e. the two edges of the band the
    // user sees between the halves (null when either half is empty).
    lastCardBottom: cards.length ? Math.max.apply(null, cards.map((c) => c.getBoundingClientRect().bottom)) : null,
    templatesHeadBox: templates && templates.firstElementChild && templates.firstElementChild.firstElementChild
      ? box(templates.firstElementChild.firstElementChild)
      : null,
    // The two section heads and the two grids they introduce: the gap a head
    // leaves above its own content is a title-to-CARDS distance, so the head
    // BOX is no use here - its height depends on whether it carries a button.
    headBoxes: [tasks, templates, runs].map((sec) => (sec ? box(sec.firstElementChild) : null)),
    titleBoxes: [tasks, templates, runs].map((sec) => (sec && sec.firstElementChild ? box(sec.firstElementChild.firstElementChild) : null)),
    tasksGrid: box(cards[0] ? cards[0].parentElement : null),
    templateIds: buttons.map((b) => b.getAttribute('data-template')),
    templateBoxes: buttons.map((b) => box(b)),
    templateNames: buttons.map((b) => b.querySelector('span span')?.textContent ?? ''),
    templatePills: buttons.map((b) => b.querySelector('.routine-pill')?.textContent ?? ''),
    templateIsButton: buttons.map((b) => b.tagName === 'BUTTON' && b.getAttribute('type') === 'button'),
    // The description inside the card, to prove the whole card is the target.
    templateDescBoxes: buttons.map((b) => box(b.querySelectorAll('span')[1])),
  }
}
/** The 新建任务 card's own facts — one element, read three ways (tag/box/paint). */
window.__newCard = () => {
  const b = document.querySelector('.routine-new-card')
  if (!b) return null
  const cs = getComputedStyle(b)
  const firstCard = document.querySelector('.routine-card')
  return {
    tag: b.tagName,
    type: b.getAttribute('type'),
    text: b.textContent.trim(),
    box: box(b),
    // Same parent as the cards = inside the grid, and last in it.
    inGrid: !!firstCard && b.parentElement === firstCard.parentElement,
    last: b.parentElement.lastElementChild === b,
    inTasks: !!b.closest('[data-section="tasks"]'),
    siblingCount: b.parentElement.children.length,
    paint: {
      borderStyle: cs.borderTopStyle,
      borderWidth: cs.borderTopWidth,
      borderColor: cs.borderTopColor,
      radius: cs.borderRadius,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      color: cs.color,
      background: cs.backgroundColor,
      cursor: cs.cursor,
      minHeight: cs.minHeight,
      display: cs.display,
      alignItems: cs.alignItems,
      justifyContent: cs.justifyContent,
      gap: cs.gap,
      transition: cs.transitionProperty,
    },
  }
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE_HTML = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

const layout = () => page.evaluate(() => window.__layout())
const viewOf = () => page.evaluate(() => window.__view())
const texts = () => page.evaluate(() => document.body.innerText)
/** antd gives an icon an aria-label, so a button's accessible name is
 *  "plus 新建任务" — match on the label without `exact`. */
const createButton = () => page.getByRole('button', { name: '新建任务' })

await page.evaluate(() => window.__mount({}))
await page.waitForSelector('.routine-template')

// ── 1 · the title row is gone, and 新建任务 is a card in the task grid ──
const body = await texts()
check('the view title is gone from the page (the window bar carries it)', !body.includes('日常 • 自动化'), body.split('\n')[0])
const createButtons = await createButton().count()
check('新建任务 appears exactly once', createButtons === 1, `${createButtons} button(s)`)
const card = await page.evaluate(() => window.__newCard())
check(
  '…as a card that closes the task grid',
  !!card && card.tag === 'BUTTON' && card.type === 'button' && card.inGrid && card.last && card.inTasks,
  card ? `${card.tag}:${card.type} inGrid=${card.inGrid} last=${card.last} inTasks=${card.inTasks}` : 'no card'
)
check(
  '…wearing the dashed create recipe (radius 12, 72px floor, centred plus + label)',
  !!card &&
    card.paint.borderStyle === 'dashed' && card.paint.borderWidth === '1px' && card.paint.borderColor === 'rgb(200, 200, 204)' &&
    card.paint.radius === '12px' && card.paint.minHeight === '72px' &&
    card.paint.display === 'flex' && card.paint.alignItems === 'center' && card.paint.justifyContent === 'center' &&
    card.paint.gap === '8px' && card.paint.transition.includes('border-color') && card.paint.transition.includes('color'),
  card ? `${card.paint.borderStyle} ${card.paint.borderColor} r${card.paint.radius} min${card.paint.minHeight} ${card.paint.display}/${card.paint.alignItems}/${card.paint.justifyContent}/${card.paint.gap}` : 'no card'
)
check(
  '…on the page’s own type scale, not the UA button face',
  !!card && card.text === '新建任务' && card.paint.fontSize === '14px' &&
    card.paint.color === 'rgb(136, 136, 136)' && card.paint.background === 'rgba(0, 0, 0, 0)' && card.paint.cursor === 'pointer',
  card ? `"${card.text}" ${card.paint.fontSize} ${card.paint.color} on ${card.paint.background}` : 'no card'
)
// A real mouse: the dashed recipe darkens on hover (CSS :hover, so this is the
// only layer that can see it — jsdom runs no cascade for a hovered box).
if (card) {
  await page.mouse.move(card.box.left + card.box.width / 2, card.box.top + card.box.height / 2)
  await page.waitForTimeout(260)
}
const hovered = await page.evaluate(() => {
  const b = document.querySelector('.routine-new-card')
  const cs = getComputedStyle(b)
  return { borderColor: cs.borderTopColor, color: cs.color }
})
check(
  '…and answers the pointer (border and label darken)',
  hovered.borderColor === 'rgb(102, 102, 102)' && hovered.color === 'rgb(68, 68, 68)',
  `${hovered.borderColor} / ${hovered.color}`
)
await page.mouse.move(0, 0)
await page.waitForTimeout(260)

// ── 2 · two columns, split by a rule ──
const L = await layout()
check('the left column and the runs column do not overlap', L.tasks.right <= L.runs.left + 0.5, `left ends ${L.tasks.right.toFixed(1)}, right starts ${L.runs.left.toFixed(1)}`)
check('the rule between them is the runs column’s left border', L.runs.borderLeftWidth === '1px' && L.runs.borderLeftColor === 'rgb(240, 240, 240)', `${L.runs.borderLeftWidth} ${L.runs.borderLeftColor}`)
check('no rule on the left column’s own left edge (the rule belongs to the split)', L.tasks.borderLeftWidth === '0px', L.tasks.borderLeftWidth)
check('both columns start at the top of the view', Math.abs(L.tasks.top - L.runs.top) < 0.5 && Math.abs(L.runs.top - L.view.top) < 0.5, `tasks ${L.tasks.top.toFixed(1)}, runs ${L.runs.top.toFixed(1)}, view ${L.view.top.toFixed(1)}`)
check('the runs column runs to the bottom of the view', Math.abs(L.runs.bottom - L.view.bottom) < 0.5, `runs ${L.runs.bottom.toFixed(1)}, view ${L.view.bottom.toFixed(1)}`)
check('the lower half stays inside the view (the slab never overflows the column)', L.templates.bottom <= L.view.bottom + 0.5, `templates end ${L.templates.bottom.toFixed(1)}, view ends ${L.view.bottom.toFixed(1)}`)
check('the columns share the width (no third column, no gap left over)', Math.abs((L.runs.left - L.view.left) + L.runs.width - L.view.width) < 0.5, `${(L.runs.left - L.view.left).toFixed(1)} + ${L.runs.width} vs ${L.view.width}`)

// ── 3 · the left column is stacked: tasks above templates, no rule, no band ──
check('推荐模板 sits strictly below 我的任务', L.templates.top >= L.tasks.bottom - 0.5, `tasks bottom ${L.tasks.bottom.toFixed(1)}, templates top ${L.templates.top.toFixed(1)}`)
check(
  '…with no horizontal rule at the seam (the halves abut directly)',
  L.templates.borderTopWidth === '0px' && L.tasks.borderBottomWidth === '0px' && L.seamRules.length === 0,
  `template borderTop ${L.templates.borderTopWidth}, task borderBottom ${L.templates.borderBottomWidth}, rules at the seam: ${L.seamRules.length ? L.seamRules.join(', ') : 'none'}`
)
check(
  '…and the two halves meet exactly (no padding stacked at the seam either)',
  Math.abs(L.templates.top - L.tasks.bottom) < 0.5 && Math.abs(L.tasks.bottom - L.lastCardBottom) < 0.5,
  `tasks ${L.tasks.top.toFixed(1)}..${L.tasks.bottom.toFixed(1)}, last card ends ${L.lastCardBottom.toFixed(1)}, templates start ${L.templates.top.toFixed(1)}`
)
// The gap a section head leaves above ITS OWN content, measured from the TITLE
// TEXT (not from the head box, whose height depends on whether the head carries
// a 新建任务 button — that asymmetry is exactly what the user saw).
const headToContent = (title, grid) => (title && grid ? grid.top - title.bottom : null)
const tasksGap = headToContent(L.titleBoxes[0], L.tasksGrid)
const templatesGap = headToContent(L.titleBoxes[1], L.grid)
check(
  '我的任务 → 任务卡片 is the same distance as 推荐模板 → 模板卡片',
  tasksGap != null && templatesGap != null && Math.abs(tasksGap - templatesGap) < 0.5,
  `${tasksGap == null ? 'n/a' : tasksGap.toFixed(1)}px vs ${templatesGap == null ? 'n/a' : templatesGap.toFixed(1)}px`
)
check(
  '…and the head BOXES are the same height, so the titles sit identically',
  L.headBoxes[0] && L.headBoxes[1] && Math.abs(L.headBoxes[0].height - L.headBoxes[1].height) < 0.5,
  `我的任务 head ${L.headBoxes[0] ? L.headBoxes[0].height.toFixed(1) : 'n/a'}px, 推荐模板 head ${L.headBoxes[1] ? L.headBoxes[1].height.toFixed(1) : 'n/a'}px`
)
check(
  '…while the two halves keep a slightly larger gap between them',
  // The band is the templates section's own top padding plus the 5px a centred
  // head leaves above its title. User ruling 2026-09-18: 「略微增加…间距」 —
  // raised again from 16px (21px band) to 24px (29px band), so both the floor
  // (still wider than the 17px inside a half) and the ceiling (still a gap, not
  // a band that reads as a missing section) moved up with it.
  L.titleBoxes[1] && L.titleBoxes[1].top - L.lastCardBottom >= 22 && L.titleBoxes[1].top - L.lastCardBottom <= 40,
  `${(L.titleBoxes[1].top - L.lastCardBottom).toFixed(1)}px from the last card to the 推荐模板 title (vs ${tasksGap.toFixed(1)}px inside a half)`
)
check(
  '…and the leftover height sits BELOW both halves, never inside the lower one',
  L.templates.bottom - L.grid.bottom <= 24 && L.templates.bottom <= L.view.bottom + 0.5,
  `templates end ${L.templates.bottom.toFixed(1)}, grid ends ${L.grid.bottom.toFixed(1)}, view ends ${L.view.bottom.toFixed(1)}`
)
check('…inside the left column (never under the runs column)', L.templates.right <= L.runs.left + 0.5, `${L.templates.right.toFixed(1)} <= ${L.runs.left.toFixed(1)}`)
check('the task cards render in that upper half', L.cardCount === 3 && L.cardBox.top >= L.tasks.top && L.cardBox.bottom <= L.templates.top, `${L.cardCount} cards, first ${L.cardBox.top.toFixed(1)}..${L.cardBox.bottom.toFixed(1)}`)
const gridCard = await page.evaluate(() => window.__newCard())
check(
  'the 新建任务 card takes a task card’s own cell (same column width, same height)',
  !!gridCard && Math.abs(gridCard.box.width - L.cardBox.width) < 0.5 && Math.abs(gridCard.box.height - L.cardBox.height) < 0.5,
  gridCard ? `${gridCard.box.width.toFixed(1)}x${gridCard.box.height.toFixed(1)} vs task card ${L.cardBox.width.toFixed(1)}x${L.cardBox.height.toFixed(1)}` : 'no card'
)
check(
  '…and it is the grid’s last cell (4th child of the 3 task cards’ grid)',
  !!gridCard && gridCard.siblingCount === 4 && gridCard.last && gridCard.box.right <= L.tasks.right + 0.5,
  gridCard ? `${gridCard.siblingCount} children, last=${gridCard.last}, right ${gridCard.box.right.toFixed(1)} <= ${L.tasks.right.toFixed(1)}` : 'no card'
)

// ── 4 · five starters, each a button whose click is the whole card ──
check('five templates render', L.templateIds.length === 5, L.templateIds.join(', '))
check(
  'they are the five documented starters, in order',
  JSON.stringify(L.templateIds) === JSON.stringify(['daily-report', 'weekly-report', 'meeting-notes', 'today-priorities', 'monthly-review']),
  L.templateIds.join(', ')
)
check('each is a real <button type="button">', L.templateIsButton.every(Boolean), String(L.templateIsButton))
check('each carries its own name', L.templateNames.every((n) => n.length > 0), L.templateNames.join(' / '))
check(
  'scheduled ones show their derived schedule, the manual one shows none',
  L.templatePills[0] === '每天 18:00' && L.templatePills[1] === '每周五 17:30' && L.templatePills[2] === '' &&
    L.templatePills[3] === '工作日 08:45' && L.templatePills[4] === '每月 1 日 17:00',
  L.templatePills.join(' | ')
)
check(
  'the description is inside the click target (the whole card is the target)',
  L.templateDescBoxes.every((d, i) => d && d.bottom <= L.templateBoxes[i].bottom + 0.5 && d.top >= L.templateBoxes[i].top - 0.5)
)
check(
  'the template grid stays inside the left column’s width',
  L.templateBoxes.every((b) => b.left >= L.tasks.left - 0.5 && b.right <= L.runs.left + 0.5)
)
check(
  'the template slab is capped, so the task half always keeps the larger share',
  L.templates.height <= L.view.height * 0.52 + 1,
  `${L.templates.height.toFixed(1)}px of ${L.view.height}`
)
await page.screenshot({ path: join(SHOTS, 'zh.png') })

// ── 5 · the runs column is a column: full height, own scroll ──
check('the runs list scrolls on its own', L.runsScroller.overflowY === 'auto' && L.runsScroller.scrollHeight > L.runsScroller.clientHeight, `${L.runsScroller.scrollHeight} > ${L.runsScroller.clientHeight}`)
check('the runs column is narrower than the working half', L.runs.width < L.tasks.width, `runs ${L.runs.width} vs left ${L.tasks.width}`)
const bucketState = await page.evaluate(() => {
  const aside = document.querySelector('[data-section="runs"]')
  const rendered = [...aside.querySelectorAll('div')].map((d) => d.textContent).filter((t) => ['今天', '昨天', '本周', '更早'].includes(t))
  return { rendered, expected: window.__expectedBuckets }
})
const toZh = { today: '今天', yesterday: '昨天', thisWeek: '本周', earlier: '更早' }
check(
  'the run buckets render in the canonical order',
  JSON.stringify(bucketState.rendered) === JSON.stringify(bucketState.expected.map((b) => toZh[b])),
  `rendered ${bucketState.rendered.join('/')} vs expected ${bucketState.expected.map((b) => toZh[b]).join('/')}`
)
check('at least three buckets are actually exercised by the fixture', bucketState.expected.length >= 3, bucketState.expected.join(', '))
// …and the column stays bounded when the history is long.
await page.evaluate(() => window.__mount({ runs: window.__capRuns }))
await page.waitForSelector('.routine-run-row')
const cappedRows = await page.locator('.routine-run-row').count()
check('the runs column paints at most 50 rows', cappedRows === 50, `${cappedRows} rows`)

// ── 6 · a template click opens the editor prefilled, and creates nothing ──
await page.evaluate(() => { window.__calls = [] })
await page.locator('.routine-template[data-template="meeting-notes"]').click()
await page.waitForTimeout(120)
const afterTemplate = await viewOf()
const callsAfterTemplate = await page.evaluate(() => window.__calls.map((c) => c.method))
check(
  'clicking a template opens the editor with that template id',
  afterTemplate.kind === 'routines' && afterTemplate.routineEditing === true && afterTemplate.routineTemplateId === 'meeting-notes',
  JSON.stringify(afterTemplate)
)
check('…and writes nothing (no routine is created by a click)', !callsAfterTemplate.includes('routineCreate'), callsAfterTemplate.join(', '))
check('the template’s own routine is not opened for editing', afterTemplate.routineId === undefined, String(afterTemplate.routineId))

// ── 7 · 新建任务 lands on the plain create-new form, and creates nothing ──
await page.evaluate(() => { window.__calls = [] })
await page.evaluate(() => window.__mount({}))
await page.waitForSelector('.routine-template')
const createClickable = (await createButton().count()) > 0
if (createClickable) {
  await createButton().click()
  await page.waitForTimeout(120)
}
const afterCreate = await viewOf()
const callsAfterCreate = await page.evaluate(() => window.__calls.map((c) => c.method))
check(
  '新建任务 opens the editor with no template id',
  createClickable && afterCreate.kind === 'routines' && afterCreate.routineEditing === true && afterCreate.routineTemplateId === undefined,
  `clickable=${createClickable} ${JSON.stringify(afterCreate)}`
)
check('…and creates nothing (the editor’s 保存 is what writes)', !callsAfterCreate.includes('routineCreate'), callsAfterCreate.join(', '))

// ── 8 · with nothing created yet, the card and the starters are still there ──
// The first run of the app is exactly this state: no routines at all. The
// actionable card must be on screen (the user's report was that the empty half
// offered only a sentence), so this section clicks it too.
await page.evaluate(() => { window.__calls = [] })
await page.evaluate(() => window.__mount({ routines: [], runs: [] }))
await page.waitForSelector('.routine-template')
const empty = await layout()
const emptyCard = await page.evaluate(() => window.__newCard())
const emptyText = await texts()
check('empty state: the task half says so', emptyText.includes('还没有日常工作'), emptyText.split('\n').slice(0, 3).join(' / '))
check('empty state: the hint points at the card', emptyText.includes('「新建任务」卡片'), emptyText.split('\n').find((l) => l.includes('新建任务')) ?? '')
check(
  'empty state: the 新建任务 card renders (the actionable thing on an empty page)',
  !!emptyCard && emptyCard.inTasks && emptyCard.box.height > 0 && emptyCard.box.width > 0 && emptyCard.box.top >= empty.tasks.top && emptyCard.box.bottom <= empty.templates.top,
  emptyCard ? `${emptyCard.box.width.toFixed(1)}x${emptyCard.box.height.toFixed(1)} at ${emptyCard.box.top.toFixed(1)}..${emptyCard.box.bottom.toFixed(1)} (templates start ${empty.templates.top.toFixed(1)})` : 'no card'
)
check(
  'empty state: it is the grid’s only cell, and the grid sits under the hint',
  !!emptyCard && emptyCard.siblingCount === 1,
  emptyCard ? `${emptyCard.siblingCount} child(ren)` : 'no card'
)
check('empty state: the five templates stay on screen', empty.templateIds.length === 5 && empty.templates.height > 0, `${empty.templateIds.length} templates, ${empty.templates.height.toFixed(1)}px`)
check('empty state: the runs column still renders its own empty line', emptyText.includes('暂无运行记录'))
check('empty state: the layout still holds (rule + stacking)', empty.runs.borderLeftWidth === '1px' && Math.abs(empty.templates.top - empty.tasks.bottom) < 0.5 && empty.seamRules.length === 0, `runs rule ${empty.runs.borderLeftWidth}, seam rules ${empty.seamRules.length}, seam gap ${(empty.templates.top - empty.tasks.bottom).toFixed(1)}px`)
await page.screenshot({ path: join(SHOTS, 'empty.png') })
// …and the click from THAT state reaches the plain editor (a real mouse on the
// card the user would press first). Guarded so a missing card is a FAIL line,
// not a Playwright timeout that ends the run.
const emptyClickable = (await createButton().count()) > 0
if (emptyClickable) {
  await createButton().click()
  await page.waitForTimeout(120)
}
const emptyCreate = await viewOf()
const emptyCalls = await page.evaluate(() => window.__calls.map((c) => c.method))
check(
  'empty state: clicking the card opens the plain create-new form',
  emptyClickable && emptyCreate.kind === 'routines' && emptyCreate.routineEditing === true && emptyCreate.routineTemplateId === undefined,
  `clickable=${emptyClickable} ${JSON.stringify(emptyCreate)}`
)
check('empty state: …and writes nothing', !emptyCalls.includes('routineCreate'), emptyCalls.join(', '))

// ── 9 · a half-screen window: the slab scrolls instead of pushing the tasks out ──
await page.setViewportSize({ width: 900, height: 620 })
await page.evaluate(() => window.__mount({}))
await page.waitForSelector('.routine-template')
const narrow = await layout()
check('narrow: both columns still split the width', Math.abs(narrow.runs.left - narrow.templates.right) < 0.5 && Math.abs(narrow.runs.left - narrow.tasks.right) < 0.5, `left ends ${narrow.tasks.right.toFixed(1)}, runs starts ${narrow.runs.left.toFixed(1)}`)
check(
  'narrow: the slab stays capped, so the task half keeps its share',
  narrow.templates.height <= narrow.view.height * 0.52 + 1,
  `${narrow.templates.height.toFixed(1)}px of ${narrow.view.height}`
)
check(
  'narrow: the wrapped starter grid scrolls inside the slab (nothing is clipped away)',
  narrow.templatesScroller.overflowY === 'auto' && narrow.templatesScroller.scrollHeight > narrow.templatesScroller.clientHeight,
  `${narrow.templatesScroller.scrollHeight} > ${narrow.templatesScroller.clientHeight}`
)
check(
  'narrow: the five starters are still all in the DOM and inside the left column',
  narrow.templateBoxes.length === 5 && narrow.templateBoxes.every((b) => b.right <= narrow.runs.left + 0.5)
)
check(
  'narrow: the task cards fit the narrower column',
  narrow.cardTops.length === 3 && narrow.cardBox.right <= narrow.runs.left + 0.5,
  `card right ${narrow.cardBox.right.toFixed(1)} <= ${narrow.runs.left.toFixed(1)}`
)
check(
  'narrow: the create card reflows with them (inside the left column)',
  (await page.evaluate(() => window.__newCard()))?.box.right <= narrow.runs.left + 0.5,
  `card right ${(await page.evaluate(() => window.__newCard()))?.box.right.toFixed(1)} <= ${narrow.runs.left.toFixed(1)}`
)
await page.screenshot({ path: join(SHOTS, 'narrow.png') })
await page.setViewportSize({ width: 1280, height: 800 })

// ── 9b · a list longer than its half: packing must not push the starters off ──
await page.evaluate(() => window.__mount({ routines: window.__manyRoutines }))
await page.waitForSelector('.routine-card')
const many = await layout()
check('long list: twelve tasks render', many.cardCount === 12, `${many.cardCount} cards`)
check(
  'long list: the halves still meet exactly (packing is not "the upper half hugs nothing")',
  Math.abs(many.templates.top - many.tasks.bottom) < 0.5,
  `tasks end ${many.tasks.bottom.toFixed(1)}, templates start ${many.templates.top.toFixed(1)}`
)
check(
  'long list: the task half takes the overflow and scrolls on its own',
  many.tasksScroller.overflowY === 'auto' && many.tasksScroller.scrollHeight > many.tasksScroller.clientHeight + 1,
  `${many.tasksScroller.scrollHeight} > ${many.tasksScroller.clientHeight}`
)
check(
  'long list: the starters stay on screen (the overflowing list is clipped, not pushed)',
  many.templates.bottom <= many.view.bottom + 0.5 && many.templates.height > 100 && many.templates.top > many.view.top,
  `templates ${many.templates.top.toFixed(1)}..${many.templates.bottom.toFixed(1)} of ${many.view.bottom}`
)
check(
  'long list: the slab is still capped at 52%',
  many.templates.height <= many.view.height * 0.52 + 1,
  `${many.templates.height.toFixed(1)}px of ${many.view.height}`
)
check(
  'long list: the clipped cards stay inside the upper half (nothing painted over the starters)',
  many.cardTops.filter((top) => top < many.templates.top).length > 0 && many.lastCardBottom > many.templates.top,
  `${many.cardTops.filter((t) => t < many.templates.top).length} cards above the seam, last card ends ${many.lastCardBottom.toFixed(1)} (scrolled out of view)`
)
check(
  'long list: the runs column is untouched by a long task list',
  many.runs.borderLeftWidth === '1px' && many.runs.height === many.view.height,
  `runs ${many.runs.height.toFixed(1)} / view ${many.view.height.toFixed(1)}`
)
await page.screenshot({ path: join(SHOTS, 'many-tasks.png') })

// ── 10 · EN: the same page, translated ──
await page.evaluate(() => window.__mount({ locale: 'en' }))
await page.waitForSelector('.routine-template')
const en = await layout()
const enText = await texts()
check('EN: the section heads read in English', enText.includes('My Tasks') && enText.includes('Templates') && enText.includes('Recent Runs'), enText.split('\n').slice(0, 4).join(' / '))
check('EN: the starters render with English names', en.templateNames[0] === 'Daily work log' && en.templateNames[2] === 'Meeting minutes', en.templateNames.join(' / '))
check('EN: the schedule pills follow the locale', en.templatePills[0] === 'Daily 18:00' && en.templatePills[1] === 'Weekly · Fri 17:30', en.templatePills.join(' | '))
check('EN: no Chinese label leaks into the buttons', (await page.getByRole('button', { name: 'New Task' }).count()) === 1)
check(
  'EN: the create card is the same card, translated',
  (await page.evaluate(() => window.__newCard()))?.text === 'New Task',
  JSON.stringify((await page.evaluate(() => window.__newCard()))?.text)
)
check('EN: the layout is identical (rule + stacking + five cards)', en.runs.borderLeftWidth === '1px' && en.templates.top >= en.tasks.bottom - 0.5 && en.templateIds.length === 5 && en.seamRules.length === 0, `runs rule ${en.runs.borderLeftWidth}, seam rules ${en.seamRules.length}`)
await page.screenshot({ path: join(SHOTS, 'en.png') })

// ── 11 · the other end of the hand-off: the editor opens prefilled ──
// The landing page only names a template; what the user sees next is the form.
const formOf = () => page.evaluate(() => window.__form())
const nameValue = (form) => form.inputs.find((i) => i.placeholder.includes('每日依赖巡检'))?.value
const descValue = (form) => form.inputs.find((i) => i.placeholder.includes('一句话说明'))?.value

await page.evaluate(() => window.__mountEditor({ templateId: 'daily-report' }))
await page.waitForSelector('textarea')
await page.waitForTimeout(250)
const daily = await formOf()
check('editor: the form mounted (so the checks below are not vacuous)', daily.inputs.length > 0 && daily.textareas.length > 0, `${daily.inputs.length} inputs, ${daily.textareas.length} textareas`)
check('editor: the name is prefilled', nameValue(daily) === '每日工作日报', String(nameValue(daily)))
check('editor: the description is prefilled', (descValue(daily) ?? '').includes('下班前'), String(descValue(daily)))
check('editor: the prompt is prefilled', daily.textareas.some((t) => t.includes('生成今天的工作日报')), daily.textareas.map((t) => t.slice(0, 24)).join(' | '))
check('editor: the schedule came with the template', daily.switchOn && daily.inputs.some((i) => i.type === 'time' && i.value === '18:00'), JSON.stringify(daily.inputs.filter((i) => i.type === 'time')))
check('editor: it is the create-new flow, not an edit', daily.text.includes('新建任务') && !daily.text.includes('编辑任务'), daily.text.split('\n').slice(0, 3).join(' / '))
await page.screenshot({ path: join(SHOTS, 'editor-daily.png') })

await page.evaluate(() => window.__mountEditor({ templateId: 'meeting-notes' }))
await page.waitForSelector('textarea')
await page.waitForTimeout(250)
const meeting = await formOf()
check('editor: a manual template arrives with no schedule', meeting.switchOn === false)
check('editor: its param is carried into the form', meeting.inputs.some((i) => i.placeholder === '参数名' && i.value === 'notes'), JSON.stringify(meeting.inputs.filter((i) => i.placeholder === '参数名').map((i) => i.value)))
check('editor: the label is localized, not the raw key', meeting.inputs.some((i) => i.placeholder === '显示名' && i.value.includes('会议记录')), JSON.stringify(meeting.inputs.filter((i) => i.placeholder === '显示名').map((i) => i.value)))
check('editor: the prompt keeps its {{notes}} placeholder', meeting.textareas.some((t) => t.includes('{{notes}}')))

await page.evaluate(() => window.__mountEditor({ templateId: 'not-a-template' }))
await page.waitForSelector('textarea')
await page.waitForTimeout(250)
const unknown = await formOf()
check('editor: an unknown template id falls back to the plain empty form', nameValue(unknown) === '' && unknown.switchOn === false, `name "${nameValue(unknown)}"`)

await page.evaluate(() => window.__mountEditor({ templateId: 'weekly-report', locale: 'en' }))
await page.waitForSelector('textarea')
await page.waitForTimeout(250)
const enForm = await formOf()
check('editor EN: the template arrives translated', nameValue(enForm) === 'Weekly report' && enForm.textareas.some((t) => t.includes('this week’s report')), String(nameValue(enForm)))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed · shots in ${SHOTS}`)
process.exit(failed.length === 0 ? 0 : 1)
