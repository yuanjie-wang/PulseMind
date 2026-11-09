/**
 * Routine landing-page layout probe (real Chromium).
 *
 * 日常 • 自动化 was reorganised into two columns split by a rule (user ruling
 * 2026-09-18): the LEFT holds what the user owns and can start — 我的任务 over
 * 推荐模板 — and the RIGHT is the recent-runs list. The page's own
 * 日常 • 自动化 + 新建任务 title row is gone. 新建任务 follows the state (user
 * ruling 2026-09-23: 「仅当未创建任何任务的时候，新建按钮以卡片形式呈现，如果有
 * 任务，则变为普通按钮，放到【我的任务】同一行的最右侧」): a plain button pinned
 * at the far right of the 我的任务 head once tasks exist, the dashed card
 * closing the task grid when none do. 导入分享 sits immediately to its LEFT in
 * that same head row (user 2026-11-09) and is the ONE action the empty head
 * keeps — importing is how a bare install gets its first task.
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
 *     column, and the template grid reflows rather than overflowing. The left
 *     COLUMN is the scroll container (user ruling 2026-09-24: 我的任务 「不用设
 *     最大高度，就展开」，接受把推荐模版挤到第二屏): neither half scrolls
 *     internally any more, a long task list renders every card at natural
 *     height and pushes the starters below the fold, and scrolling the column
 *     reaches them
 *   - the seam: NOTHING rules the two left halves apart — no border on either
 *     section and no inner divider element at the seam (user ruling
 *     2026-09-18: 「不用硬分隔…直接接壤」) — while the vertical rule against the
 *     runs column is untouched
 *   - the missing title row: the view title 日常任务 appears nowhere on
 *     the page, and 新建任务 appears exactly once — as a plain primary button
 *     pinned at the far right of the 我的任务 head while tasks exist, and as
 *     the dashed card closing the task grid once none do (wearing the recipe,
 *     with a real mouse proving its hover — asserted in §8, the only state
 *     that renders it)
 *   - the starters: five templates, each a real <button> whose click reaches
 *     the navigation store as `routineEditing + routineTemplateId` and creates
 *     NOTHING (the whole point of a template is that it is not a routine yet)
 *   - 新建任务 from either affordance lands on the plain create-new form (no
 *     stale templateId) and creates nothing either, and the empty state keeps
 *     the card and the starters on screen
 *   - the mixed grid's card contract (user ruling 2026-11-09: 「对话式任务和工作流
 *     任务的卡片样式要统一…标签就保留两个…当设定了定时执行计划时，才展示开关」):
 *     both kinds land in ONE grid wearing the same shell, each card carries
 *     exactly one 执行计划 pill (下次运行：… when a valid cron is enabled,
 *     手动执行 otherwise) plus a 批量数据 pill only with a CSV, and the enable
 *     switch appears only on cards with a scheduled plan — clicking a workflow's
 *     switch goes through PIPELINE_WORKFLOWS' toggle op and the card really
 *     flips after the reload. Fine grain (all four plan-text combinations, long
 *     content not stretching the card, routine-side clicks) lives in
 *     probe-task-card-pills.mjs.
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
import TaskWizardPage from './src/renderer/src/components/routine/TaskWizardPage'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
// The routine center is migrated onto the theme sheet (PLAN-dark-mode M3/T2),
// so the page needs the variable table injected before the components render —
// without it a var() resolves to nothing and the dashed card's computed
// border/label colours fall back to the UA. Light is pinned explicitly.
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'

installThemeVars()
applyThemeAttr('light')
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
// 今天组也必须钉在今天：NOW 减 6 小时在午夜后整组翻进昨天，剩下的桶凑不到三个
// （实锤：00:0x 那一跑 expected = yesterday, earlier）。锚到本地零点之后，
// 桶归属与跑探针的时刻无关——同 conversation-time-groups 的夹具修法。
const START_OF_TODAY = new Date(NOW)
START_OF_TODAY.setHours(0, 0, 0, 0)
const RUNS = []
const BUCKET_SEEN = new Set()
for (const group of RUN_GROUPS) {
  for (let i = 0; i < group.count; i++) {
    const startedAt = group.daysAgo == null
      ? Math.max(START_OF_TODAY.getTime() + 1000, NOW - (i + 1) * group.step)
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

// A task list that does NOT fit the screen - 我的任务 must still render every
// card at natural height (the 2026-09-24 ruling: the area expands, it never
// compresses), pushing 推荐模板 below the fold; the column's own scrollbar is
// what reaches them.
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
    // 每次调用都是新引用（真 IPC 过结构化克隆）——见下方 pipelineWorkflows 的
    // 同一句注释：回同一个数组会让 reload 的 setState 被 React 跳过。
    if (key === 'routineList') return Promise.resolve((window.__routines ?? ROUTINES).map((r) => ({ ...r })))
    if (key === 'routineGet') return Promise.resolve((window.__routines ?? ROUTINES).find((r) => r.id === args[0]) ?? null)
    if (key === 'routineRuns') return Promise.resolve(window.__runs ?? RUNS)
    // 工作流卡片（2026-11-09 混排两类任务的卡片契约）：默认空列表 = 只有对话式
    // 任务的旧形态，前面各节的数量断言逐字不变；契约节用 window.__workflows 换
    // 真定义。toggle 写回夹具本身，让 reload 之后卡片真的换态。
    // list 必须每次返回**新数组**（.map 拷贝）：真 IPC 过一遍结构化克隆，返回的
    // 永远是新引用；直接回 window.__workflows 会让 reload 的 setState 撞上同一个
    // 引用、React 按 Object.is 跳过重渲染——卡片看着没换态，探针就会误报产品的
    // 错（2026-11-09 实锤踩过）。
    if (key === 'pipelineWorkflows') {
      if (args[0] === 'list') return Promise.resolve((window.__workflows ?? []).map((w) => ({ ...w })))
      if (args[0] === 'toggle') {
        const { id, enabled } = args[1] ?? {}
        const wf = (window.__workflows ?? []).find((w) => w.id === id)
        if (wf) wf.enabled = enabled
        return Promise.resolve(wf ? { ...wf } : null)
      }
      return Promise.resolve(undefined)
    }
    if (key === 'routineToggle') {
      const r = (window.__routines ?? ROUTINES).find((x) => x.id === args[0])
      if (r) r.enabled = !!args[1]
      return Promise.resolve(r ?? null)
    }
    // A save must round-trip: the editor reads created.id to promote the
    // assist thread, so answer with the stored shape instead of undefined.
    if (key === 'routineCreate' || key === 'routineUpdate') {
      const input = args[key === 'routineCreate' ? 0 : 1] ?? {}
      return Promise.resolve({ id: 'r_stub', ...input, createdAt: '', updatedAt: '' })
    }
    if (EMPTY_LISTS.includes(String(key))) return Promise.resolve([])
    // 分享导入两段（2026-11-09 任务中心头部新增入口）：默认按「用户取消了文件
    // 对话框」应答；导入用例用 window.__importPreview 换真 payload，验预览模态
    // 真的挂上来。
    if (key === 'shareImportPreview') return Promise.resolve(window.__importPreview ?? { canceled: true })
    if (key === 'shareImportCommit') return Promise.resolve({ imported: 0, overwritten: 0, skipped: 0, failed: 0, errors: [] })
    // The editor mounts the real SettingsProvider, which loads settings.json.
    // window.__profiles/__activeProfileId let a section pin the model list the
    // 模型 select reads.
    if (key === 'getSettings') {
      return Promise.resolve({ activeProfileId: window.__activeProfileId ?? '', profiles: window.__profiles ?? [], theme: 'light', myName: '', soul: '',
        yourName: '', workspaceDir: '', autoCleanup: false, locale: window.__locale ?? 'zh' })
    }
    return Promise.resolve(undefined)
  },
})

window.__opened = null
let root = null
window.__mount = ({ locale = 'zh', routines = null, runs = null, workflows = null } = {}) => {
  window.__routines = routines
  window.__runs = runs
  window.__workflows = workflows
  window.__locale = locale
  useNavigationStore.getState().navigate({ kind: 'routines' })
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider initialLocale={locale}>
            <div id="view" style={{ height: '100vh' }}>
              <RoutineCenter />
            </div>
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
  return true
}

/** Mount the real editor with a template id (the landing page's hand-off) or a
 *  stored routine id (the 编辑 hop — the run-context fields are only visible
 *  on a routine that carries them). */
