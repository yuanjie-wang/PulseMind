/**
 * Chat approval probe (real Chromium).
 *
 * The desktop chat collapses twice before a tool card: the execution segment
 * (chat/ExecutionSegment) and the tool block inside it (chat/MessageGroup's
 * CollapsibleToolBlock). 运行 / 跳过 live in the card at the bottom of both, so a
 * held call used to cost two clicks to answer — the report was "审批很麻烦，需要
 * 展开折叠的消息至最里层".
 *
 * The fix is *not* to expand for the user (nothing may rearrange the transcript on
 * its own). A held call lays an approval area — the same 跳过 / 运行 pair — directly
 * below whichever collapsed header is hiding it (`chat/ApprovalArea`), and the cards
 * keep their own pair for when the user does open them. That "below the collapsed
 * block" position, and the fact that answering needs zero clicks, are layout facts
 * no other check in this repo can see: jsdom has no layout engine and these
 * components carry no test ids.
 *
 * So this mounts the production TranscriptView — the same component ChatView and the
 * tool studio render — and checks what a user experiences:
 *
 *   1. held, segment collapsed → 运行/跳过 visible with **zero** clicks, the area
 *      measured *below* the segment header, and both cards still closed
 *   2. the same call, segment opened by hand → the area moves down to the tool blocks
 *      (one per call) and the cards stay closed: reachable at every level, never twice
 *   3. approved → the area is gone, nothing expanded on its own, the header shows the run
 *   4. streaming → no area and no buttons: the stream marks a generating tool 'pending'
 *      too, so keying on 'pending' alone would offer a decision that cannot be made
 *   5. the composer's own 授权 button → 全部允许's icon and wording carry the amber
 *      that marks it as the one unrestricted level (and keep it under hover), the
 *      other levels stay grey, and an unreported level resolves to the shared
 *      default (按需确认) rather than reading as 全部允许
 *
 * Section 5 mounts InputArea only when it runs, so the transcript checks above
 * cannot see buttons it drew — the two concerns share this file because both are
 * the approval surface, not because they share a tree.
 *
 * No Electron, no LLM calls, no extension: the harness stubs `window.electronAPI` and
 * renders into a plain page, so this cannot touch a real PulseMind session.
 *
 * Usage: node scripts/probe-chat-approval.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-chat-approval-')), 'harness.js')

const HARNESS = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { TranscriptView } from './src/renderer/src/components/chat/TranscriptView'
import { InputArea } from './src/renderer/src/components/chat/InputArea'

// The transcript reads electronAPI on render (FileRefChip's birthtime stat) and on
// click (copy / favorite, which this probe never presses), so every call just
// resolves to undefined. expertList is the exception: InputArea maps over what it
// answers, so an undefined would throw before it renders.
// main.tsx's boot, in order: the variable sheet, then the attribute. The chat's
// migrated surfaces read var(--pm-*), and an unset variable resolves to nothing
// (transparent / inherited) — so a probe that measures them without the sheet is
// measuring a page the app never renders (PLAN-dark-mode D7: the helper ships in
// the same change as the migration, not after it).
installThemeVars()
applyThemeAttr('light')

window.electronAPI = new Proxy({}, { get: (_t, key) => () => Promise.resolve(key === 'expertList' ? [] : undefined) })

const NOW = '2026-09-15T10:00:00.000Z'
const user = (text) => ({ id: 'u1', role: 'user', contentBlocks: [{ type: 'text', text }], createdAt: NOW })
const assistant = (id, blocks) => ({ id, role: 'assistant', contentBlocks: blocks, createdAt: NOW })

/** Two calls the approval ladder holds: 'pending' + the parked agentStatus. */
const HELD_CALLS = [
  { type: 'tool_use', id: 't1', name: 'exec', status: 'pending', input: { command: 'rm -rf ./build', description: '清理构建目录' } },
  { type: 'tool_use', id: 't2', name: 'write', status: 'pending', input: { file_path: 'src/a.ts', content: 'export const a = 1', description: '写入入口文件' } },
]

// One messages array, deliberately shared by the held and approved states: the engine
// mutates a block's status in place and notifies, it does not rebuild the message.
const MESSAGES = [user('清一下构建目录'), assistant('a1', [{ type: 'text', text: '这一步会删掉 build/，先确认：' }, ...HELD_CALLS])]

