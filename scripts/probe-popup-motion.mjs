/**
 * Popup-motion probe — the antd popup parking defect, pinned end-to-end.
 *
 * The Windows user report this pins: 「使用到一半突然就不行了，所有下拉框都没反应，
 * 上下文圆环也看不到数据，所有动画都没了」 — triggered NOT by any in-app action
 * but by the OS motion state flipping mid-session (Windows 辅助功能 → 视觉效果
 * → 动画效果 toggled off — Win+U is the page with that switch — or an RDP
 * connect, both silent). Under `prefers-reduced-motion: reduce` Blink clamps
 * animation/transition durations to 0.01ms, and the popup choreography
 * rc-motion/rc-trigger established at mount then computes garbage offsets on
 * the next open: every dropdown/Select/tooltip mounts, animates to opacity 1,
 * and is parked off-screen at `left:-1000vw` (@rc-component/trigger
 * useOffsetStyle, `!ready && open`) — rendered and permanently invisible.
 * The context ring's numbers live only in its tooltip, so they vanish with it.
 *
 * What the app ships against it: src/main/motion-guard.ts pins the media
 * feature to no-preference via CDP for the main window's lifetime, so the
 * renderer never enters reduce and the choreography never breaks. This probe
 * runs WITHOUT that guard (plain Chromium, emulated media) and pins the
 * defect's contract:
 *   - default: popups land on-screen;
 *   - mid-session flip: popups PARK off-screen (the bug — a future antd
 *     upgrade fixing upstream turns this check red and retires the guard);
 *   - flip back: popups recover (why the Win+U advice works);
 *   - the ring tooltip: on-screen under default.
 *
 * Usage: node scripts/probe-popup-motion.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-popup-probe-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-popup-shots')

const CONV_KEY = 'conv_20260101120000'

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'

installThemeVars()
applyThemeAttr('light')

const PROFILES = [
  { id: 'model_a', name: 'Chat', provider: 'openai', providerName: 'DeepSeek', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com', maxTokens: 8192, contextLength: 184320, apiKey: 'sk-test' },
  { id: 'model_b', name: 'Reasoner', provider: 'openai', providerName: 'DeepSeek', model: 'deepseek-reasoner', baseURL: 'https://api.deepseek.com', maxTokens: 8192, contextLength: 131072, apiKey: 'sk-test' },
]
const CONV = { key: '${CONV_KEY}', label: '弹层探针', updatedAt: '2026-10-11T12:00:00.000Z' }

let root = null
window.__mount = () => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <SettingsProvider>
        <TranslationProvider initialLocale="zh">
          <AppLayout
            conversations={[CONV]}
            activeConversationKey={'${CONV_KEY}'}
            totalSessions={1}
            autoCleanup={true}
            onCreateNew={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onSelectConversation={() => {}}
            onTogglePinConversation={() => {}}
          >
            <ChatView
              messages={[
                { id: 'm1', role: 'user', contentBlocks: [{ type: 'text', text: '你好' }], createdAt: '2026-10-11T12:00:00.000Z' },
                { id: 'm2', role: 'assistant', contentBlocks: [{ type: 'text', text: '回答', inputTokens: 4200 }], createdAt: '2026-10-11T12:00:05.000Z' },
              ]}
              conversationId={'${CONV_KEY}'}
              conversations={[CONV]}
              isRequesting={false}
              agentStatus={{ status: 'idle' }}
              streamingBlocks={[]}
              hasApiKey={true}
              onSendMessage={() => {}}
              onCancel={() => {}}
              onApproveTool={() => {}}
              onRejectTool={() => {}}
              onClearError={() => {}}
              onOpenConversation={() => {}}
              profiles={PROFILES}
              activeProfileId="model_a"
              onSelectProfile={() => {}}
              contextLength={184320}
            />
          </AppLayout>
        </TranslationProvider>
      </SettingsProvider>
    </ConfigProvider>
  )
  return true
}
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
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ content: `window.electronAPI = new Proxy({}, { get: (_t, key) =>
  key === 'getWindowControls' ? () => ({ side: 'left', inset: 70 })
  : key === 'getPlatformInfo' ? () => Promise.resolve({ platform: 'win32' })
  : key === 'getSettings' ? () => Promise.resolve({
      activeProfileId: 'model_a', theme: 'light', myName: '', soul: '', yourName: '',
      workspaceDir: '', autoCleanup: true, locale: 'zh',
      providers: [{ id: 'prov_1', name: 'DeepSeek', apiFormat: 'openai', baseURL: 'https://api.deepseek.com', models: [
        { id: 'model_a', model: 'deepseek-chat', name: 'Chat', maxTokens: 8192, contextLength: 184320 },
        { id: 'model_b', model: 'deepseek-reasoner', name: 'Reasoner', maxTokens: 8192, contextLength: 131072 },
      ] }],
      profiles: [
        { id: 'model_a', name: 'Chat', provider: 'openai', providerName: 'DeepSeek', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com', maxTokens: 8192, contextLength: 184320, apiKey: 'sk-test' },
        { id: 'model_b', name: 'Reasoner', provider: 'openai', providerName: 'DeepSeek', model: 'deepseek-reasoner', baseURL: 'https://api.deepseek.com', maxTokens: 8192, contextLength: 131072, apiKey: 'sk-test' },
      ],
    })
  : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
  : /^on[A-Z]/.test(key) ? () => () => {}
  : () => Promise.resolve(undefined) })` })
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.evaluate(() => window.__mount())
await page.locator('button.pm-chat-model').waitFor()

const shot = async (name) => page.screenshot({ path: join(SHOTS, name) })

/** Open via a real mouse click and measure the dropdown. The verdict is the
 *  ON-SCREEN position, not opacity — the failure mode parks the popup at
 *  -1000vw while it still fades to opacity 1. */
