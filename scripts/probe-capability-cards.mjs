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
window.electronAPI = new Proxy({}, {
  get: (_t, key) => () => Promise.resolve((FIXTURES[key] ?? (() => undefined))()),
})

const SKILLS = [
  { definition: { name: 'tavily-search', description: '联网搜索能力，用于获取实时信息，覆盖新闻与网页正文', category: 'engineering' }, enabled: true },
  { definition: { name: 'code-review', description: '按团队规范审查代码改动并给出可执行的修改建议', category: 'debugging' }, enabled: false },
  { definition: { name: 'builtin-skill', description: '内置技能示例，用于演示内置徽标', category: 'education', builtIn: true }, enabled: true },
]

/** Each panel is a *real* CapabilityCenter pinned to one tab — not the bare panel —
 *  so the pill-row → pane → panel → grid chain (and the pane's scroll/clip box) is
 *  the shipped one. */
function Tab({ id, tab }) {
  return (
    <div data-panel={id} style={{ width: 640, height: 820, background: '#fff' }}>
      <CapabilityCenter
        initialTab={tab}
        skills={SKILLS}
        onToggleSkill={() => {}}
        onImportSkill={() => {}}
        onRefreshSkills={() => {}}
        onDeleteSkill={() => {}}
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
// All three panels fetch asynchronously; wait until every grid has a card.
await page.waitForFunction(
  () => ['mcp', 'skills', 'expert'].every((p) => document.querySelector(`[data-panel="${p}"] .ant-card`)),
  null,
  { timeout: 15000 }
)

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
    const card = panel?.querySelector('.ant-card')
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
  return { mcp: read('mcp'), skills: read('skills'), expert: read('expert') }
})

const PANELS = ['mcp', 'skills', 'expert']
const LABEL = { mcp: '连接器', skills: '技能', expert: '专家' }
const missing = PANELS.filter((p) => !snap[p])
check('三个页签都渲染出卡片', missing.length === 0, missing.length ? `missing: ${missing}` : PANELS.map((p) => `${LABEL[p]}×${snap[p]?.cardCount}`).join(' '))

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
//    and the skill delete was a grey icon rather than danger. ──
check('操作行都是「开关在前」', PANELS.every((p) => snap[p]?.actions[0] === 'switch'),
  PANELS.map((p) => `${LABEL[p]}=${snap[p]?.actions.join('·')}`).join('  |  '))
check('操作行都是「删除在后」', PANELS.every((p) => snap[p]?.actions.at(-1) === 'delete'),
  PANELS.map((p) => `${LABEL[p]}=${snap[p]?.actions.at(-1)}`).join(' | '))
check('没有卡片再渲染多余的编辑按钮', PANELS.every((p) => !snap[p]?.actions.includes('edit')))
check('连接器的条件「重启」排在开关与删除之间',
  snap.mcp?.actions.join('·') === 'switch·restart·delete', snap.mcp?.actions.join('·'))

// ── Hover + whole-card click: the expert card used to be the odd one out ──
const hover = {}
for (const p of PANELS) {
  const card = page.locator(`[data-panel="${p}"] .ant-card`).first()
  const before = await card.evaluate((el) => getComputedStyle(el).boxShadow)
  await card.hover()
  const after = await card.evaluate((el) => getComputedStyle(el).boxShadow)
  hover[p] = { changed: before !== after, cursor: await card.evaluate((el) => getComputedStyle(el).cursor) }
}
check('三张卡都 hoverable（悬停出现阴影 + pointer）',
  PANELS.every((p) => hover[p].changed && hover[p].cursor === 'pointer'),
  PANELS.map((p) => `${LABEL[p]}:${hover[p].changed ? 'shadow' : 'static'}/${hover[p].cursor}`).join(' | '))

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
check('三张卡的高度接近（同一种正文节奏）',
  Math.max(...Object.values(layout).map((l) => l.height)) - Math.min(...Object.values(layout).map((l) => l.height)) <= 90,
  Object.entries(layout).map(([p, l]) => `${LABEL[p]}:${l.height}`).join(' '))

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
  for (const p of ['mcp', 'skills', 'expert']) {
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
      footerOutsideBy: footer ? Math.round((footer.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom) * 10) / 10 : null,
      bodyOverflowsCard: card.scrollHeight - card.clientHeight,
    }
  }
  return out
})

check('工具计数页脚留在卡片里（没有跑到卡片外面）',
  PANELS.every((p) => containment[p].footerOutsideBy === null || containment[p].footerOutsideBy <= 0),
  PANELS.map((p) => `${LABEL[p]}:${containment[p].footerOutsideBy > 0 ? `越界 ${containment[p].footerOutsideBy}px` : '卡内'}`).join(' '))
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
  for (const p of ['mcp', 'skills', 'expert']) {
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

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`screenshots: ${SHOTS}`)
if (failed.length > 0) {
  console.error('failed:', failed.map((f) => f.name).join(' | '))
  process.exit(1)
}
