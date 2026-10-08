// Real-Chromium end-to-end for the PPT design route (PLAN-pptx-html-route).
//
// The vitest half pins the pure emitter and validators with jsdom stubs; only
// the real browser answers the questions that matter here:
//   1. a real .slide renders and the collector reports token-cascaded colors,
//      run splits, boxes, bullets, chart annotations, tables, images;
//   2. the emitted pptx carries those facts at 96dpi (px → EMU/pt);
//   3. profile violations measured IN the page (transform, overflow,
//      translucency) refuse with named, page-numbered errors;
//   4. the tokens.css link beats the injected defaults in the cascade.
// The defaultLaunch candidate resolution (env → bundled → system) is
// ManagedBackend's battle-tested code — this probe injects its own launcher,
// which is also the seam the DI contract promises.
//
// Bundle with esbuild (`packages: external` keeps pptxgenjs/playwright-core
// real), run under plain node — no native modules on this path, so the
// ELECTRON_RUN_AS_NODE recipe is unnecessary.

import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url)) + '/..'
const require = createRequire(join(root, 'package.json'))
const work = mkdtempSync(join(tmpdir(), 'pm-html-route-probe-'))
const fixture = join(work, 'deck')
// the bundle runs in-process, but `packages: external` makes its requires
// resolve from its own directory — park it under the project's node_modules
// so pptxgenjs/playwright-core/adm-zip resolve by walking up
const cacheDir = join(root, 'node_modules/.cache/pm-probe')
mkdirSync(cacheDir, { recursive: true })

// ── fixture: tokens.css + deck.html + a real image ──
mkdirSync(join(fixture, 'assets'), { recursive: true })
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
writeFileSync(join(fixture, 'assets/logo.png'), PNG_1PX)
writeFileSync(join(fixture, 'tokens.css'), `:root {
  --pm-accent: #C2483B;
  --pm-accent-soft: #F5DDD9;
  --pm-ink: #1F1F1F;
  --pm-bg: #FFFDF8;
  --pm-line: #E0DAD2;
  --pm-font-zh: '微软雅黑';
  --pm-font-latin: 'Arial';
  --pm-font-mono: 'Menlo';
  --pm-fs-cover: 44px;
  --pm-fs-note: 13px;
}`)
const CHART = JSON.stringify({ type: 'pie', categories: ['甲', '乙'], series: [{ name: '构成', values: [60, 40] }] })
writeFileSync(join(fixture, 'deck.html'), `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="./tokens.css">
<style>
  body { margin: 0 }
  .slide { width: 960px; height: 540px; position: relative; background: var(--pm-bg) }
</style></head><body>
<div class="slide">
  <div style="position:absolute; left:40px; top:40px; width:200px; height:100px; background:var(--pm-accent); border-radius:12px"></div>
  <h1 style="position:absolute; left:64px; top:80px; width:600px; font-size:var(--pm-fs-cover); color:var(--pm-ink); font-weight:normal; letter-spacing:4px">季度<strong>回顾</strong></h1>
  <div style="position:absolute; left:820px; top:500px; width:100px; font-size:var(--pm-fs-note); color:var(--pm-muted); font-family:var(--pm-font-mono)">3 / 14</div>
  <ul style="position:absolute; left:64px; top:200px; width:300px">
    <li style="font-size:18px">要点甲</li>
  </ul>
  <div data-chart='${CHART}' style="position:absolute; left:500px; top:120px; width:360px; height:300px"></div>
  <table style="position:absolute; left:64px; top:320px; border-collapse:collapse">
    <tr><th style="background:var(--pm-accent); color:#FFFFFF; font-size:16px">名称</th><th>数量</th></tr>
    <tr><td style="font-size:14px">甲</td><td>12</td></tr>
  </table>
  <img src="assets/logo.png" style="position:absolute; left:500px; top:440px; width:40px; height:40px">
  <div style="position:absolute; left:64px; top:470px; width:240px; height:50px; border:2px dashed var(--pm-accent)"></div>
</div>
<div class="slide" style="background:var(--pm-bg)">
  <img src="assets/logo.png" style="position:absolute; left:0; top:0; width:960px; height:540px; object-fit:cover">
  <div style="position:absolute; left:0; top:0; width:960px; height:540px; background:rgba(0,0,0,0.35)"></div>
  <div style="position:absolute; left:64px; top:200px; width:400px; height:160px; background:#FFFFFF; box-shadow:0px 2px 8px rgba(0,0,0,0.10); border-radius:8px"></div>
  <h1 style="position:absolute; left:64px; top:60px; width:600px; font-size:var(--pm-fs-cover); color:#FFFFFF; font-weight:normal">满版封面</h1>
</div>
</body></html>`)

