/**
 * Generate the Windows / Linux icon sets from the 1024px master (offline asset
 * generation). macOS is deliberately NOT touched — see below.
 *
 * `resources/pulseMind.png` keeps ~9% transparent margin on every side. That is
 * the macOS convention (Apple's grid: artwork occupies 80.5% of the canvas,
 * because the OS draws the squircle plate around it), and `pulseMind.icns`
 * reproduces it correctly. Windows and Linux have no such plate: a desktop icon
 * is expected to fill its canvas, so reusing the mac framing makes the icon look
 * undersized there — on UOS the .deb shipped only a single padded 1024px asset
 * and the launcher had to downscale it, which compounded the effect.
 *
 * So: trim to the artwork's own extent, add back INSET (1% per side), and emit
 * per-platform sets. 98% reads as full-bleed while keeping the anti-aliased edge
 * off the canvas boundary.
 *
 * Windows frames <= 64px are written as 32bpp DIB (widest compatibility, and
 * what the previous .ico used); 128/256 as PNG (Windows Vista+ reads those, and
 * a DIB at 256 costs 262KB per frame). 24/64/128 are added because the previous
 * file had only 16/32/48/256 — at those DPI steps Windows had to scale a
 * neighbour, which softened the mark.
 *
 * Usage: node scripts/generate-icons.mjs
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'

const SRC = 'resources/pulseMind.png'
const LINUX_DIR = 'resources/icons-linux'
const ICO_OUT = 'resources/pulseMind-win.ico'
const WINDOW_OUT = 'resources/pulseMind-window.png'
const TRAY_ICO_OUT = 'resources/pulseMind-win-tray.ico'
const TRAY_PNG_OUT = 'resources/pulseMind-tray-color.png'

/** Total padding, split evenly per side. 2% of 840px is 8px per side, which at
 *  the 16px target is the sub-pixel that keeps the rounded corners clean. */
const INSET = 0.02
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const DIB_MAX = 64

/**
 * Tray glyphs are viewed at 16-24px, which is why they do NOT share the app
 * icon's framing. At that size the full-bleed tile loses its rounded corners to
 * anti-aliasing (it reads as a hard square), and an icon that touches the canvas
 * edge sits visibly larger than its neighbours in the notification area, which
 * keep a margin. 88% leaves ~1px of clearance per side at 16px.
 */
const TRAY_INSET = 0.12
/** 20/40 are the 125%/250% DPI steps Windows asks the notification area for; the
 *  app .ico carries 16/24/32/48/64/128/256 only. */
const TRAY_ICO_SIZES = [16, 20, 24, 32, 40, 48, 64]

/** Linux window (title bar / taskbar) icon: no OS-drawn plate, so it takes the
 *  full-bleed framing like the launcher icon. One oversized PNG — the window
 *  manager scales it down to 16-32px. */
const WINDOW_SIZE = 256

/** Share of the canvas the artwork should occupy, and the bbox actually measured. */
function coverage(rgba, size) {
  let minX = size, minY = size, maxX = -1, maxY = -1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (rgba[(y * size + x) * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return 'empty'
  return `${(((maxX - minX + 1) / size) * 100).toFixed(1)}%`
}

function dibFrame(rgba, w, h) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(w, 4)
  header.writeInt32LE(h * 2, 8) // XOR bitmap + AND mask
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(w * h * 4, 20)

  const xor = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    const src = y * w * 4
    const dst = (h - 1 - y) * w * 4 // bottom-up
    for (let x = 0; x < w; x++) {
      const s = src + x * 4
      const d = dst + x * 4
      xor[d] = rgba[s + 2]
      xor[d + 1] = rgba[s + 1]
      xor[d + 2] = rgba[s]
      xor[d + 3] = rgba[s + 3]
    }
  }

  // AND mask: 1 = transparent. Only fully-clear pixels, so the 8-bit alpha in
  // the XOR bitmap stays authoritative for partial edges.
  const stride = Math.ceil(w / 32) * 4
  const and = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    const dst = (h - 1 - y) * stride
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] === 0) and[dst + (x >> 3)] |= 1 << (7 - (x & 7))
    }
  }
  return Buffer.concat([header, xor, and])
}

