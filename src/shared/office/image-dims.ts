// ── Image dimension probe (PLAN-office-expressiveness M1) ──
// Zero-dependency: reads the pixel size straight from the header bytes, so
// both the docx generation path (ImageRun transformation, px) and the docx
// edit path (wp:extent, EMU) share one resolver. Unknown formats return null —
// callers decide whether to refuse or degrade, this never guesses.

/** 1px @96dpi = 9525 EMU (docx edit path converts display px → EMU with this). */
export const EMU_PER_PX = 9525

export interface ImageDims {
  width: number
  height: number
}

export function imageDims(buf: Buffer): ImageDims | null {
  if (!buf || buf.length < 8) return null
  // PNG: signature + IHDR (width/height at bytes 16–24, big-endian)
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    if (buf.length < 24) return null
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    return valid(width, height)
  }
  // GIF: logical screen descriptor (bytes 6–10, little-endian)
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) { // "GIF"
    if (buf.length < 10) return null
    return valid(buf.readUInt16LE(6), buf.readUInt8(8) | (buf.readUInt8(9) << 8))
  }
  // JPEG: scan SOF0/SOF1/SOF2 (skip DHT C4, JPG C8, DAC CC) segments
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue }
      const marker = buf[off + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue } // standalone
      const len = buf.readUInt16BE(off + 2)
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (off + 9 > buf.length) return null
        const height = buf.readUInt16BE(off + 5)
        const width = buf.readUInt16BE(off + 7)
        return valid(width, height)
      }
      off += 2 + len
    }
    return null
  }
  return null
}

function valid(width: number, height: number): ImageDims | null {
  return width > 0 && height > 0 ? { width, height } : null
}

/** Display size (M1/§2.2): intrinsic width capped at 600px, height scaled
 *  proportionally; an explicit width or height wins (the other side follows
 *  the intrinsic ratio). */
export function displaySize(
  intrinsic: ImageDims,
  opts?: { widthPx?: number; heightPx?: number },
): ImageDims {
  const MAX_WIDTH = 600
  const ratio = intrinsic.height / intrinsic.width
  if (opts?.widthPx && opts.widthPx > 0) return { width: Math.round(opts.widthPx), height: Math.round(opts.widthPx * ratio) }
  if (opts?.heightPx && opts.heightPx > 0) return { width: Math.round(opts.heightPx / ratio), height: Math.round(opts.heightPx) }
  if (intrinsic.width <= MAX_WIDTH) return { ...intrinsic }
  return { width: MAX_WIDTH, height: Math.round(MAX_WIDTH * ratio) }
}
