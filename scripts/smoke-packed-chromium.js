#!/usr/bin/env node
// 打包态浏览器冒烟（2026-11-24，配合 after-pack 的 prune-packaged-assets）：
// 用**包内** chrome.exe 真起一次 headless —— 裁掉 setup.exe / elevation_service /
// chrome_pwa_launcher / notification_helper / chrome_proxy 之后，浏览器还能不能
// 启动、渲染、求值、截图。
//
// 为什么不只断言文件存在：2026-11-09 OCR 的教训——冒烟自配一套加载逻辑，
// 结果是门禁绿、装机崩。这里走产品同一条路（playwright-core 的
// chromium.launch({ executablePath })），删错一个启动期依赖（chrome_elf.dll、
// D3DCompiler_47.dll、locales/*.pak 全删）都会在这里当场退出非零。
//
// 用法：
//   node scripts/smoke-packed-chromium.js --app-out <dir> [--platform win32|linux|darwin]
// --app-out 指向 electron-builder 的 unpacked 目录（含 resources/chromium）。

'use strict'

const { existsSync, readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    out[argv[i].slice(2)] = argv[i + 1]
    i++
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const appOut = resolve(args['app-out'] || '')
const platform = args.platform || process.platform
if (!existsSync(appOut)) {
  console.error('usage: smoke-packed-chromium.js --app-out <dir> [--platform win32|linux|darwin]')
  process.exit(2)
}

const fail = (msg) => {
  console.error(`[smoke-packed-chromium] FAIL: ${msg}`)
  process.exit(1)
}

// mac 的资源在 <out>/PulseMind.app/Contents/Resources，win/linux 在 <out>/resources
const resDirOf = (base) => {
  const apps = existsSync(base) ? readdirSync(base).filter((d) => d.endsWith('.app')) : []
  const candidates = [
    ...apps.map((d) => join(base, d, 'Contents', 'Resources')),
    ...['resources', 'Resources'].map((d) => join(base, d)),
  ]
  return candidates.find((p) => existsSync(p)) || join(base, 'resources')
}
const resDir = resDirOf(appOut)

// 与 ManagedBackend.bundledChromiumPath 同源（包内布局的唯一真源）。
const exeCandidates = {
  win32: [join(resDir, 'chromium', 'chrome-win', 'chrome.exe')],
  darwin: [
    join(resDir, 'chromium', 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    join(resDir, 'chromium', 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  ],
  linux: [join(resDir, 'chromium', 'chrome-linux', 'chrome')],
}
const candidates = exeCandidates[platform] || []
const executablePath = candidates.find((p) => existsSync(p))
if (!executablePath) {
  fail(`no bundled Chromium for ${platform}; tried:\n  ${candidates.join('\n  ')}`)
}

const main = async () => {
  const { chromium } = await import('playwright-core')
  let browser
  try {
    // headless 与产品缺省一致（ManagedBackend 的 settings.browser.headless ?? true）
    browser = await chromium.launch({ executablePath, headless: true })
    const page = await browser.newPage()
    await page.setContent('<h1 id="probe">ok</h1>')
    const text = await page.evaluate(() => document.getElementById('probe')?.textContent)
    if (text !== 'ok') fail(`page evaluation returned ${JSON.stringify(text)}`)
    const ua = await page.evaluate(() => navigator.userAgent)
    if (!/Chrome\/\d+/.test(ua)) fail(`unexpected user agent: ${ua}`)
    const shot = await page.screenshot()
    if (!shot || shot.length < 1000) fail(`screenshot looks empty (${shot ? shot.length : 0} bytes)`)
    console.log(`[smoke-packed-chromium] OK: ${executablePath}`)
    console.log(`[smoke-packed-chromium] ua=${ua}`)
    console.log(`[smoke-packed-chromium] screenshot=${shot.length} bytes`)
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

main().then(
  () => process.exit(0),
  (err) => fail(err && err.stack ? err.stack : String(err)),
)