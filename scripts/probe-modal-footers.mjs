// Modal footer pair probe (real Chromium).
//
// A dialog's footer is a PAIRED control: 取消 and the primary action sit side
// by side and the eye reads them as one row of equal buttons. That broke once:
// BatchRunModal put the row count into its ok label —「开始（5 个会话）」 — and
// the primary stretched to 142px against a 64px cancel (same height, lopsided
// widths; user report 2026-09-22: 「取消和开始按钮大小不一致」). The count moved
// into a cost note at the bottom of the body, and the footer went back to the
// app-wide convention: every okText is a 2-char CJK word (取消/运行/创建/删除),
// so antd's two-CJK-char autoInsertSpace makes each pair a matched 64×32 set.
//
// This probe mounts the production modals with the app's own theme and pins
// what a user sees: every footer pair measures equal height, and where the
// labels are the conventional two-char pair, equal width too — plus the batch
// modal's count must be readable in the body (above the footer), not on the
// button.
//
// No Electron, no LLM calls: electronAPI is stubbed (the preview fetch returns
// a fixed CSV verdict), so this cannot touch a real session.
//
// Usage: node scripts/probe-modal-footers.mjs [--headed]
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-modal-footers-')), 'harness.js')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ConfigProvider, App as AntdApp } from 'antd'
import { buildAntdTheme } from './src/renderer/src/theme/tokens'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import { BatchRunModal } from './src/renderer/src/components/routine/BatchRunModal'
import { RoutineRunModal } from './src/renderer/src/components/routine/RoutineRunModal'
import { ProjectModal } from './src/renderer/src/components/project/ProjectModal'

installThemeVars()
applyThemeAttr('light')

const ROUTINE = {
  id: 'routine_dbg', name: '巡检', description: '', prompt: 'p',
  params: [
    { key: 'repo', label: '仓库', required: true },
    { key: 'branch', label: '分支' },
  ],
  enabled: true, createdAt: '', updatedAt: '',
  batch: { csvPath: '/tmp/demo.csv', concurrency: 3 },
}

window.electronAPI = {
  routineCsvPreview: async () => ({
    ok: true,
    preview: {
      csvName: 'demo.csv', headers: ['repo', 'branch'],
      previewRows: [['r1', 'b1'], ['r2', 'b2']],
      totalRows: 5,
      analysis: { matchedParams: ['repo', 'branch'], unmatchedHeaders: [], missingRequiredHeaders: [], totalRows: 5 },
      overRowLimit: false,
    },
  }),
}

function Host() {
  const [batchOpen, setBatchOpen] = useState(false)
  const [runOpen, setRunOpen] = useState(false)
  const [projOpen, setProjOpen] = useState(false)
  return (
    <AntdApp>
      <button id="open-batch" onClick={() => setBatchOpen(true)}>batch</button>
      <button id="open-run" onClick={() => setRunOpen(true)}>run</button>
      <button id="open-proj" onClick={() => setProjOpen(true)}>proj</button>
      <BatchRunModal routine={ROUTINE} open={batchOpen} onClose={() => setBatchOpen(false)} onStarted={() => {}} />
      <RoutineRunModal routine={ROUTINE} open={runOpen} onClose={() => setRunOpen(false)} onRun={() => {}} />
      <ProjectModal open={projOpen} editing={null} onClose={() => setProjOpen(false)} onSaved={() => {}} />
    </AntdApp>
  )
}

createRoot(document.getElementById('root')).render(
  <ConfigProvider theme={buildAntdTheme('light')}>
    <SettingsProvider>
      <TranslationProvider>
        <Host />
      </TranslationProvider>
    </SettingsProvider>
  </ConfigProvider>,
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
const check = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
await page.setContent('<div id="root"></div>')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready === true)

