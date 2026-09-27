/**
 * Composer footer responsiveness probe (real Chromium).
 *
 * The report: 消息输入框内部下方的那一排工具要做成响应式布局，当页面被宽度
 * 压缩后，能够把权限选择和模型选择简化为icon，避免超出屏幕。
 *
 * The composer column (Composer.tsx) is an inline-size query container; below
 * 600px the 授权/模型 selectors shed label + caret via pm-collapse-compact and
 * the model picker swaps to a robot glyph (pm-collapse-only). This mounts the
 * production InputArea at three host widths plus a long-model-name case and
 * measures what a user gets:
 *
 *   1. wide (952): both buttons keep label + caret, robot hidden — the
 *      responsive rule must not touch the normal row
 *   2. narrow (480): both buttons are ~28px icons, the 全部允许 amber still
 *      rides the approval icon, and the footer shows ZERO overflow
 *   3. long model name at 620 (above the breakpoint): the 160px ellipsis cap
 *      holds the row inside the card — the cap is what makes the breakpoint
 *      safe for names longer than any width budget assumed
 *   4. the collapsed buttons still WORK: a real mouse opens both dropdowns
 *      and a pick lands (icon-only must not cost the function)
 *
 * No Electron, no LLM, no extension: `window.electronAPI` is stubbed, so this
 * cannot touch a real session.
 *
 * Usage: node scripts/probe-composer-responsive.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-composer-resp-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-composer-resp-shots')

const PROFILES = [
  { id: 'prof_glm', name: 'GLM-4.6', providerName: '智谱' },
  { id: 'prof_long', name: 'DeepSeek-R1-Distill-Qwen-32B-Chat-Reasoning-Preview', providerName: 'DeepSeek' },
]

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { InputArea } from './src/renderer/src/components/chat/InputArea'

installThemeVars()
applyThemeAttr('light')

window.electronAPI = new Proxy({}, { get: () => () => Promise.resolve([]) })
window.__pickedModel = null
window.__pickedApproval = null

function Case({ id, width, approvalMode, activeProfileId }) {
  return (
    <div data-case={id} style={{ width, position: 'relative', height: 260, background: '#fff', overflow: 'hidden', fontFamily: 'system-ui', marginBottom: 24 }}>
      <InputArea
        layout="inline"
        isRequesting={false} isStreaming={false} isAwaitingApproval={false} isAwaitingInput={false}
        hasMessages={false}
        onSendMessage={() => {}}
        onCancel={() => {}}
        profiles={${JSON.stringify(PROFILES)}}
        activeProfileId={activeProfileId}
        onSelectProfile={(id) => { window.__pickedModel = id }}
        approvalMode={approvalMode}
        onChangeApprovalMode={(mode) => { window.__pickedApproval = mode }}
      />
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <TranslationProvider>
    {/* The colour the 全部允许 tint must resolve to, read from the same sheet */}
    <span id="warn-ref" style={{ color: 'var(--pm-warn)' }} />
    <Case id="wide" width={952} activeProfileId="prof_glm" />
    <Case id="narrow" width={480} activeProfileId="prof_glm" />
    <Case id="narrow-auto" width={480} approvalMode="auto" activeProfileId="prof_glm" />
    <Case id="wide-long" width={620} activeProfileId="prof_long" />
  </TranslationProvider>
)
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
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0;padding:20px"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction('window.__ready === true')
await page.waitForSelector('.pm-chat-model')

/** One read per case: every fact the checks below argue from. */
const read = (caseId) => page.evaluate((cid) => {
  const root = document.querySelector(`[data-case=${cid}]`)
  const card = root.querySelector('.ant-sender')
  const footer = card.querySelector('.ant-sender-footer')
  const approval = root.querySelector('.pm-chat-approval')
  const model = root.querySelector('.pm-chat-model')
  const disp = (el) => (el ? getComputedStyle(el).display : null)
  // antd icons render as <span class="anticon …"><svg/></span> — a className
  // passed to a *Outlined lands on the wrapper span, so the class selectors
  // below must not presume an svg.
  return {
    cardWidth: card.getBoundingClientRect().width,
    footerOverflow: footer.scrollWidth - footer.clientWidth,
    buttonsInsideCard: [approval, model].every((b) => b.getBoundingClientRect().right <= card.getBoundingClientRect().right + 0.5),
    approval: {
      width: approval.getBoundingClientRect().width,
      color: getComputedStyle(approval).color,
      labelDisplay: disp(approval.querySelector('span.pm-collapse-compact')),
      labelText: approval.querySelector('span.pm-collapse-compact')?.textContent,
      caretDisplay: disp(approval.querySelector('.anticon.pm-collapse-compact')),
      allCompactHidden: [...approval.querySelectorAll('.pm-collapse-compact')].every((el) => disp(el) === 'none'),
    },
    model: {
      width: model.getBoundingClientRect().width,
      labelDisplay: disp(model.querySelector('span.pm-collapse-compact')),
      labelText: model.querySelector('span.pm-collapse-compact')?.textContent,
      labelWidth: model.querySelector('span.pm-collapse-compact')?.getBoundingClientRect().width,
      caretDisplay: disp(model.querySelector('.anticon.pm-collapse-compact')),
      robotDisplay: disp(model.querySelector('.pm-collapse-only')),
      allCompactHidden: [...model.querySelectorAll('.pm-collapse-compact')].every((el) => disp(el) === 'none'),
    },
  }
}, caseId)

