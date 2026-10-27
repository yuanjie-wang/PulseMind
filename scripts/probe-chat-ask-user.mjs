/**
 * Chat ask_user probe (real Chromium).
 *
 * ask_user is the one tool whose card IS the interaction: the model's question,
 * the choice chips and the custom-answer box are rendered inline, and the card
 * has to turn into "已选择：…" (or 已由用户跳过) once the answer is in. The report
 * was that it never does — "点击答案选项后，问题框没有消失，还停留在会话区中，且处于
 * 可交互的状态".
 *
 * The answer itself is fine end to end: the click reaches the main-hosted engine,
 * `respondToTool` sets the block completed and the loop resumes. What goes wrong is
 * entirely inside the renderer, at the seam between the session mirror and the
 * memoized views:
 *
 *   - `shared/agent-session/mirror` folds a `tool_status` event by writing the new
 *     `status`/`exitCode`/`output` into the existing block object (in place), so the
 *     ToolUseBlock keeps its identity;
 *   - `chat/MessageGroup`, `chat/ExecutionSegment` and `terminal/CommandCard` are all
 *     `React.memo` and compare props by reference.
 *
 * An in-place change is therefore invisible to every one of them: the card keeps the
 * subtree React last rendered, which is the pre-answer one — chips and input box,
 * still clickable. (The desktop chat used to be immune because the engine ran in the
 * renderer and rebuilt the block, `{ ...block, status: 'completed' }`; hosting the
 * engine in main moved the mutation behind the mirror.) Nothing else in the repo can
 * see this: jsdom renders none of it, and the wire-level tests start from an event
 * that already looks well-formed.
 *
 * So this mounts the production TranscriptView on a real session mirror and answers
 * a question the way the app does — click a chip, then fold the `tool_status` event
 * the engine's answer produces through the real `applySessionEvent`:
 *
 *   1. a live question: prompt, chips and custom box all present, nothing answered yet
 *   2. the click reports that call's id and the chosen text (the wire half)
 *   3. the answer lands → chips and input are gone, the card reads 已选择：生产
 *   4. a second question skipped → the same card reads 已由用户跳过 and offers nothing
 *   5. a multi-select question (2026-10-06 row redesign): rows toggle without
 *      reporting, the checked rows carry .pm-ask-row-on, the persistent 确认
 *      reports the join
 *   6. dark: rows lift to --pm-sunk with --pm-border edges; a selected row
 *      keeps the link border
 *   7. two ask_user calls in ONE batch merge into one [data-ask-batch] card:
 *      progress badge, settled questions collapse to summaries, the rows hand
 *      over question by question, and a double click answers exactly once
 *   8. streaming thinking (2026-10-25 飞行棋卡死复盘): a pure-thinking round
 *      renders a live strip — tail preview + char count, expandable to the full
 *      plain pre — and on commit folds into a collapsible execution group whose
 *      header shows the Thinking first line (把 thinking 当作 execution)
 *
 * No Electron, no LLM calls, no extension: `window.electronAPI` is stubbed and the
 * page is plain, so this cannot touch a real PulseMind session.
 *
 * Usage: node scripts/probe-chat-ask-user.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-ask-user-')), 'harness.js')

const HARNESS = `
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { TranscriptView } from './src/renderer/src/components/chat/TranscriptView'
import { applySessionEvent, freshSessionState } from './src/shared/agent-session/mirror'

// The transcript reaches for electronAPI while rendering (FileRefChip stats a file's
// creation time); every call resolves to undefined, which every caller tolerates.
// main.tsx's boot, in order: the variable sheet, then the attribute. The chat's
// migrated surfaces read var(--pm-*), and an unset variable resolves to nothing
// (transparent / inherited) — so a probe that measures them without the sheet is
// measuring a page the app never renders (PLAN-dark-mode D7: the helper ships in
// the same change as the migration, not after it).
installThemeVars()
applyThemeAttr('light')

window.electronAPI = new Proxy({}, { get: (_t, key) => () => Promise.resolve(key === 'expertList' ? [] : undefined) })

const NOW = '2026-09-16T10:00:00.000Z'
const user = (id, text) => ({ id, role: 'user', contentBlocks: [{ type: 'text', text }], createdAt: NOW })
const question = (id, prompt) => ({ type: 'tool_use', id, name: 'ask_user', status: 'running', input: { prompt, choices: '生产, 预发, 本地' } })

/** The live question, and the mirror the session events are folded into — one
 *  object, exactly as useConversationEngine keeps it. */
