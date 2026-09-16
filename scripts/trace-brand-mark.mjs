/**
 * Turn the brand mark into an inline SVG path (offline asset generation).
 *
 * The panel's floating launcher shows the PulseMind mark. It cannot be an
 * `<img>` pointing at a PNG: a content script's elements live in the *page's*
 * document, so a `chrome-extension://` URL needs `web_accessible_resources` and
 * a `data:` URL is a fetched subresource like any other — both are subject to
 * the host page's `img-src`, which several of the sites the extension runs on
 * lock down. SVG geometry in the DOM is not a fetch, so it renders everywhere.
 * (Same reason ui/icons.tsx carries path data instead of icon fonts.)
 *
 * The source is `resources/pulseMind.png` — the 1024px app icon, whose interior
 * carries the very same mark as the transparent PNG the mark was cut from
 * (622x446, aspect 1.395; the two silhouettes overlap at IoU 0.976, the
 * remainder being anti-aliasing). Tracing from an in-repo file keeps this
 * reproducible; nothing here depends on a path outside the repository.
 *
 * Method: the icon is a near-white mark on a #222 tile, so luminance maps to
 * coverage. Marching squares on that field at level 0.5 walks the contour with
 * sub-pixel precision (linear interpolation along each cell edge), the loops are
 * chained, Douglas–Peucker simplifies them, and the result is *verified by
 * rasterizing it back* (even-odd scanline fill at the source resolution) and
 * reporting the IoU against the source mask. A trace that drifts would show up
 * as a lower number, so the reported IoU is the check that the emitted path is
 * the same drawing.
 *
 * Usage: node scripts/trace-brand-mark.mjs [--write]
 *   --write   rewrite src/extension/ui/logo.ts (otherwise print the path)
 */
import { writeFileSync, readFileSync } from 'node:fs'
import sharp from 'sharp'

const SRC = 'resources/pulseMind.png'
const OUT = 'src/extension/ui/logo.tsx'
/** Contour level in coverage units. 0.5 is the geometric edge of an
 *  anti-aliased stroke. */
const LEVEL = 0.5
/** Douglas–Peucker tolerance, in source pixels — the knee of the fidelity
 *  curve, measured by sweeping it: 0.35px keeps 691 points for IoU 0.9971, 0.6px
 *  keeps 200 for 0.9929, 1.0px drops to 57 for 0.9806. 0.6 is 3.5x fewer points
 *  for 0.4% of the ink, and even that 0.4% is sub-pixel: one source pixel is
 *  0.042 screen pixels at the launcher's 26px mark. */
const EPSILON = 0.6

/** Luminance of the tile and of the mark, measured from the image's own
 *  histogram (1st/99th percentile inside the artwork) rather than assumed, so
 *  the mapping stays right if the icon is ever recoloured. */
function coverageField(raw, width, height, channels) {
  const lum = new Float32Array(width * height)
  const values = []
  for (let i = 0, p = 0; p < width * height; i += channels, p++) {
    const a = channels === 4 ? raw[i + 3] : 255
    const l = a < 16 ? 0 : (raw[i] * 0.299 + raw[i + 1] * 0.587 + raw[i + 2] * 0.114) * (a / 255)
    lum[p] = l
    if (a > 200) values.push(l)
  }
  values.sort((x, y) => x - y)
  const lo = values[Math.floor(values.length * 0.01)]
  const hi = values[Math.floor(values.length * 0.99)]
  const span = Math.max(1, hi - lo)
  const cov = new Float32Array(width * height)
  for (let p = 0; p < lum.length; p++) cov[p] = Math.min(1, Math.max(0, (lum[p] - lo) / span))
  return { cov, lo, hi }
}

/** Marching squares over a padded copy of `cov` (outside the image is empty
 *  ink, which is what makes the glyph's outer contour close at the border).
 *  Each crossing point is cached per grid edge, so the neighbouring cells that
 *  share an edge produce *the same* key and the segments chain exactly. */