const warnColor = await page.evaluate(() => getComputedStyle(document.getElementById('warn-ref')).color)

console.log('── wide (952)：常规行不受响应式规则影响 ──')
const wide = await read('wide')
check('wide: 授权 label+caret visible', wide.approval.labelDisplay !== 'none' && wide.approval.caretDisplay !== 'none' && wide.approval.labelText === '按需确认', JSON.stringify(wide.approval))
check('wide: 授权 button wider than its icon (label present)', wide.approval.width > 60, `${wide.approval.width.toFixed(0)}px`)
check('wide: 模型 label+caret visible, robot hidden', wide.model.labelDisplay !== 'none' && wide.model.caretDisplay !== 'none' && wide.model.robotDisplay === 'none' && wide.model.labelText === 'GLM-4.6', JSON.stringify(wide.model))
check('wide: footer does not overflow', wide.footerOverflow <= 0 && wide.buttonsInsideCard, `overflow ${wide.footerOverflow}px`)
await page.screenshot({ path: join(SHOTS, 'wide.png'), clip: { x: 0, y: 0, width: 1200, height: 260 } })

console.log('── narrow (480)：两个选择器收成 icon，行不溢出 ──')
const narrow = await read('narrow')
check('narrow: 授权 label+caret hidden', narrow.approval.labelDisplay === 'none' && narrow.approval.caretDisplay === 'none' && narrow.approval.allCompactHidden, JSON.stringify(narrow.approval))
check('narrow: 授权 button is a ~28px icon', narrow.approval.width >= 24 && narrow.approval.width <= 34, `${narrow.approval.width.toFixed(0)}px`)
check('narrow: 模型 label+caret hidden, robot shown', narrow.model.labelDisplay === 'none' && narrow.model.caretDisplay === 'none' && narrow.model.allCompactHidden && narrow.model.robotDisplay !== 'none', JSON.stringify(narrow.model))
check('narrow: 模型 button is a ~28px icon', narrow.model.width >= 24 && narrow.model.width <= 34, `${narrow.model.width.toFixed(0)}px`)
check('narrow: footer does not overflow, buttons inside the card', narrow.footerOverflow <= 0 && narrow.buttonsInsideCard, `overflow ${narrow.footerOverflow}px`)

console.log('── narrow + 全部允许：色彩随 icon 存活 ──')
const auto = await read('narrow-auto')
check('narrow-auto: collapsed 授权 icon still wears the amber', auto.approval.color === warnColor, `${auto.approval.color} vs warn ${warnColor}`)

console.log('── wide + 超长模型名 (620)：省略号上限兜底 ──')
const long = await read('wide-long')
check('wide-long: label still visible above the breakpoint', long.model.labelDisplay !== 'none', long.model.labelDisplay)
check('wide-long: label capped at ≤160px (ellipsis, tooltip carries the full name)', long.model.labelWidth <= 160.5, `${long.model.labelWidth?.toFixed(1)}px for "${long.model.labelText}"`)
check('wide-long: footer does not overflow', long.footerOverflow <= 0 && long.buttonsInsideCard, `overflow ${long.footerOverflow}px`)
await page.screenshot({ path: join(SHOTS, 'wide-long.png'), clip: { x: 0, y: 556, width: 1200, height: 260 } })

console.log('── 收起后仍可用：真实点击打开两个下拉 ──')
/** antd keeps a closed dropdown's portal in the DOM through its leave motion,
 *  so every menu read below counts only VISIBLE items — and each dropdown must
 *  be fully shut before the next one opens. */
const visibleItems = () => page.locator('.ant-dropdown-menu-item:visible')
const waitMenusShut = () => page.waitForFunction(
  () => [...document.querySelectorAll('.ant-dropdown-menu-item')].every((el) => el.offsetParent === null && el.getClientRects().length === 0)
)

await page.locator('[data-case=narrow] .pm-chat-model').click()
// Playwright's own :visible is the read's definition of "open" — the wait and
// the read must use the SAME predicate, or the enter motion races the read.
await visibleItems().first().waitFor()
const modelItems = await visibleItems().allTextContents()
check('narrow: model dropdown opens from the icon with the full list', modelItems.length === 2 && modelItems.some((l) => l.includes('GLM-4.6')), modelItems.join(' | '))
await visibleItems().filter({ hasText: 'GLM-4.6' }).click()
await waitMenusShut()
check('narrow: picking a model lands onSelectProfile', (await page.evaluate(() => window.__pickedModel)) === 'prof_glm', String(await page.evaluate(() => window.__pickedModel)))

await page.locator('[data-case=narrow] .pm-chat-approval').click()
await visibleItems().first().waitFor()
const approvalItems = await visibleItems().allTextContents()
check('narrow: approval dropdown opens from the icon with the three levels', approvalItems.length === 3 && approvalItems.some((l) => l.includes('始终询问')), approvalItems.join(' | '))
await page.screenshot({ path: join(SHOTS, 'narrow-menus.png') })
await visibleItems().filter({ hasText: '始终询问' }).click()
await waitMenusShut()
check('narrow: picking a level lands onChangeApprovalMode', (await page.evaluate(() => window.__pickedApproval)) === 'always-ask', String(await page.evaluate(() => window.__pickedApproval)))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(failed.length === 0 ? `\nPASS: ${results.length} checks` : `\nFAIL: ${failed.length}/${results.length} checks`)
process.exit(failed.length === 0 ? 0 : 1)