const state = freshSessionState()
state.messages = [user('u1', '帮我发一版'), { id: 'a1', role: 'assistant', contentBlocks: [question('aq1', '这一版发到哪个环境？')], createdAt: NOW }]
state.agentStatus = { status: 'awaiting_user_input', tools: [state.messages[1].contentBlocks[0]] }

/** The transcript's handlers, held at module scope on purpose: App owns them as
 *  stable useCallback values, and a fresh arrow per render would hand the
 *  memoized views new props and hide the very bug this probe exists for. */
const handlers = {
  approve: () => {},
  reject: () => {},
  kill: () => {},
  respond: (toolUseId, response) => {
    window.__respondedWith = [toolUseId, response]
    window.__respondLog = [...(window.__respondLog ?? []), [toolUseId, response]]
  },
  clearError: () => {},
  retry: () => {},
}

function Harness() {
  const [, force] = useState(0)
  const rerender = () => force((n) => n + 1)
  window.__rerender = rerender
  // isRequesting is stateful so the streaming-thinking section can settle the
  // turn (the done-state chrome only lights when the engine is idle).
  const [requesting, setRequesting] = useState(true)
  window.__setRequesting = (v) => setRequesting(v)
  // Streaming tail (2026-10-25 streaming-thinking segment): non-empty blocks
  // ride a streaming status, exactly what the engine's 80ms coalesced pushes
  // look like in the mirror.
  const [streamingBlocks, setStreamingBlocks] = useState([])
  window.__setStreaming = (blocks) => {
    setStreamingBlocks(blocks)
    state.agentStatus = blocks.length > 0 ? { status: 'streaming' } : { status: 'completed' }
  }
  // The commit step: a thinking-only round lands (the max_tokens shape) while
  // the live tail clears — state is bundle-scoped, so this has to run inside.
  window.__commitThinking = (t) => {
    state.messages = [...state.messages, { id: 'a-think', role: 'assistant', contentBlocks: [{ type: 'thinking', thinking: t }], createdAt: NOW }]
    window.__setStreaming([])
  }
  // A following TEXT round — the retro-fusion trigger.
  window.__appendTextRound = (t) => {
    state.messages = [...state.messages, { id: 'a-text', role: 'assistant', contentBlocks: [{ type: 'text', text: t }], createdAt: NOW }]
    rerender()
  }
  // A committed TOOL round (executed, settled) — the user's spinning-group sequence.
  window.__appendToolRound = () => {
    state.messages = [
      ...state.messages,
      { id: 'a-tool', role: 'assistant', contentBlocks: [{ type: 'tool_use', id: 'tool-x', name: 'write', status: 'completed', exitCode: 0, input: {} }], createdAt: NOW },
      { id: 'u-result', role: 'user', contentBlocks: [{ type: 'tool_result', tool_use_id: 'tool-x', content: 'ok' }], createdAt: NOW },
    ]
    rerender()
  }

  // What the renderer's session subscription does (useConversationEngine): fold the
  // wire event into the mirror, then hand React the mirrored array. The engine
  // answered in main; the event below is the one it emits for that answer.
  window.__answered = (toolUseId, response) => {
    applySessionEvent(state, { type: 'tool_status', updates: [{ messageId: 'a1', toolUseId, status: 'completed', exitCode: 0, output: response }] })
    rerender()
  }
  // A follow-up question the user skips (rejectTool → 'rejected', in place again).
  window.__askedAgain = (prompt) => {
    const msg = { id: 'a2', role: 'assistant', contentBlocks: [question('aq2', prompt)], createdAt: NOW }
    state.messages = [...state.messages, msg]
    state.agentStatus = { status: 'awaiting_user_input', tools: [msg.contentBlocks[0]] }
    rerender()
  }
  // A multi-select question (2026-10-06 row redesign: rows toggle, 确认 joins).
  window.__askedMulti = () => {
    const msg = { id: 'a3', role: 'assistant', contentBlocks: [{ type: 'tool_use', id: 'aq3', name: 'ask_user', status: 'running', input: { prompt: '要迁移哪些库？', choices: '用户, 订单, 日志', multi: true } }], createdAt: NOW }
    state.messages = [...state.messages, msg]
    state.agentStatus = { status: 'awaiting_user_input', tools: [msg.contentBlocks[0]] }
    rerender()
  }
  // Two ask_user calls in ONE batch (one message) — the merge case.
  window.__askedBatch = () => {
    const msg = { id: 'a4', role: 'assistant', contentBlocks: [
      { type: 'tool_use', id: 'bq1', name: 'ask_user', status: 'running', input: { prompt: '先发哪个环境？', choices: '生产, 预发' } },
      { type: 'tool_use', id: 'bq2', name: 'ask_user', status: 'running', input: { prompt: '要不要打 tag？', choices: '要, 不要' } },
    ], createdAt: NOW }
    state.messages = [...state.messages, msg]
    state.agentStatus = { status: 'awaiting_user_input', tools: msg.contentBlocks }
    rerender()
  }
  window.__skipped = () => {
    applySessionEvent(state, { type: 'tool_status', updates: [{ messageId: 'a2', toolUseId: 'aq2', status: 'rejected' }] })
    rerender()
  }

  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>
      <TranslationProvider>
        <div style={{ width: 1000, padding: '12px 0', background: '#fff', fontFamily: 'system-ui' }}>
          <TranscriptView
            messages={state.messages}
            agentStatus={state.agentStatus}
            streamingBlocks={streamingBlocks}
            isRequesting={requesting}
            restoring={false}
            onApproveTool={handlers.approve}
            onRejectTool={handlers.reject}
            onKillTool={handlers.kill}
            onRespondToTool={handlers.respond}
            onClearError={handlers.clearError}
            onRetry={handlers.retry}
          />
        </div>
      </TranslationProvider>
    </ConfigProvider>
  )
}

