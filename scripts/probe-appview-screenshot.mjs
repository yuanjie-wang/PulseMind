// App-view screenshot probe — real Electron + real WebContentsView + the real
// capture helper, then pixel-level assertions on the returned PNGs.
//
// Why a probe: the defect lives in coordinate spaces that only the real stack
// has. The dock lays pages out at 1280 CSS px and shrinks them with page zoom
// (346/1280 ≈ 0.27 here); a screenshot's clip must therefore be DOCUMENT DIP
// = CSS × zoom. jsdom can pin the arithmetic but not that Chromium agrees with
// it, nor that the output pixels are the pane's own raster at physical DPR.
//
// What it pins (fixture: red top bar, green #marker at doc y≈600, blue band,
// tall #fafafa filler, orange last row):
//   • OLD (Playwright page.screenshot over connectOverCDP) reproduces the
//     user-reported defect: a >2000px-wide canvas, almost entirely white.
//   • NEW plain: the painted viewport — ~346 DIP wide (692px @2x), red on top,
//     >4% painted. At any scroll offset.
//   • NEW selector: the marker alone, ~108×54, essentially all green.
//   • NEW fullPage: ~692×1460, red top, #fafafa middle, orange bottom.
//
// Usage: node scripts/probe-appview-screenshot.mjs
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
// The bundle must sit INSIDE the project for the external playwright-core
// require() to resolve under the electron binary.
const bundle = join(here, 'probe-appview-screenshot.bundle.cjs')

await build({
  entryPoints: [join(here, 'probe-appview-screenshot.body.mjs')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'playwright-core', 'sharp'],
})

const cleanup = () => rmSync(bundle, { force: true })
process.once('exit', cleanup)

const electron = join(here, '..', 'node_modules', '.bin', 'electron')
const proc = spawn(electron, [bundle], { stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
proc.stdout.on('data', (d) => {
  out += d.toString()
  process.stdout.write(d)
})
proc.stderr.on('data', (d) => process.stderr.write(d))
const code = await new Promise((resolve) => proc.on('exit', resolve))
cleanup()

const results = new Map()
let meta = null
for (const line of out.split('\n')) {
  if (line.startsWith('META ')) meta = JSON.parse(line.slice(5))
  else if (line.startsWith('RESULT ')) {
    const r = JSON.parse(line.slice(7))
    results.set(r.name, r.value)
  }
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail })
}

async function load(name) {
  const info = results.get(name)
  if (!info) throw new Error(`probe did not produce ${name}`)
  const { data, info: raw } = await sharp(info.file).raw().toBuffer({ resolveWithObject: true })
  return { ...info, data, raw }
}

function pixel(img, x, y) {
  const i = (Math.round(y) * img.raw.width + Math.round(x)) * img.raw.channels
  return [img.data[i], img.data[i + 1], img.data[i + 2]]
}

function isWhite(img, x, y) {
  const [r, g, b] = pixel(img, x, y)
  return Math.abs(r - 255) + Math.abs(g - 255) + Math.abs(b - 255) < 24
}

async function paintedFraction(img) {
  let painted = 0
  for (let y = 0; y < img.raw.height; y++) {
    for (let x = 0; x < img.raw.width; x += 2) {
      if (!isWhite(img, x, y)) painted++
    }
  }
  return painted / (img.raw.height * Math.ceil(img.raw.width / 2))
}

function isRed(px) {
  return px[0] > 180 && px[1] < 90 && px[2] < 90
}
function isGreen(px) {
  return px[1] > 120 && px[0] < 90 && px[2] < 90
}
function isOrange(px) {
  return px[0] > 200 && px[1] > 100 && px[1] < 210 && px[2] < 90
}
function isFafafa(px) {
  return px.every((v) => v > 235)
}

if (code !== 0 || !out.includes('DONE')) {
  console.error(`\nPROBE FAILED: electron exited ${code} without DONE`)
  process.exit(1)
}

// window.devicePixelRatio is CSS-relative and therefore already multiplied by
// the page zoom (0.54 here); the physical display factor is dpr / zoom = 2,
// and output pixels = DIP × that physical factor.
const zoom = meta?.zoom ?? 0.2703125
const dpr = meta?.dpr ? meta.dpr / zoom : 2

