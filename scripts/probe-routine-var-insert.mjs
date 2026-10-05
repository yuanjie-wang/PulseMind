/**
 * Real-browser caret/viewport behavior of the routine editor's 插入变量
 * (user report 2026-10-05: 「提示词过长时，在头部插入变量后，输入框会定位到尾部」).
 * The REAL RoutineForm is mounted through the real ConfigProvider theme; the
 * 插入变量 Select is driven with a real mouse and the textarea's caret +
 * scrollTop are read after the insert settles.
 *
 * The mechanics (measured in Chromium): React's controlled write of the new
 * prompt value resets the textarea's caret to the END of the text, and
 * insertVar's rAF callback has to restore it. Order matters — focus() scrolls
 * to the caret (which is the tail right after the value write) and a LATER
 * setSelectionRange moves the caret back WITHOUT bringing the view with it,
 * so a long prompt ends up showing its tail while the caret sits at the
 * insertion point. Setting the selection BEFORE focus() scrolls the caret
 * into view and the insertion point stays on screen.
 *
 * What must hold:
 *   · the token lands at the caret in the draft, the caret is restored to
 *     just after it, and the textarea is focused again;
 *   · inserting at the HEAD of a long prompt keeps the viewport at the top
 *     (scrollTop stays 0 — this exact check failed against the pre-fix
 *     order: focus-first dragged scrollTop to ≈ max);
 *   · inserting mid-text while the viewport sits elsewhere scrolls the
 *     insertion point into view;
 *   · a short prompt (nothing to scroll) is untouched: token appended at the
 *     caret, scrollTop stays 0.
 *
 * Non-vacuity: the long fixture asserts it actually overflows the 8-row
 * textarea (scrollHeight > clientHeight) before any scroll check; the probe
 * was run against the pre-fix order where 头部插入 fails with scrollTop ≈ max
 * and 中部插入 fails the caret-visible check.
 *
 * Usage: node scripts/probe-routine-var-insert.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = process.env.PM_SHOT_DIR ?? join(tmpdir(), 'pm-routine-var-insert-shots')
mkdirSync(SHOTS, { recursive: true })

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ConfigProvider, App as AntdApp } from 'antd'
import { installThemeVars } from './src/renderer/src/theme/dom'
import { buildAntdTheme } from './src/renderer/src/theme/tokens'
import { RoutineForm } from './src/renderer/src/components/routine/RoutineForm'
import { EMPTY_DRAFT } from './src/renderer/src/components/routine/routine-form-model'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'

installThemeVars()
// The real useAppSettings reads through the seam on mount.
window.electronAPI = {
  getSettings: () => Promise.resolve({ activeProfileId: '', profiles: [], theme: 'light', locale: 'zh', workspaceDir: '' }),
  setSettings: () => Promise.resolve(),
}
const state = { draft: EMPTY_DRAFT }
window.__state = state
// One short line each — a wrapped line would break the line-height caret math.
window.LONG_PROMPT = Array.from({ length: 260 }, (_, i) =>
  \`第 \${i + 1} 行：检查依赖 dep-\${i + 1} 的漏洞。\`).join('\\n')

function ProbeHost() {
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  state.draft = draft
  window.__setDraft = (patch) => setDraft((d) => ({ ...d, ...patch }))
  return (
    <div style={{ width: 520, padding: 24, background: 'var(--pm-bg)' }}>
      <RoutineForm draft={draft} onChange={setDraft} appliedAssistantPatch={null} onUndoAssistantPatch={() => {}} models={[]} />
    </div>
  )
}

createRoot(document.getElementById('app')).render(
  <ConfigProvider theme={buildAntdTheme('light')}>
    <AntdApp>
      <SettingsProvider>
        <TranslationProvider initialLocale="zh">
          <ProbeHost />
        </TranslationProvider>
      </SettingsProvider>
    </AntdApp>
  </ConfigProvider>
)
`

const OUT = join(tmpdir(), `pm-routine-var-insert-${process.pid}.js`)
await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx' },
  outfile: OUT,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning',
})

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 800, height: 1000 }, deviceScaleFactor: 2 })
page.on('pageerror', (e) => {
  console.error('[pageerror]', e.message)
  console.error(e.stack?.split('\n').slice(0, 6).join('\n'))
})
const PAGE = '<!doctype html><html><body style="margin:0"><div id="app"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForSelector('[data-routine-field="prompt-head"]', { timeout: 15000 })

const AREA = '[data-routine-field="prompt"] textarea.ant-input'
const DATE_TOKEN = '{{date}}'
const WORKSPACE_TOKEN = '{{workspace}}'

const areaState = () => page.evaluate((sel) => {
  const t = document.querySelector(sel)
  return {
    value: t.value,
    selStart: t.selectionStart,
    selEnd: t.selectionEnd,
    scrollTop: t.scrollTop,
    clientHeight: t.clientHeight,
    scrollHeight: t.scrollHeight,
    focused: document.activeElement === t,
    lineHeight: getComputedStyle(t).lineHeight,
  }
}, AREA)

/** Caret's Y offset (line number × line height — the fixture's lines never
 *  wrap, asserted by the width) inside [scrollTop, scrollTop+clientHeight]. */
const caretVisible = (st, caret) => {
  const lineH = parseFloat(st.lineHeight) || 22
  const line = st.value.slice(0, caret).split('\n').length - 1
  const y = line * lineH
  return y >= st.scrollTop && y <= st.scrollTop + st.clientHeight
}

