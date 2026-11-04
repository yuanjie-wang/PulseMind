/**
 * Welcome project-cards probe (real Chromium).
 *
 * The welcome page's project view lists one card per project, each carrying a
 * second line: the project's last conversation read as a chat line —
 * "1天前：把周报整理一下" — or, for a project nothing was ever said in, 立即开始
 * in the text slot with the same play button after it. The row is therefore one
 * shape across both states, and two facts of it no other layer can see:
 *
 *   - the ROW is geometry. The card is a bordered box with a 72px floor whose
 *     two rows want exactly its content height (22px name + 4px gap + 20px
 *     line), so an empty state that renders nothing — or something taller —
 *     changes the card's height, and the grid row sizes every card by the
 *     tallest one. Only a layout engine shows whether the fallback still fits.
 *   - the BUTTON is an interaction. It is a click target inside a click target:
 *     the card's own click "targets this project" (the next message opens in
 *     it) while the play button either opens the latest conversation or, on the
 *     立即开始 row, means the same as the card's click. Which one runs is decided
 *     by a real mouse — `e.stopPropagation()` on a path jsdom cannot walk
 *     (vitest here is node-env, no mounting at all).
 *
 * The 新建项目 card gets its own section, WITH and WITHOUT projects. With
 * projects it is the grid's last cell and nothing more (user request
 * 2026-09-18: 「如果没有任何项目，那么也要展示新建项目的那个卡片」). On an empty
 * page the explanation and the create action are MERGED into one full-row card
 * — 「把【还没有项目】这个卡片和【新建项目】的卡片合并，透明背景、灰色虚线边框，
 * 把【还没有项目】改为【立即创建项目】」 — so what is measured there is that the
 * two are genuinely one element spanning all three columns, its title and hint
 * lines, the transparent + dashed recipe, its hover, and that a click (mouse
 * AND Enter: it is a real <button>) reaches the create modal without writing
 * anything.
 *
 * The 试试 row is asserted last (2026-09-18 introduced it; 2026-11-04 追加裁定
 * scoped it to the compressed form): the selection form has NO starters — with
 * the composer hidden there is nothing to send from — and the compressed strip
 * form carries them beside the mounted composer. The chips are inline-styled
 * spans whose onClick hands the prompt to the host's send channel (2026-11-04
 * 二次裁定：点一下即发送，不再是落草稿）— a real mouse click is the only layer
 * that can see the handoff.
 *
 * What this mounts is the production `ProjectCards` behind a stubbed
 * `window.electronAPI` (project list + last-user-message lookups) and the real
 * `projectStore` / `newTaskStore` / i18n, so the assertions run against the
 * shipping component and the shipping translation, not a copy.
 *
 * No Electron, no LLM: pure renderer components in a plain page.
 *
 * Usage: node scripts/probe-project-cards.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-project-cards-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-project-cards-shots')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import { ProjectCards } from './src/renderer/src/components/welcome/ProjectCards'
import { useProjectStore } from './src/renderer/src/stores/projectStore'
import { useNewTaskStore } from './src/renderer/src/stores/newTaskStore'
// The welcome band is migrated onto the theme sheet (PLAN-dark-mode M3/T1), so
// the page needs the variable table injected before the components render —
// a var() with no sheet paints nothing, and the ink assertions below would
// pass on transparent. Light is pinned explicitly: this probe freezes the
// light values; the dark column is probe-theme-dark.mjs's territory.
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'

installThemeVars()
applyThemeAttr('light')

// 30h back reads as 1天前 for the whole life of a probe run.
const LAST_TOUCH = new Date(Date.now() - 30 * 3600 * 1000).toISOString()

const PROJECTS = [
  { id: 'p_empty', name: '空白项目', workspaceDir: '/tmp/pm-probe/empty', createdAt: LAST_TOUCH, updatedAt: LAST_TOUCH },
  { id: 'p_used', name: '在用的项目', workspaceDir: '/tmp/pm-probe/used', createdAt: LAST_TOUCH, updatedAt: LAST_TOUCH },
]
const CONVERSATIONS = [
  { key: 'c1', label: '之前的对话', projectId: 'p_used', updatedAt: LAST_TOUCH },
]
window.__QUOTE = '把周报整理一下'
/** Set by __mount — the empty state is a real state of this page, not a fixture. */
window.__projects = PROJECTS