createRoot(document.getElementById('root')).render(<Harness />)
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning', treeShaking: false,
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
// A real http origin rather than setContent: an opaque about:blank origin denies the
// localStorage access the stores behind the transcript reach for.
// The motion kill is the same sheet probe-theme-dark injects, scoped the same way
// (inside #root only — antd portals its dropdown/menu motion to <body>, and a
// document-wide kill leaves the open animation stuck so the menu never becomes
// visible): the transcript now plays entrance/collapse micro-animations
// (chat/motion.tsx), and getComputedStyle reports MID-ANIMATION values — a box
// measured during the 0.22s entrance would fail these geometry checks on the
// animation, not on the code under test.
const PAGE = '<!doctype html><html><head><style>#root *,#root *::before,#root *::after{animation:none!important;transition:none!important}</style></head><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.waitForTimeout(300)

/** A chip by its label, and whether it is still on screen. antd's Button inserts a
 *  space between two CJK characters (autoInsertSpace), so the DOM reads 生 产 —
 *  match with the whitespace optional rather than against the source string. */
const cjk = (label) => new RegExp(label.split('').join('\\s*'))
const chip = (label) => page.locator('button', { hasText: cjk(label) })
const chips = () => page.locator('button', { hasText: /^(生\s*产|预\s*发|本\s*地)$/ })
const customBox = () => page.locator('input[placeholder="输入自定义回答..."]')
const chosen = (value) => page.getByText(`已选择：${value}`, { exact: false })
const skipped = () => page.getByText('已由用户跳过', { exact: false })

// ── 1. A live question offers its choices and nothing else ──
{
  console.log('== 提问中 ==')
  check('问题原文可见', await page.getByText('这一版发到哪个环境？').first().isVisible())
  check('三个选项都可点', (await chips().count()) === 3, `${await chips().count()} chips`)
  check('自定义回答框在', (await customBox().count()) === 1)
  check('还没回答，卡片上没有结论', (await page.getByText('已选择：', { exact: false }).count()) === 0)

  // The skin lives in CommandCard's one injected sheet — the behavior checks
  // here cannot see it fail (an unstyled row still reads and clicks fine), so
  // pin its application on computed styles.
  const row = chips().first()
  check('选项行带行式皮肤（radius 8）', await row.evaluate((el) => getComputedStyle(el).borderRadius) === '8px')
  check('行首示能是 14px 圆盒', await row.locator('.pm-ask-afford').evaluate((el) => {
    const s = getComputedStyle(el)
    return s.width === '14px' && s.height === '14px' && s.borderRadius === '50%'
  }))
  await row.hover()
  await page.waitForTimeout(100)
  check('hover 走主题色', await row.evaluate((el) => getComputedStyle(el).borderColor) === 'rgb(22, 119, 255)')
  await page.mouse.move(0, 0)
}