const trimmed = await sharp(SRC).ensureAlpha().trim({ threshold: 1 }).png().toBuffer()
const meta = await sharp(trimmed).metadata()

/** Re-add `inset` (total, split per side) of transparent margin around the
 *  trimmed artwork, logging the coverage that should produce. */
async function padWith(inset) {
  const pad = Math.round((meta.width * inset) / 2)
  const buf = await sharp(trimmed)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  const expected = (((meta.width / (meta.width + pad * 2)) * 100)).toFixed(1)
  console.log(`source   ${SRC} -> trimmed ${meta.width}x${meta.height}, inset ${(inset * 100).toFixed(0)}% (pad ${pad}px/side), expected ${expected}%`)
  return buf
}

const padded = await padWith(INSET)

async function render(size, source = padded) {
  const { data } = await sharp(source)
    .resize(size, size, { fit: 'contain', kernel: 'lanczos3', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return data
}

// ---- Linux / UOS: one file per hicolor size, consumed as an icon-set directory
mkdirSync(LINUX_DIR, { recursive: true })
for (const size of LINUX_SIZES) {
  const file = `${LINUX_DIR}/${size}x${size}.png`
  await sharp(padded)
    .resize(size, size, { fit: 'contain', kernel: 'lanczos3', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(file)
  console.log(`linux    ${file.padEnd(34)} ${String(statSync(file).size).padStart(6)}B  content ${coverage(await render(size), size)}`)
}

// ---- Windows: single .ico carrying every frame
/** Write an .ico holding one frame per requested size (<=64 DIB, >64 PNG). */
async function writeIco(outPath, sizes, source, label) {
  const frames = []
  for (const size of sizes) {
    const rgba = await render(size, source)
    const blob = size <= DIB_MAX
      ? dibFrame(rgba, size, size)
      : await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer()
    frames.push({ size, blob, kind: size <= DIB_MAX ? 'DIB' : 'PNG' })
    console.log(`${label.padEnd(8)} ${size}x${size} ${frames.at(-1).kind.padEnd(4)} ${String(blob.length).padStart(7)}B  content ${coverage(rgba, size)}`)
  }

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  const dir = Buffer.alloc(16 * frames.length)
  let offset = 6 + dir.length
  frames.forEach((f, i) => {
    const e = i * 16
    dir[e] = f.size >= 256 ? 0 : f.size
    dir[e + 1] = f.size >= 256 ? 0 : f.size
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(f.blob.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += f.blob.length
  })
  writeFileSync(outPath, Buffer.concat([header, dir, ...frames.map(f => f.blob)]))
  console.log(`${label.padEnd(8)} ${outPath}  ${frames.length} frames  ${statSync(outPath).size}B`)
}

await writeIco(ICO_OUT, ICO_SIZES, padded, 'win')

// ---- Linux window / title bar: full-bleed like the launcher icon, one PNG
await sharp(padded)
  .resize(WINDOW_SIZE, WINDOW_SIZE, { fit: 'contain', kernel: 'lanczos3', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9 })
  .toFile(WINDOW_OUT)
console.log(`window   ${WINDOW_OUT.padEnd(35)} ${String(statSync(WINDOW_OUT).size).padStart(6)}B  content ${coverage(await render(WINDOW_SIZE), WINDOW_SIZE)}`)

// ---- Tray: margin-preserving variants, kept off the app icon on purpose
const trayPadded = await padWith(TRAY_INSET)

await writeIco(TRAY_ICO_OUT, TRAY_ICO_SIZES, trayPadded, 'tray-ico')

await sharp(trayPadded)
  .resize(32, 32, { fit: 'contain', kernel: 'lanczos3', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9 })
  .toFile(TRAY_PNG_OUT)
console.log(`tray-png ${TRAY_PNG_OUT.padEnd(35)} ${String(statSync(TRAY_PNG_OUT).size).padStart(6)}B  content ${coverage(await render(32, trayPadded), 32)}`)