/** A turn still generating its first tool call: 'pending', nothing held yet. */
const GENERATING = [{ type: 'tool_use', id: 't9', name: 'exec', status: 'pending', input: {} }]

/** Settled batch for the T4 activity narrative: 2 reads, 1 edit, 2 execs —
 *  every call completed, nothing held. */
const SETTLED_CALLS = [
  { type: 'tool_use', id: 's1', name: 'read', status: 'completed', exitCode: 0, input: { file_path: 'src/a.ts' }, output: 'x' },
  { type: 'tool_use', id: 's2', name: 'read', status: 'completed', exitCode: 0, input: { file_path: 'src/b.ts' }, output: 'y' },
  { type: 'tool_use', id: 's3', name: 'edit', status: 'completed', exitCode: 0, input: { file_path: 'src/a.ts', old_str: 'a', new_str: 'b' }, output: 'z' },
  { type: 'tool_use', id: 's4', name: 'exec', status: 'completed', exitCode: 0, input: { command: 'npm test' }, output: 'ok' },
  { type: 'tool_use', id: 's5', name: 'exec', status: 'completed', exitCode: 0, input: { command: 'npm run build' }, output: 'built' },
]
const SETTLED_MESSAGES = [user('继续'), assistant('a2', [{ type: 'text', text: '跑一遍检查：' }, ...SETTLED_CALLS])]

/** Settled work AND one call the ladder still holds: the narrative must not
 *  fight the approval decision for the header. */
const SETTLED_HELD_MESSAGES = [user('继续2'), assistant('a3', [
  { type: 'text', text: '最后一步需要确认：' },
  ...SETTLED_CALLS,
  { type: 'tool_use', id: 's6', name: 'exec', status: 'pending', input: { command: 'rm -rf ./dist', description: '清理产物' } },
])]

/** review_20260928 高1: the mirror's view of a held batch AFTER the stamped
 *  messages_update lands. The storable call (rm -rf ./build -> key "rm") wears
 *  the engine's _allowKey stamp; the interpreter+flag call (bash -c ...) keys as
 *  null (高2) and must never grow the third button. */
const HELD_STAMPED_CALLS = [
  { type: 'tool_use', id: 't3', name: 'exec', status: 'pending', input: { command: 'rm -rf ./build', description: '清理构建目录' }, _allowKey: 'rm' },
  { type: 'tool_use', id: 't4', name: 'exec', status: 'pending', input: { command: 'bash -c "echo hi"', description: '回声测试' } },
]
const HELD_STAMPED_MESSAGES = [user('再清一次'), assistant('a5', [{ type: 'text', text: '这一步也会删东西：' }, ...HELD_STAMPED_CALLS])]

/** Mid-loop (PLAN-tool-ux T5): settled work behind a tool that is running with
 *  no output yet — the header falls to the last extracted text, which used to
 *  read as: exec + a space + the raw command, spliced locally. */
const EXECUTING_MESSAGES = [user('跑一遍构建'), assistant('a4', [
  { type: 'text', text: '先读配置，再构建：' },
  { type: 'tool_use', id: 'x1', name: 'read', status: 'completed', exitCode: 0, input: { file_path: 'vite.config.ts' }, output: 'config' },
  { type: 'tool_use', id: 'x2', name: 'exec', status: 'running', input: { command: 'npm run build' } },
])]