function traceContours(cov, width, height) {
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : cov[y * width + x])
  const points = new Map()
  const cache = (key, x, y) => {
    let p = points.get(key)
    if (!p) points.set(key, (p = { x, y }))
    return p
  }
  // The interpolated crossing of the level on the edge from (x0,y0) to (x1,y1).
  const cross = (key, x0, y0, x1, y1, c0, c1) => {
    const t = (LEVEL - c0) / (c1 - c0 || 1e-9)
    return cache(key, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
  }
  const segments = []
  for (let y = -1; y < height; y++) {
    for (let x = -1; x < width; x++) {
      const tl = at(x, y)
      const tr = at(x + 1, y)
      const br = at(x + 1, y + 1)
      const bl = at(x, y + 1)
      const idx = (tl >= LEVEL ? 1 : 0) | (tr >= LEVEL ? 2 : 0) | (br >= LEVEL ? 4 : 0) | (bl >= LEVEL ? 8 : 0)
      if (idx === 0 || idx === 15) continue
      // Crossings on the four edges, named by the edge they belong to so the
      // adjacent cell reuses the identical point.
      const top = tl >= LEVEL !== tr >= LEVEL ? cross(`h:${x}:${y}`, x, y, x + 1, y, tl, tr) : null
      const right = tr >= LEVEL !== br >= LEVEL ? cross(`v:${x + 1}:${y}`, x + 1, y, x + 1, y + 1, tr, br) : null
      const bottom = bl >= LEVEL !== br >= LEVEL ? cross(`h:${x}:${y + 1}`, x, y + 1, x + 1, y + 1, bl, br) : null
      const left = tl >= LEVEL !== bl >= LEVEL ? cross(`v:${x}:${y}`, x, y, x, y + 1, tl, bl) : null
      const found = [top, right, bottom, left].filter(Boolean)
      if (found.length === 2) segments.push(found)
      else if (found.length === 4) {
        // Saddle: the field's own centre breaks the tie, which keeps the two
        // arcs from crossing each other.
        const mid = (tl + tr + br + bl) / 4
        const pairs =
          mid >= LEVEL
            ? [
                [top, left],
                [right, bottom],
              ]
            : [
                [top, right],
                [bottom, left],
              ]
        segments.push(...pairs.map(([a, b]) => [a ?? top, b ?? left]))
      }
    }
  }
  // Chain segments into closed loops: each crossing point joins exactly two
  // segments except where an isoline touches itself, which this glyph has not.
  const byPoint = new Map()
  const pointList = [...points.values()]
  pointList.forEach((p, i) => byPoint.set(p, i))
  const incident = new Map()
  segments.forEach((seg, i) => {
    for (const p of seg) {
      const list = incident.get(byPoint.get(p)) ?? []
      list.push(i)
      incident.set(byPoint.get(p), list)
    }
  })
  const used = new Array(segments.length).fill(false)
  const loops = []
  for (let s = 0; s < segments.length; s++) {
    if (used[s]) continue
    used[s] = true
    const start = segments[s][0]
    const loop = [segments[s][0], segments[s][1]]
    let tail = segments[s][1]
    while (tail !== start) {
      const next = (incident.get(byPoint.get(tail)) ?? []).find((i) => !used[i])
      if (next === undefined) break
      used[next] = true
      const [a, b] = segments[next]
      tail = a === tail ? b : a
      if (tail === start) break
      loop.push(tail)
    }
    if (loop.length >= 4) loops.push(loop)
  }
  return loops
}

const area = (loop) => {
  let s = 0
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % loop.length]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

function inside(point, loop) {
  let hit = false
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i]
    const b = loop[j]
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}

/** Douglas–Peucker on a closed loop, anchored at its two most distant points. */
function simplify(loop, eps) {
  let far = 0
  let best = -1
  for (let i = 1; i < loop.length; i++) {
    const d = (loop[i].x - loop[0].x) ** 2 + (loop[i].y - loop[0].y) ** 2
    if (d > best) {
      best = d
      far = i
    }
  }
  const keep = new Set([0, far])
  const reduce = (from, to) => {
    if (to - from < 2) return
    const a = loop[from]
    // `to` may be `loop.length` on the closing segment, which wraps to point 0.
    const b = loop[to % loop.length]
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    let worst = -1
    let worstD = eps
    for (let i = from + 1; i < to; i++) {
      const d = Math.abs((b.x - a.x) * (a.y - loop[i].y) - (a.x - loop[i].x) * (b.y - a.y)) / len
      if (d > worstD) {
        worstD = d
        worst = i
      }
    }
    if (worst < 0) return
    keep.add(worst)
    reduce(from, worst)
    reduce(worst, to)
  }
  reduce(0, far)
  reduce(far, loop.length)
  return [...keep].sort((a, b) => a - b).map((i) => loop[i])
}

