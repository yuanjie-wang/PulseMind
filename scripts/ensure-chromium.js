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

const FLAVORS = [
  'chrome-mac',
  'chrome-mac-arm64',
  // CFT 的 mac 包按位宽命名：arm64 是 chrome-mac-arm64、x64 是 chrome-mac-x64。
  // 漏掉 x64 那一格时本脚本会打印 "Could not locate a flavor directory" 然后静默
  // 跳过 —— 包打好、里面没有浏览器（2026-11-07 在 macos-15-intel runner 上实锤：
  // resources/chromium 整个是空的）。本机是 arm64，这条缝只会在 Intel 上暴露。
  'chrome-mac-x64',
  'chrome-win',
  'chrome-win64',
  'chrome-linux',
  // Chrome for Testing 的 Linux 包解出来是 chrome-linux64（x64）/ chrome-linux-arm64，
  // 名字里带位宽，而 ManagedBackend 只认归一化后的 chrome-linux。
  'chrome-linux64',
  'chrome-linux-arm64',
]
const NORMALIZED = {
  'chrome-mac-arm64': 'chrome-mac',
  'chrome-mac-x64': 'chrome-mac',
  'chrome-win64': 'chrome-win',
  'chrome-linux64': 'chrome-linux',
  'chrome-linux-arm64': 'chrome-linux',
}

// 复制行为一变就 +1：marker 里带着它，老缓存因此会被强制刷新。
// v1 → v2（2026-11-07）：cpSync 加 verbatimSymlinks —— 默认行为会把 CFT 内部的
// 相对链接解析成指向 Playwright 缓存的**绝对路径**，随包浏览器因此依赖构建机的
// 那个缓存目录，且 codesign --deep 会以 "invalid destination for symbolic link
// in bundle" 拒签。改成保留原样的相对链接后，包自包含。
const COPY_VERSION = 2

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
  const sourceTag = `${normalized}@${basename(dirname(dir))}@v${COPY_VERSION}` // e.g. chrome-mac@chromium-1234@v2
  const marker = join(base, '.source')
  if (readMarker(marker) === sourceTag && existsSync(join(base, normalized))) {
    console.log(`[ensure-chromium] resources/chromium up to date (${sourceTag})`)
    return
  }

  rmSync(base, { recursive: true, force: true })
  mkdirSync(base, { recursive: true })
  // verbatimSymlinks: 默认 false 会把 CFT 内部的相对链接（Versions/Current ->
  // 153.0.8010.12）解析成指向 Playwright 缓存的绝对路径，随包浏览器于是依赖
  // 构建机的缓存目录，codesign --deep 也会以 "invalid destination for symbolic
  // link in bundle" 拒签。保留原样后包自包含。
  cpSync(dir, join(base, normalized), { recursive: true, verbatimSymlinks: true })
  writeFileSync(marker, sourceTag)
  console.log(`[ensure-chromium] ${dir} → ${join(base, normalized)} (${readdirSync(join(base, normalized)).length} entries)`)
}

main()
