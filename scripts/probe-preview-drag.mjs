/**
 * Preview-pane drag perf probe (real Chromium).
 *
 * The user report (2026-09-19): dragging the workbench pane wider is VERY
 * janky while a PYTHON file is previewed. The suspect chain: each drag tick
 * (throttled to 40ms) writes the width into the workbench store → ChatView +
 * WorkbenchPane + PreviewPane + PreviewContent all re-render → TextPreview
 * re-renders → CodeHighlight hands SyntaxHighlighter FRESH object literals
 * (customStyle / codeTagProps), which defeats its PureComponent guard — so
 * Prism re-tokenizes the whole file and React reconciles thousands of spans
 * on EVERY width tick, on top of the unavoidable re-wrap layout.
 *
 * The probe measures frame gaps (rAF deltas) while a REAL pointer drag widens
 * the pane, in two scenarios:
 *   - python preview open (the report's case)
 *   - workspace tab, no file preview (isolates the chat-refloor floor cost)
 * The assertion is comparative: the python case must not be dramatically
 * worse than the no-file case, i.e. the highlighter must not re-render during
 * a drag. Numbers print for eyeballing; the check is on the ratio.
 *
 * No Electron, no LLM calls: electronAPI is stubbed (readFile serves the
 * generated python source); this cannot touch a real session.
 *
 * Usage: node scripts/probe-preview-drag.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-drag-probe-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-drag-shots')
const CONV_KEY = 'conv_20260919100000'
const WS = '/pm-probe-ws'
const PY_PATH = `${WS}/run_pipeline.py`

// A realistic ~1500-line python module (functions, decorators, f-strings,
// imports) — big enough that re-highlighting it per drag tick is felt.
function pySource() {
  const header = [
    '#!/usr/bin/env python3',
    '"""Data pipeline runner — generated probe fixture."""',
    'import asyncio',
    'import json',
    'import logging',
    'from dataclasses import dataclass, field',
    'from pathlib import Path',
    'from typing import Any, Optional',
    '',
    'logger = logging.getLogger(__name__)',
    ''
  ]
  const fn = (i) => [
    '',
    '@dataclass',
    `class Stage${i}Config:`,
    `    """Configuration for pipeline stage ${i}."""`,
    `    name: str = "stage-${i}"`,
    `    retries: int = ${i % 5}`,
    `    timeout: float = ${(i * 1.5).toFixed(2)}`,
    `    tags: list[str] = field(default_factory=lambda: ["a${i}", "b${i}"])`,
    '',
    `def stage_${i}_validate(config: Stage${i}Config) -> bool:`,
    `    """Validate stage ${i}; returns True when the config is usable."""`,
    `    if config.retries < 0:`,
    `        logger.warning("stage ${i}: negative retries %s", config.retries)`,
    `        return False`,
    `    missing = [t for t in config.tags if not t.startswith("a")]`,
    `    logger.info("stage ${i} missing=%s timeout=%s", missing, config.timeout)`,
    `    return len(missing) == 0`,
    '',
    `async def stage_${i}_run(payload: dict[str, Any], config: Optional[Stage${i}Config] = None) -> dict[str, Any]:`,
    `    cfg = config or Stage${i}Config()`,
    `    results: dict[str, Any] = {"stage": "${i}", "ok": True}`,
    `    for key, value in sorted(payload.items()):`,
    `        try:`,
    `            results[key] = f"{key}={value!r}" if isinstance(value, str) else value * cfg.retries`,
    `        except Exception as exc:  # noqa: BLE001`,
    `            logger.exception("stage ${i} failed on %s: %s", key, exc)`,
    `            results["ok"] = False`,
    `    await asyncio.sleep(0)`,
    `    return results`,
    ''
  ]
  return [...header, ...Array.from({ length: 60 }, (_, i) => fn(i).join('\n'))].join('\n')
}
const PY = pySource()

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { usePreviewPaneStore } from './src/renderer/src/stores/previewPaneStore'
import { useWorkbenchStore } from './src/renderer/src/stores/workbenchStore'

const CONV_KEY = '${CONV_KEY}'
const WS = '${WS}'
const PY_PATH = '${PY_PATH}'

let root = null
const mount = (node) => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <SettingsProvider>
        <TranslationProvider initialLocale="zh">{node}</TranslationProvider>
      </SettingsProvider>
    </ConfigProvider>
  )
}

const text = (id, role, s) => ({ id, role, contentBlocks: [{ type: 'text', text: s }], createdAt: '2026-09-19T10:00:00.000Z' })
const MESSAGES = Array.from({ length: 12 }, (_, i) => text('m' + i, i % 2 ? 'assistant' : 'user', '消息 ' + i + '：这是一段用于占位的对话内容，让拖拽时的回流有真实的内容量。'.repeat(3)))

function Harness() {
  return (
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
    >
      <ChatView
        messages={MESSAGES}
        conversationId={CONV_KEY}
        workspaceDir={WS}
        conversations={[]}
        isRequesting={false}
        agentStatus={{ status: 'idle' }}
        streamingBlocks={[]}
        hasApiKey={true}
        onSendMessage={() => {}}
        onCancel={() => {}}
        onApproveTool={() => {}}
        onRejectTool={() => {}}
        onClearError={() => {}}
      />
    </AppLayout>
  )
}
mount(<Harness />)

window.__openPython = () => { usePreviewPaneStore.getState().openFile(CONV_KEY, PY_PATH); return true }
window.__useWorkspace = () => { useWorkbenchStore.getState().setActiveTab('workspace'); return true }
window.__useFiles = () => { useWorkbenchStore.getState().setActiveTab('files'); return true }
window.__startFrames = () => {
  window.__gaps = []
  window.__last = performance.now()
  const loop = (t) => { window.__gaps.push(t - window.__last); window.__last = t; window.__rafId = requestAnimationFrame(loop) }
  window.__rafId = requestAnimationFrame(loop)
  return true
}
window.__stopFrames = () => {
  cancelAnimationFrame(window.__rafId)
  const gaps = (window.__gaps ?? []).slice(1).sort((a, b) => a - b)
  if (gaps.length === 0) return { max: 0, p95: 0, janky: 0 }
  const max = gaps[gaps.length - 1]
  const p95 = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))]
  const janky = gaps.filter((g) => g > 34).length
  return { max: Math.round(max), p95: Math.round(p95), janky, n: gaps.length }
}
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0-probe"' },
  loader: { '.css': 'text', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning', treeShaking: false,
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
await page.route('http://pm-probe.local/**', (route) => route.fulfill({
  contentType: 'text/html',
  body: `<!doctype html><html><head><script>
    window.electronAPI = new Proxy({
      readFile: (p) => Promise.resolve(p.endsWith('.py') ? (window.__PY_SOURCE ?? '') : 'probe file body'),
      statPath: () => Promise.resolve(null),
      updateMessageMetadata: () => Promise.resolve(undefined)
    }, {
      get: (target, key) => key in target
        ? target[key]
        : key === 'getWindowControls' ? () => ({ side: 'left', inset: 70 })
        : key === 'getPlatformInfo' ? () => Promise.resolve({ platform: 'darwin' })
        : key === 'getSettings' ? () => Promise.resolve({
            activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '',
            workspaceDir: '', autoCleanup: true, locale: 'zh',
          })
        : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
        : /^on[A-Z]/.test(key) ? () => () => {}
        : () => Promise.resolve(undefined)
    })
  </script></head><body style="margin:0"><div id="root"></div></body></html>`,
}))
await page.goto('http://pm-probe.local/')
await page.evaluate((src) => { window.__PY_SOURCE = src }, PY)
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.waitForTimeout(400)

/** One scripted drag: press the pane's drag handle, widen ~190px in real
 *  pointer steps, release. Frames are sampled inside the page throughout. */