/** Rasterize the emitted loops back to a mask (even-odd scanline) so the path
 *  can be compared against the field it came from. The mask is indexed by
 *  sample, so index x *is* the point x: a pixel is on when the contour covers
 *  its own sample position, which is what makes the IoU below meaningful. */
function rasterize(loops, width, height) {
  const mask = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const xs = []
    for (const loop of loops) {
      for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const a = loop[i]
        const b = loop[j]
        if (a.y > y !== b.y > y) xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x)
      }
    }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.floor(xs[k]) + 1)
      const to = Math.min(width - 1, Math.ceil(xs[k + 1]) - 1)
      for (let x = from; x <= to; x++) mask[y * width + x] = 1
    }
  }
  return mask
}

const n = (v) => Number(v.toFixed(1)).toString()

const image = sharp(SRC).ensureAlpha()
const { data, info } = await image.raw().toBuffer({ resolveWithObject: true })
const { cov, lo, hi } = coverageField(data, info.width, info.height, info.channels)

// The artwork sits inside the 1024 canvas with a margin; the mark is the only
// ink, so its own coverage bbox is the coordinate origin.
let minX = info.width
let minY = info.height
let maxX = -1
let maxY = -1
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    if (cov[y * info.width + x] >= LEVEL) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
}
const boxW = maxX - minX + 1
const boxH = maxY - minY + 1

const raw = traceContours(cov, info.width, info.height)
console.log(`source      ${SRC} ${info.width}x${info.height}, tile lum ${lo.toFixed(1)}, mark lum ${hi.toFixed(1)}`)
console.log(`mark bbox   x[${minX},${maxX}] y[${minY},${maxY}]  ${boxW}x${boxH}  aspect ${(boxW / boxH).toFixed(3)}`)
console.log(`contours    ${raw.length} loop(s), ${raw.reduce((s, l) => s + l.length, 0)} raw points`)

// Normalize winding by nesting depth (outer clockwise, holes the other way), so
// the path is correct under either fill rule and the even-odd render below is a
// faithful stand-in for what a browser paints.
const loops = raw
  .map((loop) => ({ loop, area: area(loop) }))
  .map((entry) => {
    const depth = raw.filter((other) => other !== entry.loop && inside(entry.loop[0], other)).length
    const want = depth % 2 === 0 ? 1 : -1
    return Math.sign(entry.area) === want ? entry.loop : [...entry.loop].reverse()
  })
  .map((loop) => simplify(loop, EPSILON))
console.log(`simplified  ${loops.reduce((s, l) => s + l.length, 0)} points (ε=${EPSILON}px) after DP`)

const d = loops.map((loop) => `M${loop.map((p) => `${n(p.x - minX)} ${n(p.y - minY)}`).join('L')}Z`).join('')

// ── verification: rasterize the path and compare against the source mask ────
const sourceMask = new Uint8Array(info.width * info.height)
for (let p = 0; p < sourceMask.length; p++) sourceMask[p] = cov[p] >= LEVEL ? 1 : 0
const painted = rasterize(loops, info.width, info.height)
let both = 0
let either = 0
let missing = 0
let extra = 0
for (let p = 0; p < painted.length; p++) {
  const a = sourceMask[p]
  const b = painted[p]
  if (a && b) both++
  if (a || b) either++
  if (a && !b) missing++
  if (!a && b) extra++
}
const iou = both / either
console.log(`fidelity    IoU ${iou.toFixed(4)} vs the traced mask  (miss ${missing}px, extra ${extra}px of ${either})`)
console.log(`path        ${d.length} chars, viewBox "0 0 ${boxW} ${boxH}"`)

