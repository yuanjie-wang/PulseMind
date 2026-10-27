/**
 * Real-browser render of the capability center's three card grids (连接器 / 技能 /
 * 专家). A card's look cannot be reviewed from source, and jsdom has no layout
 * engine — so this probe mounts the *real* panels with fixture data, under the
 * *same* ConfigProvider the app uses, and asserts what "三者的卡片样式一致"
 * actually means: one head, one name size, one radius, one body padding, one grid
 * rhythm, one background, one action order.
 *
 * It exists because those three had drifted into two skeletons — the connector card
 * hand-rolled its header inside a headless Card while the other two used antd's own
 * head — and that drift was invisible to every other check in the repo.
 *
 * Usage: node scripts/probe-capability-cards.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Stable path so the printed screenshots are easy to reopen. */
const SHOTS = process.env.PM_SHOT_DIR ?? join(tmpdir(), 'pm-capability-card-shots')
mkdirSync(SHOTS, { recursive: true })

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** Inline harness (esbuild stdin) so this stays one file. It imports the production
 *  panels — a copy here would prove nothing about what ships. */
const HARNESS = `
// The capability family is migrated onto the theme sheet (PLAN-dark-mode
// M3/T3), so the page needs the variable table injected before the panels
// render — without it every var() resolves to nothing and the computed
// colours below fall back to the UA. Light is pinned explicitly; the dark
// column belongs to probe-theme-dark.mjs.
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'

installThemeVars()
applyThemeAttr('light')
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import CapabilityCenter from './src/renderer/src/components/capability/CapabilityCenter'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'

// ── Runtime stubs: the panels read settings and catalogs over electronAPI ──
const FIXTURES = {
  getSettings: () => ({ activeProfileId: '', profiles: [], theme: 'light', locale: 'zh', workspaceDir: '' }),
  mcpListServers: () => [
    { id: 's1', name: 'chrome-devtools', status: 'connected', tools: [{ name: 'a' }, { name: 'b' }],
      serverInfo: { version: '1.2.0' },
      config: { name: 'chrome-devtools', transportType: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] } },
    { id: 's2', name: 'amap', status: 'stopped', tools: [],
      config: { name: 'amap', transportType: 'streamable-http', url: 'https://mcp.amap.com/mcp?key=xxx' } },
    { id: 's3', name: 'broken-server', status: 'error', tools: [], error: 'spawn ENOENT: command not found',
      config: { name: 'broken-server', transportType: 'stdio', command: 'nope', args: [] } },
  ],
  listImportedSkills: () => [
    { name: 'tavily-search', description: '联网搜索能力' },
    { name: 'code-review', description: '按团队规范审查代码' },
  ],
  expertList: () => [
    { id: 'code-reviewer', name: '代码审查员', enabled: true, description: '按团队规范审查改动',
      skillNames: ['code-review'], mcpServerIds: ['s1'] },
    { id: 'researcher', name: '研究员', enabled: false, description: '检索并交叉验证资料',
      skillNames: [], mcpServerIds: [] },
    { id: 'writer', name: '技术写作者', enabled: true, basePrompt: '把复杂的东西讲清楚',
      skillNames: ['code-review', 'tavily-search'], mcpServerIds: [] },
  ],
}
// The mutations return the refreshed catalog, like the main process does.
FIXTURES.expertUpdate = FIXTURES.expertList
FIXTURES.expertDelete = FIXTURES.expertList
FIXTURES.expertReset = FIXTURES.expertList
// The skill card's click target is the three-pane browser, which reads the pack.
FIXTURES.listSkillFiles = () => ['SKILL.md', 'scripts/run.sh']
FIXTURES.readSkillFile = () => '# Skill\\n\\nfixture body'
// 经验分区（E1）：MemoryPagesBrowser 网格与三栏浏览器都从这里取数。p1 是
// SOP 态活页（金标 + scripts 树），p2 是被取代的旧页（半透明 + 旧版本标），
// p3 是 clue 态活页（固化按钮）。fixture 有状态：开关 IPC 真的改 enabled，
// 这样随后打开的浏览器能看到「已停用」标。
const EXPERIENCES = [
  { id: 'p1', title: '发布前跑通构建', type: 'experience', summary: null,
    body: '# 发布前跑通构建\\n\\n先跑完整 build 再打包。',
    aliases: ['发布检查'], links: [], supersededBy: null, sourceConversationId: 'conv1',
    files: [{ path: 'scripts/verify.mjs', content: 'console.log("ok")\\n' }],
    useCount: 3, lastUsedAt: null,
    createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    maturity: 'sop', recurrence: 1, lastReinforcedAt: null, sopAttempts: 0, sopLastAttemptAt: null, enabled: true },
  { id: 'p2', title: '旧版打包步骤', type: 'experience', summary: null,
    body: '旧内容', aliases: [], links: [], supersededBy: 'p1', sourceConversationId: 'conv0',
    files: null, useCount: 0, lastUsedAt: null,
    createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
    maturity: 'clue', recurrence: 0, lastReinforcedAt: null, sopAttempts: 0, sopLastAttemptAt: null, enabled: true },
  // clue 态活页：头部带固化按钮；summary（技能式 description）站在技能卡 description 的位置。
  { id: 'p3', title: '日报自动汇总', type: 'experience', summary: '每天早上汇总各群日报时用',
    body: '## 适用场景\\n每天早上。\\n## 步骤\\n1. 拉取各群消息。', aliases: ['日报'], links: [], supersededBy: null, sourceConversationId: 'conv3',
    files: null, useCount: 0, lastUsedAt: null,
    createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
    maturity: 'clue', recurrence: 0, lastReinforcedAt: null, sopAttempts: 0, sopLastAttemptAt: null, enabled: true },
  // 长标题 + 故意不带 enabled 字段（旧主进程的记录形状）：标题要出省略号且不被动作区
  // 遮住；开关要默认打开（只有显式 false 才算停用）。
  { id: 'p4', title: '把各个项目群的日报在每天早上九点前自动汇总成一份周报草稿并同步到知识库', type: 'experience', summary: '周报草稿的自动化流程',
    body: '## 适用场景\\n每周一。', aliases: [], links: [], supersededBy: null, sourceConversationId: 'conv4',
    files: null, useCount: 0, lastUsedAt: null,
    createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z',
    maturity: 'clue', recurrence: 0, lastReinforcedAt: null, sopAttempts: 0, sopLastAttemptAt: null },
]
FIXTURES.listMemoryPages = () => EXPERIENCES.map((p) => ({ ...p }))
// 技能使用计数（2026-10-27）：tavily 用过 5 次且有安装时间；内置技能用过 2 次（安装
// 时间由 UI 显示 --）；code-review 没有任何记录 → 使用 0 次 · 安装于 --。
FIXTURES.listSkillUses = () => ({
  'tavily-search': { useCount: 5, lastUsedAt: '2026-10-26T10:00:00.000Z', installedAt: '2026-10-20T08:00:00.000Z' },
  'builtin-skill': { useCount: 2, lastUsedAt: '2026-10-25T10:00:00.000Z', installedAt: '2026-10-01T08:00:00.000Z' },
})
window.__pageToggles = []
FIXTURES.setMemoryPageEnabled = (id, enabled) => {
  window.__pageToggles.push([id, enabled])
  const p = EXPERIENCES.find((x) => x.id === id)
  if (p) p.enabled = enabled
}
// Stubs receive the real call arguments (the toggle stub needs them; the rest ignore them).
window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => Promise.resolve((FIXTURES[key] ?? (() => undefined))(...args)),
})

const SKILLS = [
  { definition: { name: 'tavily-search', description: '联网搜索能力，用于获取实时信息，覆盖新闻与网页正文', category: 'engineering' }, enabled: true },
  { definition: { name: 'code-review', description: '按团队规范审查代码改动并给出可执行的修改建议', category: 'debugging' }, enabled: false },
  { definition: { name: 'builtin-skill', description: '内置技能示例，用于演示内置徽标', category: 'education', builtIn: true }, enabled: true },
]

const TOOLS = [
  { definition: { name: 'read_file', description: '读取文件内容', category: 'file', input_schema: { type: 'object', properties: {} }, instructions: 'Read a file by path. Returns text or bytes.' }, enabled: true },
  { definition: { name: 'write_file', description: '写入文件内容', category: 'file', input_schema: { type: 'object', properties: {} }, instructions: '' }, enabled: true },
  { definition: { name: 'run_terminal', description: '执行终端命令', category: 'system', input_schema: { type: 'object', properties: {} }, instructions: '' }, enabled: false },
  { definition: { name: 'memory_save', description: '保存长期记忆', category: 'memory', input_schema: { type: 'object', properties: {} }, instructions: '' }, enabled: true },
]

/** Each panel is a *real* CapabilityCenter pinned to one tab — not the bare panel —
 *  so the pill-row → pane → panel → grid chain (and the pane's scroll/clip box) is
 *  the shipped one. The default fixture mounts with NO initialTab — that is the shipped
 *  landing tab. */
function Tab({ id, tab }) {
  return (
    <div data-panel={id} style={{ width: 640, flexShrink: 0, height: 820, background: '#fff' }}>
      <CapabilityCenter
        initialTab={tab}
        skills={SKILLS}
        onToggleSkill={() => {}}
        onImportSkill={() => {}}
        onRefreshSkills={() => {}}
        onDeleteSkill={() => {}}
        tools={TOOLS}
        onToggleTool={(name) => { window.toolToggles = [...(window.toolToggles || []), name] }}
      />
    </div>
  )
}

function DefaultTab() {
  return (
    <div data-panel="default" style={{ width: 640, flexShrink: 0, height: 820, background: '#fff' }}>
      <CapabilityCenter
        skills={SKILLS}
        onToggleSkill={() => {}}
        onImportSkill={() => {}}
        onRefreshSkills={() => {}}
        onDeleteSkill={() => {}}
        tools={TOOLS}
        onToggleTool={(name) => { window.toolToggles = [...(window.toolToggles || []), name] }}
      />
    </div>
  )
}

function Harness() {
  return (
    <ConfigProvider theme={{ token: { fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" } }}>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider initialLocale="zh">
            <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', padding: 24 }}>
              <Tab id="mcp" tab="mcp" />
              <Tab id="skills" tab="skills" />
              <Tab id="expert" tab="expert" />
              <Tab id="tools" tab="tools" />
              <DefaultTab />
            </div>
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
}

createRoot(document.getElementById('app')).render(<Harness />)
`

