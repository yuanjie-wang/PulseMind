/**
 * Dark-mode probe for the expert editor's left list (real Chromium).
 *
 * User report 2026-09-21: 「专家编辑界面左侧的专家列表，在深色模式下，文字
 * 依然为灰色，看不清」— ListRow carried four light-theme literals (#333 /
 * #bbb labels, #888 / #ccc icons) plus black-alpha washes (rgba(0,0,0,…)),
 * all invisible-class on a dark ground. The fix maps each literal onto the
 * palette variable whose LIGHT value is byte-identical, so light is frozen
 * and dark follows the sheet — the same move the routine editor's pane-row
 * made (its label reads --pm-text-strong / --pm-text-faint, its washes
 * --pm-hover / --pm-hover-faint).
 *
 * What source alone cannot prove, this probe measures in both modes:
 *   · the rows really READ the sheet — expected values are resolved live from
 *     `var(--pm-*)` (the sheet is the source of truth, the palette test only
 *     pins the declarations);
 *   · light computes byte-identically to the pre-fix literals (no regression —
 *     the light theme is frozen by contract);
 *   · the mode flip actually moves the ink (a component that ignored the
 *     attribute would fail the light≠dark guards);
 *   · contrast floors against the composite ground (the active wash is an
 *     alpha over --pm-bg, so it is composited before the ratio);
 *   · the hover wash is written by React state (onMouseEnter), so it is driven
 *     with a real mouse, not assumed.
 *
 * Non-vacuity: reverting ListRow to #333 fails every dark read (the sheet
 * resolves #ececec there) and the light≠dark guards; hardcoding a dark value
 * fails the light reads instead.
 *
 * Usage: node scripts/probe-expert-editor-dark.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = process.env.PM_SHOT_DIR ?? join(tmpdir(), 'pm-expert-dark-shots')
mkdirSync(SHOTS, { recursive: true })

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ConfigProvider, App as AntdApp } from 'antd'
import { NotifyBridge } from './src/renderer/src/utils/notify'
import ExpertEditor from './src/renderer/src/components/settings/expert/ExpertEditor'
import { buildAntdTheme } from './src/renderer/src/theme/tokens'
import { applyThemeAttr, installThemeVars } from './src/renderer/src/theme/dom'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'

// ── Hosted-session stubs at the electronAPI seam (the probe-form-assist
// recipe): ExpertEditor's assist column mounts useHostedAgentSession, which
// touches exactly this family; the expert CRUD is prop-driven, and the
// bridge seam only answers save/delete. ──
const listeners = new Set()
const FIXTURES = {
  getSettings: () => ({ activeProfileId: '', profiles: [], theme: 'light', locale: 'zh', workspaceDir: '' }),
  onAgentSessionEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
  agentSessionSnapshot: () => Promise.resolve(null),
  hydrateConversation: () => Promise.resolve({ messages: [] }),
  agentSessionCreate: () => Promise.resolve({ sessionId: '', agentId: '' }),
  agentSessionAsk: () => Promise.resolve(),
  agentSessionEngineCall: () => Promise.resolve(),
  agentSessionCancel: () => Promise.resolve(),
  agentSessionRefreshOptions: () => Promise.resolve(),
  saveConversation: () => Promise.resolve(),
  expertList: () => Promise.resolve([]),
  knowledgeListBases: () => Promise.resolve([]),
  expertUpdate: () => Promise.resolve({}),
  expertCreate: () => Promise.resolve({}),
  expertDelete: () => Promise.resolve(),
}
window.electronAPI = new Proxy({}, { get: (_t, key) => (FIXTURES[key] ?? (() => Promise.resolve())) })

const PROFILES = [
  { id: 'exp-writing', name: '写作专家', description: '文案与润色', basePrompt: '', methodology: '', outputSpec: '', constraints: '', skillNames: [], mcpServerIds: [], enabled: true },
  { id: 'exp-muted', name: '停用专家', description: '', basePrompt: '', methodology: '', outputSpec: '', constraints: '', skillNames: [], mcpServerIds: [], enabled: false },
]

function Harness() {
  const [mode, setMode] = useState('light')
  window.__setMode = (m) => { applyThemeAttr(m); setMode(m) }
  return (
    <ConfigProvider theme={buildAntdTheme(mode)}>
      <AntdApp>
        <NotifyBridge />
        <SettingsProvider>
          <TranslationProvider initialLocale="zh">
            {/* The antd App wraps children in a .ant-app div — mark the ground
                holder explicitly, a positional #app > div would read that
                transparent wrapper and composite every ratio against black. */}
            <div data-probe-ground style={{ height: '100vh', padding: 24, boxSizing: 'border-box', background: 'var(--pm-bg)' }}>
              <ExpertEditor
                profiles={PROFILES}
                editingId="exp-writing"
                onSelect={() => {}}
                onExit={() => {}}
                onSaved={() => {}}
                onDeleted={() => {}}
                skillOptions={[]}
                connectorOptions={[]}
                locale="zh"
              />
            </div>
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
}