window.__calls = []
window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    // Subscribe-style APIs must answer with a cleanup function, not a Promise.
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {}
    window.__calls.push(String(key))
    // SettingsProvider (which the app wraps this page in, and ProjectModal's
    // 自动总结 reads the active profile from) needs a real shape back.
    if (key === 'getSettings') {
      return Promise.resolve({ activeProfileId: '', profiles: [], theme: 'light', locale: 'zh' })
    }
    if (key === 'projectList') return Promise.resolve(window.__projects)
    if (key === 'getConversationLastUserMessage') {
      return Promise.resolve(args[0] === 'c1' ? window.__QUOTE : null)
    }
    return Promise.resolve(undefined)
  },
})

window.__opened = null
window.__sent = []
let root = null
window.__mount = ({ locale = 'zh', projects, withSend = true } = {}) => {
  window.__projects = projects ?? PROJECTS
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider initialLocale={locale}>
            <div style={{ width: 1000, padding: 24 }}>
              <ProjectCards
                conversations={CONVERSATIONS}
                onOpenConversation={(key) => { window.__opened = key }}
                onStarterSend={withSend ? (text) => { window.__sent.push(text) } : undefined}
              />
            </div>
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
  return true
}

/** The 新建项目 card — and, when the page is empty, the explanation beside it.
 *  Read as geometry (its cell) + paint (the dashed recipe) + where it sits. */
window.__createCard = () => {
  const b = document.querySelector('[data-action="create-project"]')
  if (!b) return null
  const gb = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  }
  const cs = getComputedStyle(b)
  const grid = b.parentElement
  const gridStyle = getComputedStyle(grid)
  const empty = document.querySelector('[data-project-empty]')
  const parentFont = getComputedStyle(document.querySelector('#root > div > div')).fontFamily
  return {
    tag: b.tagName,
    type: b.getAttribute('type'),
    text: b.textContent.trim(),
    box: gb(b),
    last: grid.lastElementChild === b,
    siblings: grid.children.length,
    columnCount: gridStyle.gridTemplateColumns.split(' ').length,
    gap: parseFloat(gridStyle.columnGap),
    gridBox: gb(grid),
    emptyBox: gb(empty),
    emptyColumns: empty ? getComputedStyle(empty).gridColumn : null,
    emptyText: empty ? empty.textContent.trim() : null,
    // On an empty page the explanation and the create action are the same
    // element (the merge) — this is the check that says so rather than two
    // cells that merely line up.
    emptyIsCard: empty === b,
    emptyLines: empty
      ? [...empty.querySelectorAll(':scope > div')].map((d) => {
          const r = d.getBoundingClientRect()
          return { text: d.textContent.trim(), top: r.top, bottom: r.bottom, left: r.left, right: r.right }
        })
      : [],
    fontMatchesPage: cs.fontFamily === parentFont,
    paint: {
      borderStyle: cs.borderTopStyle, borderWidth: cs.borderTopWidth, borderColor: cs.borderTopColor,
      radius: cs.borderRadius, fontSize: cs.fontSize, color: cs.color,
      background: cs.backgroundColor, minHeight: cs.minHeight, cursor: cs.cursor,
      textAlign: cs.textAlign,
    },
  }
}

/** The create modal's own presence + the form the user is meant to fill. */
window.__modal = () => {
  const m = document.querySelector('.ant-modal')
  if (!m) return null
  return {
    title: m.querySelector('.ant-modal-title')?.textContent ?? '',
    inputs: [...m.querySelectorAll('input')].map((i) => i.placeholder),
  }
}

window.__selected = () => useNewTaskStore.getState().projectId
/** Drive the compressed strip form directly (evaluate has no module scope). */
window.__pick = (id) => { useNewTaskStore.getState().setProjectId(id); return true }
/** The 试试 row of the compressed strip form (2026-11-04 两形态：starters 只
 *  属于已选形态，横条列的下一个兄弟就是它；选择形态刻意不渲染——没有输入框，
 *  chips 点了无处可发；宿主不传发送通道时同理整行退场）。读作 label + chips；
 *  没有行时返回 null。 */
