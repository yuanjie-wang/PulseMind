// ── ensure-chromium (A-M2) ──
// Copies the Playwright-managed Chromium into resources/chromium/ so
// electron-builder can ship it (extraResources). ManagedBackend resolves the
// executable from this directory in packaged builds.
//
// Usage:
//   npm run browsers:install   # fetch Chromium into the playwright cache
//   npm run browsers:ensure    # copy it into resources/chromium/ (this script)
//
// Flavor directories are NORMALIZED to chrome-mac / chrome-win / chrome-linux
// (playwright may use chrome-win64 on newer builds) — ManagedBackend expects
// the normalized names.

const { existsSync, mkdirSync, cpSync, rmSync, readdirSync } = require('node:fs')
const { join, dirname, basename, resolve } = require('node:path')

function main() {
  const { chromium } = require('playwright-core')
  const exec = chromium.executablePath()
  if (!existsSync(exec)) {
    console.error(`[ensure-chromium] Chromium not found at ${exec}`)
    console.error('[ensure-chromium] Run `npm run browsers:install` first, then re-run this script.')
    process.exit(1)
  }

  const FLAVORS = ['chrome-mac', 'chrome-win', 'chrome-win64', 'chrome-linux']
  let dir = dirname(exec)
  while (dir !== dirname(dir) && !FLAVORS.includes(basename(dir))) dir = dirname(dir)
  if (!FLAVORS.includes(basename(dir))) {
    console.error(`[ensure-chromium] Could not locate a flavor directory above ${exec}`)
    process.exit(1)
  }

  const normalized = basename(dir) === 'chrome-win64' ? 'chrome-win' : basename(dir)
  const dest = resolve(__dirname, '..', 'resources', 'chromium', normalized)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(dir, dest, { recursive: true })
  const entries = readdirSync(dest)
  console.log(`[ensure-chromium] ${dir} → ${dest} (${entries.length} entries)`)
}

main()