// ── 2. The click reports the call it answers, with the chosen text ──
{
  console.log('== 点击选项 ==')
  await chip('生产').first().click()
  await page.waitForTimeout(150)
  const reported = await page.evaluate(() => window.__respondedWith)
  check('点击上报了这个调用的 id 与所选文案', Array.isArray(reported) && reported[0] === 'aq1' && reported[1] === '生产', JSON.stringify(reported))
}

// ── 3. The answer lands: the card must settle ──
{
  console.log('== 回答落地 ==')
  await page.evaluate(() => window.__answered('aq1', '生产'))
  await page.waitForTimeout(300)
  const left = await chips().count()
  check('选项消失', left === 0, `还剩 ${left} 个选项`)
  check('自定义回答框消失', (await customBox().count()) === 0)
  check('卡片改读 已选择：生产', await chosen('生产').first().isVisible().catch(() => false))
}

// ── 4. A skipped question settles the same way ──
{
  console.log('== 跳过 ==')
  await page.evaluate(() => window.__askedAgain('要不要一并打 tag？'))
  await page.waitForTimeout(300)
  check('追问的选项可点', (await chips().count()) === 3, `${await chips().count()} chips`)
  await page.evaluate(() => window.__skipped())
  await page.waitForTimeout(300)
  const left = await chips().count()
  check('跳过后的选项消失', left === 0, `还剩 ${left} 个选项`)
  check('卡片改读 已由用户跳过', await skipped().first().isVisible().catch(() => false))
  check('跳过只写一次结论', (await skipped().count()) === 1, `${await skipped().count()} 条 已由用户跳过`)
}

// ── 5. Multi-select: rows toggle, 确认 joins, nothing reports before it ──
{
  console.log('== 多选 ==')
  const multiRows = () => page.locator('button', { hasText: /^(用\s*户|订\s*单|日\s*志)$/ })
  await page.evaluate(() => window.__askedMulti())
  await page.waitForTimeout(300)
  // 确认常驻（2026-10-06）：未选时禁用在场，而不是首_pick 才出现
  const confirmBtn = page.getByRole('button', { name: /确\s*认/ })
  check('确认按钮常驻，未选时禁用', (await confirmBtn.count()) === 1 && (await confirmBtn.isEnabled().catch(() => false)) === false)
  const before = await page.evaluate(() => window.__respondedWith)
  await multiRows().first().click()
  await multiRows().nth(2).click()
  await page.waitForTimeout(150)
  const after = await page.evaluate(() => window.__respondedWith)
  check('多选点击只切换勾选，不上报', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after))
  check('选中行带勾选标记', (await page.locator('.pm-ask-row-on').count()) === 2, `${await page.locator('.pm-ask-row-on').count()} rows on`)
  const onRow = page.locator('.pm-ask-row-on').first()
  const skin = await onRow.evaluate((el) => {
    const afford = el.querySelector('.pm-ask-afford')
    const s = getComputedStyle(el)
    const sa = afford ? getComputedStyle(afford) : null
    return {
      rowBorder: s.borderColor,
      affordBg: sa?.backgroundColor,
      affordImg: sa?.backgroundImage.slice(0, 32),
    }
  })
  check('选中行画主题色边 + 示能画白勾', skin.rowBorder === 'rgb(22, 119, 255)' && skin.affordBg === 'rgb(22, 119, 255)' && (skin.affordImg ?? '').includes('data:image/svg+xml'), JSON.stringify(skin))
  check('选中后确认按钮可用且不带计数', (await confirmBtn.isEnabled()) && !(/项已选/.test(await confirmBtn.textContent() ?? '')))
  await confirmBtn.click()
  await page.waitForTimeout(150)
  const reported = await page.evaluate(() => window.__respondedWith)
  check('确认后上报拼接答案', Array.isArray(reported) && reported[0] === 'aq3' && reported[1] === '用户, 日志', JSON.stringify(reported))
  check('多选卡片同样带着自定义回答行', (await customBox().count()) === 1)
}

