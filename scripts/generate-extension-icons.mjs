/**
 * Generate the extension's manifest icons (offline asset generation).
 *
 * Source is `resources/pulseMind.png`, the app's 1024px icon — a #222 tile
 * carrying the brand mark. Chrome asks for 16/32/48/128: the toolbar at 1x/2x,
 * the management page, and the install dialog / Web Store. The outputs are
 * committed, so `npm run build:extension` only has to copy them; regenerate with
 * `node scripts/generate-extension-icons.mjs` when the brand icon changes.
 *
 * Two conversions matter, and both are why this is not just a resize:
 *  - the 1024 canvas keeps ~9% transparent margin on every side, which is the
 *    macOS convention (the OS adds its own padding) and costs a fifth of the
 *    icon's area in a browser. The artwork is trimmed to its own extent first.
 *  - a hairline inset is added back after trimming, so the tile's rounded
 *    corners are not shaved by the anti-aliased frame edge and the icon does not
 *    visually collide with its neighbours in the toolbar.
 *
 * Usage: node scripts/generate-extension-icons.mjs
 */
import { mkdirSync, statSync } from 'node:fs'
import sharp from 'sharp'

const SRC = 'resources/pulseMind.png'
const OUT_DIR = 'src/extension/icons'
/** Fraction of the trimmed tile left as padding, split evenly per side. 4% of
 *  840px is 17px, which at the 16px target is the sub-pixel that keeps the
 *  corners clean. */
const INSET = 0.04
const SIZES = [16, 32, 48, 128]

mkdirSync(OUT_DIR, { recursive: true })

const trimmed = await sharp(SRC).ensureAlpha().trim({ threshold: 1 }).png().toBuffer()
const meta = await sharp(trimmed).metadata()
console.log(`source   ${SRC} -> trimmed to ${meta.width}x${meta.height}`)

const pad = Math.round((meta.width * INSET) / 2)
const padded = await sharp(trimmed)
  .extend({
    top: pad,
    bottom: pad,
    left: pad,
    right: pad,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer()

for (const size of SIZES) {
  const file = `${OUT_DIR}/icon-${size}.png`
  const info = await sharp(padded)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(file)
  console.log(`wrote    ${file}  ${info.width}x${info.height}  ${statSync(file).size}B`)
}