function Harness() {
  const [scenario, setScenario] = useState('held')
  const [blocks, setBlocks] = useState(GENERATING)
  window.__scenario = setScenario
  // What the engine does on approveTool: the held calls start running, in place.
  window.__approve = () => {
    for (const b of HELD_CALLS) { b.status = 'running' }
    HELD_CALLS[0].output = 'removing build/…'
    setScenario('approved')
  }
  // Another stream chunk lands, so the generating segment re-renders.
  window.__streamMore = () => setBlocks((b) => [...b, { type: 'tool_use', id: 't10', name: 'write', status: 'pending', input: {} }])

  const streaming = scenario === 'streaming'
  const settled = scenario === 'settled'
  const settledHeld = scenario === 'settledHeld'
  const executing = scenario === 'executing'
  const heldStaged = scenario === 'heldStaged'
  const scenarioMessages = settled ? SETTLED_MESSAGES : settledHeld ? SETTLED_HELD_MESSAGES : executing ? EXECUTING_MESSAGES : heldStaged ? HELD_STAMPED_MESSAGES : MESSAGES
  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>
      <TranslationProvider>
        <div style={{ width: 1000, padding: '12px 0', background: '#fff', fontFamily: 'system-ui' }}>
          <TranscriptView
            messages={streaming ? [MESSAGES[0]] : scenarioMessages}
            agentStatus={scenario === 'held' || settledHeld || heldStaged ? { status: 'awaiting_approval' } : { status: 'streaming' }}
            streamingBlocks={streaming ? blocks : []}
            isRequesting={!settled}
            restoring={false}
            onApproveTool={(id, alwaysAllow) => { window.__approved = id; window.__approvedAlways = alwaysAllow === true }}
            onRejectTool={(id) => { window.__rejected = id }}
            onKillTool={() => {}}
            onRespondToTool={() => {}}
            onClearError={() => {}}
            onRetry={() => {}}
          />
        </div>
      </TranslationProvider>
    </ConfigProvider>
  )
}

createRoot(document.getElementById('root')).render(<Harness />)

/** Section 5's composers, mounted only when that section asks for them so
 *  the transcript checks above never see their buttons. One case per level that
 *  the button can be in: the unrestricted one, a restricted one, the level
 *  nobody reported (a fresh conversation, or a service that has not answered),
 *  and one the harness owns the value of so a click must move it. */
function ComposerCases() {
  const base = {
    isRequesting: false, isStreaming: false, isAwaitingApproval: false, isAwaitingInput: false,
    hasMessages: true, onSendMessage: () => {}, onCancel: () => {}, onChangeApprovalMode: () => {},
    features: { authorization: true },
    // 'inline', not the chat's default 'floating': three floating composers all
    // pin to the bottom of the view and land on top of each other, so only the
    // last one would be clickable. The footer controls are identical either way.
    layout: 'inline',
  }
  /** The welcome composer's own configuration — inline layout and **no**
   *  features prop, which is what ChatView's welcome branch renders — with the
   *  value owned by the parent, so picking from the menu has to move the button.
   *  That is what a click could not do on a new conversation ("权限选择无法切换"). */
  function WelcomeComposer() {
    const [mode, setMode] = useState('outside-ask')
    return (
      <div data-case="welcome" style={{ width: 1000 }}>
        <InputArea
          layout="inline"
          isRequesting={false} isStreaming={false} isAwaitingApproval={false} isAwaitingInput={false}
          hasMessages={false} onSendMessage={() => {}} onCancel={() => {}}
          approvalMode={mode}
          onChangeApprovalMode={(next) => { window.__composerChoice = next; setMode(next) }}
        />
      </div>
    )
  }
  return (
    <TranslationProvider>
      <div style={{ background: '#f0f2f4', padding: 12, fontFamily: 'system-ui' }}>
        <div data-case="auto" style={{ width: 1000 }}><InputArea {...base} approvalMode="auto" /></div>
        <div data-case="outside-ask" style={{ width: 1000 }}><InputArea {...base} approvalMode="outside-ask" /></div>
        <div data-case="unreported" style={{ width: 1000 }}><InputArea {...base} /></div>
        <WelcomeComposer />
      </div>
    </TranslationProvider>
  )
}

window.__mountComposer = () => {
  const host = document.createElement('div')
  host.id = 'composer-cases'
  document.body.appendChild(host)
  createRoot(host).render(<ComposerCases />)
}

window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  // antd's look comes from cssinjs at render time; the markdown/katex stylesheets the
  // import graph reaches are dead weight here — inert text, not font binaries.
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
// localStorage access the preview-pane store reaches for.
// The motion kill is the same sheet probe-theme-dark injects, scoped the same way
// (inside #root only): the transcript now plays entrance/collapse micro-animations
// (chat/motion.tsx), and getComputedStyle reports MID-ANIMATION values — a box
// measured during the 0.22s entrance would fail these geometry checks on the
// animation, not on the code under test. It must NOT go document-wide: antd portals
// its dropdown/menu motion to <body>, and a global kill leaves the open animation
// stuck so the menu item never becomes visible (measured, same as theme-dark's
// stuck ant-zoom-leave).
const PAGE =
  '<!doctype html><html><head><style>#root *,#root *::before,#root *::after{animation:none!important;transition:none!important}</style></head><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.waitForTimeout(300)

