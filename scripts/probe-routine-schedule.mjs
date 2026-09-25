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
}
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

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks pass; screenshots in ${SHOTS}`)
process.exit(failed.length > 0 ? 1 : 0)