// ── 6. Dark: rows must lift off the card (--pm-sunk), not dissolve into it ──
// In dark, --pm-elevated and --pm-fill are both #1f1f1f; the sheet carries an
// html[data-theme='dark'] override to the documented one-step-up rung.
{
  console.log('== 暗色 ==')
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.waitForTimeout(100)
  // The only question still on screen is aq3 (multi) — address its rows by the
  // sheet's own class, not the single-choice label regex above. The FIRST row
  // is selected (用户 was picked in §5), and a selected row keeps the link
  // border in dark by design — the lift is asserted on an unselected row.
  const darkRow = page.locator('.pm-ask-row:not(.pm-ask-row-on)').first()
  const darkBg = await darkRow.evaluate((el) => getComputedStyle(el).backgroundColor)
  check('暗色选项行用 sunk 台阶色', darkBg === 'rgb(51, 51, 51)', darkBg)
  const darkBorder = await darkRow.evaluate((el) => getComputedStyle(el).borderColor)
  check('暗色行边框同步提亮', darkBorder === 'rgb(66, 66, 66)', darkBorder)
  const darkOnBorder = await page.locator('.pm-ask-row-on').first().evaluate((el) => getComputedStyle(el).borderColor)
  check('暗色选中行保持主题色边', darkOnBorder === 'rgb(64, 150, 255)', darkOnBorder)
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
}

// ── 7. Two questions in one batch merge into ONE card, walked in order ──
// Multiple ask_user calls in a single turn used to render as N separate cards;
// the batch card merges them, collapses settled ones to summaries and walks
// the user through the rest one at a time.
{
  console.log('== 一轮多问合并 ==')
  const batch = () => page.locator('[data-ask-batch]')
  await page.evaluate(() => window.__askedBatch())
  await page.waitForTimeout(300)

  check('两个问题合并为一张卡', (await batch().count()) === 1)
  check('只渲染当前题的选项行', (await batch().locator('.pm-ask-rows').count()) === 1)
  check('第一题的行可见', (await batch().locator('button', { hasText: /^(生\s*产|预\s*发)$/ }).count()) === 2)
  check('第二题的行尚未出现', (await batch().locator('button', { hasText: /^(要|不\s*要)$/ }).count()) === 0)
  check('进度徽标显示第 1/2 题', await batch().getByText('第 1/2 题').isVisible())

  await batch().locator('button', { hasText: cjk('生产') }).click()
  await page.waitForTimeout(150)
  let reported = await page.evaluate(() => window.__respondedWith)
  check('第一题点击即上报', Array.isArray(reported) && reported[0] === 'bq1' && reported[1] === '生产', JSON.stringify(reported))
  check('进度推进到第 2/2 题', await batch().getByText('第 2/2 题').isVisible())
  check('第一题折为已选摘要', await batch().getByText('已选择：生产').isVisible())
  check('第二题的行接棒出现', (await batch().locator('button', { hasText: /^(要|不\s*要)$/ }).count()) === 2)

  // The advance re-renders under the pointer — a double click on the last
  // question must answer it exactly once, never bleed into the next rows.
  // (The 350ms post-answer click lock has expired by now — a real user is
  // still reading the next question; the probe waits it out explicitly.)
  await page.waitForTimeout(450)
  const logBefore = await page.evaluate(() => window.__respondLog.length)
  await batch().locator('button', { hasText: /^(不\s*要)$/ }).dblclick()
  await page.waitForTimeout(200)
  reported = await page.evaluate(() => window.__respondLog)
  const last = reported[reported.length - 1]
  check('双击最后一题只上报一次', reported.length === logBefore + 1 && last[0] === 'bq2' && last[1] === '不要', JSON.stringify(reported))
  check('全部答完后选项行收场', (await batch().locator('.pm-ask-rows').count()) === 0)
  check('两题各留一条摘要', (await batch().getByText('已选择：', { exact: false }).count()) === 2)
}

