// pmPath format & parsing (PLAN-html-element-edit D4) — the contract shared
// by the in-frame picker and the parent-side resolver.

import { describe, expect, it } from 'vitest'
import { formatPmPath, parsePmPath, parentPmPath, type PmPathSegment } from '../src/shared/html-edit/pm-path'

describe('formatPmPath', () => {
  it('renders the root without an index', () => {
    expect(formatPmPath([{ tag: 'html', index: 1 }])).toBe('html')
  })

  it('renders nth-child for every non-root segment', () => {
    const segments: PmPathSegment[] = [
      { tag: 'html', index: 1 },
      { tag: 'body', index: 1 },
      { tag: 'div', index: 2 },
      { tag: 'h1', index: 1 },
    ]
    expect(formatPmPath(segments)).toBe('html>body:nth-child(1)>div:nth-child(2)>h1:nth-child(1)')
  })
})

describe('parsePmPath', () => {
  it('round-trips formatted paths', () => {
    const path = 'html>body:nth-child(1)>div:nth-child(2)>h1:nth-child(1)'
    const parsed = parsePmPath(path)
    expect(parsed).toEqual([
      { tag: 'html', index: 1 },
      { tag: 'body', index: 1 },
      { tag: 'div', index: 2 },
      { tag: 'h1', index: 1 },
    ])
    expect(formatPmPath(parsed!)).toBe(path)
  })

  it("accepts the plan doc's illustrative shape (bare index-1 segments)", () => {
    expect(parsePmPath('html>body>div:nth-child(2)>h1:nth-child(1)')).toEqual([
      { tag: 'html', index: 1 },
      { tag: 'body', index: 1 },
      { tag: 'div', index: 2 },
      { tag: 'h1', index: 1 },
    ])
  })

  it('lowercases tags and defaults a missing index to 1', () => {
    expect(parsePmPath('html>body>section')).toEqual([
      { tag: 'html', index: 1 },
      { tag: 'body', index: 1 },
      { tag: 'section', index: 1 },
    ])
  })

  it('refuses malformed input', () => {
    for (const bad of ['', '  ', 'html>', 'html>>body', 'body:nth-child(0)', '1body', 'html>body:nth-child(x)', 'html body', '<script>']) {
      expect(parsePmPath(bad)).toBeNull()
    }
  })
})

describe('parentPmPath', () => {
  it('drops the last segment', () => {
    expect(parentPmPath('html>body:nth-child(1)>div:nth-child(2)>h1:nth-child(1)')).toBe('html>body:nth-child(1)>div:nth-child(2)')
  })

  it('returns null for the root and malformed input', () => {
    expect(parentPmPath('html')).toBeNull()
    expect(parentPmPath('garbage>')).toBeNull()
  })
})
