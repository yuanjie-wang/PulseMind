// ── The extension's manifest icons ────────────────────────────────────────────
// `src/extension/manifest.json` points Chrome at four PNGs under
// `src/extension/icons/`. Nothing else in the app would notice if that broke:
// a manifest entry naming a file that is not there, or a file that is not the
// size it claims, does not throw anywhere — chrome://extensions just draws a
// blank tile, and the failure is only visible by loading the extension by hand.
// The assets themselves are generated (scripts/generate-extension-icons.mjs) and
// committed, so the two halves that can drift are the manifest's list and the
// files on disk; this pins them together.
//
// The build half is checked statically, in the spirit of
// tests/agent-protocol-methods.test.ts: `out/extension/icons/` existing is the
// only thing that makes the manifest's URLs resolve, and running the real
// esbuild build inside vitest would be both slow and side-effecting.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const MANIFEST = join(REPO, 'src', 'extension', 'manifest.json')
const BUILD = join(REPO, 'scripts', 'build-extension.js')

/** Chrome's own sizes for `icons`: toolbar 1x/2x, management page, install
 *  dialog + Web Store. */
const REQUIRED_SIZES = [16, 32, 48, 128]

/** Width/height straight out of the PNG's IHDR — no image library, and it
 *  reads what a renderer reads rather than trusting the filename. */
function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file)
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

describe('extension manifest icons', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8')) as { icons?: Record<string, string> }

  it('declares an icon for every size Chrome asks for', () => {
    expect(manifest.icons).toBeTruthy()
    for (const size of REQUIRED_SIZES) {
      expect(manifest.icons?.[String(size)], `icons["${size}"]`).toBeTruthy()
    }
  })

  it('every declared icon exists and is the size it is declared as', () => {
    for (const size of REQUIRED_SIZES) {
      const rel = manifest.icons?.[String(size)]
      if (!rel) continue
      const file = join(REPO, 'src', 'extension', rel)
      expect(existsSync(file), `${rel} exists`).toBe(true)
      expect(pngSize(file), `${rel} is ${size}px`).toEqual({ width: size, height: size })
    }
  })

  it('paths are relative to the extension root, not to the source tree', () => {
    // `src/extension/manifest.json` is copied verbatim to `out/extension/`, so a
    // path that only resolves from the source tree (e.g. one starting with
    // `src/`) would be broken in the loaded extension.
    for (const rel of Object.values(manifest.icons ?? {})) {
      expect(rel.startsWith('/'), rel).toBe(false)
      expect(rel.startsWith('src/'), rel).toBe(false)
    }
  })

  it('the build copies the icons directory into the bundle', () => {
    const src = readFileSync(BUILD, 'utf-8')
    const copies = [...src.matchAll(/cpSync\(\s*'([^']+)'/g)].map((m) => m[1])
    // Non-vacuous: the manifest itself is copied by the same mechanism, so a
    // regex that stopped matching would be caught here rather than passing.
    expect(copies).toContain('src/extension/manifest.json')
    expect(copies).toContain('src/extension/icons')
  })
})