const OUT = join(tmpdir(), `pm-capability-cards-${process.pid}.js`)
await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx' },
  outfile: OUT,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  // The panels' import graph reaches markdown/katex stylesheets. The cards' own
  // look comes from antd's cssinjs at render time, so these are dead weight here:
  // load them as inert text rather than pulling font binaries into the bundle.
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning'
})

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 2100, height: 1100 }, deviceScaleFactor: 2 })
page.on('pageerror', (e) => console.error('[pageerror]', e.message))
// A real http origin, not setContent: the skills panel persists a tip-dismissed flag
// in localStorage, which an opaque about:blank origin denies access to.
const PAGE = '<!doctype html><html><body style="margin:0"><div id="app"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
// All four grids fetch asynchronously; wait until every card grid has a card.
// The tools pane now renders `.ant-card` (not `.ant-collapse-item`) — it joined
// the shared CapabilityCard shell.
await page.waitForFunction(
  () => ['mcp', 'skills', 'expert', 'tools'].every((p) => document.querySelector(`[data-panel="${p}"] .ant-card`)),
  null,
  { timeout: 15000 }
)

// ── Tab order + default (P1): 专家 → 技能 → 连接器 → 内置工具, default = 专家 ──
const tabState = await page.evaluate(() => {
  const read = (panelId) => {
    const panel = document.querySelector(`[data-panel="${panelId}"]`)
    const buttons = [...panel.querySelectorAll('button')].filter((b) => b.style.borderRadius === '999px')
    return buttons.map((b) => ({
      label: b.textContent.trim(),
      // The active pill's wash rides --pm-hover-strong (M3/T3), so "active" is
      // the computed background EQUALING that role's resolved value — a string
      // sniff for the old 0.08 literal would report every pill inactive.
      active: getComputedStyle(b).backgroundColor === (() => {
        const d = document.createElement('div')
        d.style.background = 'var(--pm-hover-strong)'
        document.body.appendChild(d)
        const v = getComputedStyle(d).backgroundColor
        d.remove()
        return v
      })(),
    }))
  }
  return { pinned: read('mcp'), defaultTab: read('default') }
})
check('四个 pill 的顺序是 专家/技能/连接器/内置工具',
  JSON.stringify(tabState.pinned.map((t) => t.label)) ===
  JSON.stringify(['专家', '技能', '连接器', '内置工具']),
  tabState.pinned.map((t) => t.label).join('/'))
