/**
 * Panel answer-path probe (real Chromium, no extension loaded).
 *
 * The panel's *decision* surface — the ask_user chips / custom answer, the
 * approval buttons, and the 模型下拉 — has to turn a **real** click into the
 * right `chrome.runtime` message, carrying `callId === toolUseId` where the
 * message is correlated to a parked call. Nothing else covers that link: jsdom
 * has no layout engine and no shadow-DOM cascade, so the panel cannot even be
 * mounted in the vitest suite, and the worker half
 * (`extension-panel-bridge.test.ts`) starts from a request that already looks
 * well-formed.
 *
 * Hence a real browser with a stubbed `chrome.runtime`: the production `App`
 * runs untouched, a real mouse click lands on the chip (so a hidden, covered or
 * `pointer-events: none` chip fails here instead of confusing a user), and the
 * messages the panel *would* send are asserted. No desktop app, no LLM calls —
 * the stub answers `panel/attach` with a fixture snapshot, so this cannot spend
 * the user's quota or disturb a running PulseMind.
 *
 * Run: node scripts/probe-panel-ask-user.mjs   (exit code = failed checks)
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-ask-probe-')), 'harness.js')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { App } from './src/extension/ui/App'

const host = document.createElement('div')
host.setAttribute('data-pulsemind-panel', '')
host.style.cssText = 'position:fixed; inset:0; width:380px; height:760px;'
const shadow = host.attachShadow({ mode: 'open' })
const rootEl = document.createElement('div')
rootEl.className = 'pm-root'
shadow.appendChild(rootEl)
document.body.appendChild(host)
createRoot(rootEl).render(<App />)
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.extension.json',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning', treeShaking: false,
})

const ASK_BLOCK_ID = 'toolu_ask_1'
const HELD_BLOCK_ID = 'toolu_hold_1'

/** One transcript: the model asked a question, and a page write is held. */
const fixture = ({ choices, multi = false, status = 'awaiting_user_input' }) => ({
  sessionId: 'ws_1',
  connection: { state: 'open', connected: true },
  panelOpen: true,
  messages: [
    { id: 'm1', role: 'user', contentBlocks: [{ type: 'text', text: '帮我订票' }], createdAt: '2026-09-15T10:00:00.000Z' },
    {
      id: 'm2', role: 'assistant', createdAt: '2026-09-15T10:00:00.000Z',
      contentBlocks: [
        { type: 'text', text: '要往哪个城市订？' },
        { type: 'tool_use', id: ASK_BLOCK_ID, name: 'ask_user', status: 'running', input: { prompt: '要往哪个城市订？', choices, multi } },
        { type: 'tool_use', id: HELD_BLOCK_ID, name: 'page_click', status: 'pending', input: { index: 3 } },
      ],
    },
  ],
  streamingBlocks: [],
  status,
  sessions: [{ sessionId: 'ws_1', title: '订票' }],
  approvalMode: 'auto',
  model: {
    profiles: [
      { id: 'p1', name: 'GPT-4o', provider: 'openai', model: 'gpt-4o' },
      { id: 'p2', name: '智谱 GLM-4', provider: 'zhipu', model: 'glm-4' },
    ],
    activeId: 'p1',
  },
})

/** Installed as a plain <script> before the bundle: the panel talks to its
 *  worker through chrome.runtime, which a normal page does not have. */
const stub = (snapshot) => `
window.__sent = [];
window.__snapshot = ${JSON.stringify(snapshot)};
if (typeof chrome === 'undefined' || !chrome) { window.chrome = {}; }
chrome.runtime = {
  sendMessage: async (msg) => {
    window.__sent.push(JSON.parse(JSON.stringify(msg)));
    if (msg.type === 'panel/attach') return { ok: true, snapshot: window.__snapshot };
    return { ok: true };
  },
  onMessage: { addListener: () => {} },
  openOptionsPage: () => {},
};
`

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch()

