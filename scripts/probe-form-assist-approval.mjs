/**
 * Form-assist 授权 probe (real Chromium).
 *
 * The routine editor's and the expert editor's assistant columns render the
 * chat's own 授权 button through FormAssistColumn → chat/InputArea
 * (features.authorization). The button itself is probe-covered in the chat
 * (probe-chat-approval.mjs §5) — what is NEW here is the composition: the
 * level rides the session (FormAssistSession.approvalMode), an absent level
 * must read as the shared default 按需确认 (a fresh assistant thread has no
 * conversation row yet), and a menu pick must reach session.setApprovalMode —
 * the exact path whose desktop twin once "could not be switched".
 *
 * This mounts the production FormAssistColumn with a plain-object session (it
 * is a prop, so no hook mounting is needed) and checks what a user experiences:
 *
 *   1. the button renders inside the editor column at the shared default
 *      (按需确认, grey) when the session reports no level
 *   2. the unrestricted level (auto) reads 全部允许 in the amber that marks it,
 *      and stays amber under hover
 *   3. the dropdown lists the three levels, 全部允许 tinted before it is picked
 *   4. a real mouse pick of 全部允许 reaches session.setApprovalMode exactly
 *      once AND moves the button (the optimistic loop renders)
 *   5. the column's other feature (model picker) is still there
 *
 * No Electron, no LLM calls, no main process: the harness stubs
 * `window.electronAPI`, so this cannot touch a real session.
 *
 * Usage: node scripts/probe-form-assist-approval.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-form-assist-approval-')), 'harness.js')

const HARNESS = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { FormAssistColumn } from './src/renderer/src/components/form-assist/FormAssistColumn'

// The transcript inside the column reads electronAPI on render/click; nothing
// here presses those, so every call just resolves to undefined. expertList is
// the exception: InputArea maps over what it answers, so undefined would throw
// before anything renders.
window.electronAPI = new Proxy({}, { get: (_t, key) => () => Promise.resolve(key === 'expertList' ? [] : undefined) })

const noop = () => {}

/** A plain-object FormAssistSession whose approval half is owned by React
 *  state, so a menu pick has to travel session.setApprovalMode → the column's
 *  prop → the button for the user to see anything move. */
function AssistCase({ name, initial, width }) {
  const [mode, setMode] = useState(initial)
  const session = {
    messages: [], agentStatus: { status: 'idle' }, streamingBlocks: [],
    isBusy: false, restoring: false,
    proposedPatch: null, clearProposedPatch: noop,
    send: noop, cancel: noop, engineCall: noop, refreshOptions: noop,
    approvalMode: mode,
    setApprovalMode: (next) => {
      window.__assistChoice = { case: name, mode: next }
      window.__assistChoiceCount = (window.__assistChoiceCount ?? 0) + 1
      setMode(next)
    },
  }
  return (
    <div data-case={name} style={{ width }}>
      <FormAssistColumn
        session={session}
        title="任务助手"
        placeholder="描述你要创建的任务…"
        onSendMessage={noop}
      />
    </div>
  )
}