const openMeasureClose = async (id, label) => {
  await page.click('#' + id)
  await page.waitForFunction(() => [...document.querySelectorAll('.ant-modal-footer .ant-btn')].some((b) => b.getBoundingClientRect().width > 0), null, { timeout: 5000 })
  const buttons = await page.evaluate(() => {
    const footer = [...document.querySelectorAll('.ant-modal-footer')].find((f) => f.getBoundingClientRect().width > 0)
    return footer ? [...footer.querySelectorAll('.ant-btn')].map((b) => {
      const r = b.getBoundingClientRect()
      const cs = getComputedStyle(b)
      return { text: b.textContent.replace(/\s/g, ''), w: Math.round(r.width), h: Math.round(r.height), padding: cs.padding, font: cs.fontSize }
    }) : []
  })
  const pair = buttons.length === 2
  check(`${label}: footer is one cancel/ok pair`, pair, buttons.map((b) => b.text).join(' / '))
  if (pair) {
    check(`${label}: equal height`, buttons[0].h === buttons[1].h, `${buttons[0].h} vs ${buttons[1].h}`)
    check(`${label}: equal width (matched pair)`, buttons[0].w === buttons[1].w, `${buttons[0].w} vs ${buttons[1].w}`)
    check(`${label}: same type metrics`, buttons[0].padding === buttons[1].padding && buttons[0].font === buttons[1].font,
      `${buttons[0].padding}/${buttons[0].font} vs ${buttons[1].padding}/${buttons[1].font}`)
  }
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => ![...document.querySelectorAll('.ant-modal')].some((m) => m.getBoundingClientRect().width > 0), null, { timeout: 5000 })
}

console.log('== the routine batch dialog (the reported one) ==')
await page.click('#open-batch')
await page.waitForFunction(() => [...document.querySelectorAll('.ant-modal-footer .ant-btn')].some((b) => b.getBoundingClientRect().width > 0), null, { timeout: 5000 })
// The footer pair must stay balanced in the LOADED state too — the long-label
// variant only existed once the preview fetch resolved, so measure after it.
await page.waitForFunction(() => [...document.querySelectorAll('[data-batch-cost-note]')].some((n) => n.getBoundingClientRect().width > 0), null, { timeout: 5000 })
{
  const buttons = await page.evaluate(() => {
    const footer = [...document.querySelectorAll('.ant-modal-footer')].find((f) => f.getBoundingClientRect().width > 0)
    return footer ? [...footer.querySelectorAll('.ant-btn')].map((b) => {
      const r = b.getBoundingClientRect()
      return { text: b.textContent.replace(/\s/g, ''), w: Math.round(r.width), h: Math.round(r.height) }
    }) : []
  })
  check('batch: footer reads 取消/开始 (count off the button)', buttons[0]?.text === '取消' && buttons[1]?.text === '开始',
    buttons.map((b) => `${b.text}(${b.w}×${b.h})`).join(' / '))
  check('batch: the pair measures equal (64×32 matched set)', buttons.length === 2 && buttons[0].w === buttons[1].w && buttons[0].h === buttons[1].h,
    buttons.map((b) => `${b.w}×${b.h}`).join(' vs '))
  const note = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-batch-cost-note]')].find((n) => n.getBoundingClientRect().width > 0)
    const footer = [...document.querySelectorAll('.ant-modal-footer')].find((f) => f.getBoundingClientRect().width > 0)
    if (!el || !footer) return null
    return { text: el.textContent, noteBottom: el.getBoundingClientRect().bottom, footerTop: footer.getBoundingClientRect().top }
  })
  check('batch: the cost note carries the count', !!note && /5 个独立会话/.test(note.text ?? ''), note?.text)
  check('batch: the cost note sits directly above the footer (user signs above 开始)', !!note && note.footerTop - note.noteBottom >= 0 && note.footerTop - note.noteBottom < 40,
    note ? `gap ${Math.round(note.footerTop - note.noteBottom)}px` : 'no note')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => ![...document.querySelectorAll('.ant-modal')].some((m) => m.getBoundingClientRect().width > 0), null, { timeout: 5000 })
}

console.log('== the sibling dialogs (the sweep for the same defect) ==')
await openMeasureClose('open-run', 'routine run dialog')
await openMeasureClose('open-proj', 'project create dialog')

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
