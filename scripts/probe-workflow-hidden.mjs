/**
 * Workflow-hidden probe (real Chromium) — 0.5.1 的展示门真的把工作流藏起来了吗。
 *
 * 用户 2026-11-09：「想尽快发 0.5.1，但是感觉工作流离可用还差很多，能先隐藏吗」。
 * 源码扫描（tests/workflow-hidden.test.ts）能证明条件门写在哪儿，却证明不了这些
 * 门在这台机器上真的挡住了东西——卡片是 .map 出来的、单选项是 options 数组拼出来
 * 的、时间线是一条 for 循环，全都可以「看起来有门」而实际照旧渲染。
 *
 * 这里故意 **不** 像另外三个工作流探针那样把常量 alias 成 true：那一侧要证明
 * 「翻转开关后功能没坏」，这一侧要证明「不翻转就看不见」。三个镜头：
 *
 *   §1 任务中心：只渲染对话式任务的卡片；workflow 列表与 pipeline 运行 feed
 *      一次都不请求（不拉才不会渲染，也不会在时间线上留可点开的尾巴）。
 *   §2 新建向导：类型单选组只剩「对话式任务」一项，默认选中它。
 *   §3 反面对照：直接挂 workflow 编辑翼时两个选项都还在且置灰——编辑态「看得到、
 *      点不动」是 2026-11-09 的独立裁定，隐藏不能把它一起删掉。
 *
 * Usage: node scripts/probe-workflow-hidden.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-workflow-hidden-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-workflow-hidden-shots')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import RoutineCenter from './src/renderer/src/components/routine/RoutineCenter'
import TaskWizardPage from './src/renderer/src/components/routine/TaskWizardPage'
// 两页都迁到主题表（PLAN-dark-mode M3/T2）上了，变量表必须先在：缺它时 var()
// 解析成空、卡片描边/标签颜色回落到 UA 默认。Light 显式钉住。
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { useNavigationStore } from './src/renderer/src/stores/navigationStore'

installThemeVars()
applyThemeAttr('light')

const ROUTINES = [
  { id: 'r_one', name: '每日工作日报', description: '汇总当天进展', prompt: '日报', enabled: true },
  { id: 'r_two', name: '每周行业动态', description: '每周一汇总', prompt: '汇总', enabled: true, schedule: { cron: '30 7 * * 1' } },
]

const WORKFLOWS = [
  { id: 'wf_one', name: '按表发信流水线', description: 'CSV 逐行', entry: 'n1',
    nodes: [{ id: 'n1', title: '发信', prompt: '发信', verdicts: ['pass'] }],
    edges: [{ from: 'n1', when: 'pass', to: 'DONE' }] },
  { id: 'wf_two', name: '定时研究', description: '每周汇总', entry: 'n1',
    nodes: [{ id: 'n1', title: '检索', prompt: '检索', verdicts: ['pass'] }],
    edges: [{ from: 'n1', when: 'pass', to: 'DONE' }], schedule: { cron: '0 6 * * *' } },
]

const EMPTY_LISTS = ['expertList', 'projectList', 'listConversations', 'knowledgeListFiles',
  'knowledgeListBases', 'toolList', 'skillList', 'recallMemories', 'routineCsvPreview']

window.__calls = []
window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {}
    window.__calls.push({ method: String(key), args })
    // 每次返回新引用（真 IPC 过结构化克隆）：回同一个数组会让 reload 的
    // setState 撞 Object.is 被 React 跳过。
    if (key === 'routineList') return Promise.resolve((window.__routines ?? ROUTINES).map((r) => ({ ...r })))
    if (key === 'routineGet') return Promise.resolve((window.__routines ?? ROUTINES).find((r) => r.id === args[0]) ?? null)
    if (key === 'routineRuns') return Promise.resolve([])
    if (key === 'routineCreate' || key === 'routineUpdate') {
      const input = args[key === 'routineCreate' ? 0 : 1] ?? {}
      return Promise.resolve({ id: 'r_stub', ...input, createdAt: '', updatedAt: '' })
    }
    if (key === 'pipelineWorkflows') {
      if (args[0] === 'list') return Promise.resolve((window.__workflows ?? WORKFLOWS).map((w) => ({ ...w })))
      if (args[0] === 'get') return Promise.resolve((window.__workflows ?? WORKFLOWS).find((w) => w.id === args[1]) ?? null)
      return Promise.resolve(undefined)
    }
    if (key === 'pipelineRuns') return Promise.resolve({ runs: [], stages: [] })
    if (key === 'shareImportPreview') return Promise.resolve({ canceled: true })
    if (key === 'shareImportCommit') return Promise.resolve({ imported: 0, overwritten: 0, skipped: 0, failed: 0, errors: [] })
    if (EMPTY_LISTS.includes(String(key))) return Promise.resolve([])
    if (key === 'getSettings') {
      return Promise.resolve({ activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '',
        yourName: '', workspaceDir: '', autoCleanup: false, locale: 'zh' })
    }
    // 助手栏会挂 useHostedAgentSession：null 快照 = 冷态，不需要真引擎。
    if (key === 'agentSessionSnapshot') return Promise.resolve(null)
    if (key === 'agentSessionCreate') return Promise.resolve({ sessionId: '', agentId: '' })
    if (key === 'hydrateConversation') return Promise.resolve({ messages: [] })
    return Promise.resolve(undefined)
  },
})

let root = null
function mount(node) {
  if (root) root.unmount()
  window.__calls = []
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider initialLocale="zh">
            <div id="view" style={{ width: 1100, height: 900 }}>{node}</div>
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>,
  )
}

window.__mountCenter = () => {
  useNavigationStore.getState().navigate({ kind: 'routines' })
  mount(<RoutineCenter />)
}

window.__mountWizard = ({ kind = 'routine', workflowId = null, routineId = null } = {}) => {
  useNavigationStore.getState().navigate({ kind: 'routines' })
  mount(
    <TaskWizardPage
      kind={kind}
      {...(workflowId ? { workflowId } : {})}
      {...(routineId ? { routineId } : {})}
    />,
  )
}

/** 首屏卡片：名称 + 胶囊（按 data-pill 取值）。 */
window.__cards = () => [...document.querySelectorAll('.routine-card')].map((c) => ({
  name: (c.querySelector('span')?.textContent ?? '').trim(),
  pills: [...c.querySelectorAll('.routine-pill')].map((p) => p.getAttribute('data-pill')),
}))