check('不传 initialTab 时默认高亮专家（第一个 pill）', tabState.defaultTab[0]?.active === true,
  tabState.defaultTab.map((t) => `${t.label}${t.active ? '●' : '○'}`).join(''))

const toolsPane = await page.locator('[data-panel="tools"]').evaluate((panel) => ({
  cards: panel.querySelectorAll('.ant-card').length,
  switches: panel.querySelectorAll('.ant-switch').length,
  // Section headers still group cards by category — the tools pane is the one
  // capability tab where a flat grid would bury 38 tools in 9 categories.
  sections: [...panel.querySelectorAll('section')].length,
  grids: panel.querySelectorAll('.ant-card').length > 0 ? panel.querySelectorAll('section > div[style]').length : 0,
}))
check('内置工具显示全部四个开关与卡片（不再是 Collapse 列表）', toolsPane.switches === 4 && toolsPane.cards === 4, JSON.stringify(toolsPane))
await page.locator('[data-panel="tools"] .ant-switch').first().click()
check('工具开关把正确名称交给调用方一次', await page.evaluate(() => JSON.stringify(window.toolToggles) === '["read_file"]'))

/** Read the three cards' geometry + their action-row composition. */
const snap = await page.evaluate(() => {
  /** switch / delete / restart / other — by icon class, since the buttons are bare. */
  const actionLabel = (el) => {
    if (el.classList.contains('ant-switch')) return 'switch'
    if (el.tagName === 'BUTTON') {
      if (el.classList.contains('ant-btn-dangerous')) return 'delete'
      if (el.querySelector('.anticon-reload')) return 'restart'
      if (el.querySelector('.anticon-edit')) return 'edit'
      return 'button'
    }
    return `other:${el.className}`
  }

  const read = (panelId) => {
    const panel = document.querySelector(`[data-panel="${panelId}"]`)
    // 三分区（E1）把「内置」网格排在面板最前，而内置卡没有删除键——操作行断言
    // 要读「已安装」区的第一张卡（DOM 序 = 内置网格在前）。
    const card = panelId === 'skills' ? panel.querySelectorAll('.ant-card')[1] : panel?.querySelector('.ant-card')
    if (!card) return null
    const cs = getComputedStyle(card)
    const head = card.querySelector('.ant-card-head')
    const title = card.querySelector('.ant-card-head-title')
    // The name is the first text-bearing leaf span inside the title (the one before
    // it is the icon, the one after may be the 内置 badge).
    const nameEl =
      [...(title?.querySelectorAll('span') ?? [])].find(
        (s) => s.children.length === 0 && s.textContent.trim().length > 0
      ) ?? title
    const body = card.querySelector('.ant-card-body')
    const extra = card.querySelector('.ant-card-extra')
    const grid = card.parentElement
    return {
      name: nameEl?.textContent?.trim(),
      radius: cs.borderRadius,
      background: cs.backgroundColor,
      cursor: cs.cursor,
      hasHead: !!head,
      headHeight: head ? Math.round(head.getBoundingClientRect().height) : null,
      headFontSize: head ? getComputedStyle(head).fontSize : null,
      headDivider: head ? getComputedStyle(head).borderBottomWidth : null,
      nameFontSize: nameEl ? getComputedStyle(nameEl).fontSize : null,
      nameFontWeight: nameEl ? getComputedStyle(nameEl).fontWeight : null,
      nameColor: nameEl ? getComputedStyle(nameEl).color : null,
      bodyPadding: body ? getComputedStyle(body).padding : null,
      gridGap: getComputedStyle(grid).gap,
      columnWidth: Math.round(parseFloat(getComputedStyle(grid).gridTemplateColumns.split(' ')[0]) || 0),
      actions: extra ? [...extra.firstElementChild.children].map(actionLabel) : [],
      cardCount: panel.querySelectorAll('.ant-card').length,
    }
  }
  return { mcp: read('mcp'), skills: read('skills'), expert: read('expert'), tools: read('tools') }
})

const PANELS = ['mcp', 'skills', 'expert', 'tools']
const LABEL = { mcp: '连接器', skills: '技能', expert: '专家', tools: '内置工具' }
const missing = PANELS.filter((p) => !snap[p])
check('四个页签都渲染出卡片', missing.length === 0, missing.length ? `missing: ${missing}` : PANELS.map((p) => `${LABEL[p]}×${snap[p]?.cardCount}`).join(' '))

/** Cross-panel equality for one property — the whole point of the exercise. */
function same(prop, label) {
  const vals = PANELS.map((p) => snap[p]?.[prop])
  const uniq = [...new Set(vals.map((v) => JSON.stringify(v)))]
  check(`${label} 三者一致`, uniq.length === 1 && vals[0] !== null && vals[0] !== undefined,
    uniq.length === 1 ? `${uniq[0]}` : PANELS.map((p, i) => `${LABEL[p]}=${vals[i]}`).join(' | '))
}

// ── The shell facts that made the three look different ──
check('三张卡都走 antd head（标题下有分割线）', PANELS.every((p) => snap[p]?.hasHead === true))
same('headDivider', '标题分割线')
same('headHeight', '标题头高度')
same('headFontSize', '标题字号')
same('nameFontSize', '卡片名字号')
same('nameFontWeight', '卡片名 weight')
same('nameColor', '卡片名字色')
same('radius', '圆角')
same('background', '卡片底色')
same('bodyPadding', 'body 内边距')
same('gridGap', '栅格间距')
same('columnWidth', '栅格列宽')

check('名字字号是 14px（跟 head 走，不再各写各的）', snap.mcp?.nameFontSize === '14px', String(snap.mcp?.nameFontSize))
check('圆角是 10px', snap.mcp?.radius === '10px', String(snap.mcp?.radius))

// ── Action row: the connector used to be switch-first while skills was delete-first,
//    and the skill delete was a grey icon rather than danger. 内置工具 has no delete
//    (built-in tools can't be removed, only toggled), so it's switch-only. ──
const DELETABLE = ['mcp', 'skills', 'expert']
check('操作行都是「开关在前」',
  PANELS.every((p) => snap[p]?.actions[0] === 'switch'),
  PANELS.map((p) => `${LABEL[p]}=${snap[p]?.actions.join('·')}`).join('  |  '))
check('操作行都是「删除在后」(可删除的三个 tab)',
  DELETABLE.every((p) => snap[p]?.actions.at(-1) === 'delete'),
  DELETABLE.map((p) => `${LABEL[p]}=${snap[p]?.actions.at(-1)}`).join(' | '))
