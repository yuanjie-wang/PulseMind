// OCR 布局探针 — 真模型端到端验证 bbox 与尺寸链（conv_20261116210413 反思
// 的 #1/#3，2026-11-16；同日第二刀加 crop/det_limit）。vitest 只能扫源码与跑
// 纯函数；这里驱动真的 recognizeImage（PP-OCRv4 WASM + sharp，与产品同一条
// require 路径）回答单测回答不了的事：
//
//   1. box 真的跟着行出来了（det 框 → 原图像素坐标，整数、在界内）。
//   2. 框在**原图**坐标系：>4000px 的图会被 decode 降到 ≤4000，文本若只画在
//      原图右缘（>4000 区域），映射正确时该行 box 必然 >4000——映射漏了就
//      全 ≤4000。这是 kx/ky 映射的判别性断言。
//   3. original/det 尺寸真实：originalWidth == 合成图宽；detWidth ≤ 960。
//   4. crop：只识别裁剪区内文字；返回的框**仍是全图坐标**（判别：裁右半时
//      左侧不可能有行、右侧行的 x0 与整图识别同源）；crop 回声与钳制生效。
//   5. det_limit：提到 1920 后 detWidth 同步变大（旋钮真生效，不只是参数被吞）。
//   6. 无效 crop 给可读错误（LLM 面的错误话术）。
//
// 合成图用 sharp 栅格化 SVG 文本（文字内容只做宽松断言——行的存在与几何是
// 承重断言，个别字识别错不红）。ORT 是纯 WASM（见 smoke-packed-ocr.js 的
// 说明），plain node 直接跑，无需 ELECTRON_RUN_AS_NODE。
//
// Usage: node scripts/probe-ocr-layout.mjs
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = new URL('..', import.meta.url).pathname
const tmp = mkdtempSync(join(tmpdir(), 'pulsemind-ocr-probe-'))
const bundle = join(tmp, 'probe-entry.mjs')