installThemeVars()
applyThemeAttr('light')
createRoot(document.getElementById('app')).render(<Harness />)
`

// In-page helpers: the sheet IS the source of truth, so expectations are
// resolved live from the custom properties in the current mode rather than
// hardcoded rgb strings.
const PAGE_HELPERS = `
window.__rowOf = (name) => {
  const row = [...document.querySelectorAll('div')].find(
    (d) => d.style.cursor === 'pointer' && d.textContent === name,
  )
  if (!row) return null
  const paint = (el) => {
    const cs = getComputedStyle(el)
    return { color: cs.color, background: cs.backgroundColor, fontWeight: cs.fontWeight }
  }
  return {
    row: paint(row),
    icon: paint(row.children[0]),
    label: paint(row.children[1]),
    rect: row.getBoundingClientRect().toJSON(),
  }
}
window.__varColor = (name) => {
  const el = document.createElement('span')
  el.style.color = 'var(' + name + ')'
  document.body.appendChild(el)
  const c = getComputedStyle(el).color
  el.remove()
  return c
}
window.__varBg = (name) => {
  const el = document.createElement('span')
  el.style.backgroundColor = 'var(' + name + ')'
  document.body.appendChild(el)
  const c = getComputedStyle(el).backgroundColor
  el.remove()
  return c
}
window.__contrast = (fgCss, bgCss) => {
  const parse = (s) => (s.match(/[\\d.]+/g) ?? []).map(Number)
  const comp = (fg, bg) => {
    const [r, g, b, a] = fg
    if (a === undefined || a >= 1) return [r, g, b]
    return [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)]
  }
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const bg = parse(bgCss)
  const fg = comp(parse(fgCss), bg)
  const l1 = lum(fg)
  const l2 = lum(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}