check('内置工具的操作行只有开关（不可删除）',
  snap.tools?.actions.length === 1 && snap.tools?.actions[0] === 'switch',
  snap.tools?.actions.join('·'))
check('没有卡片再渲染多余的编辑按钮', PANELS.every((p) => !snap[p]?.actions.includes('edit')))
check('连接器的条件「重启」排在开关与删除之间',
  snap.mcp?.actions.join('·') === 'switch·restart·delete', snap.mcp?.actions.join('·'))

// ── Hover + whole-card click: the expert card used to be the odd one out ──
// 内置工具 now uses the same CapabilityCard shell, so it must be hoverable too.
const hover = {}
for (const p of PANELS) {
  const card = page.locator(`[data-panel="${p}"] .ant-card`).first()
  const before = await card.evaluate((el) => getComputedStyle(el).boxShadow)
  await card.hover()
  const after = await card.evaluate((el) => getComputedStyle(el).boxShadow)
  hover[p] = { changed: before !== after, cursor: await card.evaluate((el) => getComputedStyle(el).cursor) }
}
check('四张卡都 hoverable（悬停出现阴影 + pointer）',
  PANELS.every((p) => hover[p].changed && hover[p].cursor === 'pointer'),
  PANELS.map((p) => `${LABEL[p]}:${hover[p].changed ? 'shadow' : 'static'}/${hover[p].cursor}`).join(' | '))

// ── Pill hover: a non-active pill must show antd's text-button hover wash.
//    The inline `background: 'transparent'` on the non-active pill used to outrank
//    antd's `:hover` by specificity and silently kill it (the reported "hover 没了").
//    The fix leaves `background: undefined` on the non-active pill.
//    CSS `:hover` needs a real pointer — synthetic mouseenter events don't trigger it.
const nonActivePillInfo = await page.evaluate(() => {
  const panel = document.querySelector('[data-panel="tools"]')
  const pills = [...panel.querySelectorAll('button')].filter((b) => b.style.borderRadius === '999px')
  const nonActive = pills.find((b) => !b.style.background.includes('0.08'))
  if (!nonActive) return null
  // Tag the pill so Playwright can target it.
  nonActive.setAttribute('data-pill-hover-target', '')
  return { label: nonActive.textContent.trim() }
})
let pillHover = { found: false }
if (nonActivePillInfo) {
  const pill = page.locator('[data-pill-hover-target]')
  await pill.waitFor({ state: 'visible', timeout: 5000 })
  const before = await pill.evaluate((el) => getComputedStyle(el).backgroundColor)
  await pill.hover()
  await page.waitForTimeout(150)
  const after = await pill.evaluate((el) => getComputedStyle(el).backgroundColor)
  // Also dump the inline style + classList for diagnosis.
  const diag = await pill.evaluate((el) => ({ inline: el.getAttribute('style'), cls: el.className }))
  pillHover = {
    found: true,
    label: nonActivePillInfo.label,
    before,
    after,
    changed: before !== after && after !== 'rgba(0, 0, 0, 0)',
    diag,
  }
}
check('非激活 pill 悬停出现底色（hover 恢复）',
  pillHover.found && pillHover.changed,
  pillHover.found ? `${pillHover.label}: ${pillHover.before} → ${pillHover.after}` : 'no non-active pill found')

// ── The connector card keeps the body blocks it always had ──
const mcpBody = await page.evaluate(() => {
  const card = document.querySelector('[data-panel="mcp"] .ant-card')
  return {
    statusLine: /.+·.+\d+ 个工具/.test(card.querySelector('.ant-card-body')?.textContent ?? ''),
    endpoint: !!card.querySelector('code'),
    footer: /工具 · \d/.test(card.textContent),
  }
})
check('连接器卡保留了状态行 / 端点条 / 工具计数页脚',
  mcpBody.statusLine && mcpBody.endpoint && mcpBody.footer, JSON.stringify(mcpBody))

// ── Nothing may have been squashed into the new head, or spilled out of the card ──
const layout = await page.evaluate(() =>
  Object.fromEntries(
    ['mcp', 'skills', 'expert'].map((p) => {
      const card = document.querySelector(`[data-panel="${p}"] .ant-card`)
      return [
        p,
        {
          overflowX: card.scrollWidth - card.clientWidth,
          height: Math.round(card.getBoundingClientRect().height),
          headHeight: Math.round(card.querySelector('.ant-card-head').getBoundingClientRect().height),
          extraHeight: Math.round(card.querySelector('.ant-card-extra').getBoundingClientRect().height),
        },
      ]
    })
  )
)
check('没有卡片横向溢出', Object.values(layout).every((l) => l.overflowX <= 1),
  Object.entries(layout).map(([p, l]) => `${LABEL[p]}:${l.overflowX}`).join(' '))
check('操作行装得进标题头（没有把 head 撑高）',
  Object.values(layout).every((l) => l.extraHeight <= l.headHeight),
  Object.entries(layout).map(([p, l]) => `${LABEL[p]}:${l.extraHeight}/${l.headHeight}`).join(' '))
check('可删除三个 tab 的卡片高度接近（同一种正文节奏）',
  Math.max(...['mcp', 'skills', 'expert'].map((p) => layout[p].height)) - Math.min(...['mcp', 'skills', 'expert'].map((p) => layout[p].height)) <= 90,
  ['mcp', 'skills', 'expert'].map((p) => `${LABEL[p]}:${layout[p].height}`).join(' '))

// ── Two failures this shell can produce and computed styles alone would not show ──
// 1. The body must not claim the card's full height any more: since the head arrived,
//    `height: 100%` on the body makes it start 39px in but still be a full card tall,
//    so a bottom-pinned footer is painted outside the card.
// 2. `overflow: auto` on the panel clips at *its own* padding box, so an inset applied
//    one level up leaves the cards sitting exactly on the clipping edge and shears the
//    hover shadow off every card in the outer rows/columns. antd's boxShadowCard
//    (0 3px 6px, 0 5px 12px 4px) bleeds 10px sideways, 15px down and 5px up.
const SHADOW = { top: 5, right: 10, bottom: 15, left: 10 }

