import { describe, expect, it } from 'vitest'
import { extractSnippet } from '../src/shared/search/snippet'

describe('extractSnippet', () => {
  it('collapses whitespace so a multi-line body stays one line', () => {
    expect(extractSnippet('first line\n\n  second\tline', 'second', 20)).toBe('first line second line')
  })

  it('returns nothing for empty or blank text', () => {
    expect(extractSnippet('', 'x')).toBe('')
    expect(extractSnippet('  \n ', 'x')).toBe('')
  })

  it('windows the text around the match with ellipses on the cut sides', () => {
    expect(extractSnippet(`${'a'.repeat(20)}needle${'b'.repeat(20)}`, 'needle', 5)).toBe('…aaaaaneedlebbbbb…')
  })

  it('omits the ellipsis on a side that is not cut', () => {
    expect(extractSnippet('needle text', 'needle', 20)).toBe('needle text')
    expect(extractSnippet(`${'a'.repeat(20)}needle`, 'needle', 3)).toBe('…aaaneedle')
  })

  it('matches case-insensitively and keeps the original casing', () => {
    expect(extractSnippet('Hello World', 'hello', 20)).toBe('Hello World')
  })

  it('falls back to the head of the text when the query is absent', () => {
    expect(extractSnippet('a short body', 'missing', 20)).toBe('a short body')
    expect(extractSnippet('c'.repeat(50), 'missing', 10)).toBe(`${'c'.repeat(20)}…`)
  })

  it('keeps CJK text intact around the match', () => {
    const text = `${'前'.repeat(30)}关键词${'后'.repeat(30)}`
    const snippet = extractSnippet(text, '关键词', 5)
    expect(snippet).toBe(`…${'前'.repeat(5)}关键词${'后'.repeat(5)}…`)
  })
})