/** A button by its visible label, and whether the user can actually see it. */
const button = (label) => page.locator('button', { hasText: label })
async function buttonState(label) {
  const el = button(label)
  const count = await el.count()
  if (count === 0) return { count, visible: false, box: null }
  const first = el.first()
  return { count, visible: await first.isVisible(), box: await first.boundingBox() }
}
/** One 输入 label per *open* card, so 0 means "nothing was expanded". */
const openCards = () => page.locator('div:text-is("【输入】")').count()
/** The approval areas on screen. Counted by attribute, not by colour: a held tool
 *  header carries the same amber, so a colour filter would count headers too. */
const areas = () => page.locator('[data-approval-area]')
/** Every amber surface on screen — the areas *and* the held headers — for the
 *  "nothing amber is left once answered" check. */
const amberBoxes = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('div')]
      .filter((d) => getComputedStyle(d).backgroundColor === 'rgb(255, 247, 230)')
      .map((d) => Math.round(d.getBoundingClientRect().top)),
  )

// ── 1. Held, segment collapsed: the decision is there, nothing got expanded ──
{
  console.log('== held calls, segment collapsed ==')
  const run = await buttonState('运行')
  const skip = await buttonState('跳过')
  check('运行 is visible with no expansion at all', run.count === 2 && run.visible, `${run.count} buttons, first at ${run.box ? `y=${Math.round(run.box.y)}` : 'nowhere'}`)
  check('跳过 is visible beside every 运行', skip.count === 2 && skip.visible, `${skip.count} buttons`)

  // "不要帮用户展开": the cards must still be shut.
  const cards = await openCards()
  check('neither card was opened for the user', cards === 0, `${cards} open cards`)

  // The area sits *below* the collapsed segment header — not over it, not inside it.
  const head = await page.locator('[data-segment-head]').boundingBox()
  const areaCount = await areas().count()
  // Guarded: with no area at all, `.first().boundingBox()` would wait out the timeout
  // and crash the run instead of failing this one check with a message.
  const areaBox = areaCount > 0 ? await areas().first().boundingBox() : null
  const areaPaint = areaCount > 0 ? await areas().first().evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopColor })) : {}
  check('one approval area, below the segment header', areaCount === 1 && !!head && !!areaBox && areaBox.y >= head.y + head.height - 1, `${areaCount} area(s), top ${areaBox ? Math.round(areaBox.y) : '?'} vs header bottom ${head ? Math.round(head.y + head.height) : '?'}`)
  check('the area is the amber one the held state uses', areaPaint.bg === 'rgb(255, 247, 230)' && areaPaint.border === 'rgb(255, 213, 145)', `${areaPaint.bg} / ${areaPaint.border}`)
  // The icon-to-label gap the panel mirrors by hand (ui/MessageBlocks.tsx sets it as
  // an inline marginRight). antd's own token, not a guess: the panel writes it too.
  const iconGap = areaCount > 0
    ? await areas().first().locator('button', { hasText: '运行' }).first().evaluate((b) => {
        const icon = b.querySelector('.ant-btn-icon') ?? b.querySelector('.anticon')
        const label = [...b.children].find((c) => c !== icon)
        if (!icon || !label) return null
        return Math.round(label.getBoundingClientRect().left - icon.getBoundingClientRect().right)
      })
    : null
  check('the button icon sits antd\'s 8px from its label (what the panel mirrors)', iconGap === 8, `${iconGap}px`)

  // You approve what you can read: the segment's header names nothing, so each row
  // carries the tool and its one-line summary.
  check('the held command is readable in the area', await page.getByText('rm -rf ./build').first().isVisible())
  check('the second held call is readable too', await page.getByText('src/a.ts').first().isVisible())
  const hints = page.getByText('待批准', { exact: true })
  const hintCount = await hints.count()
  const headColor = hintCount > 0 ? await hints.first().evaluate((el) => getComputedStyle(el).color) : null
  check('the segment header itself says 待批准 in amber', hintCount === 1 && headColor === 'rgb(212, 107, 8)', `${hintCount} label(s), ${headColor}`)

  // 运行 must reach the handler with that call's id — a mis-wired row would approve
  // its neighbour in the batch. Guarded so a missing button fails above, not here.
  if (run.count > 0) {
    await button('运行').first().click()
    await page.waitForTimeout(150)
    check('运行 reports the call it belongs to', (await page.evaluate(() => window.__approved)) === 't1', String(await page.evaluate(() => window.__approved)))
  } else {
    check('运行 reports the call it belongs to', false, 'no 运行 button to click')
  }
}

