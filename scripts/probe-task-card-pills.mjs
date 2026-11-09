/**
 * Task-card contract probe (real Chromium).
 *
 * 用户的裁定（2026-11-09）：「对话式任务和工作流任务的卡片样式要统一，任务的
 * 标签就保留两个，一个是执行计划（手动执行 / 下次执行时间），另一个有批量数据
 * 的依然展示批量数据标签，其它就不用展示了。当设定了定时执行计划时，才展示
 * 开关。」
 *
 * 三条都是「渲染后长什么样」的事实，其它层看不到：vitest 是 node 环境（无布局
 * 引擎、不挂载组件），源码里 `{card.scheduled && <Switch/>}` 与 `{cond && <span/>}`
 * 读起来和写死一颗一样；混排网格里「这一卡有几颗胶囊」更是只有真 DOM 知道。
 * 本探针钉住：
 *
 *   - 胶囊只有两种：每张卡恰好一颗 data-pill="plan"（执行计划），配了 CSV 的
 *     卡另有 data-pill="batch"（批量数据）；参数（变量）列表、定时 tag、最近
 *     运行一律不再出现在卡片上——胶囊总数 ≤ 2 是硬上限
 *   - plan 文案：有效 cron 且启用 → 「下次运行：<时刻>」；停用或没有定时 →
 *     「手动执行」（停用由开关自身表达，不占第二个标签）
 *   - 开关只在设定了有效定时计划的卡上出现，且态与 enabled 一致；点它走的是
 *     各自动作（routineToggle / pipelineWorkflows('toggle')），不误开运行历史
 *   - 两类卡片的胶囊同壳同形（同一个 className、同一颗 span），长变量名/长描述
 *     不再把卡片撑出横向滚动（旧「参数胶囊」超宽的回归面，胶囊删除后由描述截断
 *     接管——负对照放开截断必须重新溢出，证明度量本身有效）
 *
 * Usage: node scripts/probe-task-card-pills.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-task-card-pills-')), 'harness.js')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import RoutineCenter from './src/renderer/src/components/routine/RoutineCenter'

installThemeVars()
applyThemeAttr('light')

// 对话式任务：定时+启用 / 定时+停用 / 无定时 / 有批量数据 / 长名字长描述。
// 旧的参数（变量）胶囊已撤，长 key 留着当「不再渲染成胶囊」的反证。
const LONG_KEY = 'submitButtonXPathSelectorForTheLoginForm'
const ROUTINES = [
  { id: 'r_sched_on', name: '定时日报', description: '下班前整理今天的完成情况', prompt: '整理日报',
    enabled: true, schedule: { cron: '0 18 * * *' }, params: [] },
  { id: 'r_sched_off', name: '停用的巡检', description: '检查未读邮件并汇总', prompt: '检查邮件',
    enabled: false, schedule: { cron: '0 9 * * *' }, params: [] },
  { id: 'r_manual', name: '手动整理', description: '把会议记录整理成纪要', prompt: '整理纪要',
    enabled: true, params: [{ key: 'notes', label: '会议记录', default: '' }] },
  { id: 'r_batch', name: '批量发信', description: '按 CSV 逐行发送', prompt: '发信',
    enabled: true, batch: { csvPath: '/tmp/recipients.csv' } },
  { id: 'r_long', name: '长名字的任务，名字本身很长很长很长很长很长很长很长很长',
    description: '这是一段很长的描述文字，用来验证描述行会在两行处截断并且不会把卡片撑宽，' + 'x'.repeat(160),
    prompt: '长任务', enabled: true,
    params: ['收件人', '抄送', '主题', LONG_KEY, 'page', 'retryCount'].map((k) => ({ key: k, label: k, required: false })) },
]

// 工作流：定时（enabled 缺席 = 启用）/ 定时+停用 / 无定时但有批量数据。
const WORKFLOWS = [
  { id: 'w_sched', name: '定时研究', description: '每周一汇总行业动态', entry: 'n1',
    nodes: [{ id: 'n1', title: '检索', prompt: '检索', verdicts: ['pass'] }],
    edges: [{ from: 'n1', when: 'pass', to: 'DONE' }],
    schedule: { cron: '30 7 * * 1' } },
  { id: 'w_off', name: '停用的流水线', description: '已经关掉的流水线', entry: 'n1',
    nodes: [{ id: 'n1', title: '检索', prompt: '检索', verdicts: ['pass'] }],
    edges: [{ from: 'n1', when: 'pass', to: 'DONE' }],
    schedule: { cron: '0 6 * * *' }, enabled: false },
  { id: 'w_manual', name: '手动流水线', description: '按表格逐行跑', entry: 'n1',
    nodes: [{ id: 'n1', title: '检索', prompt: '检索', verdicts: ['pass'] }],
    edges: [{ from: 'n1', when: 'pass', to: 'DONE' }],
    batch: { csvPath: '/tmp/rows.csv' } },
]

window.__calls = []
window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {}
    window.__calls.push({ method: String(key), args })
    if (key === 'routineList') return Promise.resolve(ROUTINES.map((r) => ({ ...r })))
    if (key === 'routineRuns') return Promise.resolve([])
    if (key === 'pipelineWorkflows') {
      // 只有 list 与 toggle 有真答案：toggle 写回定义本身，让卡片重拉后真的
      // 换态（否则测的只是「点了」，不是「点了有用」）。
      if (args[0] === 'list') return Promise.resolve(WORKFLOWS.map((w) => ({ ...w })))
      if (args[0] === 'toggle') {
        const { id, enabled } = args[1] ?? {}
        const wf = WORKFLOWS.find((w) => w.id === id)
        if (wf) wf.enabled = enabled
        return Promise.resolve(wf ? { ...wf } : null)
      }
      return Promise.resolve(undefined)
    }
    if (key === 'routineToggle') {
      const r = ROUTINES.find((x) => x.id === args[0])
      if (r) r.enabled = !!args[1]
      return Promise.resolve(r ?? null)
    }
    if (key === 'getSettings') {
      return Promise.resolve({ activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '',
        yourName: '', workspaceDir: '', autoCleanup: false, locale: 'zh' })
    }
    return Promise.resolve(undefined)
  },
})

/** 每张卡片的契约面：名称、胶囊清单、开关态、描述是否被截断。 */
window.__cards = () => {
  const cards = [...document.querySelectorAll('.routine-card')]
  return cards.map((card) => {
    const desc = card.querySelector('[data-routine-desc]')
    const sw = card.querySelector('.ant-switch')
    const cardRight = card.getBoundingClientRect().right
    return {
      name: (card.querySelector('span')?.textContent ?? '').trim(),
      pills: [...card.querySelectorAll('.routine-pill')].map((p) => ({
        kind: p.getAttribute('data-pill'),
        tag: p.tagName,
        cls: p.className,
        text: p.textContent.trim(),
      })),
      hasSwitch: !!sw,
      switchChecked: !!sw && sw.classList.contains('ant-switch-checked'),
      descText: desc ? desc.textContent : null,
      descClipped: desc ? desc.scrollHeight > desc.clientHeight + 1 || desc.scrollWidth > desc.clientWidth + 1 : null,
      pillOverflow: [...card.querySelectorAll('.routine-pill')]
        .map((p) => p.getBoundingClientRect().right - (cardRight - 16))
        .reduce((a, b) => Math.max(a, b), 0),
    }
  })
}