window.__mountEditor = ({ templateId, routineId, locale = 'zh' } = {}) => {
  window.__locale = locale
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider initialLocale={locale}>
            <div id="view" style={{ height: '100vh' }}>
              <TaskWizardPage kind="routine" templateId={templateId} routineId={routineId} />
            </div>
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
  return true
}

/** Mount the run workspace (the three-pane RoutineWorkspace) through the
 *  production entry: RoutineCenter with a runHistoryOf deep link. Wrapped in
 *  SettingsProvider because the workspace reads the retention policy; with
 *  an empty runs list the right pane stays hint-only (no hosted session). */
window.__mountWorkspace = ({ routineId, locale = 'zh' } = {}) => {
  window.__locale = locale
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider initialLocale={locale}>
            <div id="view" style={{ height: '100vh' }}>
              <RoutineCenter runHistoryOf={routineId} />
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
    // The left column itself — the scroll container since the 2026-09-24
    // ruling. It is the sections' common parent.
    leftCol: box(tasks ? tasks.parentElement : null),
    seamRules: seamRules(tasks, templates),
    // Both inner scrollers are GONE (the sections flow at natural height);
    // these read null now and the checks below pin that absence — a reinstated
    // 52% cap or squeeze would bring a div[overflow-y] back inside a section.
    tasksScroller: tasks ? box(tasks.querySelector('div[style*="overflow-y"]')) : null,
    templatesScroller: templates ? box(templates.querySelector('div[style*="overflow-y"]')) : null,
    runsScroller: box(runsScroller),
    grid: box(grid),
    gridChildCount: cards[0] ? cards[0].parentElement.children.length : null,
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
  return {
    tag: b.tagName,
    type: b.getAttribute('type'),
    text: b.textContent.trim(),
    box: box(b),
    // Its parent IS the task grid — read as display:grid rather than "same
    // parent as the task cards", because the empty state (the only state that
    // renders the card since the 2026-09-23 ruling) has no task card to
    // compare against.
    inGrid: !!b.parentElement && getComputedStyle(b.parentElement).display === 'grid',
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

/** The 我的任务 head action's own facts — the plain 新建任务 button that takes
 *  over once tasks exist (null on the empty page, whose affordance is the
 *  grid's card). rightGap is head-right minus button-right: the ruling is
 *  同一行的最右侧, so it must be ~0; inHeadRow says the button really rides
 *  that row rather than sitting near it. */
window.__createBtn = () => {
  const head = document.querySelector('[data-section="tasks"]')?.firstElementChild
  // 动作簇自 2026-11-09 起有两颗钮（导入分享在左、新建任务在右），所以按
  // 「head 里唯一的 primary」取，不按文案也不取「第一颗」——文案随 locale 变
  // （EN 下是 New Task），primary 才是这颗钮的稳定身份。
  const b = head ? [...head.querySelectorAll('button')].find((el) => el.classList.contains('ant-btn-primary')) : null
  if (!b) return null
  const r = b.getBoundingClientRect()
  const hr = head.getBoundingClientRect()
  return {
    tag: b.tagName,
    text: b.textContent.trim(),
    classes: b.className,
    rightGap: hr.right - r.right,
    inHeadRow: r.top >= hr.top - 0.5 && r.bottom <= hr.bottom + 0.5,
    box: box(b),
    cardCount: document.querySelectorAll('.routine-new-card').length,
  }
}

/** The head's whole action cluster (2026-11-09: 导入分享 → 新建任务). Buttons in
 *  DOM order, with boxes; gap is the painted space between neighbours. */
window.__headActions = () => {
  const head = document.querySelector('[data-section="tasks"]')?.firstElementChild
  if (!head) return null
  const hr = head.getBoundingClientRect()
  const btns = [...head.querySelectorAll('button')].map((b) => {
    const r = b.getBoundingClientRect()
    return {
      text: b.textContent.trim(),
      primary: b.className.includes('ant-btn-primary'),
      inHeadRow: r.top >= hr.top - 0.5 && r.bottom <= hr.bottom + 0.5,
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
    }
  })
  return {
    count: btns.length,
    btns,
    headRight: hr.right,
    gap: btns.length === 2 ? btns[1].left - btns[0].right : null,
  }
}

window.__ready = true
`

/** 0.5.1 的展示门（WORKFLOW_TASKS_UI=false）把工作流卡片收起来了，但卡片的契约
 *  （同一 TaskCard、两颗胶囊、定时开关）必须原样完好——探针在 bundle 期把该常量
 *  钉成 true，测「翻转开关后一切照旧」。隐藏面本身由 tests/workflow-hidden.test.ts 钉。 */
const forceWorkflowUi = {
  name: 'force-workflow-ui',
  setup(b) {
    b.onResolve({ filter: /(^|\/)shared\/feature-flags$/ }, () => ({ path: 'pm-flags', namespace: 'pm-flags' }))
    b.onLoad({ filter: /.*/, namespace: 'pm-flags' }, () => ({ contents: 'export const WORKFLOW_TASKS_UI = true', loader: 'ts' }))
  },
}

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
  plugins: [forceWorkflowUi],
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
page.on('console', (msg) => { if (msg.type() === 'error') console.log('  [console.error]', msg.text().slice(0, 300)) })
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
await page.waitForSelector('.routine-card')

// ── 1 · the title row is gone, and 新建任务 is a plain button in the head ──
// With tasks on the page the affordance is NOT the card (user ruling
// 2026-09-23): it is a normal button at the far right of the 我的任务 row, and
// the grid closes with task cards alone. The card's own recipe/hover/type facts
// are asserted in §8 — the empty state is the only state that renders it.
const body = await texts()
check('the view title is gone from the page (the window bar carries it)', !body.includes('日常任务'), body.split('\n')[0])
const createButtons = await createButton().count()
check('新建任务 appears exactly once', createButtons === 1, `${createButtons} button(s)`)
const btn = await page.evaluate(() => window.__createBtn())
const populatedCard = await page.evaluate(() => window.__newCard())
check(
  '…with tasks: a button in the 我的任务 head, and NO card in the grid',
  !!btn && btn.tag === 'BUTTON' && btn.classes.includes('ant-btn-primary') && populatedCard === null,
  btn ? `${btn.tag} "${btn.text}" ant-btn-primary=${btn.classes.includes('ant-btn-primary')} card=${populatedCard ? 'present' : 'absent'}` : 'no head button'
)
check(
  '…pinned at the far right of that row, inside the head box',
  !!btn && Math.abs(btn.rightGap) <= 0.5 && btn.inHeadRow,
  btn ? `right gap ${btn.rightGap.toFixed(1)}px, inRow=${btn.inHeadRow}` : 'no head button'
)

// 1b · 导入分享 sits to the LEFT of 新建任务 (user 2026-11-09). Two buttons in one
// row: the newcomer is secondary (never primary — 新建任务 keeps the filled slot),
// 8px apart, and ONLY the import one is there when the list is empty.
const headActions = await page.evaluate(() => window.__headActions())
check(
  '…and 导入分享 is the button immediately to its LEFT (same head row, one cluster)',
  !!headActions && headActions.count === 2 &&
    headActions.btns[0].text.includes('导入分享') && headActions.btns[1].text.includes('新建任务') &&
    headActions.btns.every((b) => b.inHeadRow) &&
    headActions.btns[0].right <= headActions.btns[1].left + 0.5,
  headActions ? `${headActions.count} button(s): ${headActions.btns.map((b) => `"${b.text}"@${b.left.toFixed(0)}..${b.right.toFixed(0)}`).join(' ')}` : 'no head actions'
)
check(
  '…secondary (not primary), 8px away, and 新建任务 still closes the row',
  !!headActions && !headActions.btns[0].primary && headActions.btns[1].primary &&
    Math.abs(headActions.gap - 8) <= 1 &&
    Math.abs(headActions.headRight - headActions.btns[1].right) <= 0.5,
  headActions ? `primary=${headActions.btns.map((b) => b.primary).join('/')} gap ${headActions.gap == null ? 'n/a' : headActions.gap.toFixed(1)}px, right gap ${(headActions.headRight - headActions.btns[1].right).toFixed(1)}px` : 'no head actions'
)

// ── 2 · two columns, split by a rule ──
const L = await layout()
check('the left column and the runs column do not overlap', L.tasks.right <= L.runs.left + 0.5, `left ends ${L.tasks.right.toFixed(1)}, right starts ${L.runs.left.toFixed(1)}`)
check('the rule between them is the runs column’s left border', L.runs.borderLeftWidth === '1px' && L.runs.borderLeftColor === 'rgb(240, 240, 240)', `${L.runs.borderLeftWidth} ${L.runs.borderLeftColor}`)
check('no rule on the left column’s own left edge (the rule belongs to the split)', L.tasks.borderLeftWidth === '0px', L.tasks.borderLeftWidth)
check('both columns start at the top of the view', Math.abs(L.tasks.top - L.runs.top) < 0.5 && Math.abs(L.runs.top - L.view.top) < 0.5, `tasks ${L.tasks.top.toFixed(1)}, runs ${L.runs.top.toFixed(1)}, view ${L.view.top.toFixed(1)}`)
check('the runs column runs to the bottom of the view', Math.abs(L.runs.bottom - L.view.bottom) < 0.5, `runs ${L.runs.bottom.toFixed(1)}, view ${L.view.bottom.toFixed(1)}`)
check(
  'the left column is the scroll container (the halves flow at natural height; the column takes any overflow)',
  L.leftCol.overflowY === 'auto' && L.tasksScroller === null && L.templatesScroller === null,
  `leftCol overflow-y ${L.leftCol.overflowY}, inner scrollers: tasks=${L.tasksScroller ? 'present' : 'none'}, templates=${L.templatesScroller ? 'present' : 'none'}`
)
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
  '…and the lower half ends at its own bottom padding (nothing stretches it — natural height, no leftover distributed inside it)',
  L.templates.bottom - L.grid.bottom >= 18 && L.templates.bottom - L.grid.bottom <= 24,
  `templates end ${L.templates.bottom.toFixed(1)}, grid ends ${L.grid.bottom.toFixed(1)} (Δ ${(L.templates.bottom - L.grid.bottom).toFixed(1)} = the 20px bottom padding)`
)
check('…inside the left column (never under the runs column)', L.templates.right <= L.runs.left + 0.5, `${L.templates.right.toFixed(1)} <= ${L.runs.left.toFixed(1)}`)
check('the task cards render in that upper half', L.cardCount === 3 && L.cardBox.top >= L.tasks.top && L.cardBox.bottom <= L.templates.top, `${L.cardCount} cards, first ${L.cardBox.top.toFixed(1)}..${L.cardBox.bottom.toFixed(1)}`)
const gridCard = await page.evaluate(() => window.__newCard())
check(
  'the grid’s cells are all task cards — with tasks, the create affordance is the head button, not a 4th cell',
  gridCard === null && L.gridChildCount === 3 && L.cardCount === 3,
  `card=${gridCard ? 'present' : 'absent'}, grid children=${L.gridChildCount}, task cards=${L.cardCount}`
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
  'the template slab is uncapped (no 52% limit, no inner scroller — the 2026-09-24 ruling)',
  L.templatesScroller === null && Math.abs(L.templates.bottom - L.grid.bottom - 20) < 1,
  `grid ends ${L.grid.bottom.toFixed(1)}, slab ends ${L.templates.bottom.toFixed(1)}, inner scroller ${L.templatesScroller ? 'present' : 'none'}`
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
await page.waitForSelector('.routine-card')
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

// ── 7b · 导入分享 (user 2026-11-09: the button left of 新建任务) ──
// The head's left button runs the two-phase import: preview (main opens the file
// dialog, sanitizes, hands back rows + a token) then a modal; closing it re-reads
// the lists so an imported row appears without a reload.
await page.evaluate(() => { window.__calls = [] })
await page.evaluate(() => window.__mount({}))
await page.waitForSelector('.routine-card')
await page.evaluate(() => {
  window.__importPreview = {
    importToken: 'tok_probe',
    items: [{ index: 0, kind: 'routine', name: '分享来的任务', summary: '每天 18:00', warnings: [], blocked: false, nameConflict: false }],
  }
})
await page.locator('[data-action="share-import"]').click()
// antd 6 renders the panel as `.ant-modal` > `.ant-modal-container`（v5 的
// `.ant-modal-content` 已不存在，按旧选择器等会白等）。
await page.waitForSelector('[role="dialog"]', { timeout: 3000 }).catch(() => {})
const importModal = await page.evaluate(() => {
  const m = document.querySelector('[role="dialog"]')
  return { open: !!m, text: m ? m.innerText : '' }
})
const callsAfterImport = await page.evaluate(() => window.__calls.map((c) => c.method))
check('导入分享 asks main for a preview (shareImportPreview)', callsAfterImport.includes('shareImportPreview'), callsAfterImport.join(', '))
check(
  '…and opens the preview modal with the parsed row (kind tag + name)',
  importModal.open && importModal.text.includes('导入预览') && importModal.text.includes('日常任务') && importModal.text.includes('分享来的任务'),
  importModal.open ? importModal.text.split('\n').slice(0, 5).join(' / ') : 'no modal'
)
check('…without touching the editor route (a dialog, not a navigation)', (await viewOf()).routineEditing === undefined, JSON.stringify(await viewOf()))
const listBeforeCancel = await page.evaluate(() => window.__calls.filter((c) => c.method === 'routineList').length)
const cancelBtn = page.locator('[role="dialog"] button.ant-btn-default')
if (await cancelBtn.count()) await cancelBtn.click()
await page.waitForTimeout(300)
const listAfterCancel = await page.evaluate(() => window.__calls.filter((c) => c.method === 'routineList').length)
const modalGone = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].filter((d) => getComputedStyle(d).display !== 'none' && d.getBoundingClientRect().width > 0).length === 0)
check(
  '…closing it re-reads the task lists (an imported row must show up at once)',
  listAfterCancel > listBeforeCancel && modalGone,
  `routineList calls ${listBeforeCancel} → ${listAfterCancel}, modal ${modalGone ? 'closed' : 'still open'}`
)
await page.evaluate(() => { window.__importPreview = undefined })

// ── 8 · with nothing created yet, the card and the starters are still there ──
// The first run of the app is exactly this state: no routines at all. The
// actionable card must be on screen (the user's report was that the empty half
// offered only a sentence), so this section clicks it too.
await page.evaluate(() => { window.__calls = [] })
await page.evaluate(() => window.__mount({ routines: [], runs: [] }))
await page.waitForSelector('.routine-new-card')
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
// …and this state wears the facts §1 gave up: the head carries no CREATE button
// (the card is the affordance) — only the import one, which is the whole point
// of an empty list; the card closes the grid, and the dashed recipe + type scale
// + CSS :hover are read HERE (user ruling 2026-09-23, amended 2026-11-09).
check(
  'empty state: the 我的任务 head carries no 新建任务 button (the card is the affordance)',
  (await page.evaluate(() => window.__createBtn())) === null,
  'no create button in the head'
)
const emptyHeadActions = await page.evaluate(() => window.__headActions())
check(
  'empty state: …only 导入分享 is up there (importing is how a bare install starts)',
  !!emptyHeadActions && emptyHeadActions.count === 1 && emptyHeadActions.btns[0].text.includes('导入分享') &&
    !emptyHeadActions.btns[0].primary && emptyHeadActions.btns[0].inHeadRow,
  emptyHeadActions ? `${emptyHeadActions.count} button(s): ${emptyHeadActions.btns.map((b) => `"${b.text}"`).join(', ')}` : 'no head actions'
)
check(
  'empty state: …the card closes the task grid (a real button, in the grid, last)',
  !!emptyCard && emptyCard.tag === 'BUTTON' && emptyCard.type === 'button' && emptyCard.inGrid && emptyCard.last && emptyCard.inTasks,
  emptyCard ? `${emptyCard.tag}:${emptyCard.type} inGrid=${emptyCard.inGrid} last=${emptyCard.last} inTasks=${emptyCard.inTasks}` : 'no card'
)
check(
  'empty state: …wearing the dashed create recipe (radius 12, 72px floor, centred plus + label)',
  !!emptyCard &&
    emptyCard.paint.borderStyle === 'dashed' && emptyCard.paint.borderWidth === '1px' && emptyCard.paint.borderColor === 'rgb(200, 200, 204)' &&
    emptyCard.paint.radius === '12px' && emptyCard.paint.minHeight === '72px' &&
    emptyCard.paint.display === 'flex' && emptyCard.paint.alignItems === 'center' && emptyCard.paint.justifyContent === 'center' &&
    emptyCard.paint.gap === '8px' && emptyCard.paint.transition.includes('border-color') && emptyCard.paint.transition.includes('color'),
  emptyCard ? `${emptyCard.paint.borderStyle} ${emptyCard.paint.borderColor} r${emptyCard.paint.radius} min${emptyCard.paint.minHeight} ${emptyCard.paint.display}/${emptyCard.paint.alignItems}/${emptyCard.paint.justifyContent}/${emptyCard.paint.gap}` : 'no card'
)
check(
  'empty state: …on the page’s own type scale, not the UA button face',
  !!emptyCard && emptyCard.text === '新建任务' && emptyCard.paint.fontSize === '14px' &&
    emptyCard.paint.color === 'rgb(136, 136, 136)' && emptyCard.paint.background === 'rgba(0, 0, 0, 0)' && emptyCard.paint.cursor === 'pointer',
  emptyCard ? `"${emptyCard.text}" ${emptyCard.paint.fontSize} ${emptyCard.paint.color} on ${emptyCard.paint.background}` : 'no card'
)
// A real mouse: the dashed recipe darkens on hover (CSS :hover, so this is the
// only layer that can see it — jsdom runs no cascade for a hovered box).
if (emptyCard) {
  await page.mouse.move(emptyCard.box.left + emptyCard.box.width / 2, emptyCard.box.top + emptyCard.box.height / 2)
  await page.waitForTimeout(260)
}
const emptyHovered = await page.evaluate(() => {
  const b = document.querySelector('.routine-new-card')
  if (!b) return null
  const cs = getComputedStyle(b)
  return { borderColor: cs.borderTopColor, color: cs.color }
})
check(
  'empty state: …and answers the pointer (border and label darken)',
  !!emptyHovered && emptyHovered.borderColor === 'rgb(102, 102, 102)' && emptyHovered.color === 'rgb(68, 68, 68)',
  emptyHovered ? `${emptyHovered.borderColor} / ${emptyHovered.color}` : 'no card'
)
await page.mouse.move(0, 0)
await page.waitForTimeout(260)
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
await page.waitForSelector('.routine-card')
const narrow = await layout()
check('narrow: both columns still split the width', Math.abs(narrow.runs.left - narrow.templates.right) < 0.5 && Math.abs(narrow.runs.left - narrow.tasks.right) < 0.5, `left ends ${narrow.tasks.right.toFixed(1)}, runs starts ${narrow.runs.left.toFixed(1)}`)
check(
  'narrow: the left column takes the overflow (the halves scroll as one page, no inner scroller)',
  narrow.leftCol.overflowY === 'auto' && narrow.leftCol.scrollHeight > narrow.leftCol.clientHeight + 1 &&
    narrow.tasksScroller === null && narrow.templatesScroller === null,
  `${narrow.leftCol.scrollHeight} > ${narrow.leftCol.clientHeight}, inner scrollers ${narrow.tasksScroller || narrow.templatesScroller ? 'present' : 'none'}`
)
await page.evaluate(() => {
  const col = document.querySelector('[data-section="tasks"]').parentElement
  col.scrollTop = col.scrollHeight
})
await page.waitForTimeout(50)
const narrowScrolled = await layout()
check(
  'narrow: scrolling the column brings every starter into view (below the fold, not gone)',
  narrowScrolled.templateBoxes.length === 5 && narrowScrolled.templateBoxes[4].bottom <= narrowScrolled.view.bottom + 0.5,
  `last starter ends ${narrowScrolled.templateBoxes[4].bottom.toFixed(1)}, view ends ${narrowScrolled.view.bottom.toFixed(1)}`
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
const narrowBtn = await page.evaluate(() => window.__createBtn())
check(
  'narrow: the create button stays pinned inside the left column’s head',
  !!narrowBtn && narrowBtn.box.right <= narrow.runs.left + 0.5 && Math.abs(narrowBtn.rightGap) <= 0.5,
  narrowBtn ? `right ${narrowBtn.box.right.toFixed(1)} <= runs.left ${narrow.runs.left.toFixed(1)}, gap ${narrowBtn.rightGap.toFixed(1)}` : 'no head button'
)
await page.evaluate(() => { document.querySelector('[data-section="tasks"]').parentElement.scrollTop = 0 })
await page.waitForTimeout(50)
await page.screenshot({ path: join(SHOTS, 'narrow.png') })
await page.setViewportSize({ width: 1280, height: 800 })

// ── 9b · a list taller than the screen: 我的任务 expands, the starters wait below ──
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
  'long list: the task half fully expands — every card at natural height, none clipped or squeezed',
  many.tasksScroller === null && many.cardTops.length === 12 && many.lastCardBottom <= many.tasks.bottom + 0.5,
  `12 cards, last ends ${many.lastCardBottom.toFixed(1)}, section ends ${many.tasks.bottom.toFixed(1)}, inner scroller ${many.tasksScroller ? 'present' : 'none'}`
)
check(
  'long list: the starters are pushed past the fold (the accepted cost of the 2026-09-24 ruling)',
  many.templates.bottom > many.view.bottom && many.templateBoxes.length === 5,
  `templates end ${many.templates.bottom.toFixed(1)}, view ends ${many.view.bottom.toFixed(1)}`
)
check(
  'long list: the column scrolls, and its end reaches the starters',
  many.leftCol.overflowY === 'auto' && many.leftCol.scrollHeight > many.leftCol.clientHeight,
  `${many.leftCol.scrollHeight} > ${many.leftCol.clientHeight}`
)
await page.evaluate(() => {
  const col = document.querySelector('[data-section="tasks"]').parentElement
  col.scrollTop = col.scrollHeight
})
await page.waitForTimeout(50)
const manyScrolled = await layout()
check(
  'long list: scrolled to the end, the whole template slab is in view',
  manyScrolled.templates.bottom <= manyScrolled.view.bottom + 0.5 && manyScrolled.templates.top >= manyScrolled.view.top - 0.5,
  `templates ${manyScrolled.templates.top.toFixed(1)}..${manyScrolled.templates.bottom.toFixed(1)} of view ${manyScrolled.view.top.toFixed(1)}..${manyScrolled.view.bottom.toFixed(1)}`
)
check(
  'long list: the runs column is untouched by a long task list',
  many.runs.borderLeftWidth === '1px' && many.runs.height === many.view.height,
  `runs ${many.runs.height.toFixed(1)} / view ${many.view.height.toFixed(1)}`
)
await page.evaluate(() => { document.querySelector('[data-section="tasks"]').parentElement.scrollTop = 0 })
await page.waitForTimeout(50)
await page.screenshot({ path: join(SHOTS, 'many-tasks.png') })

// ── 10 · EN: the same page, translated ──
await page.evaluate(() => window.__mount({ locale: 'en' }))
await page.waitForSelector('.routine-card')
const en = await layout()
const enText = await texts()
check('EN: the section heads read in English', enText.includes('My Tasks') && enText.includes('Templates') && enText.includes('Recent Runs'), enText.split('\n').slice(0, 4).join(' / '))
check('EN: the starters render with English names', en.templateNames[0] === 'Daily work log' && en.templateNames[2] === 'Meeting minutes', en.templateNames.join(' / '))
check('EN: the schedule pills follow the locale', en.templatePills[0] === 'Daily 18:00' && en.templatePills[1] === 'Weekly · Fri 17:30', en.templatePills.join(' | '))
check('EN: no Chinese label leaks into the buttons', (await page.getByRole('button', { name: 'New Task' }).count()) === 1)
check(
  'EN: the create button is the same action, translated',
  (await page.evaluate(() => window.__createBtn()))?.text === 'New Task',
  JSON.stringify((await page.evaluate(() => window.__createBtn()))?.text)
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
// P3 任务中心：向导分步挂载——第一步（基本信息）读名称/描述，再切「任务内容」
// 读提示词/变量，切「触发与批量」读调度。各步条件渲染，不能一屏全读。
const basicsForm = await formOf()
check('editor: the name is prefilled', nameValue(basicsForm) === '每日工作日报', String(nameValue(basicsForm)))
check('editor: the description is prefilled', (descValue(basicsForm) ?? '').includes('下班前'), String(descValue(basicsForm)))
// P3 任务中心：提示词在「任务内容」步（基本信息是第一步）——切过去再读。
await page.getByText('任务内容', { exact: true }).click()
await page.waitForTimeout(250)
const daily = await formOf()
check('editor: the prompt is prefilled', daily.textareas.some((t) => t.includes('生成今天的工作日报')), daily.textareas.map((t) => t.slice(0, 24)).join(' | '))
// The time field is antd's TimePicker since 2026-09-23 (the native input's
// accent-blue segment highlight was unstyleable), so the pin is the VALUE,
// not the input type — the picker's inner input is a text one.
await page.getByText('触发与批量', { exact: true }).click()
await page.waitForTimeout(250)
const dailyTrigger = await formOf()
check('editor: the schedule came with the template', dailyTrigger.switchOn && dailyTrigger.inputs.some((i) => i.value === '18:00'), JSON.stringify(dailyTrigger.inputs.filter((i) => i.value === '18:00')))
check('editor: it is the create-new flow, not an edit', daily.text.includes('新建任务') && !daily.text.includes('编辑任务'), daily.text.split('\n').slice(0, 3).join(' / '))
await page.screenshot({ path: join(SHOTS, 'editor-daily.png') })

await page.evaluate(() => window.__mountEditor({ templateId: 'meeting-notes' }))
await page.waitForSelector('textarea')
// P3（2026-11-08 迁步）：变量编辑在「基本信息」步、prompt 在「任务内容」步
// ——先读基本信息，再切过去读提示词。
const meetingBasics = await formOf()
check('editor: its variable is carried into the form', meetingBasics.inputs.some((i) => i.placeholder === '变量名' && i.value === 'notes'), JSON.stringify(meetingBasics.inputs.filter((i) => i.placeholder === '变量名').map((i) => i.value)))
check('editor: the label is localized, not the raw key', meetingBasics.inputs.some((i) => i.placeholder === '显示名' && i.value.includes('会议记录')), JSON.stringify(meetingBasics.inputs.filter((i) => i.placeholder === '显示名').map((i) => i.value)))
await page.getByText('任务内容', { exact: true }).click()
await page.waitForTimeout(250)
const meeting = await formOf()
check('editor: the prompt keeps its {{notes}} placeholder', meeting.textareas.some((t) => t.includes('{{notes}}')))

await page.evaluate(() => window.__mountEditor({ templateId: 'not-a-template' }))
await page.waitForSelector('textarea')
const unknown = await formOf()
check('editor: an unknown template id falls back to the plain empty form', nameValue(unknown) === '', `name "${nameValue(unknown)}"`)
await page.getByText('触发与批量', { exact: true }).click()
await page.waitForTimeout(250)
const unknownTrigger = await formOf()
check('editor: …and no schedule rows', unknownTrigger.switchOn === false)

await page.evaluate(() => window.__mountEditor({ templateId: 'weekly-report', locale: 'en' }))
await page.waitForSelector('textarea')
// P3（en locale）：名称在基本信息步，prompt 在「Task content」步。
const enBasics = await formOf()
check('editor EN: the template arrives translated', nameValue(enBasics) === 'Weekly report', String(nameValue(enBasics)))
await page.getByText('Task content', { exact: true }).click()
await page.waitForTimeout(250)
const enForm = await formOf()
check('editor EN: the prompt arrives translated', enForm.textareas.some((t) => t.includes('this week’s report')), enForm.textareas.map((t) => t.slice(0, 24)).join(' | '))

// ── 12 · the run context: workspace / approval / model + prompt variables ──
// The three optional pickers state the conversation-default behavior in their
// placeholders; 插入变量 really inserts into the textarea; a save carries the
// whole run context through routineCreate; an edited routine's stored values
// come back as stored, a deleted model included (marked, not the bare id).
//
// Only one menu is open at a time, but the PREVIOUS dropdown spends ~200ms in
// its close motion before it earns `ant-select-dropdown-hidden` (measured: a
// count taken immediately after the click saw 5+3 options). The wait is what
// scopes options to THIS menu — exactly one open dropdown with real options.
const openListSelector = async (field) => {
  await page.locator(`[data-routine-field="${field}"] .ant-select`).click()
  await page.waitForFunction(() => {
    const open = document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
    return open.length === 1 && open[0].querySelectorAll('.ant-select-item-option').length > 0
  })
  return '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option'
}
// A select trigger shows EITHER the selected label (as the .ant-select-content
// box's title attribute, or the value element for styled options) OR the
// placeholder element — never both.
const runContextForm = () => page.evaluate(() => {
  const readSelect = (root) => {
    if (!root) return { value: null, placeholder: null }
    const titled = root.querySelector('.ant-select-content[title]')
    if (titled) return { value: titled.getAttribute('title'), placeholder: null }
    const valued = root.querySelector('.ant-select-content-value')
    if (valued) return { value: valued.textContent, placeholder: null }
    const ph = root.querySelector('.ant-select-placeholder')
    return { value: null, placeholder: ph ? ph.textContent : null }
  }
  return {
    workspace: document.querySelector('[data-routine-field="workspace"] input')?.value ?? null,
    approval: readSelect(document.querySelector('[data-routine-field="approval"] .ant-select')),
    model: readSelect(document.querySelector('[data-routine-field="model"] .ant-select')),
  }
})

await page.evaluate(() => {
  window.__profiles = [{ id: 'prof_a', name: 'GLM' }, { id: 'prof_b', name: 'DeepSeek' }]
  window.__activeProfileId = 'prof_a'
  window.__routines = null
  window.__runs = []
})
await page.evaluate(() => window.__mountEditor({}))
await page.getByText('运行设置', { exact: true }).click()
await page.waitForSelector('[data-routine-field="model"] .ant-select')
await page.waitForTimeout(300)
const fresh = await runContextForm()
check(
  'run context: a fresh form states the defaults in the placeholders',
  fresh.workspace !== null && fresh.approval.placeholder?.includes('按需确认') && fresh.model.placeholder?.includes('使用当前模型（GLM）'),
  JSON.stringify(fresh),
)
await page.screenshot({ path: join(SHOTS, 'editor-run-context.png') })

// P3 向导分步：插入变量在「任务内容」步——切过去点 prompt-head 的插入变量。
await page.getByText('任务内容', { exact: true }).click()
await page.waitForSelector('[data-routine-field="prompt-head"]')
const varSelector = await openListSelector('prompt-head')
check('run context: the variable menu offers exactly the five built-ins', (await page.locator(varSelector).count()) === 5, String(await page.locator(varSelector).count()))
await page.locator(varSelector, { hasText: '日期 {{date}}' }).click()
const promptAfterInsert = await page.evaluate(() => document.querySelectorAll('textarea')[0]?.value ?? '')
check('run context: picking a variable inserts its token into the prompt', promptAfterInsert.includes('{{date}}'), promptAfterInsert)

// 授权/模型/工作区在「运行设置」步——切回来继续。
await page.getByText('运行设置', { exact: true }).click()
await page.waitForSelector('[data-routine-field="model"] .ant-select')
const approvalSelector = await openListSelector('approval')
const approvalLabels = await page.locator(approvalSelector).allTextContents()
check('run context: 授权方式 offers exactly the three levels', approvalLabels.length === 3 && approvalLabels.some((l) => l.includes('全部允许')), approvalLabels.join(' | '))
await page.locator(approvalSelector, { hasText: '全部允许' }).click()

const modelSelector = await openListSelector('model')
const modelLabels = await page.locator(modelSelector).allTextContents()
check('run context: 模型 offers the profile list with the active marker', modelLabels.length === 2 && modelLabels[0].includes('（当前）'), modelLabels.join(' | '))
await page.locator(modelSelector, { hasText: 'DeepSeek' }).click()

// End to end: a save must carry the whole run context through routineCreate.
await page.locator('[data-routine-field="workspace"] input').fill('/tmp/pulse-runs')
// 名称在「基本信息」步——切回去填，再保存。
await page.getByText('基本信息', { exact: true }).click()
await page.waitForTimeout(200)
await page.locator('input[placeholder^="例如"]').fill('上下文任务')
await page.getByRole('button', { name: '保存' }).click()
await page.waitForTimeout(400)
const createCalls = await page.evaluate(() => window.__calls.filter((c) => c.method === 'routineCreate'))
const payload = createCalls.at(-1)?.args?.[0] ?? null
check(
  'run context: 保存 sends workspace + approval + model through routineCreate',
  createCalls.length === 1 && payload?.workspaceDir === '/tmp/pulse-runs' && payload?.approvalMode === 'auto' && payload?.profileId === 'prof_b',
  JSON.stringify(payload),
)

// The edit hop: stored values come back as stored — and a profile deleted
// after the save stays visible (marked), never as a bare id.
await page.evaluate(() => {
  window.__routines = [{
    id: 'r_ctx', name: '上下文任务', description: '', prompt: '检查 {{date}}', enabled: true,
    workspaceDir: '/tmp/pulse-runs', approvalMode: 'always-ask', profileId: 'prof_gone', params: [],
    createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
  }]
})
await page.evaluate(() => window.__mountEditor({ routineId: 'r_ctx' }))
await page.getByText('运行设置', { exact: true }).click()
await page.waitForSelector('[data-routine-field="model"] .ant-select')
await page.waitForTimeout(300)
const stored = await runContextForm()
check('run context: editing shows the stored workspace path', stored.workspace === '/tmp/pulse-runs', String(stored.workspace))
check('run context: editing shows the stored approval level', stored.approval.value === '始终询问', JSON.stringify(stored.approval))
check(
  'run context: a deleted model stays visible and marked, not the bare id',
  stored.model.value?.includes('prof_gone') === true && stored.model.value.includes('已删除'),
  JSON.stringify(stored.model),
)
check('run context: it is the edit flow, not a second create', (await texts()).includes('编辑任务'))

await page.evaluate(() => {
  window.__profiles = []
  window.__activeProfileId = ''
  window.__routines = null
})

// ── 13 · the run workspace: run/edit live IN each row, not in the list header ──
// The header's 立即运行/批量运行/编辑 acted on "the currently selected task",
// which read as acting on the whole list (user ruling 2026-09-22). They ride
// each row now — hover-revealed exactly like the run rows' delete — so the
// target is the row under the pointer, and running from a row also selects it
// (the middle pane must show the history the fresh run lands in).
await page.evaluate(() => {
  window.__routines = [
    { id: 'r_ws_batch', name: '工作台日报', description: '', prompt: 'p', enabled: true,
      params: [], batch: { csvPath: '/tmp/rows.csv', concurrency: 2 },
      createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' },
    { id: 'r_ws_week', name: '工作台周报', description: '', prompt: 'p', enabled: true, params: [],
      createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' },
    { id: 'r_ws_manual', name: '工作台手动', description: '', prompt: 'p', enabled: false,
      params: [{ key: 'notes', label: '记录', default: '' }],
      createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' },
  ]
  window.__runs = []
  window.__calls = []
})
await page.evaluate(() => window.__mountWorkspace({ routineId: 'r_ws_week' }))
await page.waitForSelector('.pane-row')
// 鼠标挪离行区：hover 依赖的 opacity 断言不能继承上一步点击的悬停位置。
await page.mouse.move(5, 5)
await page.waitForTimeout(200)

/** The left task column read from the live DOM: the header row, and each task
 *  row's icon buttons (antd icons carry aria-label) with their hover opacity. */
const wsState = () => page.evaluate(() => {
  const row = [...document.querySelectorAll('.pane-row')].find((r) => r.textContent.includes('工作台'))
  const col = row?.parentElement?.parentElement
  const header = col?.firstElementChild
  return {
    headerText: header?.textContent ?? '',
    headerIcons: header ? [...header.querySelectorAll('[aria-label]')].map((i) => i.getAttribute('aria-label')) : [],
    headerButtons: header ? header.querySelectorAll('button').length : -1,
    rows: col ? [...col.querySelectorAll('.pane-row')].map((r) => ({
      text: r.textContent,
      active: r.classList.contains('pane-row--active'),
      icons: [...r.querySelectorAll('button [aria-label]')].map((i) => i.getAttribute('aria-label')),
      opacity: getComputedStyle(r.querySelector('button') ?? r).opacity,
    })) : [],
  }
})

const ws = await wsState()
check('workspace: three task rows render', ws.rows.length === 3 && ws.rows.every((r) => r.text.includes('工作台')), JSON.stringify(ws.rows.map((r) => r.text)))
check('workspace: the list header carries only the back button', ws.headerButtons === 1 && ws.headerText.includes('日常任务') && ws.headerIcons.join(',') === 'arrow-left', `buttons=${ws.headerButtons}, icons=${ws.headerIcons.join(',')}`)
check('workspace: every row carries its own run + edit actions', ws.rows.every((r) => r.icons.includes('play-circle') && r.icons.includes('edit')), JSON.stringify(ws.rows.map((r) => r.icons)))
check('workspace: only the batch task row also carries 批量运行', ws.rows[0].icons.includes('database') && ws.rows.slice(1).every((r) => !r.icons.includes('database')), JSON.stringify(ws.rows.map((r) => r.icons)))
check('workspace: row actions stay hidden until hover', ws.rows.every((r) => r.opacity === '0'), JSON.stringify(ws.rows.map((r) => r.opacity)))

// A real mouse hover reveals them; leaving hides them again.
const rowWeek = page.locator('.pane-row', { hasText: '工作台周报' })
await rowWeek.hover()
await page.waitForTimeout(200)
const hoveredOpacity = await rowWeek.evaluate((r) => getComputedStyle(r.querySelector('button')).opacity)
check('workspace: hover reveals the row actions', hoveredOpacity === '1', String(hoveredOpacity))
const rowBatch = page.locator('.pane-row', { hasText: '工作台日报' })
await rowBatch.hover()
await page.waitForTimeout(200)
check('workspace: the reveal follows the pointer to another row', (await wsState()).rows.find((r) => r.text.includes('工作台周报'))?.opacity === '0')
await page.screenshot({ path: join(SHOTS, 'workspace-rows.png') })

// The row body still selects without running anything.
await rowBatch.click({ position: { x: 12, y: 10 } })
await page.waitForTimeout(150)
let after = await wsState()
check('workspace: the row body selects its task', after.rows.find((r) => r.text.includes('工作台日报'))?.active === true && !after.rows.find((r) => r.text.includes('工作台周报'))?.active, JSON.stringify(after.rows.map((r) => ({ t: r.text.slice(0, 6), a: r.active }))))
check('workspace: selecting ran nothing', (await page.evaluate(() => window.__calls.filter((c) => c.method === 'routineRun'))).length === 0)

// The row's run button runs THAT row (the selected task beforehand was 日报).
await rowWeek.hover()
await rowWeek.locator('button').first().click()
await page.waitForTimeout(200)
const runCalls = await page.evaluate(() => window.__calls.filter((c) => c.method === 'routineRun'))
after = await wsState()
check('workspace: a row run button runs THAT row', runCalls.length === 1 && runCalls[0].args[0] === 'r_ws_week', JSON.stringify(runCalls.map((c) => c.args)))
check('workspace: running from a row also selects it', after.rows.find((r) => r.text.includes('工作台周报'))?.active === true, JSON.stringify(after.rows.map((r) => ({ t: r.text.slice(0, 6), a: r.active }))))

// The batch row's 批量运行 opens the batch dialog for that row. (.ant-modal-root
// is permanently zero-box — mask and wrap are position:fixed — so visibility
// is read on the wrap, the full-viewport layer that actually carries a box.)
await rowBatch.hover()
await rowBatch.locator('button').nth(1).click()
await page.waitForSelector('.ant-modal-wrap', { state: 'visible' })
const batchModalText = await page.evaluate(() => document.querySelector('.ant-modal')?.textContent ?? '')
check('workspace: the batch row opens the batch dialog', batchModalText.includes('批量'), batchModalText.slice(0, 80))
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// The row's edit button edits THAT row — the navigation names the routine.
// (The harness renders RoutineCenter bare, so AppLayout's editor swap never
// mounts here; the store view is the observable hand-off.)
const rowManual = page.locator('.pane-row', { hasText: '工作台手动' })
await rowManual.hover()
await rowManual.locator('button').last().click()
await page.waitForTimeout(300)
const editView = await viewOf()
check(
  'workspace: a row edit button edits THAT row',
  editView?.routineId === 'r_ws_manual' && editView?.routineEditing === true,
  JSON.stringify(editView),
)

// ── 混排卡片的契约：两类任务同一壳、同两颗标签封顶、开关只在有定时计划时出现 ──
// 用户裁定（2026-11-09）：「对话式任务和工作流任务的卡片样式要统一，标签就保留
// 两个：执行计划（手动执行 / 下次执行时间）和批量数据；设定了定时执行计划时才
// 展示开关。」细粒度（plan 文案四种组合、长内容不撑宽、真点击换态）由
// probe-task-card-pills.mjs 钉住；这里钉的是「两类卡片落在同一个网格里、标签
// 与开关走同一套判定」——分头实现两次必然漂移的那一面。
const WORKFLOWS = [
  { id: 'w_sched', name: '每周行业动态', description: '每周一汇总', entry: 'n1',
    nodes: [{ id: 'n1', title: '检索', prompt: '检索', verdicts: ['pass'] }],
    edges: [{ from: 'n1', when: 'pass', to: 'DONE' }], schedule: { cron: '30 7 * * 1' } },
  { id: 'w_off', name: '已停用的流水线', description: '关掉了', entry: 'n1',
    nodes: [{ id: 'n1', title: '检索', prompt: '检索', verdicts: ['pass'] }],
    edges: [{ from: 'n1', when: 'pass', to: 'DONE' }], schedule: { cron: '0 6 * * *' }, enabled: false },
  { id: 'w_manual', name: '按表发信流水线', description: '无定时但有批量', entry: 'n1',
    nodes: [{ id: 'n1', title: '检索', prompt: '检索', verdicts: ['pass'] }],
    edges: [{ from: 'n1', when: 'pass', to: 'DONE' }], batch: { csvPath: '/tmp/rows.csv' } },
]
await page.evaluate((wfs) => window.__mount({ workflows: wfs }), WORKFLOWS)
await page.waitForSelector('.routine-card')
await page.waitForTimeout(250)
const cardFacts = () => page.evaluate(() => [...document.querySelectorAll('.routine-card')].map((card) => {
  const sw = card.querySelector('.ant-switch')
  return {
    name: (card.querySelector('span')?.textContent ?? '').trim(),
    pills: [...card.querySelectorAll('[data-pill]')].map((p) => ({ kind: p.dataset.pill, cls: p.className, text: p.textContent.trim() })),
    hasSwitch: !!sw,
    checked: !!sw && sw.classList.contains('ant-switch-checked'),
  }
}))
const facts = await cardFacts()
const factOf = (name) => facts.find((f) => f.name === name)
const planText = (name) => factOf(name)?.pills.find((p) => p.kind === 'plan')?.text ?? ''

check('两类任务落在同一个网格里（3 对话式 + 3 工作流）', facts.length === 6, `${facts.length} cards`)
check('每张卡都有且只有一颗「执行计划」标签（两类同形）',
  facts.every((f) => f.pills.filter((p) => p.kind === 'plan').length === 1 && f.pills[0].cls.includes('routine-pill')),
  JSON.stringify(facts.map((f) => f.pills.map((p) => p.kind))))
check('「批量数据」只出现在配了 CSV 的工作流卡上',
  facts.every((f) => f.pills.some((p) => p.kind === 'batch') === (f.name === '按表发信流水线')),
  JSON.stringify(facts.filter((f) => f.pills.length > 1).map((f) => f.name)))
check('工作流的定时计划与对话式同样翻成「下次运行：…」',
  planText('每周行业动态').startsWith('下次运行：') && planText('每日工作日报').startsWith('下次运行：'),
  `${planText('每周行业动态')} / ${planText('每日工作日报')}`)
check('没有定时计划的工作流与对话式同样说「手动执行」',
  planText('按表发信流水线') === '手动执行' && planText('会议纪要整理') === '手动执行',
  `${planText('按表发信流水线')} / ${planText('会议纪要整理')}`)
check('开关只属于有定时计划的卡：每周/已停用/日报/周报 + 无定时的会议纪要、发信流水线',
  facts.filter((f) => f.hasSwitch).map((f) => f.name).sort().join(',') ===
    ['已停用的流水线', '每周工作周报', '每周行业动态', '每日工作日报'].sort().join(','),
  facts.filter((f) => f.hasSwitch).map((f) => f.name).join(', '))
check('开关的态 = 启用位（工作流 enabled 缺席视为启用）',
  factOf('每周行业动态')?.checked === true && factOf('已停用的流水线')?.checked === false,
  `${factOf('每周行业动态')?.checked} / ${factOf('已停用的流水线')?.checked}`)

// 真点击：工作流开关走 PIPELINE_WORKFLOWS 的 toggle op，且列表重拉后卡片真的换态。
await page.evaluate(() => { window.__calls.length = 0 })
await page.locator('.routine-card', { hasText: '每周行业动态' }).locator('.ant-switch').click()
await page.waitForTimeout(400)
const wfToggleCalls = await page.evaluate(() => window.__calls.filter((c) => c.method === 'pipelineWorkflows' && c.args[0] === 'toggle').map((c) => c.args[1]))
const afterToggle = (await cardFacts()).find((f) => f.name === '每周行业动态')
check('工作流开关 → pipelineWorkflows(toggle, {id, enabled:false})',
  wfToggleCalls.length === 1 && wfToggleCalls[0].id === 'w_sched' && wfToggleCalls[0].enabled === false,
  JSON.stringify(wfToggleCalls))
check('…关掉后卡片翻成「手动执行」且开关为关（重拉生效，不是本地态）',
  afterToggle?.checked === false && afterToggle?.pills.find((p) => p.kind === 'plan')?.text === '手动执行',
  JSON.stringify(afterToggle))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed · shots in ${SHOTS}`)
process.exit(failed.length === 0 ? 0 : 1)