async function dragWider() {
  await page.evaluate(() => window.__startFrames())
  const handle = page.locator('[style*="col-resize"]').first()
  const box = await handle.boundingBox()
  if (!box) throw new Error('drag handle not found')
  const y = box.y + 300
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  for (let i = 1; i <= 16; i++) {
    await page.mouse.move(box.x + box.width / 2 - i * 12, y)
    await page.waitForTimeout(30)
  }
  await page.mouse.up()
  await page.waitForTimeout(150)
  return page.evaluate(() => window.__stopFrames())
}

// ── Scenario A: python file previewed (the report's case) ──
await page.evaluate(() => window.__openPython())
await page.waitForTimeout(800)
const pyStats = await dragWider()
console.log(`python 预览拖拽帧间隙: max=${pyStats.max}ms p95=${pyStats.p95}ms janky(>34ms)=${pyStats.janky}/${pyStats.n}`)
check('python 预览拖拽不掉帧（max < 100ms）', pyStats.max < 100, JSON.stringify(pyStats))
await page.screenshot({ path: join(SHOTS, 'python.png') })

// ── Scenario B: workspace tab, no file preview — the floor cost ──
await page.evaluate(() => window.__useWorkspace())
await page.waitForTimeout(400)
const wsStats = await dragWider()
console.log(`无文件预览拖拽帧间隙: max=${wsStats.max}ms p95=${wsStats.p95}ms janky=${wsStats.janky}/${wsStats.n}`)

// ── Scenario C: back to the file — sanity that the tab still renders ──
await page.evaluate(() => window.__useFiles())
await page.waitForTimeout(300)
const codeVisible = await page.getByText('run_pipeline.py', { exact: false }).first().isVisible().catch(() => false)
check('拖拽后文件预览仍在渲染', codeVisible)

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length === 0 ? ' — ALL GREEN' : ''}`)
process.exit(failed.length === 0 ? 0 : 1)