// ── 8. Streaming thinking is a live strip, and it survives the commit ──
// conv_20261025172138 卡死复盘: a reasoning round streamed 45,851 thinking
// tokens over ~4 minutes while the transcript rendered NOTHING (the segment
// builder lifted only text/tool_use), and the committed thinking-only round was
// skipped too. The strip must exist while the deltas flow — with a LIVE tail
// preview, plain-text expand, no markdown parse — and the settled round must
// keep it instead of dropping the round on commit.
{
  console.log('== 流式 thinking ==')
  const HEAD = 'HEADMARKER-at-the-very-start'
  const TAIL = 'TAILMARKER-at-the-very-end'
  const thinkText = (n) => `${HEAD}-${'r'.repeat(n)}-${TAIL}`
  // Tenth ruling: streaming thinking JOINS the open execution group — the old
  // separate strip is gone. Live visibility lives in the GROUP HEADER (live
  // tail + char count + spinner); the thinking row itself is inside the group
  // body (expand to reach it).
  const liveGroupHead = () => page.locator('[data-segment-head]', { hasText: '深度思考' })

  // Mid-round: only reasoning deltas have arrived.
  const first = thinkText(2900)
  const second = thinkText(3900)
  await page.evaluate((t) => window.__setStreaming([{ type: 'thinking', thinking: t }]), first)
  await page.waitForTimeout(200)
  check('直播组在流式期间可见', (await liveGroupHead().count()) === 1)
  check('组头显示活尾巴', await page.getByText(TAIL, { exact: false }).isVisible())
  check('组头不展示开头（是尾巴不是开头）', (await page.getByText(HEAD, { exact: false }).count()) === 0)
  check('组头带字符计数', await page.getByText(`(${first.length} chars)`, { exact: false }).isVisible())
  const spinning = await page.evaluate(() => {
    const head = document.querySelector('[data-segment-head]')
    const firstChild = head?.firstElementChild
    return firstChild ? getComputedStyle(firstChild).borderRadius === '50%' : false
  })
  check('接收中组头转圈', spinning)

  // Live-ness: more deltas → the tail rotates to the new count within the
  // rotation clock (~700ms), not per tick (per tick was the flicker report).
  await page.evaluate((t) => window.__setStreaming([{ type: 'thinking', thinking: t }]), second)
  await page.waitForTimeout(900)
  check('增量轮动落地新计数（节流后到达）', await page.getByText(`(${second.length} chars)`, { exact: false }).isVisible())

  // Flicker fix: the header is [stable 深度思考 label][rotating tail] — the
  // label node SURVIVES across ticks (the whole text used to remount per tick
  // via key={displayText}, replaying the fade at streaming rate), and the tail
  // is held between rotations instead of swapping every 80ms.
  await page.evaluate(() => {
    const head = document.querySelector('[data-segment-head]')
    const span = [...(head?.querySelectorAll('span') ?? [])].find((s) => s.textContent === '深度思考')
    if (span) span.__pmAnchor = 'keep-me'
  })
  await page.evaluate((t) => window.__setStreaming([{ type: 'thinking', thinking: t }]), thinkText(4400))
  await page.waitForTimeout(120)
  const anchorAlive = await page.evaluate(() => {
    const head = document.querySelector('[data-segment-head]')
    const span = [...(head?.querySelectorAll('span') ?? [])].find((s) => s.textContent === '深度思考')
    return span ? span.__pmAnchor === 'keep-me' : false
  })
  check('「深度思考」标签跨 tick 不重挂', anchorAlive)
  const tailHeld = await page.evaluate((len) => {
    const head = document.querySelector('[data-segment-head]')
    return head?.textContent.includes(`(${len} chars)`) ?? false
  }, second.length)
  check('尾巴节流持有（120ms 内未换新值）', tailHeld)
  await page.waitForTimeout(800)
  const tailRotated = await page.evaluate((len) => {
    const head = document.querySelector('[data-segment-head]')
    return head?.textContent.includes(`(${len} chars)`) ?? false
  }, thinkText(4400).length)
  check('尾巴轮动落地新值（节流后到达）', tailRotated)

  // Expand the live group: the thinking row is inside; expanding the row shows
  // the full text in a plain pre — capped and scrollable like the settled one.
  await liveGroupHead().click()
  await page.waitForTimeout(200)
  const rowHeader = () => page.locator('[data-thinking-head]', { hasText: '深度思考' })
  check('直播组内思考行可见', await rowHeader().isVisible())
  await rowHeader().click()
  await page.waitForTimeout(150)
  const pre = page.locator('pre', { hasText: TAIL })
  check('展开后全文可见（头尾都在）', (await pre.count()) === 1 && await pre.getByText(HEAD, { exact: false }).isVisible())
  check('展开态限高 400 可滚', await pre.first().evaluate((el) => {
    const s = getComputedStyle(el)
    return s.maxHeight === '400px' && s.overflowY === 'auto'
  }))
  await rowHeader().click()
  await page.waitForTimeout(100)
  check('再点收起', (await page.locator('pre').count()) === 0)

  // Collapsed = ONE line, even for a CJK tail (80 CJK chars at fontSize 12
  // used to wrap the header to ~3 lines — user report 2026-10-25).
  const cjkText = '开头标记。' + '想'.repeat(300) + '。尾部标记收尾'
  await page.evaluate((t) => window.__setStreaming([{ type: 'thinking', thinking: t }]), cjkText)
  await page.waitForTimeout(150)
  const headerH = await page.evaluate(() => {
    const el = document.querySelector('[data-thinking-head]')
    return el ? el.getBoundingClientRect().height : null
  })
  check('CJK 长预览折叠仍是一行（紧凑行）', headerH !== null && headerH < 30, `header height ${headerH}px — compact row is ~26px, two lines would be ~45`)
  check('CJK 预览带字符计数', await page.getByText(`(${cjkText.length} chars)`, { exact: false }).isVisible())

  // 上下对齐: the thinking row and a tool row are the SAME row chrome — equal
  // heights, measured against a REAL tool head inside the same open group.
  await page.evaluate(() => window.__setStreaming([
    { type: 'thinking', thinking: 'x' },
    { type: 'tool_use', id: 'tw-align', name: 'write', status: 'pending', input: {} },
  ]))
  await page.waitForTimeout(200)
  const headHeights = await page.evaluate(() => ({
    think: document.querySelector('[data-thinking-head]')?.getBoundingClientRect().height ?? null,
    tool: document.querySelector('[data-tool-head]')?.getBoundingClientRect().height ?? null,
  }))
  check('思考头与工具头同高（上下对齐）', headHeights.think !== null && headHeights.tool !== null && Math.abs(headHeights.think - headHeights.tool) <= 1, JSON.stringify(headHeights))

  const rowLeft = () => page.evaluate(() => {
    const el = document.querySelector('[data-thinking-head]')
    return el ? el.getBoundingClientRect().left : null
  })
  // The clicks above leave the pointer ON the group — the hover fill would
  // read as a grey chip. Park it before measuring the resting chrome.
  await page.mouse.move(0, 0)
  await page.waitForTimeout(150)
  const liveLeft = await rowLeft()
  const liveBg = await page.evaluate(() => {
    const el = document.querySelector('[data-thinking-head]')
    return el ? getComputedStyle(el).backgroundColor : null
  })
  check('思考头无浅灰底', liveBg === 'rgba(0, 0, 0, 0)', liveBg)

  // The round commits as thinking-only (the max_tokens shape): the SAME group
  // persists — rekeyed to the committed message, collapsed again. Settling
  // means the engine goes idle: the done-state chrome lights only then.
  await page.evaluate(() => window.__setRequesting(false))
  await page.evaluate((t) => window.__commitThinking(t), first)
  await page.waitForTimeout(250)
  const groupHead = () => page.locator('[data-segment-head]', { hasText: '已完成 · 深度思考' })
  check('提交后仍是同一个 exec 组', (await groupHead().count()) === 1)
  check('组头读工具家族口径：已完成 · 深度思考1次', await page.getByText('已完成 · 深度思考1次', { exact: false }).isVisible())
  await groupHead().click()
  await page.waitForTimeout(250)
  // 完成态 chrome（2026-10-25 统一裁定）：左绿勾 + 右向右箭头 —— 思考头与
  // 组头同形。绿勾是终端家族的 #4ec9b0（rgb 78,201,176），与工具卡完成勾同源；
  // 头内 svg 数 ≥2 = 勾 + 折箭。
  const chrome = await page.evaluate(() => {
    const probe = (sel) => {
      const head = document.querySelector(sel)
      const svg = head?.querySelector('svg')
      return { color: svg ? getComputedStyle(svg).color : null, svgs: head ? head.querySelectorAll('svg').length : 0 }
    }
    return { think: probe('[data-thinking-head]'), group: probe('[data-segment-head]') }
  })
  check('完成态思考头左缘绿勾', chrome.think.color === 'rgb(78, 201, 176)', JSON.stringify(chrome))
  check('思考头右缘有折箭（勾+箭两个 svg）', chrome.think.svgs >= 2, `svgs=${chrome.think.svgs}`)
  check('完成态执行组头同亮绿勾+折箭', chrome.group.color === 'rgb(78, 201, 176)' && chrome.group.svgs >= 2, JSON.stringify(chrome.group))
  // 行首标签是工具名字阶：粗体 600 + 深色（--pm-text-strong），不是弱色文本
  const labelStyle = await page.evaluate(() => {
    const span = [...(document.querySelector('[data-thinking-head]')?.querySelectorAll('span') ?? [])]
      .find((s) => s.textContent === '深度思考')
    if (!span) return null
    const cs = getComputedStyle(span)
    return { weight: cs.fontWeight, color: cs.color }
  })
  check('行首「深度思考」粗体深色（同工具名）', labelStyle?.weight === '600' && labelStyle.color === 'rgb(51, 51, 51)', JSON.stringify(labelStyle))
  const settledLeft = await rowLeft()
  check('提交前后思考行位置稳定（不跳动）', settledLeft !== null && liveLeft !== null && Math.abs(settledLeft - liveLeft) <= 0.5, `live ${liveLeft} vs settled ${settledLeft}`)
  check('组内思考条预览回开头摘要', await page.getByText(HEAD, { exact: false }).first().isVisible())
  await rowHeader().click()
  await page.waitForTimeout(150)
  check('组内思考条仍可展开全文', (await page.locator('pre', { hasText: TAIL }).count()) === 1)

  // Forward stability (ninth ruling — no look-ahead): when the next assistant
  // round is TEXT, the thinking group must STAND — committed structure never
  // rewrites. The old retro-folding dissolved it into the bubble; pinned gone.
  await page.evaluate((t) => window.__appendTextRound(t), '这是思考之后的正文。')
  await page.waitForTimeout(250)
  check('正文轮到来后思考组原地成立（不溶解）', (await page.locator('[data-segment-head]', { hasText: '已完成 · 深度思考' }).count()) === 1)
  check('组内思考行仍在', (await page.locator('[data-thinking-head]').count()) === 1)
  check('正文气泡独立出现在组后', await page.getByText('这是思考之后的正文。').isVisible())

  // Success marking while a LATER message streams (user report): the committed
  // group is complete the moment its round committed — the green check and the
  // 已完成 header must be up EVEN while the engine is still streaming the text
  // that follows it (it used to sit unresolved at 深度思考 · 首行).
  await page.evaluate(() => window.__setRequesting(true))
  await page.evaluate(() => window.__setStreaming([{ type: 'text', text: '后续正文流式输出中' }]))
  await page.waitForTimeout(250)
  check('正文流式时思考组已读已完成', await page.getByText('已完成 · 深度思考1次', { exact: false }).isVisible())
  const streamingMark = await page.evaluate(() => {
    const head = [...document.querySelectorAll('[data-segment-head]')].find((h) => h.textContent?.includes('已完成 · 深度思考'))
    const svg = head?.querySelector('svg')
    return svg ? getComputedStyle(svg).color : null
  })
  check('正文流式时思考组绿勾已亮', streamingMark === 'rgb(78, 201, 176)', streamingMark)

  // The user's exact sequence: tools committed → thinking streams (its live
  // slice joins the open group) → the message text streams AFTER the group.
  // The group must read 已完成 the moment the text segment exists after it —
  // a lingering live slice must not hold the header in 指令生成中 (it spun
  // until the message committed before the isReceiving-narrowing fix).
  await page.evaluate(() => window.__setRequesting(true))
  await page.evaluate(() => window.__appendToolRound())
  await page.evaluate(() => window.__setStreaming([
    { type: 'thinking', thinking: 'live-think-slice' },
    { type: 'text', text: '第二轮正文流式输出中' },
  ]))
  await page.waitForTimeout(250)
  check('工具+思考组在正文流式时已读已完成', (await page.locator('[data-segment-head]', { hasText: '已完成 · 修改 1 个文件' }).count()) === 1)
  check('残留直播切片不再让组头停留在生成中', (await page.getByText('指令生成中', { exact: false }).count()) === 0)
  const toolSpinning = await page.evaluate(() => {
    const head = [...document.querySelectorAll('[data-segment-head]')].find((h) => h.textContent?.includes('已完成 · 修改'))
    const firstChild = head?.firstElementChild
    return firstChild ? getComputedStyle(firstChild).borderRadius === '50%' : null
  })
  check('正文流式时组头不再转圈', toolSpinning === false, `spinning=${toolSpinning}`)
  // Reset the tail so the fixture ends settled.
  await page.evaluate(() => window.__setStreaming([]))
  await page.evaluate(() => window.__setRequesting(false))
}

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