/** 类型单选组：标签、选项、选中项、是否置灰。 */
window.__kindRow = () => {
  const block = document.querySelector('[data-pm-task-kind]')
  const wrappers = [...document.querySelectorAll('.ant-radio-group .ant-radio-wrapper')]
  const inputs = [...document.querySelectorAll('.ant-radio-group input[type=radio]')]
  return {
    anchor: !!block,
    radios: inputs.length,
    radioLabels: wrappers.map((w) => (w.textContent || '').trim()),
    disabled: inputs.map((i) => i.disabled),
    checkedLabel: (() => {
      const i = inputs.findIndex((x) => x.checked)
      return i >= 0 ? (wrappers[i]?.textContent || '').trim() : null
    })(),
    text: block ? (block.textContent || '').trim() : null,
  }
}

window.__apiCalls = (method) => window.__calls.filter((c) => c.method === method)

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
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text', '.png': 'dataurl' },
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const headed = process.argv.includes('--headed')
mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch({ headless: !headed })
const page = await browser.newPage({ viewport: { width: 1280, height: 950 }, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
await page.setContent('<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready === true)

// ── §1 任务中心：只有对话式任务的卡片，workflow 的数据源一次都不碰 ──
console.log('\n§1 · 任务中心：工作流卡片整族不出现')
await page.evaluate(() => window.__mountCenter())
await page.waitForSelector('.routine-card')
await page.waitForTimeout(400)
const center = await page.evaluate(() => ({
  cards: window.__cards(),
  pipelineList: window.__apiCalls('pipelineWorkflows').length,
  pipelineRuns: window.__apiCalls('pipelineRuns').length,
  createBtn: !!document.querySelector('[data-action="share-import"]'),
}))
check('卡片只有对话式任务那两张', center.cards.length === 2, center.cards.map((c) => c.name).join(' / '))
check('没有任何一张来自 workflow 定义', !center.cards.some((c) => ['按表发信流水线', '定时研究'].includes(c.name)))
check('workflow 列表一次都没请求（不拉 = 不渲染）', center.pipelineList === 0, `calls=${center.pipelineList}`)
check('运行时间线不拉 pipeline feed（隐藏功能不留可点开的尾巴）', center.pipelineRuns === 0, `calls=${center.pipelineRuns}`)
check('导入分享入口还在（routine 分享照常可用）', center.createBtn)
await page.screenshot({ path: join(SHOTS, 'hidden-center.png') })

// ── §2 新建向导：类型单选组只剩「对话式任务」 ──
console.log('\n§2 · 新建任务：类型选项只剩对话式任务')
await page.evaluate(() => window.__mountWizard({ kind: 'routine' }))
await page.waitForSelector('[data-pm-task-kind]')
await page.waitForTimeout(300)
const createRow = await page.evaluate(() => window.__kindRow())
check('类型行照常渲染（不是把整行藏掉）', createRow.anchor)
check('只剩一个选项', createRow.radios === 1, `radios=${createRow.radios}`)
check('选项文案就是「对话式任务」', createRow.radioLabels.join(',') === '对话式任务', createRow.radioLabels.join(','))
check('默认选中它', createRow.checkedLabel === '对话式任务', String(createRow.checkedLabel))
check('「工作流」这个词没有出现在类型行里', !String(createRow.text).includes('工作流'), String(createRow.text))
await page.screenshot({ path: join(SHOTS, 'hidden-wizard-create.png') })

// ── §3 反面对照：直接挂 workflow 编辑翼时，类型行仍要显示真实类型（置灰） ──
console.log('\n§3 · 反面对照：workflow 编辑态的类型行（隐藏不能删掉它）')
await page.evaluate(() => window.__mountWizard({ kind: 'workflow', workflowId: 'wf_one' }))
await page.waitForSelector('[data-pm-task-kind]')
await page.waitForTimeout(300)
const editRow = await page.evaluate(() => window.__kindRow())
check('两个选项都在（这个翼本身就是被隐藏的入口，渲染契约不变）', editRow.radios === 2, `radios=${editRow.radios}`)
check('两项都置灰（编辑态看得到、点不动）', editRow.disabled.every(Boolean), JSON.stringify(editRow.disabled))
check('选中项是「工作流」（显示这条任务真实的类型）', editRow.checkedLabel === '工作流', String(editRow.checkedLabel))
await page.screenshot({ path: join(SHOTS, 'hidden-wizard-edit.png') })

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`screenshots: ${SHOTS}`)
if (failed.length) process.exit(1)