function Harness() {
  return (
    <ConfigProvider>
      <TranslationProvider>
        <div style={{ background: '#f0f2f4', padding: 12, fontFamily: 'system-ui' }}>
          {/* No level reported: a thread whose conversation row does not exist yet. */}
          <AssistCase name="unreported" initial={undefined} width={560} />
          {/* Static unrestricted level: the amber that marks it. */}
          <AssistCase name="auto" initial="auto" width={560} />
          {/* The value this harness owns: the pick must move the button. */}
          <AssistCase name="assist" initial="outside-ask" width={560} />
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
const page = await browser.newPage({ viewport: { width: 700, height: 1000 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction('window.__ready === true')

const AMBER = 'rgb(212, 107, 8)'
const GREY = 'rgb(102, 102, 102)'
const APPROVAL_BTN = 'button[title$="工具调用审批"]'

/** One column case's 授权 button: label + its own colour + the level icon's. */
async function approvalButton(name) {
  return page.evaluate((caseName) => {
    const btn = document.querySelector(`[data-case="${caseName}"] button[title$="工具调用审批"]`)
    if (!btn) return null
    const icon = btn.querySelector('.anticon')
    const label = btn.childNodes[btn.childNodes.length - 1]
    return {
      label: (btn.textContent || '').trim(),
      color: getComputedStyle(btn).color,
      levelIcon: icon ? getComputedStyle(icon).color : null,
      labelNode: label ? getComputedStyle(label).color : null,
    }
  }, name)
}

// ── 1. Default: an unreported level reads 按需确认 in grey, never 全部允许 ──
const unreported = await approvalButton('unreported')
check('未上报档位时按钮读作共享默认 按需确认', unreported?.label.includes('按需确认'), unreported?.label)
check('默认档位保持灰（不是警示橙）', unreported?.color === GREY && unreported?.levelIcon === GREY, `${unreported?.color}/${unreported?.levelIcon}`)

// ── 2. auto: 全部允许 in amber, hover-proof ──
const auto = await approvalButton('auto')
check('auto 档按钮读 全部允许 且图标文案同为警示橙', auto?.label.includes('全部允许') && auto?.color === AMBER && auto?.levelIcon === AMBER, `${auto?.label} ${auto?.color}/${auto?.levelIcon}`)

const assistBtn = page.locator('[data-case="assist"] ' + APPROVAL_BTN)
check('列内渲染出授权按钮（初始 按需确认）', (await assistBtn.count()) === 1 && (await assistBtn.textContent()).includes('按需确认'), await assistBtn.textContent())

// ── 3. The dropdown lists three levels, 全部允许 tinted before it is picked ──
await assistBtn.click()
await page.waitForSelector('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item')
const items = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item')).map((el) => {
    const icon = el.querySelector('.anticon')
    return { label: (el.textContent || '').trim(), color: getComputedStyle(el).color, icon: icon ? getComputedStyle(icon).color : null }
  })
})
const autoItem = items.find((i) => i.label.includes('全部允许'))
check('下拉列出三档', items.length === 3, items.map((i) => i.label).join(' / '))
check('下拉里 全部允许 一项图标与文案同样标橙', autoItem?.color === AMBER && autoItem?.icon === AMBER, `${autoItem?.color}/${autoItem?.icon}`)

// ── 4. A real mouse pick reaches session.setApprovalMode and moves the button ──
await page.locator('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item', { hasText: '全部允许' }).last().click()
await page.waitForTimeout(250) // antd menu close + React commit
const after = await approvalButton('assist')
const reported = await page.evaluate(() => ({ choice: window.__assistChoice, count: window.__assistChoiceCount }))
check('点选 全部允许 到达 session.setApprovalMode 且恰好一次', reported.choice?.mode === 'auto' && reported.count === 1, JSON.stringify(reported))
check('按钮随之改文案并转警示橙', after?.label.includes('全部允许') && after?.color === AMBER && after?.levelIcon === AMBER, `${after?.label} ${after?.color}/${after?.levelIcon}`)
check('箭头仍是灰色（它标记的是档位，不是箭头）', after?.labelNode !== AMBER, String(after?.labelNode))
await assistBtn.hover()
await page.waitForTimeout(350) // antd text-button hover transition
const hovered = await approvalButton('assist')
check('悬停后 全部允许 仍是警示橙', hovered?.color === AMBER && hovered?.levelIcon === AMBER, `${hovered?.color}/${hovered?.levelIcon}`)

// ── 5. The column's other feature survived: the model picker is still there ──
const modelButton = await page.evaluate(() => {
  const scope = document.querySelector('[data-case="assist"]')
  const btns = Array.from(scope.querySelectorAll('button')).map((b) => (b.textContent || '').trim())
  return btns.some((t) => t.length > 0 && t !== '按需确认' && t !== '全部允许')
})
check('模型选择器仍在（features 未被授权挤掉）', modelButton)

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length > 0 ? 1 : 0)
