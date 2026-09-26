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
  respond: (toolUseId, response) => { window.__respondedWith = [toolUseId, response] },
  clearError: () => {},
  retry: () => {},
}

function Harness() {
  const [, force] = useState(0)
  const rerender = () => force((n) => n + 1)

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
            streamingBlocks={[]}
            isRequesting={true}
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
}

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