const openAndMeasure = async (label) => {
  await page.locator('button.pm-chat-model').click()
  await page.waitForTimeout(700)
  const s = await page.evaluate(() => {
    const popup = document.querySelector('.ant-dropdown')
    if (!popup) return { present: false }
    const cs = getComputedStyle(popup)
    const rect = popup.getBoundingClientRect()
    return {
      present: true,
      opacity: cs.opacity,
      left: Math.round(rect.x),
      onScreen: rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth,
    }
  })
  await shot(`${label}.png`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(450)
  return s
}

const flipMotion = async (reduce) => {
  await page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' })
  await page.waitForTimeout(300)
}

// ── 1. default state: the popup lands on-screen ──
console.log('\n[pass 1] default media state')
const base = await openAndMeasure('p1-default-open')
check('default: dropdown mounts', base.present, JSON.stringify(base))
check('default: dropdown reaches opacity 1', base.present && Number(base.opacity) > 0.95, `opacity=${base.opacity}`)
check('default: dropdown ON-SCREEN', base.present && base.onScreen, `left=${base.left}`)

// ── 2. the defect: a mid-session flip parks every later open off-screen ──
console.log('\n[pass 2] mid-session flip into prefers-reduced-motion: reduce')
await flipMotion(true)
const parked = await openAndMeasure('p2-after-flip')
check('defect present: dropdown parked off-screen after the flip', parked.present && !parked.onScreen, `left=${parked.left} (≈ -1000vw parking spot), opacity=${parked.opacity}`)

// ── 3. flipping the OS state back recovers (the Win+U advice) ──
console.log('\n[pass 3] flip back to no-preference')
await flipMotion(false)
const recovered = await openAndMeasure('p3-after-flip-back')
check('recovery: dropdown ON-SCREEN after flipping back', recovered.present && recovered.onScreen, `left=${recovered.left}`)

// ── 4. the context ring's tooltip under default ──
console.log('\n[pass 4] ring tooltip (the 圆环看不到数据 surface)')
await page.hover('.pm-context-ring').catch(() => {})
await page.waitForTimeout(400)
const tt = await page.evaluate(() => {
  const el = document.querySelector('.ant-tooltip')
  if (!el) return { present: false }
  const r = el.getBoundingClientRect()
  return { present: true, opacity: getComputedStyle(el).opacity, onScreen: r.width > 0 && r.left >= 0 && r.right <= innerWidth, text: (el.textContent || '').slice(0, 30) }
})
await shot('p4-tooltip.png')
check('default: ring tooltip mounts', tt.present, JSON.stringify(tt))
check('default: ring tooltip ON-SCREEN', tt.present && tt.onScreen, `opacity=${tt.opacity}`)
await page.mouse.move(640, 500)

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILURES: ${failed.map((f) => f.name).join('; ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