const containment = await page.evaluate(() => {
  const scrollerOf = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible') return n
    }
    return null
  }
  const out = {}
  for (const p of ['mcp', 'skills', 'expert', 'tools']) {
    const panel = document.querySelector(`[data-panel="${p}"]`)
    const cards = [...panel.querySelectorAll('.ant-card')]
    const card = cards[0]
    const scroller = scrollerOf(card)
    const s = scroller.getBoundingClientRect()
    const boxes = cards.map((c) => c.getBoundingClientRect())
    const footer = card.querySelector('.ant-card-body > div:last-child')
    out[p] = {
      room: {
        top: Math.round(Math.min(...boxes.map((b) => b.top)) - s.top),
        left: Math.round(Math.min(...boxes.map((b) => b.left)) - s.left),
        right: Math.round(s.right - Math.max(...boxes.map((b) => b.right))),
        bottom: Math.round(s.bottom - Math.max(...boxes.map((b) => b.bottom))),
      },
      // > 0 means the footer hangs below the card's own border box.
      // null when the card has no footer (内置工具 cards have no footer band).
      footerOutsideBy: footer ? Math.round((footer.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom) * 10) / 10 : null,
      bodyOverflowsCard: card.scrollHeight - card.clientHeight,
    }
  }
  return out
})

check('工具计数页脚留在卡片里（没有跑到卡片外面）',
  ['mcp', 'skills', 'expert'].every((p) => containment[p].footerOutsideBy === null || containment[p].footerOutsideBy <= 0),
  ['mcp', 'skills', 'expert'].map((p) => `${LABEL[p]}:${containment[p].footerOutsideBy > 0 ? `越界 ${containment[p].footerOutsideBy}px` : '卡内'}`).join(' '))
check('卡片内容不纵向溢出卡片',
  PANELS.every((p) => containment[p].bodyOverflowsCard <= 1),
  PANELS.map((p) => `${LABEL[p]}:${containment[p].bodyOverflowsCard}`).join(' '))
check('边缘卡片的 hover 阴影有地方画（滚容器自带内缩）',
  PANELS.every((p) => Object.keys(SHADOW).every((side) => containment[p].room[side] >= SHADOW[side])),
  PANELS.map((p) => `${LABEL[p]}:上${containment[p].room.top}/右${containment[p].room.right}/下${containment[p].room.bottom}/左${containment[p].room.left}`).join('  '))

// The bottom row only reveals its clip once the list is long enough to scroll — with
// short content the scroller is taller than the grid and the question never arises.
// Pin the panes short, scroll each to the end, and measure the last row again.
await page.evaluate(() => {
  document.querySelectorAll('[data-panel]').forEach((p) => {
    p.style.height = '260px'
  })
})
await page.waitForTimeout(120)
const scrolled = await page.evaluate(() => {
  const scrollerOf = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible') return n
    }
    return null
  }
  const out = {}
  for (const p of ['mcp', 'skills', 'expert', 'tools']) {
    const panel = document.querySelector(`[data-panel="${p}"]`)
    const cards = [...panel.querySelectorAll('.ant-card')]
    const scroller = scrollerOf(cards[0])
    scroller.scrollTop = scroller.scrollHeight
    const s = scroller.getBoundingClientRect()
    const last = cards.at(-1).getBoundingClientRect()
    out[p] = {
      scrollable: scroller.scrollHeight > scroller.clientHeight + 1,
      bottomRoom: Math.round(s.bottom - last.bottom),
    }
  }
  return out
})
check('滚到底部时最后一行的阴影也不被裁',
  PANELS.every((p) => !scrolled[p].scrollable || scrolled[p].bottomRoom >= SHADOW.bottom),
  PANELS.map((p) => `${LABEL[p]}:${scrolled[p].scrollable ? `可滚 ${scrolled[p].bottomRoom}px` : '无需滚动'}`).join('  '))

// Screenshots before the behaviour pass below navigates panels away from their grids.
await page.screenshot({ path: join(SHOTS, 'all-three-tabs.png'), fullPage: true })
for (const p of PANELS) {
  await page.locator(`[data-panel="${p}"]`).screenshot({ path: join(SHOTS, `cards-${p}.png`) })
}

// ── Adding onClick to the card means the action row must keep its clicks to itself,
//    or flipping a switch also opens the editor. ──
const OPENED = {
  // The browser auto-selects SKILL.md, so the "pick a file" placeholder never
  // renders — the 渲染 / 源码 segmented control is the stable marker.
  skills: '源码',
  expert: '返回列表',
  mcp: '编辑连接器',
}

await page.locator('[data-panel="skills"] .ant-switch').first().click()
await page.locator('[data-panel="expert"] .ant-switch').first().click()
await page.locator('[data-panel="mcp"] .ant-switch').first().click()
await page.waitForTimeout(250)
const leaked = await page.evaluate((opened) => ({
  skills: document.querySelector('[data-panel="skills"]').textContent.includes(opened.skills),
  expert: document.querySelector('[data-panel="expert"]').textContent.includes(opened.expert),
  mcp: document.body.textContent.includes(opened.mcp),
}), OPENED)
check('点开关不会顺带打开卡片（操作行隔离点击）',
  !leaked.skills && !leaked.expert && !leaked.mcp, JSON.stringify(leaked))

await page.locator('[data-panel="skills"] .ant-card').first().click()
await page.waitForTimeout(300)
check('点技能卡打开三栏浏览器',
  await page.evaluate((s) => document.querySelector('[data-panel="skills"]').textContent.includes(s), OPENED.skills))

await page.locator('[data-panel="expert"] .ant-card').first().click()
await page.waitForTimeout(300)
check('点专家卡打开编辑器（替代原来的编辑按钮）',
  await page.evaluate((s) => document.querySelector('[data-panel="expert"]').textContent.includes(s), OPENED.expert))

await page.locator('[data-panel="mcp"] .ant-card').first().click()
await page.waitForTimeout(300)
check('点连接器卡打开编辑弹窗',
  await page.evaluate((s) => document.body.textContent.includes(s), OPENED.mcp))

// Close the MCP modal so it doesn't intercept the tools card click below.
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

// ── 内置工具: clicking the card expands its instructions (no navigation). The
//    expanded card shows its monospace instructions block; an unexpanded one does not.
const toolCard = page.locator('[data-panel="tools"] .ant-card').first()
const beforeExpand = await toolCard.evaluate((c) => !!c.querySelector('.ant-card-body [style*="monospace"]'))
await toolCard.click()
await page.waitForTimeout(200)
const afterExpand = await toolCard.evaluate((c) => !!c.querySelector('.ant-card-body [style*="monospace"]'))
check('点内置工具卡展开说明（不跳转）',
  !beforeExpand && afterExpand, `before=${beforeExpand} after=${afterExpand}`)

