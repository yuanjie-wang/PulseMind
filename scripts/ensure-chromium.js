// ── ensure-chromium (A-M2) ──
// Copies the Playwright-managed Chromium into resources/chromium/ so
// electron-builder can ship it (extraResources). ManagedBackend resolves the
// executable from this directory in packaged builds.
//
// Usage:
//   npm run browsers:install   # fetch Chromium via the playwright-core registry (one-time)
//   npm run browsers:ensure    # copy it into resources/chromium/ (also runs at the
//                              # end of `npm run build`)
//
// NEVER exits non-zero: a missing copy only means packaged builds fall back
// to system Chrome/Edge (ManagedBackend's candidate order), and a hard
// failure here would break every build on machines without Chromium.
//
// Idempotent: a `.source` marker records the copied flavor+build; the copy is
// refreshed only when the marker changes. Flavor directories are NORMALIZED
// to chrome-mac / chrome-win / chrome-linux (playwright may use
// chrome-mac-arm64 / chrome-win64 on newer builds) — ManagedBackend expects
// the normalized names.

const { existsSync, mkdirSync, cpSync, rmSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join, dirname, basename, resolve } = require('node:path')

const FLAVORS = ['chrome-mac', 'chrome-mac-arm64', 'chrome-win', 'chrome-win64', 'chrome-linux']
const NORMALIZED = { 'chrome-mac-arm64': 'chrome-mac', 'chrome-win64': 'chrome-win' }

function readMarker(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function main() {
  const base = resolve(__dirname, '..', 'resources', 'chromium')
  mkdirSync(base, { recursive: true })

  let exec
  try {
    exec = require('playwright-core').chromium.executablePath()
  } catch {
    console.warn('[ensure-chromium] playwright-core unavailable — packaged builds will fall back to system Chrome/Edge')
    return
  }
  if (!existsSync(exec)) {
    console.warn(
      `[ensure-chromium] Chromium not found at ${exec} — run \`npm run browsers:install\` first. Packaged builds will fall back to system Chrome/Edge.`,
    )
    return
  }

  let dir = dirname(exec)
  while (dir !== dirname(dir) && !FLAVORS.includes(basename(dir))) dir = dirname(dir)
  if (!FLAVORS.includes(basename(dir))) {
    console.warn(`[ensure-chromium] Could not locate a flavor directory above ${exec} — skipping`)
    return
  }

  const normalized = NORMALIZED[basename(dir)] ?? basename(dir)
  const sourceTag = `${normalized}@${basename(dirname(dir))}` // e.g. chrome-mac@chromium-1234
  const marker = join(base, '.source')
  if (readMarker(marker) === sourceTag && existsSync(join(base, normalized))) {
    console.log(`[ensure-chromium] resources/chromium up to date (${sourceTag})`)
    return
  }

  rmSync(base, { recursive: true, force: true })
  mkdirSync(base, { recursive: true })
  cpSync(dir, join(base, normalized), { recursive: true })
  writeFileSync(marker, sourceTag)
  console.log(`[ensure-chromium] ${dir} → ${join(base, normalized)} (${readdirSync(join(base, normalized)).length} entries)`)
}

main()