window.__starters = () => {
  const strip = document.querySelector('[data-welcome-project-strip]')
  if (!strip) return null
  const stripCol = strip.parentElement
  const row = stripCol.nextElementSibling?.firstElementChild
  if (!row) return null
  const gb = (el) => {
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }
  }
  const chips = [...row.querySelectorAll('span')].slice(1)
  return {
    label: row.firstElementChild?.textContent.trim() ?? null,
    texts: chips.map((c) => c.textContent.trim()),
    stripBox: gb(stripCol),
    rowBox: gb(row),
    chips: chips.map((c) => ({
      text: c.textContent.trim(),
      box: gb(c),
      radius: getComputedStyle(c).borderRadius,
      fontSize: getComputedStyle(c).fontSize,
    })),
  }
}
// Counted outside __reset: a subscription installed per reset would count each
// write once per reset, and the whole point is "exactly one write per click".
window.__writes = 0
useNewTaskStore.subscribe(() => { window.__writes = (window.__writes || 0) + 1 })
window.__reset = () => {
  window.__opened = null
  useNewTaskStore.getState().setProjectId(null)
  window.__writes = 0
  return true
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
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

/** One card's box, its two rows and its trailing button — the layout facts. */
const cardState = (name) =>
  page.evaluate((projectName) => {
    const card = [...document.querySelectorAll('div[role="button"]')].find((c) => c.textContent.includes(projectName))
    if (!card) return null
    const box = card.getBoundingClientRect()
    const cs = getComputedStyle(card)
    const rows = [...card.children].map((r) => {
      const rb = r.getBoundingClientRect()
      return { text: r.textContent, top: rb.top, bottom: rb.bottom, height: rb.height }
    })
    const line = card.children[1]
    const lb = line?.getBoundingClientRect()
    const button = line?.querySelector('button')
    const bb = button?.getBoundingClientRect()
    // The line's own text (no time prefix on the fallback), so "the button
    // follows the hint" can be told apart from "the hint stretched".
    const textRight = line?.children[0]?.getBoundingClientRect().right
    // The row's text span is the one before the button (always the last child):
    // the empty row is [text, button], a quoted one [time, text, button].
    const kids = line ? [...line.children] : []
    const textColor = kids.length ? getComputedStyle(kids[Math.max(0, kids.length - 2)]).color : null
    const buttonColor = button ? getComputedStyle(button).color : null
    return {
      width: box.width,
      height: box.height,
      // The selection is a `background` shorthand wash, so it lands in
      // backgroundImage and clears the colour: plain = CARD_BG + no gradient.
      bg: cs.backgroundColor,
      bgImage: cs.backgroundImage,
      contentRight: box.right - parseFloat(cs.paddingRight),
      rows,
      line: lb ? { top: lb.top, bottom: lb.bottom, height: lb.height, right: lb.right, text: line.textContent } : null,
      textRight,
      textColor,
      buttonColor,
      button: bb ? { label: button?.textContent, left: bb.left, right: bb.right, top: bb.top, height: bb.height } : null,
    }
  }, name)

/** Text of the card whose name matches — the line's content, never its box. */
const lineText = (name) =>
  page.evaluate((projectName) => {
    const card = [...document.querySelectorAll('div[role="button"]')].find((c) => c.textContent.includes(projectName))
    return card?.children[1]?.textContent ?? null
  }, name)

await page.evaluate(() => window.__mount({ locale: 'zh' }))
await page.waitForSelector('div[role="button"]')
// The quote is one IPC hop behind the render, so wait for it rather than for a
// bare timeout — the card paints its title until it lands.
await page.waitForFunction(() => document.body.textContent.includes(window.__QUOTE))

// ── 1 · the two shapes of the line ──
// Both rows are one shape — text, then an icon-only play button — so it is the
// button's accessible name that tells them apart (`exact` because the card is
// itself role="button" and its name swallows the row's own text).
const startPlay = page.getByRole('button', { name: '在此项目开始新任务', exact: true })
const continuePlay = page.getByRole('button', { name: '继续对话', exact: true })
const emptyLine = await lineText('空白项目')
const usedLine = await lineText('在用的项目')
check('a project with no conversation reads 立即开始', emptyLine === '立即开始', emptyLine)
check('…and carries a play button like every other card', (await startPlay.count()) === 1)
check('a project with one keeps the quote line', /^1天前：把周报整理一下/.test(usedLine ?? ''), usedLine)
check(
  '…with the plain continue button, and no 立即开始',
  (await continuePlay.count()) === 1 && usedLine?.includes('立即开始') === false && (await startPlay.count()) === 1,
)

// ── 2 · the row still fits the card (this is why the probe exists) ──
const empty = await cardState('空白项目')
const used = await cardState('在用的项目')
check('the fallback line renders one row', empty.rows.length === 2, `${empty.rows.length} row(s)`)
check(
  'text and button share the row',
  Math.abs(empty.button.top - empty.rows[1].top) < 12 && empty.button.height <= empty.rows[1].height + 1,
  `button top ${empty.button.top.toFixed(1)} in row ${empty.rows[1].top.toFixed(1)}..${empty.rows[1].bottom.toFixed(1)}`,
)
check('the line stays inside the card', empty.line.right <= empty.contentRight + 0.5, `${empty.line.right.toFixed(1)} <= ${empty.contentRight.toFixed(1)}`)
check(
  'the button follows the text (neither stretches)',
  empty.button.left - empty.textRight < 6 && empty.button.right < empty.contentRight - 20,
  `text ends ${empty.textRight.toFixed(1)}, button ${empty.button.left.toFixed(1)}..${empty.button.right.toFixed(1)} of ${empty.contentRight.toFixed(1)}`,
)
check('the empty card keeps the 72px floor', Math.abs(empty.height - 72) < 0.5, `${empty.height.toFixed(1)}px`)
check('both cards are the same height', Math.abs(empty.height - used.height) < 0.5, `${empty.height.toFixed(1)} vs ${used.height.toFixed(1)}`)
check(
  'both rows carry the same 20px play button',
  Math.abs(empty.button.height - used.button.height) < 0.5 && Math.abs(empty.button.height - 20) < 0.5,
  `${empty.button.height.toFixed(1)} vs ${used.button.height.toFixed(1)}`,
)
check('neither card is washed before anything is picked', empty.bgImage === 'none' && empty.bg === 'rgb(247, 247, 248)', `${empty.bg} / ${empty.bgImage}`)
check(
  '立即开始 wears the play button’s ink',
  empty.textColor === 'rgb(153, 153, 153)' && empty.textColor === empty.buttonColor,
  `text ${empty.textColor} vs button ${empty.buttonColor}`,
)
check(
  'a quote stays darker than the button that acts on it',
  used.textColor === 'rgb(136, 136, 136)' && used.buttonColor === 'rgb(153, 153, 153)',
  `text ${used.textColor} vs button ${used.buttonColor}`,
)

// ── 3 · the play button opens the conversation, and only that ──
await page.evaluate(() => window.__reset())
await continuePlay.click()
await page.waitForTimeout(120)
check('play opens the project’s latest conversation', (await page.evaluate(() => window.__opened)) === 'c1')
check(
  'play does not also target the project',
  (await page.evaluate(() => window.__selected())) === null,
  String(await page.evaluate(() => window.__selected())),
)

// ── 4 · the empty card's play targets the project — once, and nothing else ──
await page.evaluate(() => window.__reset())
await startPlay.click()
await page.waitForTimeout(120)
const afterStart = await page.evaluate(() => ({ selected: window.__selected(), writes: window.__writes, opened: window.__opened }))
check('play on a 立即开始 row targets that project', afterStart.selected === 'p_empty', String(afterStart.selected))
check('the card’s own click does not also fire', afterStart.writes === 1, `${afterStart.writes} store write(s)`)
check('it opens nothing (there is nothing to open)', afterStart.opened === null, String(afterStart.opened))
// 两形态（2026-11-04 裁定）：targeting 不再点亮网格里的卡——选中即压缩，wash
// 挪到横条上（同一 selectedWash 配方），网格整组退场。
const strip = await page.evaluate(() => {
  const el = document.querySelector('[data-welcome-project-strip]')
  if (!el) return null
  const cs = getComputedStyle(el)
  return { bg: cs.backgroundColor, bgImage: cs.backgroundImage, name: el.textContent ?? '' }
})
check(
  'the targeted project compresses into the wash-wearing strip',
  strip !== null && strip.bgImage.includes('linear-gradient') && strip.name.includes('空白项目'),
  strip ? `${strip.bg} / ${strip.bgImage.slice(0, 40)}…` : 'null',
)
check('the grid leaves with the selection', await page.evaluate(() => document.querySelector('[data-action="create-project"]') === null))
await page.screenshot({ path: join(SHOTS, 'zh.png'), clip: { x: 0, y: 0, width: 1000, height: 300 } })

// ── 5 · EN fits the same card ──
await page.evaluate(() => {
  window.__reset()
  window.__mount({ locale: 'en' })
})
await page.waitForSelector('div[role="button"]')
await page.waitForTimeout(150)
const enLine = await lineText('空白项目')
const en = await cardState('空白项目')
const enStart = await page.getByRole('button', { name: 'Start a new task in this project', exact: true }).count()
check('EN: the row reads “Start now” over the same play button', enLine === 'Start now' && enStart === 1, `${enLine} / ${enStart} button(s)`)
check('EN: the line still fits', en.line.right <= en.contentRight + 0.5, `${en.line.right.toFixed(1)} <= ${en.contentRight.toFixed(1)}`)
check('EN: the card keeps its height', Math.abs(en.height - 72) < 0.5, `${en.height.toFixed(1)}px`)
await page.screenshot({ path: join(SHOTS, 'en.png'), clip: { x: 0, y: 0, width: 1000, height: 300 } })

// ── 6 · the 新建项目 card — with projects, as it always was ──
await page.evaluate(() => window.__mount({}))
await page.waitForSelector('div[role="button"]')
await page.waitForTimeout(150)
const withProjects = await page.evaluate(() => window.__createCard())
check(
  'with projects: the create card is the grid’s last cell',
  !!withProjects && withProjects.last && withProjects.siblings === 3 && withProjects.columnCount === 3,
  withProjects ? `${withProjects.siblings} cells in ${withProjects.columnCount} columns, last=${withProjects.last}` : 'no card',
)
check('with projects: no 还没有项目 panel (there are projects to show)', withProjects?.emptyBox == null, String(withProjects?.emptyText))
// The three-column grid's cell width: (952 - 2*14) / 3, and a project card is
// exactly that wide — the create card must read as one of them.
const threeColWidth = (952 - 2 * 14) / 3
check(
  'with projects: it takes a project card’s own cell width',
  !!withProjects && Math.abs(withProjects.box.width - threeColWidth) < 0.5,
  `${withProjects?.box.width.toFixed(1)} vs ${threeColWidth.toFixed(1)}`,
)

// ── 7 · the empty state: ONE card (the merge) ──
// Before the merge the page showed the explanation as a grey panel (2 of 3
// columns) beside the dashed create card (the third), both saying the same
// thing. Now they are a single full-row card: transparent, grey dashed, titled
// 立即创建项目 (user request 2026-09-18).
//
// Park the pointer first. Section 4 left the real mouse on a play button, and
// this card spans the whole row — its box covers exactly that spot — so whether
// the card's own onMouseEnter has fired by the time the dashed recipe is read is
// a race (the card paints #666 on hover, and a run that read it measured 44/45;
// reproduced at HEAD too, so it predates dark mode). The hover is a real
// behaviour and is tested with a real mouse further down; this line only makes
// the resting-state read deterministic.
await page.mouse.move(0, 0)
await page.evaluate(() => {
  window.__calls = []
  window.__mount({ projects: [] })
})
// No waitForSelector: the card's absence IS one of the things under test, so it
// has to come back as a FAIL line rather than a 30s timeout that kills the run.
await page.waitForTimeout(250)
const emptyState = await page.evaluate(() => window.__createCard())
check(
  'no projects: explanation and create action are ONE element (the merge)',
  !!emptyState && emptyState.emptyIsCard === true && emptyState.siblings === 1 && emptyState.last,
  emptyState ? `sameEl=${emptyState.emptyIsCard} cells=${emptyState.siblings} last=${emptyState.last}` : 'no card',
)
check(
  'no projects: it spans the whole grid row',
  !!emptyState &&
    emptyState.emptyColumns === 'span 3' &&
    Math.abs(emptyState.box.width - emptyState.gridBox.width) < 0.5 &&
    Math.abs(emptyState.box.left - emptyState.gridBox.left) < 0.5 &&
    Math.abs(emptyState.box.right - emptyState.gridBox.right) < 0.5,
  emptyState ? `${emptyState.emptyColumns} / ${emptyState.box.width.toFixed(1)} of ${emptyState.gridBox.width.toFixed(1)}` : 'no card',
)
check(
  'no projects: the title reads 立即创建项目, with the hint under it',
  !!emptyState &&
    emptyState.emptyLines.length === 2 &&
    emptyState.emptyLines[0].text === '立即创建项目' &&
    emptyState.emptyLines[1].text.includes('给项目一个专属文件夹') &&
    emptyState.emptyLines[1].top >= emptyState.emptyLines[0].bottom - 0.5,
  emptyState ? emptyState.emptyLines.map((l) => l.text).join(' | ') : 'no card',
)
check(
  'no projects: the card is a real <button>, not a clickable div',
  emptyState?.tag === 'BUTTON' && emptyState?.type === 'button',
  `${emptyState?.tag}:${emptyState?.type} "${emptyState?.text}"`,
)
// Both lines sit on the card's horizontal centre (the full-row card reads as
// one centred affordance, not a left-aligned paragraph).
check(
  'no projects: both lines are centred on the card’s axis',
  !!emptyState &&
    emptyState.paint.textAlign === 'center' &&
    emptyState.emptyLines.every((l) => Math.abs((l.left + l.right) / 2 - (emptyState.box.left + emptyState.box.right) / 2) <= 1),
  emptyState
    ? `${emptyState.paint.textAlign} · ` +
        emptyState.emptyLines.map((l) => ((l.left + l.right) / 2).toFixed(1)).join(' | ') +
        ` vs ${((emptyState.box.left + emptyState.box.right) / 2).toFixed(1)}`
    : 'no card',
)
check(
  'no projects: the dashed recipe + the page’s own type scale',
  !!emptyState &&
    emptyState.paint.borderStyle === 'dashed' &&
    emptyState.paint.borderWidth === '1px' &&
    emptyState.paint.borderColor === 'rgb(200, 200, 204)' &&
    emptyState.paint.radius === '16px' &&
    emptyState.paint.minHeight === '72px' &&
    emptyState.paint.background === 'rgba(0, 0, 0, 0)' &&
    emptyState.fontMatchesPage &&
    emptyState.paint.cursor === 'pointer',
  emptyState
    ? `${emptyState.paint.borderStyle} ${emptyState.paint.borderColor} r${emptyState.paint.radius} min${emptyState.paint.minHeight} fontInherited=${emptyState.fontMatchesPage} on ${emptyState.paint.background}`
    : 'no card',
)
// The floor, not a fixed height: the card is alone in the row, so it takes the
// height its two lines want — never below the 72px floor.
check(
  'no projects: the card clears the 72px floor with both lines inside',
  !!emptyState &&
    emptyState.box.height >= 71.5 &&
    emptyState.emptyLines.every((l) => l.top >= emptyState.box.top - 0.5 && l.bottom <= emptyState.box.bottom + 0.5),
  emptyState ? `${emptyState.box.height.toFixed(1)}px, ${emptyState.emptyLines.length} line(s) inside` : 'no card',
)
// A real mouse: the dashed recipe darkens on hover (inline handlers, so this is
// the only layer that can see it). The title inherits the button's color, so it
// darkens with it.
if (emptyState) {
  // Park the pointer off the card first: the previous section's click left it
  // inside the grid's area, and the merged card spans the whole row — moving
  // within the same element fires no mouseover, so the hover handlers would
  // never run and the check would read the resting paint.
  await page.mouse.move(0, 0)
  await page.waitForTimeout(120)
  await page.mouse.move(emptyState.box.left + emptyState.box.width / 2, emptyState.box.top + emptyState.box.height / 2)
  await page.waitForTimeout(200)
}
const createHover = await page.evaluate(() => {
  const b = document.querySelector('[data-action="create-project"]')
  const cs = getComputedStyle(b)
  return { borderColor: cs.borderTopColor, color: cs.color }
})
check(
  'no projects: it answers the pointer (border and title darken)',
  createHover.borderColor === 'rgb(102, 102, 102)' && createHover.color === 'rgb(68, 68, 68)',
  `${createHover.borderColor} / ${createHover.color}`,
)
await page.mouse.move(0, 0)
await page.waitForTimeout(200)
await page.screenshot({ path: join(SHOTS, 'no-projects.png'), clip: { x: 0, y: 0, width: 1000, height: 300 } })

// A click — and Enter, since it takes focus — reaches the create modal, and
// neither writes a project (nothing is created until the modal is submitted).
if (emptyState) {
  await page.mouse.click(emptyState.box.left + emptyState.box.width / 2, emptyState.box.top + emptyState.box.height / 2)
  await page.waitForTimeout(400)
}
const modalByMouse = await page.evaluate(() => window.__modal())
check('no projects: a click opens the create modal', !!modalByMouse && modalByMouse.inputs.some((p) => p.includes('my-app')), JSON.stringify(modalByMouse))
check(
  'no projects: …and writes nothing (the modal’s 保存 is what creates)',
  !(await page.evaluate(() => window.__calls)).includes('projectCreate'),
  (await page.evaluate(() => window.__calls)).join(', '),
)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
const focusable = await page.evaluate(() => {
  const b = document.querySelector('[data-action="create-project"]')
  if (!b) return false
  b.focus()
  return document.activeElement === b
})
if (focusable) {
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
}
check('no projects: Enter opens it too (the card is focusable)', focusable && (await page.evaluate(() => window.__modal())) != null, `focusable=${focusable}`)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// ── 8 · EN in the empty state: the same merged card, translated ──
await page.evaluate(() => window.__mount({ locale: 'en', projects: [] }))
await page.waitForTimeout(250)
const enEmpty = await page.evaluate(() => window.__createCard())
check(
  'EN no projects: the merged card is translated, not hard-coded',
  !!enEmpty &&
    enEmpty.emptyIsCard === true &&
    enEmpty.emptyLines[0]?.text === 'Create a project now' &&
    (enEmpty.emptyLines[1]?.text ?? '').includes('own folder'),
  enEmpty ? enEmpty.emptyLines.map((l) => l.text).join(' | ') : 'no card',
)
check(
  'EN no projects: it still spans the row',
  !!enEmpty && Math.abs(enEmpty.box.width - enEmpty.gridBox.width) < 0.5 && enEmpty.emptyColumns === 'span 3',
  enEmpty ? `${enEmpty.box.width.toFixed(1)} / ${enEmpty.emptyColumns}` : 'no card',
)
await page.screenshot({ path: join(SHOTS, 'no-projects-en.png'), clip: { x: 0, y: 0, width: 1000, height: 300 } })

// ── 9 · the 试试 row lives ONLY in the compressed form ──
// 2026-09-18: project mode gained the same 「试试」 affordance chat mode has.
// 2026-11-04 追加裁定：选择形态（无输入框）撤掉——chips 点了无处可发，点了
// 就是「没反应」；已选形态（压缩横条）composer 已挂载，chips 才有用。The
// chips are spans with an inline onClick, so the send handoff is invisible
// to jsdom and to reading the source — it has to be clicked for real.
// 二次裁定（同日）：点击即发送，不再经草稿。
const ZH_STARTERS = ['看一下这个项目里的文件，给我讲讲整体结构', '根据项目里的资料，帮我写一份项目说明', '找出项目里值得改进的地方，给出建议']
const EN_STARTERS = [
  'Look through this project’s files and walk me through its structure',
  'Write a project overview from the material in this folder',
  'Find what is worth improving in this project and suggest fixes',
]
await page.evaluate(() => {
  window.__sent = []
  window.__reset()
  window.__mount({})
})
await page.waitForSelector('[data-action="create-project"]')
await page.waitForTimeout(200)
check(
  'the selection form has no 试试 row (no composer to send from)',
  await page.evaluate(() => !(document.querySelector('[data-welcome-shake="projectPicker"]')?.textContent ?? '').includes('试试')),
)
// Selecting compresses to the strip, whose composers-adjacent starters appear.
await page.evaluate(() => window.__pick('p_empty'))
await page.waitForSelector('[data-welcome-project-strip]')
await page.waitForTimeout(200)
const zhStarters = await page.evaluate(() => window.__starters())
check(
  'the compressed form carries the 试试 row',
  !!zhStarters && zhStarters.label === '试试' && JSON.stringify(zhStarters.texts) === JSON.stringify(ZH_STARTERS),
  zhStarters ? `${zhStarters.label} / ${zhStarters.texts.length} chip(s)` : 'no row',
)
check(
  '…strictly below the strip',
  !!zhStarters && zhStarters.rowBox.top >= zhStarters.stripBox.bottom - 0.5,
  zhStarters ? `row ${zhStarters.rowBox.top.toFixed(1)} >= strip ${zhStarters.stripBox.bottom.toFixed(1)}` : 'no row',
)
check(
  'each starter is a pill from the shared chip',
  !!zhStarters && zhStarters.chips.every((c) => c.radius === '999px' && c.fontSize === '13px'),
  zhStarters ? zhStarters.chips.map((c) => `${c.radius}/${c.fontSize}`).join(', ') : 'no row',
)
if (zhStarters?.chips[1]) {
  const c = zhStarters.chips[1]
  await page.mouse.click(c.box.left + c.box.width / 2, c.box.top + c.box.height / 2)
  await page.waitForTimeout(120)
}
// 2026-11-04 用户裁定（翻转「只落草稿」）：点一下就是发送，不再要求按第二次。
check(
  'clicking a project starter SENDS it (one click, no draft pass-through)',
  JSON.stringify(await page.evaluate(() => window.__sent)) === JSON.stringify([ZH_STARTERS[1]]),
  `sent=${JSON.stringify(await page.evaluate(() => window.__sent))}`,
)
await page.screenshot({ path: join(SHOTS, 'starters-zh.png'), clip: { x: 0, y: 0, width: 1000, height: 380 } })

// ── 9b · no send channel, no chips (dead pills are worse than none) ──
// 未配置 API 密钥时宿主不传 onStarterSend（composer 也不挂）：这时整行退场。
await page.evaluate(() => {
  window.__sent = []
  window.__mount({ withSend: false })
  window.__pick('p_empty')
})
await page.waitForSelector('[data-welcome-project-strip]')
await page.waitForTimeout(200)
check(
  'without a send channel the 试试 row is not rendered at all',
  (await page.evaluate(() => window.__starters())) === null,
)

// ── 10 · the starters are translated, not hard-coded ──
await page.evaluate(() => {
  window.__mount({ locale: 'en' })
  window.__pick('p_empty')
})
await page.waitForSelector('[data-welcome-project-strip]')
await page.waitForTimeout(200)
const enStarters = await page.evaluate(() => window.__starters())
check(
  'EN: the 试试 row is “Try” over the translated prompts',
  !!enStarters && enStarters.label === 'Try' && JSON.stringify(enStarters.texts) === JSON.stringify(EN_STARTERS),
  enStarters ? `${enStarters.label} / ${enStarters.texts.join(' | ')}` : 'no row',
)
await page.screenshot({ path: join(SHOTS, 'starters-en.png'), clip: { x: 0, y: 0, width: 1000, height: 380 } })

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed · shots in ${SHOTS}`)
process.exit(failed.length === 0 ? 0 : 1)