// Cross-check against the transparent cut-out of the same mark, when present:
// it is an independent mask (alpha, not luminance) at the same 622x446 size.
try {
  const ref = await sharp(`${process.env.HOME}/Desktop/pulsemind-extension.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const m = new Uint8Array(ref.info.width * ref.info.height)
  let rMinX = ref.info.width
  let rMinY = ref.info.height
  let rMaxX = -1
  let rMaxY = -1
  for (let y = 0; y < ref.info.height; y++) {
    for (let x = 0; x < ref.info.width; x++) {
      const on = ref.data[(y * ref.info.width + x) * ref.info.channels + 3] >= 128
      m[y * ref.info.width + x] = on ? 1 : 0
      if (on) {
        if (x < rMinX) rMinX = x
        if (x > rMaxX) rMaxX = x
        if (y < rMinY) rMinY = y
        if (y > rMaxY) rMaxY = y
      }
    }
  }
  // Compare box-to-box: crop both to their own bbox and resample one onto the
  // other's grid, so only shape agreement is measured, not placement.
  const W = 400
  const H = 286
  const sample = (mask, w, h, bx, by, bw, bh) => {
    const out = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const sx = bx + Math.round(((x + 0.5) / W) * bw)
        const sy = by + Math.round(((y + 0.5) / H) * bh)
        out[y * W + x] = mask[Math.min(h - 1, sy) * w + Math.min(w - 1, sx)]
      }
    }
    return out
  }
  const a = sample(sourceMask, info.width, info.height, minX, minY, boxW, boxH)
  const b = sample(m, ref.info.width, ref.info.height, rMinX, rMinY, rMaxX - rMinX + 1, rMaxY - rMinY + 1)
  let inter = 0
  let union = 0
  for (let p = 0; p < a.length; p++) {
    if (a[p] && b[p]) inter++
    if (a[p] || b[p]) union++
  }
  console.log(`cross-check IoU ${(inter / union).toFixed(4)} against ~/Desktop/pulsemind-extension.png (same drawing?)`)
} catch {
  console.log('cross-check skipped (no ~/Desktop/pulsemind-extension.png)')
}

const file = `/** The PulseMind brand mark, as inline SVG.
 *
 * Generated by scripts/trace-brand-mark.mjs from ${SRC} — regenerate with
 * \`node scripts/trace-brand-mark.mjs --write\` rather than editing by hand. It is
 * a path and not an <img> on purpose: the launcher lives in the *page's*
 * document, where a chrome-extension:// URL needs web_accessible_resources and a
 * data: URL is still a fetched image — both answer to the host page's \`img-src\`
 * — while SVG geometry in the DOM is not a fetch at all (the same reasoning
 * behind ui/icons.tsx). Traced at level ${LEVEL} with a ${EPSILON}px tolerance: the
 * rasterized path reproduces the source mask at IoU ${iou.toFixed(4)}.
 *
 * viewBox is the mark's own bounding box (${boxW}x${boxH}) and the component takes a
 * width, deriving the height from it — the caller sizes the glyph once and the
 * aspect ratio is never the caller's problem. */

import type { CSSProperties, ReactElement } from 'react'

export const BRAND_MARK_VIEW_BOX = '0 0 ${boxW} ${boxH}'

const MARK =
  '${d}'

export interface LogoProps {
  /** Rendered width in px; the height follows the mark's own aspect ratio, so
   *  the glyph is never stretched by the box it is dropped into. */
  width?: number
  style?: CSSProperties
}

export function Logo({ width = 24, style }: LogoProps): ReactElement {
  return (
    <svg
      viewBox={BRAND_MARK_VIEW_BOX}
      width={width}
      height={(width * ${boxH}) / ${boxW}}
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      <path d={MARK} />
    </svg>
  )
}
`

if (process.argv.includes('--write')) {
  writeFileSync(OUT, file)
  console.log(`\nwrote ${OUT}`)
} else {
  console.log('\n(pass --write to update ' + OUT + ')')
}
// Touch the import so a lint of this file is honest about what it emits.
void readFileSync