// ── 2. Segment opened by hand: the area moves down, still no expansion needed ──
{
  console.log('== segment opened by hand ==')
  await page.locator('[data-segment-head]').click()
  await page.waitForTimeout(300)
  const cards = await openCards()
  check('opening the segment still leaves both cards closed', cards === 0, `${cards} open cards`)
  const areaCount = await areas().count()
  check('each held call now has its own area', areaCount === 2, `${areaCount} areas`)
  // Below its own tool header, i.e. the same "collapsed block + area" shape one level down.
  const underFirst = await page.locator('[data-tool-head="t1"] + div button').count()
  const underSecond = await page.locator('[data-tool-head="t2"] + div button').count()
  check('each area is attached below its tool block header', underFirst === 2 && underSecond === 2, `${underFirst} / ${underSecond} buttons`)
  check('the pair is still reachable, never in two places at once', (await buttonState('运行')).count === 2, `${(await buttonState('运行')).count} buttons`)
}

// ── 3. Approved: the decision area goes, nothing rearranges ──
{
  console.log('== approved calls (running) ==')
  await page.evaluate(() => window.__approve())
  await page.waitForTimeout(300)
  check('the approval area is gone once answered', (await areas().count()) === 0)
  check('no amber approval surface is left on screen', (await amberBoxes()).length === 0, `${(await amberBoxes()).length} amber box(es)`)
  check('the cards were never opened for the user', (await openCards()) === 0)
  check('the segment header reports the run instead', await page.getByText('removing build/…').first().isVisible())
}

// ── 4. Streaming: 'pending' alone must not offer a decision ──
{
  console.log('== generating call (pending, not held) ==')
  await page.evaluate(() => window.__scenario('streaming'))
  await page.waitForTimeout(300)
  check('no 运行 button appears while the model is still generating', (await buttonState('运行')).count === 0)
  check('no approval area either', (await areas().count()) === 0)
  check('the generating call stays collapsed', (await openCards()) === 0)
  // Re-render mid-generation: a second chunk must not turn anything on either.
  await page.evaluate(() => window.__streamMore())
  await page.waitForTimeout(300)
  check('a later stream chunk leaves it collapsed and undecided', (await openCards()) === 0 && (await areas().count()) === 0)
  const genHead = await page.locator('[data-segment-head]').textContent()
  check('the generating header names the calls in human form', !!genHead && genHead.includes('运行命令、写入文件 指令生成中...'), genHead?.slice(0, 80))
}

// ── 4.5 Executing mid-loop (PLAN-tool-ux T5): the header narrates the running
//    call in the same human form the tool block's header uses ──
{
  console.log('== executing: the running call reads human, not raw ==')
  await page.evaluate(() => window.__scenario('executing'))
  await page.locator('[data-segment-head]').waitFor()
  await page.waitForTimeout(300)
  const head = page.locator('[data-segment-head]')
  const text = await head.textContent()
  check('the executing header shows 动词 · 对象（运行命令 · npm run build）', !!text && text.includes('运行命令 · npm run build'), text?.slice(0, 80))
  check('the executing header no longer splices `exec` + command', !!text && !text.includes('exec npm run build'), text?.slice(0, 80))
}

// ── 4.7 The third button follows the stamp (review_20260928 高1): the mirror's
//    blocks carry _allowKey only where the command has a storable key — there
//    本会话总是允许 renders with zero clicks; the interpreter+flag call (null
//    key, 高2) keeps the bare pair. ──
{
  console.log('== the 本会话总是允许 button follows the stamp ==')
  await page.evaluate(() => window.__scenario('heldStaged'))
  await page.locator('[data-segment-head]').waitFor()
  await page.waitForTimeout(300)
  const always = await buttonState('本会话总是允许')
  check('the stamped call grew the third button with zero clicks', always.count === 1 && always.visible, `${always.count} button(s)`)
  const keyTitle = always.count > 0 ? await button('本会话总是允许').first().getAttribute('title') : null
  check('the button names the key it would store', keyTitle === 'rm', String(keyTitle))
  check('the unstamped interpreter call keeps only 运行/跳过', (await buttonState('运行')).count === 2, `${(await buttonState('运行')).count} run buttons`)
  await button('本会话总是允许').first().click()
  await page.waitForTimeout(150)
  const approved = await page.evaluate(() => ({ id: window.__approved, always: window.__approvedAlways }))
  check('the click approves WITH alwaysAllow', approved.id === 't3' && approved.always === true, JSON.stringify(approved))
}