/** Mount one fixture in its own page and hand back the shadow root locator. */
async function open(snapshot) {
  const page = await browser.newPage({ viewport: { width: 500, height: 800 } })
  page.on('pageerror', (e) => check('no page error', false, e.message))
  await page.setContent('<!doctype html><html><body style="margin:0"></body></html>')
  await page.addScriptTag({ content: stub(snapshot) })
  await page.addScriptTag({ path: OUT })
  await page.waitForFunction(() => window.__ready === true)
  await page.waitForTimeout(400)
  return { page, root: page.locator('[data-pulsemind-panel]') }
}

/** Messages the panel sent with this `type`, newest last. */
const sent = (page, type) => page.evaluate((t) => window.__sent.filter((m) => m.type === t), type)

// ── 1. Chip answer (the reported symptom) ──────────────────────────────
{
  console.log('== ask_user choices (array) ==')
  const { page, root } = await open(fixture({ choices: ['北京', '上海', '广州'] }))

  check('the ask card renders its prompt', (await root.locator('.pm-ask-prompt').textContent()) === '要往哪个城市订？')
  const chips = await root.locator('.pm-chip-choice').allTextContents()
  check('every choice becomes a chip', JSON.stringify(chips) === JSON.stringify(['北京', '上海', '广州']), JSON.stringify(chips))

  // A real mouse click: fails if the chip is hidden, covered or unbindable.
  await root.locator('.pm-chip-choice').first().click()
  await page.waitForTimeout(300)

  const answers = await sent(page, 'panel/answer')
  check('clicking a chip sends exactly one answer', answers.length === 1, JSON.stringify(answers))
  check('the answer carries the tool block id as callId', answers[0]?.callId === ASK_BLOCK_ID, String(answers[0]?.callId))
  check('the answer carries the chip label', answers[0]?.response === '北京', String(answers[0]?.response))
  await page.close()
}

// ── 2. Choices the model emitted as a comma-separated string ───────────
{
  console.log('== ask_user choices (comma-separated string) ==')
  const { page, root } = await open(fixture({ choices: '北京, 上海, 广州' }))
  const chips = await root.locator('.pm-chip-choice').allTextContents()
  check('a string choices value still splits into chips', JSON.stringify(chips) === JSON.stringify(['北京', '上海', '广州']), JSON.stringify(chips))
  await root.locator('.pm-chip-choice').nth(1).click()
  await page.waitForTimeout(300)
  const answers = await sent(page, 'panel/answer')
  check('the second chip answers with its own label', answers[0]?.response === '上海', String(answers[0]?.response))
  await page.close()
}

// ── 3. Custom answer ───────────────────────────────────────────────────
{
  console.log('== ask_user custom answer ==')
  const { page, root } = await open(fixture({ choices: ['北京', '上海'] }))
  await root.locator('.pm-ask-input').fill('杭州')
  await root.locator('.pm-ask-input').press('Enter')
  await page.waitForTimeout(300)
  const answers = await sent(page, 'panel/answer')
  check('Enter in the custom input answers with the typed text', answers[0]?.response === '杭州', JSON.stringify(answers))
  check('the custom answer carries the tool block id', answers[0]?.callId === ASK_BLOCK_ID, String(answers[0]?.callId))
  await page.close()
}

// ── 4. Multi-select confirm ────────────────────────────────────────────
{
  console.log('== ask_user multi-select ==')
  const { page, root } = await open(fixture({ choices: ['北京', '上海', '广州'], multi: true }))
  await root.locator('.pm-chip-choice').nth(0).click()
  await root.locator('.pm-chip-choice').nth(2).click()
  await page.waitForTimeout(200)
  check('picking a chip alone sends nothing yet', (await sent(page, 'panel/answer')).length === 0)
  check('selected chips are marked', (await root.locator('.pm-chip-choice-on').count()) === 2)
  await root.locator('.pm-cmd-btn-primary').click()
  await page.waitForTimeout(300)
  const answers = await sent(page, 'panel/answer')
  check('确认 joins the selected labels', answers[0]?.response === '北京, 广州', String(answers[0]?.response))
  await page.close()
}

