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
import { ProjectCards } from './src/renderer/src/components/welcome/ProjectCards'
import { useProjectStore } from './src/renderer/src/stores/projectStore'
import { useNewTaskStore } from './src/renderer/src/stores/newTaskStore'

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

window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    // Subscribe-style APIs must answer with a cleanup function, not a Promise.
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {}
    if (key === 'projectList') return Promise.resolve(PROJECTS)
    if (key === 'getConversationLastUserMessage') {
      return Promise.resolve(args[0] === 'c1' ? window.__QUOTE : null)
    }
    return Promise.resolve(undefined)
  },
})

window.__opened = null
let root = null
window.__mount = ({ locale = 'zh' } = {}) => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <AntdApp>
        <TranslationProvider initialLocale={locale}>
          <div style={{ width: 1000, padding: 24 }}>
            <ProjectCards
              conversations={CONVERSATIONS}
              onOpenConversation={(key) => { window.__opened = key }}
            />
          </div>
        </TranslationProvider>
      </AntdApp>
    </ConfigProvider>
  )
  return true
}

window.__selected = () => useNewTaskStore.getState().projectId
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
    const card = [...document.querySelectorAll('div[role="button"]')].find((c) =>
      c.textContent.includes(projectName)
    )
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
      line: lb
        ? { top: lb.top, bottom: lb.bottom, height: lb.height, right: lb.right, text: line.textContent }
        : null,
      textRight,
      textColor,
      buttonColor,
      button: bb
        ? { label: button?.textContent, left: bb.left, right: bb.right, top: bb.top, height: bb.height }
        : null,
    }
  }, name)

/** Text of the card whose name matches — the line's content, never its box. */
const lineText = (name) =>
  page.evaluate((projectName) => {
    const card = [...document.querySelectorAll('div[role="button"]')].find((c) =>
      c.textContent.includes(projectName)
    )
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
  (await continuePlay.count()) === 1 && usedLine?.includes('立即开始') === false && (await startPlay.count()) === 1
)

// ── 2 · the row still fits the card (this is why the probe exists) ──
const empty = await cardState('空白项目')
const used = await cardState('在用的项目')
check('the fallback line renders one row', empty.rows.length === 2, `${empty.rows.length} row(s)`)
check(
  'text and button share the row',
  Math.abs(empty.button.top - empty.rows[1].top) < 12 && empty.button.height <= empty.rows[1].height + 1,
  `button top ${empty.button.top.toFixed(1)} in row ${empty.rows[1].top.toFixed(1)}..${empty.rows[1].bottom.toFixed(1)}`
)
check('the line stays inside the card', empty.line.right <= empty.contentRight + 0.5, `${empty.line.right.toFixed(1)} <= ${empty.contentRight.toFixed(1)}`)
check(
  'the button follows the text (neither stretches)',
  empty.button.left - empty.textRight < 6 && empty.button.right < empty.contentRight - 20,
  `text ends ${empty.textRight.toFixed(1)}, button ${empty.button.left.toFixed(1)}..${empty.button.right.toFixed(1)} of ${empty.contentRight.toFixed(1)}`
)
check('the empty card keeps the 72px floor', Math.abs(empty.height - 72) < 0.5, `${empty.height.toFixed(1)}px`)
check('both cards are the same height', Math.abs(empty.height - used.height) < 0.5, `${empty.height.toFixed(1)} vs ${used.height.toFixed(1)}`)
check(
  'both rows carry the same 20px play button',
  Math.abs(empty.button.height - used.button.height) < 0.5 && Math.abs(empty.button.height - 20) < 0.5,
  `${empty.button.height.toFixed(1)} vs ${used.button.height.toFixed(1)}`
)
check('neither card is washed before anything is picked', empty.bgImage === 'none' && empty.bg === 'rgb(247, 247, 248)', `${empty.bg} / ${empty.bgImage}`)
check(
  '立即开始 wears the play button’s ink',
  empty.textColor === 'rgb(153, 153, 153)' && empty.textColor === empty.buttonColor,
  `text ${empty.textColor} vs button ${empty.buttonColor}`
)
check(
  'a quote stays darker than the button that acts on it',
  used.textColor === 'rgb(136, 136, 136)' && used.buttonColor === 'rgb(153, 153, 153)',
  `text ${used.textColor} vs button ${used.buttonColor}`
)

// ── 3 · the play button opens the conversation, and only that ──
await page.evaluate(() => window.__reset())
await continuePlay.click()
await page.waitForTimeout(120)
check('play opens the project’s latest conversation', (await page.evaluate(() => window.__opened)) === 'c1')
check('play does not also target the project', (await page.evaluate(() => window.__selected())) === null, String(await page.evaluate(() => window.__selected())))

// ── 4 · the empty card's play targets the project — once, and nothing else ──
await page.evaluate(() => window.__reset())
await startPlay.click()
await page.waitForTimeout(120)
const afterStart = await page.evaluate(() => ({ selected: window.__selected(), writes: window.__writes, opened: window.__opened }))
check('play on a 立即开始 row targets that project', afterStart.selected === 'p_empty', String(afterStart.selected))
check('the card’s own click does not also fire', afterStart.writes === 1, `${afterStart.writes} store write(s)`)
check('it opens nothing (there is nothing to open)', afterStart.opened === null, String(afterStart.opened))
const lit = await cardState('空白项目')
check(
  'the targeted card wears the wash',
  lit.bgImage.includes('linear-gradient') && lit.bg === 'rgba(0, 0, 0, 0)',
  `${lit.bg} / ${lit.bgImage.slice(0, 40)}…`
)
check('the other card stays plain', (await cardState('在用的项目')).bgImage === 'none')
await page.screenshot({ path: join(SHOTS, 'zh.png'), clip: { x: 0, y: 0, width: 1000, height: 300 } })

// ── 5 · EN fits the same card ──
await page.evaluate(() => { window.__reset(); window.__mount({ locale: 'en' }) })
await page.waitForSelector('div[role="button"]')
await page.waitForTimeout(150)
const enLine = await lineText('空白项目')
const en = await cardState('空白项目')
const enStart = await page.getByRole('button', { name: 'Start a new task in this project', exact: true }).count()
check('EN: the row reads “Start now” over the same play button', enLine === 'Start now' && enStart === 1, `${enLine} / ${enStart} button(s)`)
check('EN: the line still fits', en.line.right <= en.contentRight + 0.5, `${en.line.right.toFixed(1)} <= ${en.contentRight.toFixed(1)}`)
check('EN: the card keeps its height', Math.abs(en.height - 72) < 0.5, `${en.height.toFixed(1)}px`)
await page.screenshot({ path: join(SHOTS, 'en.png'), clip: { x: 0, y: 0, width: 1000, height: 300 } })

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed · shots in ${SHOTS}`)
process.exit(failed.length === 0 ? 0 : 1)