// ── 经验也是技能（E1 展示面收口，2026-10-26 用户裁定）：经验卡点击进入与技能
//    一致的三栏浏览器，不再弹详情 Modal。skills 面板此刻停在技能浏览器里——
//    先返回栅格，经验分区才可见（上面的滚动测试把面板压到了 260px，先还原）。 ──
await page.evaluate(() => { document.querySelector('[data-panel="skills"]').style.height = '820px' })
await page.locator('[data-panel="skills"] button', { hasText: '返回' }).click()
await page.waitForFunction(
  () => document.querySelector('[data-panel="skills"]')?.textContent.includes('发布前跑通构建'),
  null,
  { timeout: 5000 }
)

const expGrid = await page.evaluate(() => {
  const panel = document.querySelector('[data-panel="skills"]')
  const cardOf = (title) => [...panel.querySelectorAll('div[style*="cursor: pointer"]')].find((d) => d.textContent.includes(title))
  const live = cardOf('发布前跑通构建')
  const stale = cardOf('旧版打包步骤')
  const clue = cardOf('日报自动汇总')
  // 同壳断言的参照：已安装区第一张技能卡（tavily-search）
  const skillCard = [...panel.querySelectorAll('.ant-card')].find((c) => c.textContent.includes('tavily-search'))
  const shell = (card) => {
    if (!card) return null
    const head = card.querySelector('.ant-card-head')
    const title = card.querySelector('.ant-card-head-title')
    const nameEl = [...(title?.querySelectorAll('span') ?? [])].find((s) => s.children.length === 0 && s.textContent.trim().length > 0) ?? title
    const body = card.querySelector('.ant-card-body')
    return {
      isAntCard: card.classList.contains('ant-card'),
      hasHead: !!head,
      headHeight: head ? Math.round(head.getBoundingClientRect().height) : null,
      headDivider: head ? getComputedStyle(head).borderBottomWidth : null,
      radius: getComputedStyle(card).borderRadius,
      nameFontSize: nameEl ? getComputedStyle(nameEl).fontSize : null,
      nameFontWeight: nameEl ? getComputedStyle(nameEl).fontWeight : null,
      bodyPadding: body ? getComputedStyle(body).padding : null,
      hasHeadIcon: !!title?.querySelector('.anticon'),
      gridColumn: Math.round(parseFloat(getComputedStyle(card.parentElement).gridTemplateColumns.split(' ')[0]) || 0),
    }
  }
  return {
    hasSearch: !!panel.querySelector('input[placeholder="搜索经验"]'),
    liveOpacity: live ? getComputedStyle(live).opacity : null,
    staleOpacity: stale ? getComputedStyle(stale).opacity : null,
    liveTags: live ? [...live.querySelectorAll('.ant-tag')].map((t) => t.textContent.trim()) : [],
    staleTags: stale ? [...stale.querySelectorAll('.ant-tag')].map((t) => t.textContent.trim()) : [],
    liveHasDelete: !!live?.querySelector('.ant-card-extra .anticon-delete'),
    liveDeleteDanger: !!live?.querySelector('.ant-card-extra .ant-btn-dangerous'),
    // 头部 icon 也是闪电——固化按钮要限定在 button 里找
    liveHasDistill: !!live?.querySelector('.ant-card-extra button .anticon-thunderbolt'),
    clueHasDistill: !!clue?.querySelector('.ant-card-extra button .anticon-thunderbolt'),
    // 正文位 = 描述段落（body 里还有元信息行，不能读整个 body）
    clueBodyText: clue?.querySelector('.ant-card-body .ant-typography')?.textContent.trim() ?? null,
    liveBodyText: live?.querySelector('.ant-card-body .ant-typography')?.textContent.trim() ?? null,
    // 动作序与技能卡同：开关在前、删除在后；被取代的旧页没有开关
    actionsOf: (() => {
      const label = (el) => el.classList.contains('ant-switch') ? 'switch'
        : el.classList.contains('ant-btn-dangerous') ? 'delete'
        : el.querySelector?.('.anticon-thunderbolt') ? 'distill' : el.tagName.toLowerCase()
      const read = (card) => card ? [...(card.querySelector('.ant-card-extra')?.firstElementChild?.children ?? [])].map(label) : null
      return { live: read(live), clue: read(clue), stale: read(stale) }
    })(),
    clueSwitchChecked: !!clue?.querySelector('.ant-card-extra .ant-switch-checked'),
    // 长标题卡：名字 span 出省略号、右缘不越过动作区左缘；无 enabled 字段时开关默认开
    longTitle: (() => {
      const card = cardOf('把各个项目群的日报')
      if (!card) return null
      const title = card.querySelector('.ant-card-head-title')
      const nameEl = [...(title?.querySelectorAll('span') ?? [])].find((s) => s.children.length === 0 && s.textContent.trim().length > 0)
      const extra = card.querySelector('.ant-card-extra')
      const n = nameEl?.getBoundingClientRect()
      const x = extra?.getBoundingClientRect()
      return {
        ellipsis: !!nameEl && nameEl.scrollWidth > nameEl.clientWidth && getComputedStyle(nameEl).textOverflow === 'ellipsis',
        noOverlap: !!n && !!x && n.right <= x.left + 0.5,
        gap: n && x ? Math.round(x.left - n.right) : null,
        switchChecked: !!card.querySelector('.ant-card-extra .ant-switch-checked'),
      }
    })(),
    expShell: shell(live),
    skillShell: shell(skillCard),
  }
})
check('经验分区渲染网格：搜索框 + SOP 活页 + 被取代旧页',
  expGrid.hasSearch && expGrid.liveOpacity === '1' && expGrid.staleOpacity === '0.55',
  JSON.stringify({ search: expGrid.hasSearch, live: expGrid.liveOpacity, stale: expGrid.staleOpacity }))
check('经验卡操作区在头部：SOP 活页带金标 + danger 删除、无固化按钮（固化只对 clue 态）',
  expGrid.liveTags.some((s) => s.startsWith('SOP')) && expGrid.liveHasDelete && expGrid.liveDeleteDanger && !expGrid.liveHasDistill,
  JSON.stringify({ tags: expGrid.liveTags, delete: expGrid.liveHasDelete, danger: expGrid.liveDeleteDanger, distill: expGrid.liveHasDistill }))
check('被取代的经验卡带「旧版本」标',
  expGrid.staleTags.includes('旧版本'), JSON.stringify(expGrid.staleTags))
check('clue 态活页头部带固化按钮；正文位显示技能式 summary（无 summary 的旧页回落剥标记的正文摘录）',
  expGrid.clueHasDistill && expGrid.clueBodyText === '每天早上汇总各群日报时用'
    && expGrid.liveBodyText === '发布前跑通构建 先跑完整 build 再打包。',
  JSON.stringify({ distill: expGrid.clueHasDistill, clueBody: expGrid.clueBodyText, liveBody: expGrid.liveBodyText }))