async function openVarDropdown() {
  await page.locator('[data-routine-field="prompt-head"] .ant-select').click()
  await page.waitForFunction(() => {
    const open = document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
    return open.length === 1 && open[0].querySelectorAll('.ant-select-item-option').length > 0
  })
  return '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option'
}

/** Settle = the rAF caret restore has run: caret after the token AND the
 *  textarea focused. The focused half is load-bearing — a caret at the END
 *  of the text is also where React's controlled write parks the selection
 *  before the restore, so selStart alone can satisfy the wait a frame early. */
async function settleAt(caret, timeout = 5000) {
  await page.waitForFunction(([sel, c]) => {
    const t = document.querySelector(sel)
    return t?.selectionStart === c && document.activeElement === t
  }, [AREA, caret], { timeout }).catch(() => {})
}

// Load the long fixture into the real draft (setState is not sync — wait for
// the controlled textarea to carry it).
async function loadPrompt(text) {
  await page.evaluate((t) => window.__setDraft({ prompt: t }), text)
  await page.waitForFunction(([sel, t]) => document.querySelector(sel)?.value === t, [AREA, text], { timeout: 5000 })
}

// ── 1. 插入到头部（the reported shape: long prompt, caret at head） ──
await loadPrompt(await page.evaluate(() => window.LONG_PROMPT))
{
  const st0 = await areaState()
  check('长提示词夹具真实可滚动', st0.scrollHeight > st0.clientHeight, `scrollHeight=${st0.scrollHeight} clientHeight=${st0.clientHeight}`)
  check('夹具初始视口在顶部', st0.scrollTop === 0, `scrollTop=${st0.scrollTop}`)
}
await page.locator(AREA).click()
// The caret at the head: a real click lands mid-text, so pin it explicitly
// while the textarea is focused (what the user's click produced).
await page.evaluate((sel) => { const t = document.querySelector(sel); t.setSelectionRange(0, 0) }, AREA)
const OPT = await openVarDropdown()
await page.locator(OPT, { hasText: '日期 {{date}}' }).click()
await settleAt(DATE_TOKEN.length)
const st1 = await areaState()
check('变量落在头部（草稿以 token 开头）', st1.value === DATE_TOKEN + await page.evaluate(() => window.LONG_PROMPT))
check('光标恢复到变量之后', st1.selStart === DATE_TOKEN.length && st1.selEnd === DATE_TOKEN.length, `sel=${st1.selStart}..${st1.selEnd}`)
check('插入后 textarea 重新聚焦', st1.focused)
check('头部插入：视口停在顶部（不跳到尾部）', st1.scrollTop === 0, `scrollTop=${st1.scrollTop}`)
check('头部插入：插入点在视口内', caretVisible(st1, DATE_TOKEN.length))
await page.screenshot({ path: join(SHOTS, 'insert-head.png') })

// ── 2. 插入到中部（caret far from the viewport） ──
await loadPrompt(await page.evaluate(() => window.LONG_PROMPT))
const mid = await page.evaluate((sel) => {
  const t = document.querySelector(sel)
  const half = Math.floor(t.value.length / 2)
  const lineStart = t.value.lastIndexOf('\n', half) + 1
  t.setSelectionRange(lineStart, lineStart)
  t.scrollTop = 0
  return lineStart
}, AREA)
const OPT2 = await openVarDropdown()
await page.locator(OPT2, { hasText: '工作区路径 {{workspace}}' }).click()
await settleAt(mid + WORKSPACE_TOKEN.length)
const st2 = await areaState()
check('变量落在中部（草稿）', st2.value.length === await page.evaluate(() => window.LONG_PROMPT.length) + WORKSPACE_TOKEN.length
  && st2.value.slice(mid, mid + WORKSPACE_TOKEN.length) === WORKSPACE_TOKEN)
check('中部插入：光标恢复到变量之后', st2.selStart === mid + WORKSPACE_TOKEN.length, `sel=${st2.selStart}`)
check('中部插入：textarea 重新聚焦', st2.focused)
check('中部插入：视口滚到插入点（光标可见）', caretVisible(st2, mid + WORKSPACE_TOKEN.length),
  `scrollTop=${st2.scrollTop} sel=${st2.selStart}`)
await page.screenshot({ path: join(SHOTS, 'insert-middle.png') })

// ── 3. 短提示词回归（nothing to scroll） ──
const SHORT = '请检查 {{repo}} 仓库的依赖是否有已知安全漏洞。'
await loadPrompt(SHORT)
await page.locator(AREA).click()
await page.evaluate((sel) => { const t = document.querySelector(sel); t.setSelectionRange(t.value.length, t.value.length) }, AREA)
await page.locator(await openVarDropdown(), { hasText: '日期 {{date}}' }).click()
await settleAt(SHORT.length + DATE_TOKEN.length)
const st3 = await areaState()
check('短提示词：变量追加在光标处（末尾）', st3.value === SHORT + DATE_TOKEN)
check('短提示词：光标在变量之后', st3.selStart === SHORT.length + DATE_TOKEN.length, `sel=${st3.selStart}`)
check('短提示词：重新聚焦', st3.focused)
check('短提示词：无滚动（scrollTop 0）', st3.scrollTop === 0, `scrollTop=${st3.scrollTop}`)

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks pass; screenshots in ${SHOTS}`)
process.exit(failed.length > 0 ? 1 : 0)
