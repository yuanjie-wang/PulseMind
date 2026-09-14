import { describe, expect, it } from 'vitest'
import { stringToHue, hsvToCss } from '../src/renderer/src/utils/hash-color'

describe('stringToHue', () => {
  it('is deterministic for the same input', () => {
    for (const name of ['PulseMind', '博客后端', 'a', '', '数据管道 pipeline']) {
      expect(stringToHue(name)).toBe(stringToHue(name))
    }
  })

  it('stays within [0, 360) for CJK, latin and empty inputs', () => {
    for (const name of ['PulseMind', '博客后端', '数据管道 pipeline', '', 'x'.repeat(200)]) {
      const hue = stringToHue(name)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    }
  })

  it('spreads distinct names across the wheel', () => {
    const names = ['PulseMind', '博客后端', '数据管道', 'notes', 'website', 'game', 'blog', 'shop']
    const hues = names.map(stringToHue)
    expect(new Set(hues).size).toBe(names.length)
  })

  it('matches the file-chip extension hash it was extracted from', () => {
    // extToHue hashes only the first 2 chars of the extension, so 'ts' and
    // 'tsx' must land on the same hue
    expect(stringToHue('tsx'.slice(0, 2))).toBe(stringToHue('ts'))
    expect(stringToHue('ts')).toBe(3711 % 360) // (116<<5)-116+115, pinned to the chip palette
  })
})

describe('hsvToCss', () => {
  it('converts the primary hues to rgb', () => {
    expect(hsvToCss(0, 1, 1)).toBe('rgb(255, 0, 0)')
    expect(hsvToCss(60, 1, 1)).toBe('rgb(255, 255, 0)')
    expect(hsvToCss(120, 1, 1)).toBe('rgb(0, 255, 0)')
    expect(hsvToCss(240, 1, 1)).toBe('rgb(0, 0, 255)')
  })

  it('handles partial saturation and value', () => {
    expect(hsvToCss(30, 1, 1)).toBe('rgb(255, 128, 0)')
    expect(hsvToCss(0, 0, 0.5)).toBe('rgb(128, 128, 128)')
  })

  it('emits rgba below alpha 1 and rgb at it', () => {
    expect(hsvToCss(0, 1, 1, 0.1)).toBe('rgba(255, 0, 0, 0.1)')
    expect(hsvToCss(120, 1, 1, 1)).toBe('rgb(0, 255, 0)')
  })
})