// ── 2026-10-27 用户三点：长标题用省略号截断、不被开关遮住；开关默认打开（无 enabled 字段也开）──
check('长标题出省略号且名字右缘不越过动作区左缘（开关不再遮标题）',
  !!expGrid.longTitle && expGrid.longTitle.ellipsis && expGrid.longTitle.noOverlap,
  JSON.stringify(expGrid.longTitle))
check('开关默认打开：记录没有 enabled 字段时仍是开（只有显式 false 才停用）',
  !!expGrid.longTitle && expGrid.longTitle.switchChecked, JSON.stringify({ checked: expGrid.longTitle?.switchChecked }))

// ── 使用次数 + 安装/提取时间（2026-10-27）：技能卡与经验卡同形的元信息行；内置技能安装时间显示 --。
await page.waitForFunction(
  () => document.querySelector('[data-panel="skills"]')?.textContent.includes('使用 5 次'),
  null,
  { timeout: 5000 }
)
const meta = await page.evaluate(() => {
  const panel = document.querySelector('[data-panel="skills"]')
  const metaOf = (title) => {
    const card = [...panel.querySelectorAll('.ant-card')].find((c) => c.querySelector('.ant-card-head-title')?.textContent.includes(title))
    return card?.querySelector('[data-card-meta]')?.textContent.trim() ?? null
  }
  // 分区标题：<div><Text strong>标签</Text><Text secondary>计数</Text></div>
  const countOf = (label) => {
    const d = [...panel.querySelectorAll('div')].find((x) => x.children.length === 2 && x.children[0].textContent.trim() === label)
    return d?.children[1]?.textContent.trim() ?? null
  }
  return {
    tavily: metaOf('tavily-search'),
    builtin: metaOf('builtin-skill'),
    review: metaOf('code-review'),
    expLive: metaOf('发布前跑通构建'),
    counts: { builtIn: countOf('内置'), imported: countOf('已安装'), experience: countOf('经验') },
  }
})
check('技能卡元信息行：已安装技能显示使用次数与安装日期',
  meta.tavily === '使用 5 次 · 安装于 2026-10-20', JSON.stringify(meta.tavily))
check('内置技能的安装时间显示 --（用户裁定），使用次数照常',
  meta.builtin === '使用 2 次 · 安装于 --', JSON.stringify(meta.builtin))
check('无任何记录的技能显示 使用 0 次 · 安装于 --',
  meta.review === '使用 0 次 · 安装于 --', JSON.stringify(meta.review))
check('经验卡元信息行同形：使用次数 · 提取日期',
  meta.expLive === '使用 3 次 · 提取于 2026-10-26', JSON.stringify(meta.expLive))
check('三个分区标题右侧都有总数（经验的总数不再缺席）',
  JSON.stringify(meta.counts) === JSON.stringify({ builtIn: '1', imported: '2', experience: '4' }), JSON.stringify(meta.counts))
// ── 经验卡与技能卡同壳（2026-10-26 用户裁定「经验卡片的样式应该和普通技能一致」）：
//    同 antd head（分割线/高度）、同名字号与字重、同圆角、同 body 内边距、同栅格列宽、头部带 icon。
{
  const e = expGrid.expShell
  const s = expGrid.skillShell
  const same = (k) => e && s && JSON.stringify(e[k]) === JSON.stringify(s[k])
  const keys = ['isAntCard', 'hasHead', 'headHeight', 'headDivider', 'radius', 'nameFontSize', 'nameFontWeight', 'bodyPadding', 'hasHeadIcon', 'gridColumn']
  const diff = keys.filter((k) => !same(k))
  check('经验卡与技能卡同壳（head/字号/圆角/内边距/栅格列宽/头部 icon 全部一致）',
    !!e && !!s && e.isAntCard && diff.length === 0,
    diff.length === 0 ? `shell=${JSON.stringify(e)}` : `差异: ${diff.map((k) => `${k} 经验=${JSON.stringify(e?.[k])} 技能=${JSON.stringify(s?.[k])}`).join(' | ')}`)
}

// ── 经验卡开关（2026-10-27 用户：「开关呢」）：技能卡有启用开关，经验卡同款——
//    动作序 开关·(固化)·删除 与技能卡一致；被取代的旧页无开关；拨开关走 IPC 且不打开卡片。
check('经验卡动作序与技能卡同：开关在前、删除在后（SOP 页 switch·delete，clue 页 switch·distill·delete）',
  JSON.stringify(expGrid.actionsOf.live) === JSON.stringify(['switch', 'delete'])
    && JSON.stringify(expGrid.actionsOf.clue) === JSON.stringify(['switch', 'distill', 'delete'])
    && expGrid.clueSwitchChecked,
  JSON.stringify({ ...expGrid.actionsOf, clueChecked: expGrid.clueSwitchChecked }))
check('被取代的旧页没有开关（只剩删除）',
  JSON.stringify(expGrid.actionsOf.stale) === JSON.stringify(['delete']), JSON.stringify(expGrid.actionsOf.stale))

await page.locator('[data-panel="skills"] div[style*="cursor: pointer"]', { hasText: '日报自动汇总' }).first()
  .locator('.ant-card-extra .ant-switch').click()
await page.waitForTimeout(200)
const toggled = await page.evaluate(() => {
  const panel = document.querySelector('[data-panel="skills"]')
  const clue = [...panel.querySelectorAll('div[style*="cursor: pointer"]')].find((d) => d.textContent.includes('日报自动汇总'))
  return {
    calls: window.__pageToggles,
    switchChecked: !!clue?.querySelector('.ant-card-extra .ant-switch-checked'),
    browserOpened: !!panel.querySelector('.ant-segmented'),
  }
})
check('拨开关：IPC 收到 (p3,false)、开关即时转灰（乐观更新）、卡片没有被顺带打开',
  JSON.stringify(toggled.calls) === JSON.stringify([['p3', false]]) && !toggled.switchChecked && !toggled.browserOpened,
  JSON.stringify(toggled))

