/**
 * Real-browser check of the panel banner's 打开设置 button (the "not
 * connected" hint) with the REAL extension loaded.
 *
 * The button's click → options-page link is covered nowhere else: jsdom has no
 * chrome.* contexts, and the panel probes stub chrome.runtime entirely. The
 * shape this pins is exactly the one that regressed silently —
 * `chrome.runtime.openOptionsPage` does not EXIST in a content script's
 * chrome.runtime binding (the property is absent, not gated), so a direct call
 * threw and the old try/catch swallowed it into a dead button. The call must
 * ride OPEN_OPTIONS_MESSAGE_TYPE to the service worker.
 *
 * Requires a prior `npm run build:extension` (loads out/extension unpacked)
 * and the desktop PulseMind NOT running (a live service connects the panel and
 * the banner never shows — the probe bails out instead of hanging).
 *
 * Usage: node scripts/probe-panel-open-options.mjs [--headed]
 */
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXT = 'out/extension'
const FIXTURE_PORT = 18097
const headed = process.argv.includes('--headed')

if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error('✗ out/extension/manifest.json missing — run `npm run build:extension` first')
  process.exit(1)
}

// A live desktop service would connect the panel and the disconnected banner
// (the thing this probe clicks from) would never render.
for (let port = 8765; port <= 8779; port++) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(400) })
    const data = await res.json()
    if (data?.service === 'pulsemind-agent') {
      console.error(`✗ desktop PulseMind is running on port ${port} — the panel would connect and never show the banner. Stop it to run this probe.`)
      process.exit(1)
    }
  } catch {
    /* port closed — exactly what we want */
  }
}

const server = createFixtureServer()
await new Promise((r) => server.listen(FIXTURE_PORT, '127.0.0.1', r))

let context
try {
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'pm-options-probe-')), {
    // New headless of the full `chromium` channel loads MV3 extensions (the
    // default headless shell does not — its service worker never comes up).
    channel: 'chromium',
    headless: !headed,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  })
  await run(context)
} finally {
  await context?.close()
  server.close()
}

function createFixtureServer() {
  return createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><body><h1>fixture</h1></body></html>')
  })
}

async function run(context) {
  let checks = 0
  const ok = (label) => {
    checks++
    console.log(`ok ${checks} — ${label}`)
  }

  // The extension id rides the service worker URL.
  let extId = null
  for (let i = 0; i < 60 && !extId; i++) {
    for (const sw of context.serviceWorkers()) {
      if (sw.url().includes('background.js')) extId = new URL(sw.url()).host
    }
    if (!extId) await new Promise((r) => setTimeout(r, 500))
  }
  if (!extId) throw new Error('extension service worker never came up')
  ok(`extension loaded (${extId})`)

  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${FIXTURE_PORT}/`)
  // Playwright locators pierce open shadow roots, so the panel's internals are
  // addressable from the page directly.
  await page.locator('[data-pulsemind-panel]').waitFor({ state: 'attached', timeout: 15_000 })

  await page.locator('.pm-fab').click()
  await page.locator('.pm-panel').waitFor({ timeout: 15_000 })
  ok('FAB opens the panel')

  // Discovery fails (desktop not running) → the disconnected banner. The banner
  // first paints in the connecting state (正在连接桌面端 PulseMind…); wait for it
  // to settle on the disconnected wording before reading it.
  await page.waitForFunction(
    () => {
      const host = document.querySelector('[data-pulsemind-panel]')
      return (host?.shadowRoot?.querySelector('.pm-banner')?.textContent ?? '').includes('请先打开')
    },
    { timeout: 30_000 },
  )
  ok('disconnected banner shows')

  const link = page.locator('.pm-banner .pm-link', { hasText: '打开设置' })
  if ((await link.count()) !== 1) throw new Error(`expected exactly one 打开设置 button, got ${await link.count()}`)
  ok('banner carries exactly one 打开设置 button')

  await link.click()
  const optionsPage = await context
    .waitForEvent('page', {
      predicate: (p) => p.url().startsWith(`chrome-extension://${extId}/options.html`),
      timeout: 5_000,
    })
    .catch(() => null)
  if (!optionsPage) throw new Error('clicking 打开设置 did not open the options page — the worker routing regressed?')
  ok('click opens the options page')

  await optionsPage.locator('#status').waitFor({ timeout: 5_000 })
  ok('options page renders')
}
