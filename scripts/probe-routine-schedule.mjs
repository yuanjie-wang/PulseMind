/**
 * Real-browser render of the routine editor's 定时执行 section (2026-09-23
 * rework: Segmented kind picker, weekday chips, the recessed panel, and the
 * dark-mode pass — every hardcoded #666/#999/#cf1322 became a --pm-* var).
 * The REAL RoutineForm is mounted through the real ConfigProvider theme
 * (buildAntdTheme) and the real injected variable sheet (installThemeVars);
 * the probe flips data-theme + the antd algorithm and drives the section with
 * a real mouse.
 *
 * What must hold:
 *   · switching on reveals the panel; the kind picker is a Segmented block
 *     with the five kinds, and each kind swaps its row in;
 *   · the weekly chips toggle the right weekdays and keep the display order
 *     in the stored config (a saved 周三、周一 reads back 周一、周三);
 *   · the selected chip wears solid ink (bg --pm-ink, ink --pm-ink-contrast);
 *   · labels/captions resolve through the CSS vars — light byte-identical to
 *     the literals they replaced (#666/#999/#cf1322), dark on the dark rungs;
 *   · the time field is the antd TimePicker (review0924 M5: the probe was
 *     written against the native `input[type=time]` it replaced and crashed
 *     on HEAD) — its inner input carries the draft time and the picker
 *     repaints with the app palette per mode;
 *   · the time wheel COMMITS on the cell click (2026-11-23: antd v6's
 *     needConfirm=true default made pick-then-click-away revert to 09:00 —
 *     the user report 「改不了定时执行的时间滚轮」; the footer ✓ must be gone,
 *     the draft must follow each column click, and closing must not revert);
 *   · an invalid cron hint carries --pm-error in BOTH modes.
 *
 * Non-vacuity: every assertion reads a computed style or the draft the real
 * form wrote; deleting the theme pass turns the dark ink checks red, deleting
 * the chips' toggle turns the weekday-draft check red.
 *
 * Usage: node scripts/probe-routine-schedule.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = process.env.PM_SHOT_DIR ?? join(tmpdir(), 'pm-routine-schedule-shots')
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
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
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
  // The trigger section's 浏览… opens a native dialog; record the requested
  // property list instead (canceled = the draft stays as it was).
  showOpenDialog: (opts) => {
    window.__openDialogCalls.push(opts)
    return Promise.resolve({ canceled: true, filePaths: [] })
  },
}
window.__openDialogCalls = []
const state = { draft: EMPTY_DRAFT }
window.__state = state

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

function Harness() {
  const [mode, setMode] = useState('light')
  window.__setTheme = (m) => { setMode(m); applyThemeAttr(m) }
  return (
    <ConfigProvider theme={buildAntdTheme(mode)}>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider initialLocale="zh">
            <ProbeHost />
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
}

createRoot(document.getElementById('app')).render(<Harness />)
`

const OUT = join(tmpdir(), `pm-routine-schedule-${process.pid}.js`)
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
await page.waitForSelector('[data-routine-field="schedule"]', { timeout: 15000 })

const FIELD = '[data-routine-field="schedule"]'
const draft = () => page.evaluate(() => window.__state.draft.sched)
const stylesOf = (sel, props) => page.evaluate(([s, ps]) => {
  const el = document.querySelector(s)
  if (!el) return null
  const cs = getComputedStyle(el)
  return Object.fromEntries(ps.map((p) => [p, cs.getPropertyValue(p)]))
}, [sel, props])

// ── 1. switch on → the panel with the Segmented kind picker ──
await page.locator(`${FIELD} .ant-switch`).click()
await page.waitForSelector(`${FIELD} .ant-segmented`, { timeout: 5000 })
check('开关联动出定时面板', await page.locator(`${FIELD} .ant-segmented`).count() === 1)
check('分段控件有五个频率', await page.locator(`${FIELD} .ant-segmented-item`).count() === 5)
// The daily row's time field is the antd TimePicker (antd v6 renders no
// `type` attribute on its inner input — the native `input[type=time]` this
// probe originally counted is gone), and its value carries the draft time.
check('默认每天行在（TimePicker 输入框，草稿时刻 09:00）', await page.locator(`${FIELD} .ant-picker input`).count() === 1
  && await page.inputValue(`${FIELD} .ant-picker input`) === '09:00')

// ── 1b. the time wheel actually lands (2026-11-23) ──
// antd v6 defaults needConfirm=true for time pickers: a cell click only moved
// the panel's pending value and onChange waited for the footer's ✓ — the user
// report 「改不了定时执行的时间滚轮，一直是9:00」 was pick-then-click-away
// silently reverting. Drive the real columns and read the draft the form
// wrote; under the regression all of these stay at 09:00.
const timeDraft = async () => (await draft()).time
await page.locator(`${FIELD} .ant-picker input`).click()
await page.waitForSelector('.ant-picker-time-panel-column', { timeout: 5000 })
check('时间面板无确认钮（needConfirm=false）', await page.locator('.ant-picker-footer').count() === 0)
await page.locator('.ant-picker-time-panel-column[data-type="hour"] li[data-value="10"]').click()
await page.waitForTimeout(250)
check('点小时 10 即入草稿（没有 OK 按钮这一步）', await timeDraft() === '10:00', await timeDraft())
await page.locator('.ant-picker-time-panel-column[data-type="minute"] li[data-value="30"]').click()
await page.waitForTimeout(250)
check('点分钟 30 即入草稿 10:30', await timeDraft() === '10:30', await timeDraft())
// While the popup is open the field previews the HOVERED cell (rc-picker's
// selectorValues) — park the pointer so it reads the committed value.
await page.mouse.move(760, 950)
await page.waitForTimeout(200)
check('面板开着时输入框 = 已落草稿的 10:30', await page.inputValue(`${FIELD} .ant-picker input`) === '10:30')
check('下次运行提示跟着滚轮走', (await page.locator(`${FIELD} .pm-sched-hint`).innerText()).includes('10:30'))
await page.mouse.click(760, 950)
await page.waitForTimeout(300)
check('点外关闭不回退（仍是 10:30）', await timeDraft() === '10:30', await timeDraft())
// Turn the wheel back to 09:00 through the same path, so the draft literals
// in the sections below keep their 09:00 expectation.
await page.locator(`${FIELD} .ant-picker input`).click()
await page.waitForTimeout(250)
await page.locator('.ant-picker-time-panel-column[data-type="hour"] li[data-value="9"]').click()
await page.waitForTimeout(200)
await page.locator('.ant-picker-time-panel-column[data-type="minute"] li[data-value="0"]').click()
await page.waitForTimeout(200)
await page.mouse.click(760, 950)
await page.waitForTimeout(300)
check('回拨 09:00 收尾', await timeDraft() === '09:00', await timeDraft())

// ── 2. Segmented swaps the rows ──
await page.locator(`${FIELD} .ant-segmented-item`, { hasText: '每周' }).click()
check('每周行出星期胶囊', await page.locator(`${FIELD} .pm-sched-chip`).count() === 7)
await page.locator(`${FIELD} .ant-segmented-item`, { hasText: 'Cron' }).click()
check('Cron 行出表达式输入框', await page.locator(`${FIELD} input.ant-input[placeholder*="分 时"]`).count() === 1)
await page.locator(`${FIELD} .ant-segmented-item`, { hasText: '每周' }).click()

// ── 3. chips toggle the draft, keeping the display order ──
const chip = (t) => page.locator(`${FIELD} .pm-sched-chip`, { hasText: t })
await chip('三').click()
check('点周三入草稿（周一在前）', JSON.stringify(await draft()) === '{"kind":"weekly","weekdays":[1,3],"time":"09:00"}', JSON.stringify(await draft()))
await chip('六').click()
check('再加周六', JSON.stringify(await draft()) === '{"kind":"weekly","weekdays":[1,3,6],"time":"09:00"}', JSON.stringify(await draft()))
await chip('六').click()
check('再点同一枚是取消', JSON.stringify(await draft()) === '{"kind":"weekly","weekdays":[1,3],"time":"09:00"}', JSON.stringify(await draft()))
await chip('一').click()
await chip('三').click()
check('逐个取消到空', JSON.stringify(await draft()) === '{"kind":"weekly","weekdays":[],"time":"09:00"}', JSON.stringify(await draft()))
await chip('六').click()
check('空后可再选', JSON.stringify(await draft()) === '{"kind":"weekly","weekdays":[6],"time":"09:00"}', JSON.stringify(await draft()))
await chip('六').click()
await chip('三').click()
// The chips tween 150ms; measure the settled state, not the transition.
await page.waitForTimeout(300)

// light: selected chip = solid ink on the light palette
let cs = await stylesOf(`${FIELD} .pm-sched-chip--active`, ['background-color', 'color'])
check('选中胶囊 = 实心墨（浅色）', cs['background-color'] === 'rgb(0, 0, 0)' && cs.color === 'rgb(255, 255, 255)', JSON.stringify(cs))
cs = await stylesOf(`${FIELD} .pm-sched-chip:not(.pm-sched-chip--active)`, ['color', 'border-color'])
check('未选胶囊 = 次级墨 + 边框（浅色）', cs.color === 'rgb(102, 102, 102)', JSON.stringify(cs))

// ── 4. light palette stays byte-identical to the literals the vars replaced ──
cs = await stylesOf(`${FIELD} span[style*="font-size: 12"]`, ['color'])
check('行标签 #666（浅色不变）', cs.color === 'rgb(102, 102, 102)', JSON.stringify(cs))
cs = await stylesOf(`${FIELD} .pm-sched-hint`, ['color'])
check('提示行 #999（浅色不变）', cs.color === 'rgb(153, 153, 153)', JSON.stringify(cs))
// The TimePicker repaints with the app palette: antd's container colour is
// white in light (color-scheme says nothing to a text input, so the old pin
// was reading a property the component never had).
cs = await stylesOf(`${FIELD} .ant-picker`, ['background-color'])
check('TimePicker 底色走浅色容器白', cs['background-color'] === 'rgb(255, 255, 255)', JSON.stringify(cs))
await page.screenshot({ path: join(SHOTS, 'schedule-light.png'), fullPage: true })

// ── 5. dark: same section, every ink on the dark rung ──
await page.evaluate(() => window.__setTheme('dark'))
// 300ms: past the chips' 150ms transition so the flip is fully repainted.
await page.waitForTimeout(300)
cs = await stylesOf(`${FIELD} span[style*="font-size: 12"]`, ['color'])
check('行标签走深色 --pm-text-secondary', cs.color === 'rgb(166, 166, 166)', JSON.stringify(cs))
cs = await stylesOf(`${FIELD} .pm-sched-hint`, ['color'])
check('提示行走深色 --pm-text-muted', cs.color === 'rgb(140, 140, 140)', JSON.stringify(cs))
cs = await stylesOf(`${FIELD} .pm-sched-chip--active`, ['background-color', 'color'])
check('选中胶囊反色（深色墨）', cs['background-color'] === 'rgb(230, 230, 230)' && cs.color === 'rgb(0, 0, 0)', JSON.stringify(cs))
cs = await stylesOf(`${FIELD} .pm-sched-panel`, ['background-color', 'border-color'])
check('面板底/边走深色变量', cs['background-color'] === 'rgba(255, 255, 255, 0.03)' && cs['border-color'] === 'rgb(43, 43, 43)', JSON.stringify(cs))
cs = await stylesOf(`${FIELD} .ant-picker`, ['background-color'])
check('TimePicker 底色随主题翻到深色容器（不再停留白色）', cs['background-color'] !== 'rgb(255, 255, 255)' && cs['background-color'] !== 'rgba(0, 0, 0, 0)', JSON.stringify(cs))

// ── 6. invalid cron → --pm-error in dark (#ff7875) ──
// '0 9 * *' turns out VALID (cron-parser pads), so the fixture is a real
// semantic error: minute 61.
await page.locator(`${FIELD} .ant-segmented-item`, { hasText: 'Cron' }).click()
await page.locator(`${FIELD} input.ant-input`).fill('61 9 * * *')
cs = await stylesOf(`${FIELD} .pm-sched-hint`, ['color'])
check('无效 cron 提示 = 深色 --pm-error', cs.color === 'rgb(255, 120, 117)', JSON.stringify(cs))
await page.screenshot({ path: join(SHOTS, 'schedule-dark.png'), fullPage: true })

// ── 7. the same error in light stays the old #cf1322 ──
await page.evaluate(() => window.__setTheme('light'))
await page.waitForTimeout(100)
cs = await stylesOf(`${FIELD} .pm-sched-hint`, ['color'])
check('无效 cron 提示 = #cf1322（浅色不变）', cs.color === 'rgb(207, 19, 34)', JSON.stringify(cs))

// ── 8. the file trigger's 浏览… is a two-arm menu (2026-11-24) ──
// Requesting openFile AND openDirectory in one dialog is a macOS-only shape:
// Windows and Linux show only the directory selector, so "watch a file"
// could only ever add a folder there. The kind is now picked BEFORE the
// dialog opens — the same split as the composer's attach menu.
const TRIG = '[data-routine-field="triggers"]'
const visibleItems = () => page.locator('.ant-dropdown-menu-item:visible')
await page.locator(`${TRIG} .ant-switch`).click()
await page.locator(`${TRIG} .ant-input`).first().waitFor()
await page.locator(`${TRIG} button`, { hasText: '浏览…' }).click()
await visibleItems().filter({ hasText: /^选择文件夹…$/ }).waitFor()
const browseItems = (await visibleItems().allTextContents()).map((s) => s.trim())
check('trigger 浏览 opens exactly 选择文件…/选择文件夹…', JSON.stringify(browseItems) === JSON.stringify(['选择文件…', '选择文件夹…']), JSON.stringify(browseItems))
await visibleItems().filter({ hasText: /^选择文件…$/ }).click()
await page.waitForTimeout(120)
let dialogCalls = await page.evaluate(() => window.__openDialogCalls)
check('trigger 文件 arm asks ONLY openFile (never combined)', JSON.stringify(dialogCalls.at(-1)?.properties) === JSON.stringify(['openFile']), JSON.stringify(dialogCalls.at(-1)))
await page.locator(`${TRIG} button`, { hasText: '浏览…' }).click()
await visibleItems().filter({ hasText: /^选择文件夹…$/ }).waitFor()
await visibleItems().filter({ hasText: /^选择文件夹…$/ }).click()
await page.waitForTimeout(120)
dialogCalls = await page.evaluate(() => window.__openDialogCalls)
check('trigger 文件夹 arm asks ONLY openDirectory', JSON.stringify(dialogCalls.at(-1)?.properties) === JSON.stringify(['openDirectory']), JSON.stringify(dialogCalls.at(-1)))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks pass; screenshots in ${SHOTS}`)
process.exit(failed.length > 0 ? 1 : 0)
