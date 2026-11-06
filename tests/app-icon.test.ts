// Lookup + framing tests for the two surfaces that are NOT the packaged app
// icon: a BrowserWindow's icon and the tray glyph.
//
// The report these pin (2026-11-06: 「mac 上很合适，到 windows 和 UOS 上都略小」)
// has two halves. The app/launcher icons were one padded asset reused on every
// platform; the launcher half is fixed in scripts/generate-icons.mjs. The half
// covered here is the RUNTIME surfaces:
//   • Linux reused the macOS master for window icons. macOS draws its own
//     squircle plate (`pulseMind.icns`), so the master deliberately leaves ~9%
//     margin per side — with no plate, that framing reads as undersized.
//   • Linux reused the macOS tray glyph, which is knocked out to white and
//     recoloured by `setTemplateImage`. That call is a no-op off macOS, so on a
//     light panel (UOS ships one) the icon was effectively invisible.
// Each name is also asserted to EXIST, so renaming an output in the generator
// without a matching package.json extraResources entry fails here rather than
// shipping an invisible or missing icon.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { trayIconName, windowIconName } from '../src/main/app-icon'

const RESOURCES = join(process.cwd(), 'resources')

/** Share of the canvas that is opaque AND not pure white. */
async function colouredShare(file: string): Promise<number> {
  const { data, info } = await sharp(join(RESOURCES, file))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let coloured = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 8 && (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250)) coloured++
  }
  return coloured / (info.width * info.height)
}

describe('windowIconName', () => {
  it('gives Windows the app .ico and macOS the mac-grid master', () => {
    expect(windowIconName('win32')).toBe('pulseMind-win.ico')
    expect(windowIconName('darwin')).toBe('pulseMind.png')
  })

  it('gives Linux a full-bleed derivative, never the mac master', () => {
    expect(windowIconName('linux')).toBe('pulseMind-window.png')
    expect(windowIconName('linux')).not.toBe(windowIconName('darwin'))
    // Any other POSIX target lands on the same plate-less framing.
    expect(windowIconName('freebsd')).toBe(windowIconName('linux'))
  })

  it('resolves to a file that ships', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(existsSync(join(RESOURCES, windowIconName(platform))), windowIconName(platform)).toBe(true)
    }
  })
})

describe('trayIconName', () => {
  it('gives each platform its own tray asset', () => {
    expect(trayIconName('win32')).toBe('pulseMind-win-tray.ico')
    expect(trayIconName('darwin')).toBe('pulseMind_tray.png')
    expect(trayIconName('linux')).toBe('pulseMind-tray-color.png')
  })

  it('never hands a non-darwin platform the template glyph', () => {
    // setTemplateImage is darwin-only; off macOS the knocked-out white glyph is
    // invisible on a light panel — exactly what Linux used to get.
    expect(trayIconName('linux')).not.toBe(trayIconName('darwin'))
    expect(trayIconName('win32')).not.toBe(trayIconName('darwin'))
  })

  it('resolves to a file that ships', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(existsSync(join(RESOURCES, trayIconName(platform))), trayIconName(platform)).toBe(true)
    }
  })

  it('darwin stays a white template glyph, linux carries colour', async () => {
    // The contract in one assertion: template = pure white + alpha (the OS
    // recolours it), colour tile = actual pixels (nothing recolours it).
    expect(await colouredShare(trayIconName('darwin'))).toBeLessThan(0.05)
    expect(await colouredShare(trayIconName('linux'))).toBeGreaterThan(0.2)
  })
})