// ── 5. Held tool call: the approval strip below the header ────────────
{
  console.log('== held page tool (approval) ==')
  const { page, root } = await open(fixture({ choices: ['北京'], status: 'awaiting_approval' }))

  const held = root.locator('.pm-tool').filter({ hasText: 'page_click' })
  check('the held call is marked 待批准', (await held.locator('.pm-tool-hint').textContent()) === '待批准')
  // The decision sits below the collapsed header (the chat's ApprovalArea rule too,
  // where those buttons otherwise hide behind two collapsed layers). Nothing here
  // clicks the header: if the strip needs expanding, this fails.
  const approve = held.locator('.pm-approve-btn-primary')
  check('运行 is reachable without expanding the card', (await approve.count()) === 1)
  check('the card body stayed shut — the strip is what was clicked', (await held.locator('.pm-cmd').count()) === 0)
  await approve.click()
  await page.waitForTimeout(300)

  const approvals = await sent(page, 'panel/approval-response')
  check('批准 sends the decision for that call', approvals[0]?.callId === HELD_BLOCK_ID && approvals[0]?.approved === true, JSON.stringify(approvals))
  check('approving does not double as opening the card', (await held.locator('.pm-cmd').count()) === 0)

  await held.locator('.pm-approve-btn').first().click()
  await page.waitForTimeout(300)
  const both = await sent(page, 'panel/approval-response')
  check('跳过 sends a rejection for that call', both[1]?.callId === HELD_BLOCK_ID && both[1]?.approved === false, JSON.stringify(both[1]))
  await page.close()
}

// ── 6. 模型下拉:一次选择 → 一条 panel/set-model ─────────────────────────
{
  console.log('== 模型下拉 ==')
  const { page, root } = await open(fixture({ choices: ['北京'] }))

  check('模型按钮回显当前生效的档位', (await root.locator('.pm-model-label').textContent()) === 'GPT-4o')
  // A real mouse click on the trigger: a covered or unclickable control fails
  // here rather than in the user's face.
  await root.locator('.pm-model').click()
  await page.waitForTimeout(200)
  const items = await root.locator('.pm-model-item').allTextContents()
  check('菜单列出设置里的全部 profiles', JSON.stringify(items) === JSON.stringify(['GPT-4o', '智谱 GLM-4']), JSON.stringify(items))

  await root.locator('.pm-model-item').nth(1).click()
  await page.waitForTimeout(300)
  const switches = await sent(page, 'panel/set-model')
  check('点一项只发一条 panel/set-model', switches.length === 1, JSON.stringify(switches))
  check('带着被点那一项的 profileId', switches[0]?.profileId === 'p2', String(switches[0]?.profileId))
  check('菜单随即关闭', (await root.locator('.pm-model-menu').count()) === 0)
  // The panel does not wait for the service to answer before updating: the
  // switch is visible immediately (and rolled back only if the request fails).
  check('按钮文案立刻跟上所选档位', (await root.locator('.pm-model-label').textContent()) === '智谱 GLM-4')
  await page.close()
}

// ── 7. 授权下拉:点一项 → 一条 panel/set-approval ────────────────────────
// Same dropdown shell as 模型, and the same shadow-boundary trap: the outside-
// click close has to look at `composedPath()`, not at the retargeted `e.target`.
// A real mouse click is the only thing that shows the difference — the menu used
// to close on mousedown and swallow the choice.
{
  console.log('== 授权下拉 ==')
  const { page, root } = await open(fixture({ choices: ['北京'] }))

  await root.locator('.pm-approval').click()
  await page.waitForTimeout(200)
  await root.locator('.pm-approval-item').nth(0).click()
  await page.waitForTimeout(300)

  const modes = await sent(page, 'panel/set-approval')
  check('点一项授权档位只发一条 panel/set-approval', modes.length === 1, JSON.stringify(modes))
  check('带着所点档位的 mode', modes[0]?.mode === 'always-ask', String(modes[0]?.mode))
  check('授权按钮文案跟着换', (await root.locator('.pm-approval-label').textContent()) === '始终询问')
  await page.close()
}

await browser.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.label).join('; '))
  process.exit(1)
}