// 点经验卡 → 三栏浏览器（技能同款），绝不弹 Modal。等 h1 落地——正文经
// XMarkdown 的异步解析器渲染，Segmented 出现在内容之前。
await page.locator('[data-panel="skills"] div[style*="cursor: pointer"]', { hasText: '发布前跑通构建' }).first().click()
await page.waitForFunction(
  () => {
    const panel = document.querySelector('[data-panel="skills"]')
    return !!panel?.querySelector('.ant-segmented') && !!panel?.querySelector('h1')
  },
  null,
  { timeout: 5000 }
)
const expBrowser = await page.evaluate(() => {
  const panel = document.querySelector('[data-panel="skills"]')
  const treeTitles = [...panel.querySelectorAll('.ant-tree-title')].map((n) => n.textContent.trim())
  // 左列表分组标：三分区与网格同构（内置 / 已安装 / 经验）
  const groupLabels = [...panel.querySelectorAll('div')]
    .filter((d) => d.children.length === 0 && ['内置', '已安装', '经验'].includes(d.textContent.trim()))
    .map((d) => d.textContent.trim())
  return {
    // 探针前段开过的 MCP 编辑弹窗 Esc 后 DOM 仍留存（antd 不销毁）——判「可见」
    // 的 modal-wrap 而不是 DOM 存在性。
    modalOpen: [...document.querySelectorAll('.ant-modal-wrap')].some((w) => getComputedStyle(w).display !== 'none'),
    groupLabels,
    // 刚拨停用的 p3 在左列表要挂「已停用」标（浏览器重新拉取 fixture 看到了 enabled:false）
    disabledRowTag: (() => {
      // 行 = 直接子元素里有一个 span 恰为标题文本的 div（祖先容器的直接子元素不满足）
      const row = [...panel.querySelectorAll('div')].find((d) =>
        [...d.children].some((c) => c.tagName === 'SPAN' && c.textContent.trim() === '日报自动汇总'))
      return row?.querySelector('.ant-tag')?.textContent.trim() ?? null
    })(),
    rows: ['发布前跑通构建', '旧版打包步骤', 'tavily-search'].every((s) => panel.textContent.includes(s)),
    treeTitles,
    defaultMarkdown: !!panel.querySelector('h1'),
    segmented: [...panel.querySelectorAll('.ant-segmented-item')].map((s) => s.textContent.trim()),
    metaLine: panel.textContent.includes('别名: 发布检查') && panel.textContent.includes('使用 3 次'),
    sopRowTag: !!panel.querySelector('.ant-tag-gold'),
  }
})
check('点经验卡打开三栏浏览器且零 Modal',
  !expBrowser.modalOpen && expBrowser.defaultMarkdown && expBrowser.segmented.includes('源码'),
  JSON.stringify({ modal: expBrowser.modalOpen, md: expBrowser.defaultMarkdown, segmented: expBrowser.segmented }))
check('左列表三分区组标齐全（内置/已安装/经验，与网格同构）+ 两条经验行 + SOP 金标',
  JSON.stringify(expBrowser.groupLabels) === JSON.stringify(['内置', '已安装', '经验'])
    && expBrowser.rows && expBrowser.sopRowTag,
  JSON.stringify({ groups: expBrowser.groupLabels, rows: expBrowser.rows, sop: expBrowser.sopRowTag }))
check('刚停用的经验在左列表挂「已停用」标（与停用技能同款）',
  expBrowser.disabledRowTag === '已停用', JSON.stringify(expBrowser.disabledRowTag))
check('中间树：SKILL.md 与 scripts/verify.mjs（经验正文文件与技能同名）',
  expBrowser.treeTitles.join('|').includes('SKILL.md') && !expBrowser.treeTitles.join('|').includes('page.md') && expBrowser.treeTitles.join('|').includes('verify.mjs'),
  JSON.stringify(expBrowser.treeTitles))
check('经验正文默认渲染 markdown 且页首带别名/使用次数',
  expBrowser.defaultMarkdown && expBrowser.metaLine, `md=${expBrowser.defaultMarkdown} meta=${expBrowser.metaLine}`)

// 渲染 → 源码切换：原始 markdown 可见（与技能预览同一 Segmented）。
await page.locator('[data-panel="skills"] .ant-segmented-item', { hasText: '源码' }).click()
await page.waitForTimeout(150)
check('源码形态显示原始正文（# 标题字面量在 DOM）',
  await page.evaluate(() => document.querySelector('[data-panel="skills"]').textContent.includes('# 发布前跑通构建')))

// 树切到脚本：高亮代码形态（resolveCodeLang(.mjs) → javascript）。
await page.locator('[data-panel="skills"] .ant-tree-title', { hasText: 'verify.mjs' }).click()
await page.waitForTimeout(200)
check('树切脚本显示脚本源码',
  await page.evaluate(() => document.querySelector('[data-panel="skills"]').textContent.includes('console.log')))

// 左列表技能 ↔ 经验互切（一个浏览空间）。等待落在 check 里——超时落 FAIL 而不是异常。
let skillSwitch = false
try {
  await page.locator('[data-panel="skills"] span', { hasText: 'tavily-search' }).first().click()
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-panel="skills"] .ant-tree-title')].some((n) => n.textContent.includes('run.sh')),
    null,
    { timeout: 5000 }
  )
  skillSwitch = true
} catch { /* keep false */ }
check('左列表切回技能后文件树回到技能包（run.sh 在树里）', skillSwitch)

let expSwitchBack = false
try {
  await page.locator('[data-panel="skills"] span', { hasText: '发布前跑通构建' }).first().click()
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-panel="skills"] .ant-tree-title')].some((n) => n.textContent.includes('verify.mjs')),
    null,
    { timeout: 5000 }
  )
  expSwitchBack = true
} catch { /* keep false */ }
check('再点经验行回到经验（verify.mjs 在树里，exp: key 往返无损）', expSwitchBack)

// 被取代的旧页也可打开阅读（列表半透明 ≠ 不可读）。
await page.locator('[data-panel="skills"] span', { hasText: '旧版打包步骤' }).first().click()
await page.waitForTimeout(300)
check('被取代的经验页打开后正文可读',
  await page.evaluate(() => document.querySelector('[data-panel="skills"]').textContent.includes('旧内容')))

// 返回 → 栅格恢复（浏览器卸载）。
await page.locator('[data-panel="skills"] button', { hasText: '返回' }).click()
await page.waitForTimeout(250)
check('返回后经验网格恢复、浏览器卸载',
  await page.evaluate(() => {
    const panel = document.querySelector('[data-panel="skills"]')
    return panel.textContent.includes('发布前跑通构建') && !panel.querySelector('.ant-segmented')
  }))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`screenshots: ${SHOTS}`)
if (failed.length > 0) {
  console.error('failed:', failed.map((f) => f.name).join(' | '))
  process.exit(1)
}
