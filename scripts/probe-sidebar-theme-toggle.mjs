/**
 * Sidebar theme-toggle probe (real Chromium).
 *
 * The sidebar's bottom row has three icon buttons since the 2026-09-20 change:
 * the 浅色/深色 toggle owns the LEFT edge, and 用量 + 设置 pin the right via the
 * auto margin on 用量 (previously 用量 sat alone on the left). The toggle is
 * icon-only (no label text), advertises the mode the click LEADS TO (moon while
 * light, sun while dark), and writes the opposite concrete preference through
 * the same `settings.theme` the environment settings' 外观 radio edits.
 *
 * Mounted as the real production surface: the real AppLayout under the real
 * SettingsProvider, plus a ThemeSync that replays App.tsx's own theme effect
 * (resolveThemePreference → setThemeMode + applyThemeAttr) — that effect is
 * what turns a click into a `html[data-theme]` flip in the real app, and the
 * toggle's icon/tooltip ride the same mode store, so the replay drives the
 * real chain rather than a parallel one.
 *
 * No Electron, no LLM: electronAPI is stubbed, so this cannot touch a real
 * PulseMind session.
 *
 * Usage: node scripts/probe-sidebar-theme-toggle.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-theme-toggle-probe-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-theme-toggle-shots')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import React, { useLayoutEffect, useState } from 'react'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider, useSettings } from './src/renderer/src/hooks/SettingsContext'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import { buildAntdTheme } from './src/renderer/src/theme/tokens'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { setThemeMode } from './src/renderer/src/theme/mode'
import { resolveThemePreference } from './src/renderer/src/theme/palette'

installThemeVars()

/** App.tsx's theme effect, verbatim in shape: the click path under test is
 *  click → saveSettings → context update → THIS effect → mode store + attr →
 *  AppLayout's useThemeMode re-render (icon + aria-label flip). Without it the
 *  harness would test a toggle that flips nothing. */