`

const OUT = join(tmpdir(), `pm-expert-dark-${process.pid}.js`)
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
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 })
page.on('pageerror', (e) => {
  console.error('[pageerror]', e.message)
  console.error(e.stack?.split('\n').slice(0, 6).join('\n'))
})
const PAGE = '<!doctype html><html><body style="margin:0"><div id="app"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => document.body.textContent.includes('写作专家'), null, { timeout: 15000 })
await page.evaluate(PAGE_HELPERS)

const rowOf = (name) => page.evaluate((n) => window.__rowOf(n), name)
const varColor = (name) => page.evaluate((v) => window.__varColor(v), name)
const varBg = (name) => page.evaluate((v) => window.__varBg(v), name)
const ground = () => page.evaluate(() => getComputedStyle(document.querySelector('[data-probe-ground]')).backgroundColor)

// ── 1. light — byte-identical to the pre-fix literals (the frozen contract) ──
const enabled = await rowOf('写作专家')
const muted = await rowOf('停用专家')
check('浅色：列表渲染了启用与停用两类行', !!enabled && !!muted)
check('浅色：选中行加粗', enabled?.row.fontWeight === '600')
check('浅色：启用行文字 = 旧字面量 #333', enabled?.label.color === 'rgb(51, 51, 51)', enabled?.label.color)
check('浅色：停用行文字 = 旧字面量 #bbb', muted?.label.color === 'rgb(187, 187, 187)', muted?.label.color)
check('浅色：启用行图标 = 旧字面量 #888', enabled?.icon.color === 'rgb(136, 136, 136)', enabled?.icon.color)
check('浅色：停用行图标 = 旧字面量 #ccc', muted?.icon.color === 'rgb(204, 204, 204)', muted?.icon.color)
check('浅色：选中行背景 = --pm-hover（黑 6% 系）', enabled?.row.background === (await varBg('--pm-hover')), enabled?.row.background)
check('浅色：未选中未悬停行背景透明', muted?.row.background === 'rgba(0, 0, 0, 0)', muted?.row.background)
const lightGround = await ground()
const lightEnabledContrast = await page.evaluate(([f, b]) => window.__contrast(f, b), [enabled.label.color, lightGround])
check('浅色：启用行文字对地面对比度 ≥ 4.5', lightEnabledContrast >= 4.5, lightEnabledContrast.toFixed(2))
check(
  '浅色：停用行弱于启用行（刻意的暗淡层级）',
  (await page.evaluate(([f, b]) => window.__contrast(f, b), [muted.label.color, lightGround])) < lightEnabledContrast,
)

// ── 2. light hover — the wash is React state, drive it with a real mouse ──
const box = muted.rect
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.waitForTimeout(80)
const hoverLight = (await rowOf('停用专家')).row.background
check('浅色：悬停行背景 = --pm-hover-faint（黑 3% 系）', hoverLight === (await varBg('--pm-hover-faint')), hoverLight)

// ── 3. the flip: attribute + antd theme together, sheet values land ──
await page.evaluate(() => window.__setMode('dark'))
await page.waitForTimeout(150)
check(
  '深色：悬停行背景已翻成白 alpha 系（= --pm-hover-faint）',
  (await rowOf('停用专家')).row.background === (await varBg('--pm-hover-faint')),
  (await rowOf('停用专家')).row.background,
)
await page.mouse.move(0, 0)
await page.waitForTimeout(80)

const dEnabled = await rowOf('写作专家')
const dMuted = await rowOf('停用专家')
check('深色：启用行文字 = --pm-text-strong', dEnabled?.label.color === (await varColor('--pm-text-strong')), dEnabled?.label.color)
check('深色：停用行文字 = --pm-text-faint', dMuted?.label.color === (await varColor('--pm-text-faint')), dMuted?.label.color)
check('深色：启用行图标 = --pm-text-quiet', dEnabled?.icon.color === (await varColor('--pm-text-quiet')), dEnabled?.icon.color)
check('深色：停用行图标 = --pm-text-disabled', dMuted?.icon.color === (await varColor('--pm-text-disabled')), dMuted?.icon.color)
check('深色：选中行背景 = --pm-hover（白 8% 系）', dEnabled?.row.background === (await varBg('--pm-hover')), dEnabled?.row.background)
check('深色：未选中未悬停行背景透明', dMuted?.row.background === 'rgba(0, 0, 0, 0)', dMuted?.row.background)

// ── 4. the switch is real — ink and washes must move with the mode ──
check('非空：启用行文字随模式改变', enabled.label.color !== dEnabled.label.color, `${enabled.label.color} → ${dEnabled.label.color}`)
check('非空：停用行文字随模式改变', muted.label.color !== dMuted.label.color, `${muted.label.color} → ${dMuted.label.color}`)
check('非空：选中行洗色随模式反转（黑系 → 白系）', enabled.row.background !== dEnabled.row.background, `${enabled.row.background} → ${dEnabled.row.background}`)

// ── 5. dark contrast floors (the user's actual complaint, quantified) ──
const darkGround = await ground()
const darkEnabledContrast = await page.evaluate(([f, b]) => window.__contrast(f, b), [dEnabled.label.color, darkGround])
const darkMutedContrast = await page.evaluate(([f, b]) => window.__contrast(f, b), [dMuted.label.color, darkGround])
check('深色：启用行文字对地面对比度 ≥ 4.5（本次报告的修复点）', darkEnabledContrast >= 4.5, darkEnabledContrast.toFixed(2))
check('深色：停用行文字对比度 ≥ 2 且仍弱于启用行', darkMutedContrast >= 2 && darkMutedContrast < darkEnabledContrast, darkMutedContrast.toFixed(2))

await page.screenshot({ path: join(SHOTS, 'expert-editor-dark.png'), clip: { x: 0, y: 0, width: 1400, height: 1000 } })
await page.evaluate(() => window.__setMode('light'))
await page.waitForTimeout(150)
await page.screenshot({ path: join(SHOTS, 'expert-editor-light.png'), clip: { x: 0, y: 0, width: 1400, height: 1000 } })

// ── 收尾 ──
await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed; shots in ${SHOTS}`)
process.exit(failed.length ? 1 : 0)