const bad = (name, body) => {
  writeFileSync(join(fixture, name), `<!doctype html><html><head><style>.slide{width:960px;height:540px;position:relative}body{margin:0}</style></head>
<body><div class="slide">${body}</div></body></html>`)
}
bad('transform.html', `<p style="transform:translateX(5px)">斜的</p>`)
bad('overflow.html', `<div style="position:absolute; left:900px; top:500px; width:200px; height:100px; background:#333333"></div>`)
// translucent TEXT color still refuses (fills map; OOXML runs carry no alpha)
bad('alpha.html', `<p style="position:absolute; left:10px; top:10px; width:100px; color:rgba(0,0,0,0.5)">浅字</p>`)
bad('overlap.html', `<p style="position:absolute; left:100px; top:100px; width:400px">上方标题标题标题标题</p><p style="position:absolute; left:100px; top:108px; width:400px">下方文本文本文本文本</p>`)
// text-vs-surface (2026-10-07): tables and charts are text-bearing — a
// full-width line crossing a table shipped once (the 20261007235037 p12 shape)
bad('table-overlap.html', `<p style="position:absolute; left:64px; top:200px; width:832px">安卓续航充电普遍 80–120W</p><table style="position:absolute; left:64px; top:212px; width:600px"><tr><td>机型</td><td>电池</td></tr></table>`)

// ── recipes.html: the reference's own skeletons must pass the profile they teach ──
// Extracted VERBATIM from office-references.ts (single source of truth). Two
// kinds of fence: those opening with <div class="slide" are PAGE SHELLS and
// mount as slides; every other html fence is a COMPONENT and the probe wraps
// it in a standard shell before measuring — the same band geometry the
// reference's prose promises. A future edit that makes any recipe refusable
// (overflow, text/table overlap, …) fails here.
const refsSrc = readFileSync(join(root, 'src/renderer/src/skills/built-in/office-references.ts'), 'utf8')
// only §3 carries recipes — §1/§2 have other html fences (the deck skeleton,
// the data-chart example) that are not pages
const section3 = refsSrc.slice(refsSrc.indexOf('### 3. 版式配方库'), refsSrc.indexOf('### 4. 转换与交付'))
const htmlFences = Array.from(
  section3.matchAll(/\\`\\`\\`html\n([\s\S]*?)\n\\`\\`\\`/g),
  (m) => m[1].replaceAll('\\`', '`')
)
const shells = htmlFences.filter((f) => f.startsWith('<div class="slide"'))
const components = htmlFences.filter((f) => !f.startsWith('<div class="slide"'))
// 5 shells: cover / section / quote / closing + the worked example (C).
// 6 components: 要点列表 / 卡片行 / 大数字 / 图表 / 对比栏 / 表格.
if (shells.length !== 5) throw new Error(`expected 5 page shells in office-references.ts §3, got ${shells.length}`)
if (components.length !== 6) throw new Error(`expected 6 content components in office-references.ts §3, got ${components.length}`)
const recipeSlides = [
  ...shells,
  ...components.map((f) => `<div class="slide" style="background:var(--pm-bg)">${f}</div>`),
]
  .map((s) => s.replaceAll('assets/cover.jpg', 'assets/logo.png'))
  .join('\n')