const ThemeSync = () => {
  const { settings } = useSettings()
  const [systemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useLayoutEffect(() => {
    const resolved = resolveThemePreference(settings.theme, systemDark)
    setThemeMode(resolved)
    applyThemeAttr(resolved)
  }, [settings.theme, systemDark])
  return null
}

let root = null
window.__mountLayout = ({ locale = 'zh', theme = 'light' } = {}) => {
  window.__probeLocale = locale
  window.__probeTheme = theme
  window.__savedSettings = []
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider theme={buildAntdTheme(resolveThemePreference(theme, window.matchMedia('(prefers-color-scheme: dark)').matches))}>
      <SettingsProvider>
        <TranslationProvider initialLocale={locale}>
          <ThemeSync />
          <AppLayout
            conversations={[]}
            activeConversationKey=""
            totalSessions={0}
            autoCleanup={true}
            onCreateNew={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onSelectConversation={() => {}}
            onTogglePinConversation={() => {}}
          />
        </TranslationProvider>
      </SettingsProvider>
    </ConfigProvider>
  )
  return true
}
window.__savedTheme = () => (window.__savedSettings.length ? window.__savedSettings[window.__savedSettings.length - 1].theme : null)
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.PROBE_DEV ? 'development' : 'production'), __APP_VERSION__: '"0.0.0-probe"' },
  loader: { '.css': 'text', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
if (process.env.PROBE_DEV) page.on('console', (m) => console.log('  [console]', m.text()))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
// Before the bundle: AppLayout reads electronAPI at module scope (its window-control
// inset is computed on import), and ESM imports evaluate ahead of the harness body.
await page.addScriptTag({
  content: `window.electronAPI = new Proxy({}, { get: (_t, key) =>
    key === 'getWindowControls' ? () => ({ side: 'left', inset: 70 })
      : key === 'getPlatformInfo' ? () => Promise.resolve({ platform: 'darwin' })
      : key === 'getSettings' ? () => Promise.resolve({
          activeProfileId: '', profiles: [], theme: window.__probeTheme || 'light', myName: '', soul: '', yourName: '',
          workspaceDir: '', autoCleanup: true, locale: window.__probeLocale || 'zh',
        })
      : key === 'setSettings' ? (s) => {
          (window.__savedSettings = window.__savedSettings || []).push(JSON.parse(JSON.stringify(s)))
          return Promise.resolve()
        }
      : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
      : /^on[A-Z]/.test(key) ? () => () => {}
      : () => Promise.resolve(undefined) })`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

const readFooter = () => page.evaluate(() => {
  const sider = document.querySelector('.ant-layout-sider').getBoundingClientRect()
  const btns = [...document.querySelectorAll('.sidebar-icon-btn')]
  const pick = (label) => btns.find((b) => (b.getAttribute('aria-label') || '').includes(label))
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, right: r.right, y: r.y, w: r.width, h: r.height }
  }
  return {
    siderRight: sider.right,
    siderLeft: sider.left,
    count: btns.length,
    toggle: rect(btns[0]),
    usage: rect(pick('用量统计')),
    settings: rect(pick('设置')),
    toggleLabel: btns[0]?.getAttribute('aria-label') || null,
    toggleText: btns[0]?.textContent?.trim() ?? null,
    toggleHasCircle: !!btns[0]?.querySelector('svg circle'),
    toggleIsSvg: !!btns[0]?.querySelector('svg'),
  }
})

/* ── 1 · light mode: layout, icon-only, moon on offer ── */
await page.evaluate(() => window.__mountLayout({ theme: 'light' }))
await page.waitForSelector('.sidebar-icon-btn')
let f = await readFooter()
check('the footer has exactly three icon buttons', f.count === 3, String(f.count))
check('toggle is leftmost, 用量 then 设置 rightmost', f.toggle && f.usage && f.settings && f.toggle.x < f.usage.x && f.usage.x < f.settings.x,
  `x ${f.toggle?.x.toFixed(1)} < ${f.usage?.x.toFixed(1)} < ${f.settings?.x.toFixed(1)}`)
check('用量 sits immediately left of 设置 (the 4px gap)', Math.abs(f.settings.x - f.usage.right - 4) <= 1,
  `${(f.settings.x - f.usage.right).toFixed(1)}`)
check('right cluster pins to the sider edge, toggle hugs the left edge',
  Math.abs(f.siderRight - f.settings.right - 8) <= 1 && Math.abs(f.toggle.x - f.siderLeft - 8) <= 1,
  `right ${ (f.siderRight - f.settings.right).toFixed(1) } / left ${ (f.toggle.x - f.siderLeft).toFixed(1) }`)
check('the three buttons share one row and size', f.toggle.y === f.usage.y && f.toggle.y === f.settings.y && f.toggle.h === f.settings.h,
  `y ${f.toggle.y.toFixed(1)}/${f.usage.y.toFixed(1)}/${f.settings.y.toFixed(1)}`)
check('the toggle is icon-only (no label text, svg present)', f.toggleText === '' && f.toggleIsSvg, `text "${f.toggleText}"`)
check('light mode offers the dark mode (moon, no circle)', f.toggleLabel === '切换到深色模式' && !f.toggleHasCircle, f.toggleLabel)
await page.locator('.sidebar-icon-btn').first().hover()
await page.waitForTimeout(400)
// antd v6 names the tooltip paper .ant-tooltip-container (no .ant-tooltip-inner).
check('the tooltip names the mode the click leads to', (await page.locator('.ant-tooltip-container').textContent().catch(() => '')) === '切换到深色模式')
await page.mouse.move(0, 0)

/* ── 2 · a real click flips the theme through the real chain ── */
await page.locator('.sidebar-icon-btn').first().click()
await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
f = await readFooter()
check('click wrote theme:"dark" through setSettings', (await page.evaluate(() => window.__savedTheme())) === 'dark')
check('dark mode now offers the light mode (sun, circle)', f.toggleLabel === '切换到浅色模式' && f.toggleHasCircle, f.toggleLabel)
await page.screenshot({ path: join(SHOTS, 'dark-after-click.png') })

await page.locator('.sidebar-icon-btn').first().click()
await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
f = await readFooter()
check('second click wrote theme:"light" and restored the moon', (await page.evaluate(() => window.__savedTheme())) === 'light' && !f.toggleHasCircle)

/* ── 3 · a dark session mounts offering light (深色默认 lands as sun) ── */
await page.evaluate(() => window.__mountLayout({ theme: 'dark' }))
await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
f = await readFooter()
check('a dark session mounts with the sun (offer light) and data-theme=dark',
  f.toggleLabel === '切换到浅色模式' && f.toggleHasCircle, f.toggleLabel)

/* ── 4 · a `system` preference follows the OS, and the toggle reports the resolved mode ── */
await page.emulateMedia({ colorScheme: 'dark' })
await page.evaluate(() => window.__mountLayout({ theme: 'system' }))
await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
f = await readFooter()
check('system+darkOS resolves dark; the toggle offers light', f.toggleLabel === '切换到浅色模式' && f.toggleHasCircle, f.toggleLabel)

await page.emulateMedia({ colorScheme: 'light' })
await page.evaluate(() => window.__mountLayout({ theme: 'system' }))
await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
f = await readFooter()
check('system+lightOS resolves light; the toggle offers dark', f.toggleLabel === '切换到深色模式' && !f.toggleHasCircle, f.toggleLabel)
await page.emulateMedia({ colorScheme: null })

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ''}`)
console.log(`screenshots: ${SHOTS}`)
process.exit(failed.length ? 1 : 0)