// 每次调用重新打包：目标图片与 opts 写死在入口里（bundled ESM 的 import 缓存
// 不吃参数），?v= 时间戳只是兜底。
async function bundleAndRun (imgPath, opts = undefined) {
  writeFileSync(
    join(tmp, 'entry.ts'),
    `import { recognizeImage } from '${repo}src/main/services/ocr'
export async function run () {
  return recognizeImage(${JSON.stringify(imgPath)}, ${JSON.stringify(opts ?? {})})
}
`
  )
  await build({
    entryPoints: [join(tmp, 'entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundle,
    external: ['sharp', 'onnxruntime-web'],
    // ocr.ts 按产品态用 __dirname 定位 models/ort-web，且候选链从它向上走两级
    // ——产品里那是 out/main。注入 out/main 的绝对路径，两个 resolve* 的落点
    // （resources/ocr-models、node_modules/onnxruntime-web/dist）与产品完全一致。
    define: { __dirname: JSON.stringify(join(repo, 'out', 'main')) },
    // ocr.ts 对 sharp 与 ort.node.min.js 都是运行时 require（后者按计算出的绝对
    // 路径动态 require，external 后 esbuild 原样保留）——ESM 输出没有 require。
    // createRequire 必须锚在**仓库内**（bundle 在 /tmp，向上找不到 node_modules），
    // 与 __dirname 的注入点同址：两条路径都落到仓库 node_modules 的真实文件。
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(join(repo, 'out', 'main', 'index.js'))});` },
    logLevel: 'silent',
  })
  const mod = await import(pathToFileURL(bundle).href + `?v=${Date.now()}-${Math.random()}`)
  return mod.run()
}

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const FONT = 'font-family="Helvetica, Arial, sans-serif"'

try {
  const { default: sharp } = await import('sharp')

  // ── 图 1：常规尺寸（1200x400），两行文本 ──
  const svgSmall = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400">
      <rect width="1200" height="400" fill="white"/>
      <text x="100" y="120" font-size="56" ${FONT} fill="black">TOTAL SCORE 12345</text>
      <text x="100" y="260" font-size="56" ${FONT} fill="black">HEADER ROW SAMPLE</text>
    </svg>`
  )
  const imgSmall = join(tmp, 'small.png')
  await sharp(svgSmall).png().toFile(imgSmall)

  const r1 = await bundleAndRun(imgSmall)

  check('small: recognized some text', r1.lines.length >= 2, `${r1.lines.length} lines: ${r1.lines.map(l => l.text).join(' | ')} (ms=${r1.ms})`)
  check('small: originalWidth == 1200', r1.originalWidth === 1200 && r1.originalHeight === 400, `${r1.originalWidth}x${r1.originalHeight}`)
  check('small: decode == original (no downscale)', r1.width === 1200 && r1.height === 400, `${r1.width}x${r1.height}`)
  check('small: detWidth <= 960 (default)', r1.detWidth <= 960 && r1.detHeight > 0, `det ${r1.detWidth}x${r1.detHeight}`)
  check('small: every line carries a box', r1.lines.every(l => l.box && [l.box.x0, l.box.y0, l.box.x1, l.box.y1].every(Number.isInteger)), '')
  check(
    'small: boxes within image bounds',
    r1.lines.every(l => l.box.x0 >= 0 && l.box.y0 >= 0 && l.box.x1 <= 1200 && l.box.y1 <= 400),
    JSON.stringify(r1.lines.map(l => l.box))
  )
  // 第一行画在 y≈64-120：它的框必须落在上半（粗略几何，不认字体差异）
  const firstLine = r1.lines.find(l => /TOTAL|12345/.test(l.text))
  check('small: first text row box sits in the top half', !!firstLine && firstLine.box.y1 <= 200, firstLine ? JSON.stringify(firstLine.box) : 'line not matched')
  check('small: no crop echoed without one', r1.crop === undefined, '')

  // ── 图 2：4600x300（decode 会降到 ≤4000），左右各一行文本 ──
  const svgWide = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="4600" height="300">
      <rect width="4600" height="300" fill="white"/>
      <text x="100" y="180" font-size="72" ${FONT} fill="black">LEFT SIDE</text>
      <text x="4150" y="180" font-size="72" ${FONT} fill="black">EDGE 88</text>
    </svg>`
  )
  const imgWide = join(tmp, 'wide.png')
  await sharp(svgWide).png().toFile(imgWide)

  const r2 = await bundleAndRun(imgWide)
  check('wide: originalWidth == 4600', r2.originalWidth === 4600 && r2.originalHeight === 300, `${r2.originalWidth}x${r2.originalHeight} (ms=${r2.ms})`)
  check('wide: decode downscaled to <= 4000', r2.width <= 4000, `${r2.width}x${r2.height}`)
  const edgeLine = r2.lines.find(l => /88|EDGE/i.test(l.text))
  check('wide: recognized the edge text', !!edgeLine, r2.lines.map(l => l.text).join(' | ') || '(none)')
  check(
    'wide: edge box mapped back to ORIGINAL space (>4000)',
    !!edgeLine && edgeLine.box.x0 > 4000,
    edgeLine ? `x0=${edgeLine.box.x0}, box=${JSON.stringify(edgeLine.box)}` : 'no line'
  )
  check('wide: boxes within ORIGINAL bounds', (edgeLine ? [edgeLine] : r2.lines).every(l => l.box.x1 <= 4600 && l.box.y1 <= 300), '')

  // ── 图 2 + crop 左半：只识别左侧；框仍是全图坐标；crop 回声 ──
  const r3 = await bundleAndRun(imgWide, { crop: { x0: 50, y0: 20, x1: 900, y1: 280 } })
  check('crop: recognized ONLY the left text', r3.lines.length >= 1 && !r3.lines.some(l => /88|EDGE/i.test(l.text)), r3.lines.map(l => l.text).join(' | ') || '(none)')
  check(
    'crop: echoed region is the clamped request',
    !!r3.crop && r3.crop.x0 === 50 && r3.crop.y0 === 20 && r3.crop.x1 === 900 && r3.crop.y1 === 280,
    JSON.stringify(r3.crop)
  )
  const leftLine = r3.lines[0]
  check(
    'crop: box stays in FULL-image coords (x0 near 100, NOT crop-relative)',
    !!leftLine && leftLine.box.x0 >= 50 && leftLine.box.x0 < 300,
    leftLine ? JSON.stringify(leftLine.box) : 'no line'
  )

  // ── det_limit 生效：4600 图 decode 后宽 4000，det_limit 1920 → detWidth≈1920 ──
  const r4 = await bundleAndRun(imgWide, { detLimit: 1920 })
  check('det_limit: detWidth follows the knob (≈1920, > default 960)', r4.detWidth > 960 && Math.abs(r4.detWidth - 1920) <= 32, `det ${r4.detWidth}x${r4.detHeight}`)

  // ── 无效 crop：可读错误，不是 sharp 的天书 ──
  let badCropMsg = ''
  try {
    await bundleAndRun(imgWide, { crop: { x0: 5000, y0: 0, x1: 4000, y1: 100 } })
  } catch (err) {
    badCropMsg = err instanceof Error ? err.message : String(err)
  }
  check('bad crop: readable error naming the coordinates', /ocr crop/.test(badCropMsg), badCropMsg.slice(0, 120))

  // ── 图 3：阅读顺序判别（conv_20261116210413 第二轮实测的缺陷形状）——
  // 同一视觉行两列，右列抬高 3px：det 的 y 中心排序会把右列排到前面；
  // readingOrderLines 必须把它们聚成一行、按 x 输出（左列在前）。
  const svgOrder = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="160">
      <rect width="900" height="160" fill="white"/>
      <text x="80" y="110" font-size="52" ${FONT} fill="black">KEYROW</text>
      <text x="560" y="107" font-size="52" ${FONT} fill="black">VAL77</text>
    </svg>`
  )
  const imgOrder = join(tmp, 'order.png')
  await sharp(svgOrder).png().toFile(imgOrder)

  const r5 = await bundleAndRun(imgOrder, { includeLayout: undefined })
  check('order: recognized both columns', r5.lines.length >= 2, r5.lines.map(l => l.text).join(' | ') || `(none) (ms=${r5.ms})`)
  const joined = r5.lines.map(l => l.text).join(' ')
  const iKey = joined.indexOf(/KEY|KEYROW/.test(joined) ? 'KEY' : joined)
  const iVal = joined.indexOf('VAL')
  check(
    'order: same-row columns come out left→right (not by y-center)',
    iKey >= 0 && iVal > iKey,
    `lines order: ${r5.lines.map(l => l.text).join(' | ')}`
  )

  // ── 图 4：tile 判别（conv_20261116210413 round5——竖长截图整图 det 0.34x 的
  // 尺度依赖误读根治路径）。1320x2868、40 行文字，与出问题的表格图同尺寸：
  //   a. tile 分带跑通：tile.bands > 1 回声；
  //   b. 覆盖完整：40 行全识别（首尾行都在——带缘不丢行）；
  //   c. 零重复：40 个不同的 ROW 文本各出现一次（接受区间分区的承重断言）；
  //   d. box 全图坐标：首行 y<200、末行 y>2700，全部界内；
  //   e. det 尺寸链可见：detWidth == 1320（1:1，不再 448）。
  const svgTall = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1320" height="2868">
      <rect width="1320" height="2868" fill="white"/>
      ${Array.from({ length: 40 }, (_, i) =>
        `<text x="80" y="${120 + i * 66}" font-size="44" ${FONT} fill="black">ROW ${String(i).padStart(2, '0')} MARK ${i}</text>`
      ).join('\n')}
    </svg>`
  )
  const imgTall = join(tmp, 'tall.png')
  await sharp(svgTall).png().toFile(imgTall)

  const rt = await bundleAndRun(imgTall, { tile: true })
  check('tile: bands echoed (>1)', !!rt.tile && rt.tile.bands > 1, `bands=${rt.tile?.bands} (ms=${rt.ms})`)
  check('tile: det at ~1:1 (>=0.9x width, not the 448 whole-image downscale)', rt.detWidth >= 0.9 * 1320, `det ${rt.detWidth}x${rt.detHeight}`)
  const rowTexts = rt.lines.map(l => l.text)
  const rowIdx = rowTexts.filter(t => /ROW/.test(t))
  check('tile: coverage complete (all 40 rows detected)', rowIdx.length >= 38, `${rowIdx.length}/40 rows: first=${rowTexts[0] ?? '?'} last=${rowTexts[rowTexts.length - 1] ?? '?'}`)
  const norm = (s) => s.replace(/\s+/g, ' ').trim()
  const counts = new Map()
  for (const t of rowIdx) counts.set(norm(t), (counts.get(norm(t)) ?? 0) + 1)
  const dups = [...counts.entries()].filter(([, n]) => n > 1)
  check('tile: zero duplicates (acceptance partition)', dups.length === 0, dups.length ? `dups: ${JSON.stringify(dups.slice(0, 3))}` : `${counts.size} unique`)
  check(
    'tile: boxes in full-image coords (first top, last bottom)',
    rt.lines.every(l => l.box.y0 >= 0 && l.box.y1 <= 2868)
      && rt.lines.some(l => l.box.y1 <= 200)
      && rt.lines.some(l => l.box.y0 >= 2600),
    `y range: ${Math.min(...rt.lines.map(l => l.box.y0))}..${Math.max(...rt.lines.map(l => l.box.y1))}`
  )
  // 对照：同图不带 tile 也能跑（非 tile 路径逐字节不动的烟测）+ 基线对照耗时
  const rt0 = await bundleAndRun(imgTall, {})
  check('tile: non-tile path still works on the same image', rt0.lines.length >= 38 && !rt0.tile, `lines=${rt0.lines.length} tile=${JSON.stringify(rt0.tile)} (ms=${rt0.ms} vs tile ${rt.ms}ms)`)

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
  process.exitCode = failures === 0 ? 0 : 1
} catch (err) {
  console.error('[probe-ocr-layout] ERROR:', err)
  process.exitCode = 2
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 临时目录失败不影响结论 */ }
}