writeFileSync(
  join(fixture, 'recipes.html'),
  `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="./tokens.css">
<style>
  body { margin: 0 }
  .slide { width: 960px; height: 540px; position: relative }
</style></head><body>
${recipeSlides}
</body></html>`
)

// ── bundle the real modules and run in-process ──
const bundle = join(cacheDir, 'pptx-html-route.cjs')
await build({
  stdin: {
    contents: `
const assert = require('node:assert/strict')
const { measureLayout } = require('${join(root, 'src/main/office-export/html-measure.ts')}')
const { htmlDeckToPptxBuffer } = require('${join(root, 'src/main/office-export/html-to-pptx.ts')}')

const launch = async () => {
  const { chromium } = require('playwright-core')
  try { return await chromium.launch({ headless: true }) } catch { return chromium.launch({ channel: 'chrome', headless: true }) }
}
const fixturePath = (name) => ${JSON.stringify(fixture)} + '/' + name

async function main() {
  // 1 + 4: real measurement — token cascade, runs, boxes, bullets, chart, table, image
  const measured = await measureLayout(fixturePath('deck.html'), { launch })
  assert.equal(measured.slides.length, 2, 'two slides')
  assert.equal(measured.slides[0].background, 'FFFDF8', 'tokens.css --pm-bg beats injected defaults')
  const blocks = measured.slides[0].blocks
  const box = blocks.find((b) => b.kind === 'box')
  assert.equal(box.fill, 'C2483B', 'accent token cascades into the box fill')
  assert.equal(box.radiusPx, 12, 'border-radius measured')
  assert.ok(Math.abs(box.x - 40) < 0.6 && Math.abs(box.y - 40) < 0.6, 'box at its absolute position')
  const h1 = blocks.find((b) => b.kind === 'text' && b.runs.some((r) => r.text.includes('季度')))
  assert.ok(h1, 'h1 text block collected')
  assert.equal(h1.runs[0].fontSizePx, 44, '44px read off the browser')
  assert.equal(h1.runs[0].color, '1F1F1F', 'ink token cascades')
  assert.equal(h1.runs[0].bold, false, 'font-weight:normal respected')
  assert.equal(h1.runs[1].bold, true, '<strong> splits the run bold')
  assert.equal(h1.runs[0].fontSizePx, 44, '--pm-fs-cover resolves through the cascade')
  assert.equal(h1.runs[0].charSpacingPx, 4, 'letter-spacing:4px rides the run')
  const dashedBox = blocks.filter((b) => b.kind === 'box' && b.border && b.border.dash)
  assert.equal(dashedBox.length, 1, 'dashed border box collected')
  assert.equal(dashedBox[0].border.dash, 'dash')
  const footer = blocks.find((b) => b.kind === 'text' && b.runs.some((r) => r.text.includes('3 / 14')))
  assert.ok(footer, 'footer block collected')
  assert.equal(footer.runs[0].mono, true, 'mono run detected via tokens face')
  assert.ok(Math.abs(h1.x - 64) < 0.6, 'h1 at left:64px')
  const li = blocks.find((b) => b.kind === 'text' && b.bullet)
  assert.equal(li.bullet.ordered, false, 'ul bullet')
  const chart = blocks.find((b) => b.kind === 'chart')
  assert.equal(JSON.parse(chart.raw).type, 'pie', 'chart annotation carried raw')
  const table = blocks.find((b) => b.kind === 'table')
  assert.equal(table.cells[0][0].fill, 'C2483B', 'th fill measured')
  const img = blocks.find((b) => b.kind === 'image')
  assert.equal(img.src, 'assets/logo.png', 'img src carried raw')
  console.log('  ok  measurement: tokens cascade, runs, box, bullet, chart, table, image')

  // slide 2: the new design devices measured in a real Chromium
  const s2 = measured.slides[1].blocks
  const mask = s2.find((b) => b.kind === 'box' && b.fill === '000000')
  assert.ok(mask, 'rgba mask measured as a box')
  assert.equal(mask.fillTransparency, 65, 'rgba(0,0,0,0.35) → transparency 65 (35% opaque)')
  const card = s2.find((b) => b.kind === 'box' && b.shadow)
  assert.ok(card, 'box-shadow card measured')
  assert.equal(card.fill, 'FFFFFF')
  assert.deepEqual(card.shadow, { offsetX: 0, offsetY: 2, blur: 8, color: '000000', alpha: 0.1 }, 'shadow facts from computed style')
  const cover = s2.find((b) => b.kind === 'image' && b.objectFit === 'cover')
  assert.ok(cover, 'cover image measured')
  assert.equal(cover.naturalW, 1, 'natural size decoded (1×1 PNG)')
  assert.deepEqual(cover.coverCrop, { l: 0, r: 0, t: 0.21875, b: 0.21875 }, '1:1 natural in 16:9 window → t/b crop 0.21875')
  assert.equal(measured.degradations.length, 0, 'no degradations on the fixture deck')
  console.log('  ok  design devices: rgba mask, box-shadow, object-fit:cover crop')

  // 3: in-page profile refusals
  for (const [file, pattern] of [
    ['transform.html', /transform/],
    ['overflow.html', /超出页面/],
    ['alpha.html', /半透明/],
    ['overlap.html', /文字区域重叠/],
    ['table-overlap.html', /表格区域重叠/],
  ]) {
    await assert.rejects(
      () => measureLayout(fixturePath(file), { launch }),
      (err) => pattern.test(err.message),
      file + ' must refuse')
    console.log('  ok  refusal: ' + file)
  }

  // 2: facts → pptx at 96dpi
  const { readFileSync } = require('node:fs')
  const images = new Map([['assets/logo.png', readFileSync(fixturePath('assets/logo.png'))]])
  const { buffer, report } = await htmlDeckToPptxBuffer({
    facts: { slides: measured.slides },
    images,
    accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', fontMono: 'Menlo',
    title: '设计路线探针',
    degradations: measured.degradations,
  })
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(buffer)
  const slide1 = zip.readAsText('ppt/slides/slide1.xml')
  assert.ok(slide1, 'slide1 exists')
  assert.ok(slide1.includes('x="609600"'), '64px → 609600 EMU')
  assert.ok(slide1.includes('lIns="0"'), 'text-box insets zeroed (margin: 0)')
  assert.ok(slide1.includes('cx="5' ), 'left-aligned h1 width extended beyond measured 600px')
  assert.ok(slide1.includes('sz="3300"'), '44px → 33pt (sz=3300)')
  assert.ok(slide1.includes('val="FFFDF8"'), 'slide background from --pm-bg')
  assert.ok(slide1.includes('prst="roundRect"'), 'radius → roundRect')
  assert.ok(slide1.includes('prst="pie"'), 'data-chart → native pie shapes')
  assert.ok(slide1.includes('<a:tbl>'), 'table → native a:tbl')
  assert.ok(slide1.includes('<a:latin typeface="Arial"'), 'a:latin = --pm-font-latin')
  assert.ok(slide1.includes('<a:ea typeface="微软雅黑"'), 'a:ea = --pm-font-zh')
  assert.ok(slide1.includes('<a:latin typeface="Menlo"'), 'mono run rides --pm-font-mono')
  assert.ok(!slide1.includes('<a:ea typeface="Menlo"'), 'mono run CJK corrected back to the sans ea')
  assert.ok(slide1.includes('spc="300"'), 'letter-spacing 4px → charSpacing 3pt (spc 300)')
  assert.ok(slide1.includes('<a:prstDash val="dash"/>'), 'dashed border → prstDash')
  const media = zip.getEntries().filter((e) => e.entryName.startsWith('ppt/media/') && !e.entryName.endsWith('/'))
  assert.equal(media.length, 2, 'both slides embed the image (data URIs are not deduped)')
  assert.ok(report.includes('2 页'), 'report census')
  assert.ok(report.includes('原生可编辑形状'), 'report mentions native shapes')
  console.log('  ok  emission: px→EMU/pt, tokens, chart, table, latin/ea split, image, report')

  // slide 2 emission: the design devices land as real OOXML
  const slide2 = zip.readAsText('ppt/slides/slide2.xml')
  assert.ok(slide2.includes('<a:alpha val="35000"/>'), 'rgba mask fill → 35% opaque (transparency 65)')
  assert.ok(slide2.includes('<a:outerShdw'), 'box-shadow → outerShdw')
  assert.ok(slide2.includes('blurRad="76200"'), 'shadow blur 8px → 6pt')
  assert.ok(slide2.includes('dir="5400000"'), 'shadow offset (0,2)px → dir 90°')
  assert.ok(slide2.includes('<a:alpha val="10000"/>'), 'shadow alpha 0.10')
  assert.ok(slide2.includes('<a:srcRect l="0" r="0" t="21875" b="21875"/>'), 'cover crop injected (post-pass)')
  assert.ok(!slide2.includes('t="0" b="0"/><a:stretch'), 'no zero-crop marker left behind')
  console.log('  ok  emission devices: fill alpha, outerShdw, real srcRect crop')

  // 5: the reference's own shells + components must pass the profile they teach
  const recipes = await measureLayout(fixturePath('recipes.html'), { launch })
  assert.equal(recipes.slides.length, 11, 'five shells + six band components measured')
  assert.equal(recipes.degradations.length, 0, 'recipes degrade nothing: ' + JSON.stringify(recipes.degradations))
  // every component sits inside the band: its content must clear the page-number
  // airspace (top ≤ 480) — the geometry the prose promises
  recipes.slides.slice(5).forEach((sf, i) => {
    for (const b of sf.blocks) {
      assert.ok(b.y + b.h <= 480.5, 'component ' + (i + 1) + ' block overflows the band: kind=' + b.kind + ' bottom=' + Math.round(b.y + b.h))
    }
  })
  const recipeDeck = await htmlDeckToPptxBuffer({
    facts: { slides: recipes.slides },
    images,
    accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', fontMono: 'Menlo',
    title: '配方库探针',
  })
  const recipeZip = new AdmZip(recipeDeck.buffer)
  for (let i = 1; i <= 11; i++) assert.ok(recipeZip.readAsText('ppt/slides/slide' + i + '.xml'), 'recipe slide ' + i + ' emitted')
  assert.ok(recipeZip.readAsText('ppt/slides/slide1.xml').includes('t="21875"'), 'recipe A computes the cover crop')
  assert.ok(recipeZip.readAsText('ppt/slides/slide1.xml').includes('spc="300"'), 'recipe A kicker carries letter-spacing')
  console.log('  ok  recipes: 5 shells + 6 band components measure clean, stay in-band, and emit')

  // DI contract: a failing launcher propagates its own error (the
  // browsers:install hint lives in defaultLaunch, not in the injected one)
  await assert.rejects(
    () => measureLayout(fixturePath('deck.html'), {
      launch: async () => { throw new Error('probe-injected launcher failure') },
    }),
    (err) => err.message.includes('probe-injected launcher failure'))
  console.log('  ok  DI: failing launcher propagates')
}

main().then(
  () => { console.log('ALL PASS'); process.exit(0) },
  (err) => { console.error('FAIL: ' + (err && err.stack || err)); process.exit(1) },
).finally(() => rmSync(work, { recursive: true, force: true }))
`,
    resolveDir: root,
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
})
const { pathToFileURL } = await import('node:url')
await import(pathToFileURL(bundle).href)