// ── 5. The composer's 授权 button: 全部允许 is the amber one ──
// 这一档工具调用不再经过批准，是唯一「无人拦截」的一档，所以图标与文案一起转警示橙；
// 其余档位是 #666。探针量的是真渲染出来的 computed color —— antd 的 Button 把
// color 写在按钮上、图标靠继承，写错了源码看不出来，样式表里也没有这条规则。
{
  console.log('== 授权 button tint (composer) ==')
  await page.evaluate(() => window.__mountComposer())
  await page.waitForTimeout(300)

  /** One composer case's 授权 button, found by its own title ("<level> · 工具调用
   *  审批") — the card's first <button> is the send circle, not this one. Reports
   *  the label text, the button's colour (the label inherits it), the level icon's
   *  colour and the caret's. */
  const APPROVAL_BTN = 'button[title$="工具调用审批"]'
  const approvalButton = (caseName) =>
    page.evaluate(
      ([name, selector]) => {
        const btn = document.querySelector(`#composer-cases [data-case="${name}"] ${selector}`)
        if (!btn) return null
        const icons = btn.querySelectorAll('.anticon')
        return {
          label: btn.textContent.trim(),
          color: getComputedStyle(btn).color,
          levelIcon: icons[0] ? getComputedStyle(icons[0]).color : null,
          caret: icons[1] ? getComputedStyle(icons[1]).color : null,
        }
      },
      [caseName, APPROVAL_BTN],
    )

  const AMBER = 'rgb(212, 107, 8)'
  const GREY = 'rgb(102, 102, 102)'

  const auto = await approvalButton('auto')
  check('全部允许 的图标与文案同为警示橙（#d46b08）', auto?.label === '全部允许' && auto.color === AMBER && auto.levelIcon === AMBER, `${auto?.label} ${auto?.color}/${auto?.levelIcon}`)
  // The caret is the affordance, not the level: it stays the muted grey both
  // footer buttons use, exactly as the panel's does.
  check('全部允许 的箭头仍是灰色（它标记的是档位，不是箭头）', auto?.caret === 'rgb(187, 187, 187)', String(auto?.caret))

  const ask = await approvalButton('outside-ask')
  check('其余档位的图标与文案是灰的', ask?.label === '按需确认' && ask.color === GREY && ask.levelIcon === GREY, `${ask?.label} ${ask?.color}/${ask?.levelIcon}`)

  // + the point of tinting by inline color: antd's text-button hover rule would
  // otherwise brighten the one surface that must keep reading as a warning.
  const autoBtn = page.locator(`#composer-cases [data-case="auto"] ${APPROVAL_BTN}`)
  await autoBtn.hover()
  await page.waitForTimeout(200)
  const hovered = await approvalButton('auto')
  check('悬停后 全部允许 仍是警示橙（inline 压过 antd 的 hover 色）', hovered?.color === AMBER && hovered?.levelIcon === AMBER, `${hovered?.color}/${hovered?.levelIcon}`)

  const unreported = await approvalButton('unreported')
  check('没有档位上报时回落到共享默认（按需确认），读不出「没人拦」', unreported?.label === '按需确认' && unreported.color === GREY, `${unreported?.label} ${unreported?.color}`)

  // The menu tints the level before it is picked, so 全部允许 is recognisable in
  // the list — the same rule the panel's dropdown follows.
  await autoBtn.click()
  await page.waitForTimeout(300)
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item')].map((li) => {
      const icon = li.querySelector('.anticon')
      return {
        label: li.textContent.trim(),
        color: getComputedStyle(li).color,
        icon: icon ? getComputedStyle(icon).color : null,
      }
    }),
  )
  const autoItem = items.find((i) => i.label.includes('全部允许'))
  const otherItems = items.filter((i) => !i.label.includes('全部允许'))
  check('下拉里 全部允许 一项的图标与文案同样标橙', items.length === 3 && autoItem?.color === AMBER && autoItem?.icon === AMBER, items.map((i) => `${i.label} ${i.icon}/${i.color}`).join(', '))
  // 橙色标记的是这一档，不是整张菜单：另外两项必须彼此同色、且都不是橙。
  check('下拉里其余档位不变色（标记的是档位，不是菜单主题）', otherItems.length === 2 && otherItems.every((i) => i.color === otherItems[0].color && i.icon === otherItems[0].icon && i.color !== AMBER), items.map((i) => `${i.label} ${i.icon}/${i.color}`).join(', '))

  // ── Picking one has to *move* the button ──
  // Everything above reads a value handed in; this case starts at 按需确认 and must
  // end at 全部允许 through a real mouse, in the welcome composer's configuration.
  // 「权限选择无法切换」 had two causes and this is the component-level half of the
  // desktop one: the item's click has to reach the parent and the parent's value
  // has to come back to the label. (The other half — the parent had no
  // conversation to write to before the first message — is the pending-choice
  // store, covered by tests/pending-approval.test.ts.)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const welcomeBefore = await approvalButton('welcome')
  check('新会话的授权按钮起始于共享默认（按需确认）', welcomeBefore?.label === '按需确认' && welcomeBefore.color === GREY, `${welcomeBefore?.label} ${welcomeBefore?.color}`)

  const welcomeBtn = page.locator(`#composer-cases [data-case="welcome"] ${APPROVAL_BTN}`)
  await welcomeBtn.hover()
  await welcomeBtn.click()
  await page.waitForTimeout(300)
  await page.locator('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item', { hasText: '全部允许' }).last().click()
  await page.waitForTimeout(300)
  const welcomeAfter = await approvalButton('welcome')
  const reported = await page.evaluate(() => window.__composerChoice)
  check('点选 全部允许 后按钮改文案、转橙，并把 auto 交给上层', welcomeAfter?.label === '全部允许' && welcomeAfter.color === AMBER && reported === 'auto', `${welcomeAfter?.label} ${welcomeAfter?.color} / 上报 ${reported}`)
  check('切换后箭头仍是灰色', welcomeAfter?.caret === 'rgb(187, 187, 187)', String(welcomeAfter?.caret))
}