/** The nearest scroller above the cards — the tasks column (overflow-y auto). */
window.__scroller = () => {
  const card = document.querySelector('.routine-card')
  let el = card?.parentElement
  while (el) {
    const ox = getComputedStyle(el).overflowX
    if (ox === 'auto' || ox === 'scroll') return el
    el = el.parentElement
  }
  return document.documentElement
}

window.__overflow = () => {
  const s = window.__scroller()
  return s.scrollWidth - s.clientWidth
}

/** 负对照：放开描述行的截断（inline 样式只能用 !important 盖住），
 *  与「源码里删掉 lineClamp/overflow」等价。 */
window.__override = (css) => {
  let el = document.getElementById('probe-override')
  if (css === null) { el?.remove(); return }
  if (!el) { el = document.createElement('style'); el.id = 'probe-override'; document.head.appendChild(el) }
  el.textContent = css
}

window.__mount = () => {
  const host = document.createElement('div')
  host.id = 'case-cards'
  document.body.appendChild(host)
  createRoot(host).render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider>
            <div id="view" style={{ width: 1000, height: 900 }}><RoutineCenter /></div>
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>,
  )
}

const root = createRoot(document.getElementById('root'))
root.render(<div />)
window.__ready = true
`

/** 0.5.1 的展示门（WORKFLOW_TASKS_UI=false）把工作流卡片收起来了，但这张卡片与
 *  routine 共用同一个 TaskCard、那颗开关也必须仍然工作——探针在 bundle 期把该常量
 *  钉成 true。隐藏面本身由 tests/workflow-hidden.test.ts 钉。 */
const forceWorkflowUi = {
  name: 'force-workflow-ui',
  setup(b) {
    b.onResolve({ filter: /(^|\/)shared\/feature-flags$/ }, () => ({ path: 'pm-flags', namespace: 'pm-flags' }))
    b.onLoad({ filter: /.*/, namespace: 'pm-flags' }, () => ({ contents: 'export const WORKFLOW_TASKS_UI = true', loader: 'ts' }))
  },
}

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text', '.png': 'dataurl' },
  logLevel: 'warning', treeShaking: false,
  plugins: [forceWorkflowUi],
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
page.on('console', (msg) => { if (msg.type() === 'error') console.log('  [console.error]', msg.text().slice(0, 300)) })
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.evaluate(() => window.__mount())
await page.waitForSelector('.routine-card')
await page.waitForTimeout(300)

const cards = () => page.evaluate(() => window.__cards())
const byName = (list, name) => list.find((c) => c.name === name)
const planOf = (list, name) => byName(list, name)?.pills.find((p) => p.kind === 'plan')?.text ?? ''

console.log('\n§1 两种卡片同壳：每卡恰好一颗「执行计划」胶囊，批量数据只在配了 CSV 时出现')
const S = await cards()
console.log('  ', JSON.stringify(S.map((c) => ({ n: c.name.slice(0, 8), p: c.pills.map((x) => x.kind) }))))
check('八张卡都渲染（5 对话式 + 3 工作流）', S.length === 8, `${S.length} cards`)
check('每张卡恰好一颗执行计划胶囊（data-pill="plan"）',
  S.every((c) => c.pills.filter((p) => p.kind === 'plan').length === 1),
  JSON.stringify(S.map((c) => c.pills.map((p) => p.kind))))
check('胶囊总数不超过两颗（没有第三个标签的位置）', S.every((c) => c.pills.length <= 2),
  JSON.stringify(S.map((c) => c.pills.length)))
check('批量数据胶囊只出现在配了 CSV 的卡上',
  S.every((c) => c.pills.some((p) => p.kind === 'batch') === ['批量发信', '手动流水线'].includes(c.name)),
  S.filter((c) => c.pills.some((p) => p.kind === 'batch')).map((c) => c.name).join(', '))
check('变量列表不再渲染成胶囊（长参数名只留在描述/编辑里）',
  S.every((c) => !c.pills.some((p) => p.text.startsWith('变量') || p.text.includes('submitButton'))),
  JSON.stringify(S.map((c) => c.pills.map((p) => p.text.slice(0, 10)))))
check('两类卡片的胶囊同壳同形（同一个 routine-pill class + span）',
  S.every((c) => c.pills.every((p) => p.tag === 'SPAN' && p.cls.includes('routine-pill'))),
  JSON.stringify(S.flatMap((c) => c.pills.map((p) => p.tag + '.' + p.cls)).slice(0, 3)))

console.log('\n§2 执行计划文案：定时启用 → 下次运行时间；其余 → 手动执行')
check('对话式（定时+启用）展示下次运行时间', planOf(S, '定时日报').startsWith('下次运行：'), planOf(S, '定时日报'))
check('工作流（定时，enabled 缺席=启用）同样展示下次运行时间', planOf(S, '定时研究').startsWith('下次运行：'), planOf(S, '定时研究'))
check('停用的定时任务按「手动执行」——停用由开关表达，不占第二个标签',
  planOf(S, '停用的巡检') === '手动执行' && planOf(S, '停用的流水线') === '手动执行',
  `${planOf(S, '停用的巡检')} / ${planOf(S, '停用的流水线')}`)
check('没有定时计划的卡展示「手动执行」',
  planOf(S, '手动整理') === '手动执行' && planOf(S, '批量发信') === '手动执行' && planOf(S, '手动流水线') === '手动执行',
  `${planOf(S, '手动整理')} / ${planOf(S, '批量发信')} / ${planOf(S, '手动流水线')}`)

console.log('\n§3 开关只属于设定了定时计划的卡，且态 = enabled')
// 四张 = 两台启用中的定时卡 + 两台停用的定时卡。停用的仍要有开关，否则关掉
// 之后就再也没有重新打开它的入口——「没有定时计划」才是无开关的唯一理由。
check('只有四张定时卡有开关（停用的定时卡也在，否则无从重新打开）',
  S.filter((c) => c.hasSwitch).map((c) => c.name).sort().join(',') === '停用的巡检,停用的流水线,定时日报,定时研究',
  S.filter((c) => c.hasSwitch).map((c) => c.name).join(', '))
check('启用中的定时卡开关为开',
  byName(S, '定时日报')?.switchChecked === true && byName(S, '定时研究')?.switchChecked === true,
  `${byName(S, '定时日报')?.switchChecked} / ${byName(S, '定时研究')?.switchChecked}`)
check('停用的定时卡开关为关（仍然显示——它可被重新打开）', byName(S, '停用的巡检')?.switchChecked === false,
  String(byName(S, '停用的巡检')?.switchChecked))

console.log('\n§4 真点击开关：各走各的动作，不误开运行历史')
await page.evaluate(() => { window.__calls.length = 0 })
await page.locator('.routine-card', { hasText: '停用的巡检' }).locator('.ant-switch').click()
await page.waitForTimeout(400)
const afterRoutine = await page.evaluate(() => window.__calls.filter((c) => c.method === 'routineToggle').map((c) => c.args))
check('点对话式任务的开关 → routineToggle(id, true)',
  afterRoutine.length === 1 && afterRoutine[0][0] === 'r_sched_off' && afterRoutine[0][1] === true,
  JSON.stringify(afterRoutine))
const afterRoutineCards = await cards()
check('…开关随即变开（列表已重拉，不是只改了本地态）', byName(afterRoutineCards, '停用的巡检')?.switchChecked === true)
check('…卡片网格还在（没有误开运行历史）', (await page.locator('.routine-card').count()) === 8,
  `${await page.locator('.routine-card').count()} cards`)

await page.evaluate(() => { window.__calls.length = 0 })
await page.locator('.routine-card', { hasText: '定时研究' }).locator('.ant-switch').click()
await page.waitForTimeout(400)
const afterWf = await page.evaluate(() => window.__calls.filter((c) => c.method === 'pipelineWorkflows' && c.args[0] === 'toggle').map((c) => c.args[1]))
check('点工作流的开关 → pipelineWorkflows(toggle, {id, enabled:false})',
  afterWf.length === 1 && afterWf[0].id === 'w_sched' && afterWf[0].enabled === false, JSON.stringify(afterWf))
const afterWfCards = await cards()
check('…工作流卡片随即换态：手动执行 + 开关关',
  byName(afterWfCards, '定时研究')?.switchChecked === false &&
  planOf(afterWfCards, '定时研究') === '手动执行',
  JSON.stringify(byName(afterWfCards, '定时研究')))

console.log('\n§5 长内容不再撑破卡片（旧的参数胶囊回归面）')
const overflow0 = await page.evaluate(() => window.__overflow())
const L5 = await cards()
const longCard = L5.reduce((a, b) => (b.name.length > a.name.length ? b : a), L5[0])
check('页面无横向溢出（滚动容器 scrollWidth ≤ clientWidth）', overflow0 <= 0.5, `overflow=${overflow0}px`)
check('长描述在两行处截断（clamp 生效）', longCard?.descClipped === true, String(longCard?.descClipped))
check('胶囊不越过卡片右内边距线', L5.every((c) => c.pillOverflow <= 0.5),
  JSON.stringify(L5.map((c) => Math.round(c.pillOverflow))))

console.log('\n§6 非空性 — 放开描述截断后必须重新溢出（度量有效）')
await page.evaluate(() => window.__override(`
  [data-routine-desc] { -webkit-line-clamp: unset !important; display: block !important;
    overflow: visible !important; white-space: nowrap !important; }
`))
await page.waitForTimeout(150)
const overflowBad = await page.evaluate(() => window.__overflow())
check('[负对照] 描述不再截断 → 页面重新出现横向溢出', overflowBad > 0.5, `overflow=${overflowBad}px`)
await page.evaluate(() => window.__override(null))
await page.waitForTimeout(150)
const overflowHealed = await page.evaluate(() => window.__overflow())
check('[还原] 移除负对照后恢复无溢出', overflowHealed <= 0.5, `overflow=${overflowHealed}px`)

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length > 0 ? 1 : 0)