// ── META: the fixture really is the zoomed 1280-wide page ──
check('zoom stamped on the view ≈ 346/1280', Math.abs(zoom - 346 / 1280) < 0.01, { zoom })
check('layout viewport is 1280 CSS × 721 CSS', meta?.layout?.w === 1280 && Math.abs(meta.layout.h - 721) <= 2, meta?.layout)
check('content is 1280×2700 CSS', meta?.content?.w === 1280 && meta?.content?.h === 2700, meta?.content)

// ── OLD: the user-reported defect ──
const old = await load('OLD_plain_playwright')
const oldPainted = await paintedFraction(old)
check('OLD playwright capture is the wide white canvas (>2000px)', old.width > 2000, { width: old.width, height: old.height })
check('OLD capture is almost entirely white (<2% painted)', oldPainted < 0.02, { painted: oldPainted.toFixed(4) })

// ── NEW plain: the pane's own viewport raster ──
const plain = await load('NEW_plain')
const plainPainted = await paintedFraction(plain)
check('NEW plain is the pane width (~346 DIP → 692px @2x)', Math.abs(plain.width - 346 * dpr) <= 6, { width: plain.width, dpr })
check('NEW plain is the pane height (~195 DIP)', Math.abs(plain.height - 195 * dpr) <= 6, { height: plain.height })
check('NEW plain has real content (>4% painted)', plainPainted > 0.04, { painted: plainPainted.toFixed(4) })
check('NEW plain shows the red top bar', isRed(pixel(plain, plain.width / 2, 5)), pixel(plain, plain.width / 2, 5))

// ── NEW folded: docked background tabs sit at 0×0 bounds ──
const folded = await load('FOLDED_plain')
const foldedPainted = await paintedFraction(folded)
check('FOLDED tab still captures the pane viewport', folded.width === plain.width && folded.height === plain.height, { width: folded.width, height: folded.height })
check('FOLDED capture still has real content', foldedPainted > 0.04, { painted: foldedPainted.toFixed(4) })
check('FOLDED capture still shows the red top bar', isRed(pixel(folded, folded.width / 2, 5)), pixel(folded, folded.width / 2, 5))

// ── NEW selector: the marker alone ──
const selector = await load('NEW_selector')
check('NEW selector box is 200×100 CSS × zoom', Math.abs(selector.width - 108) <= 3 && Math.abs(selector.height - 54) <= 3, { width: selector.width, height: selector.height })
let green = 0
for (let y = 0; y < selector.raw.height; y++) {
  for (let x = 0; x < selector.raw.width; x++) {
    if (isGreen(pixel(selector, x, y))) green++
  }
}
const greenShare = green / (selector.raw.width * selector.raw.height)
check('NEW selector is essentially all marker green (>90%)', greenShare > 0.9, { greenShare: greenShare.toFixed(4) })
check('NEW selector has no red top bar', !isRed(pixel(selector, selector.width / 2, 2)), pixel(selector, selector.width / 2, 2))

// ── NEW fullPage: the whole document, top to bottom ──
const full = await load('NEW_fullPage')
check('NEW full page is ~2700 CSS × zoom', Math.abs(full.width - 692) <= 6 && Math.abs(full.height - 1459.7) <= 10, { width: full.width, height: full.height })
check('NEW full page keeps the red top bar', isRed(pixel(full, full.width / 2, 5)), pixel(full, full.width / 2, 5))
check('NEW full page has the #fafafa filler in the middle', isFafafa(pixel(full, full.width / 2, full.height / 2)), pixel(full, full.width / 2, full.height / 2))
check('NEW full page ends on the orange last row', isOrange(pixel(full, full.width / 2, full.height - 5)), pixel(full, full.width / 2, full.height - 5))

const failed = checks.filter((c) => !c.ok)
for (const c of checks) {
  console.log(`CHECK ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ' ' + JSON.stringify(c.detail) : ''}`)
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.error(`FAIL: ${failed.map((c) => c.name).join(' | ')}`)
  process.exit(1)
}
console.log('PASS: app-view screenshots capture in document DIP')