/* ── T4: the activity narrative (PLAN-tool-ux) — a settled batch narrates;
      settled work + a held call keeps 待批准 in charge, area below the head ── */
console.log('== settled batch: activity narrative ==')
await page.evaluate(() => window.__scenario('settled'))
await page.locator('[data-segment-head]').waitFor()
{
  const head = page.locator('[data-segment-head]')
  const text = await head.textContent()
  check(
    'the done header narrates the activity by family',
    // ffc25e0 gave the 修改 family a diff-magnitude badge (「修改 N 个文件
    // （+a/−d）」) — the fixture's settled edit is 'a'→'b', so the badge must
    // read （+1/−1） right there in the narrative (review_20260929 中9).
    !!text && text.includes('已完成 · 已读取 2 个文件 · 修改 1 个文件（+1/−1） · 运行 2 条命令'),
    text?.slice(0, 80),
  )
  const areas = await page.locator('[data-approval-area]').count()
  check('no approval surface on a fully settled batch', areas === 0, `${areas} area(s)`)
}

console.log('== settled work + one held call: narrative yields to the decision ==')
await page.evaluate(() => window.__scenario('settledHeld'))
await page.locator('[data-approval-area]').waitFor()
{
  const head = page.locator('[data-segment-head]')
  const headText = await head.textContent()
  check('the held call still owns the header (待批准, not the narrative)', !!headText && headText.includes('待批准') && !headText.includes('已完成 ·'), headText?.slice(0, 60))
  const headBox = await head.boundingBox()
  const areaBox = await page.locator('[data-approval-area]').boundingBox()
  check(
    'the approval area still sits below the header — no conflict',
    !!headBox && !!areaBox && areaBox.y >= headBox.y + headBox.height - 1,
    `area top ${areaBox ? Math.round(areaBox.y) : '?'} vs header bottom ${headBox ? Math.round(headBox.y + headBox.height) : '?'}`,
  )
  const buttons = await page.locator('[data-approval-area] button').count()
  check('…and the decision is there with zero clicks', buttons >= 2, `${buttons} button(s)`)
}

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
