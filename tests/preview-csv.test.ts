import { describe, it, expect } from 'vitest'
import { parseCsv, CSV_PREVIEW_ROW_LIMIT } from '../src/shared/preview/csv'

describe('parseCsv', () => {
  it('parses plain rows and strips the trailing newline', () => {
    const { rows, truncated } = parseCsv('a,b,c\n1,2,3\n')
    expect(rows).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
    expect(truncated).toBe(false)
  })

  it('handles CRLF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n').rows).toEqual([['a', 'b'], ['1', '2']])
  })

  it('handles quoted fields with commas, escaped quotes and newlines', () => {
    const { rows } = parseCsv('"a,1","he said ""hi""","line1\nline2"\nplain,2')
    expect(rows).toEqual([
      ['a,1', 'he said "hi"', 'line1\nline2'],
      ['plain', '2'],
    ])
  })

  it('supports custom delimiter (tsv)', () => {
    expect(parseCsv('a\tb\n1\t2', { delimiter: '\t' }).rows).toEqual([['a', 'b'], ['1', '2']])
  })

  it('keeps blank inner lines as empty rows but drops a single trailing newline', () => {
    expect(parseCsv('a\n\nb').rows).toEqual([['a'], [''], ['b']])
    expect(parseCsv('a\n').rows).toEqual([['a']])
    expect(parseCsv('').rows).toEqual([])
  })

  it('stops at the row cap and reports truncation', () => {
    const text = Array.from({ length: CSV_PREVIEW_ROW_LIMIT + 50 }, (_, i) => `r${i}`).join('\n')
    const { rows, truncated } = parseCsv(text)
    expect(rows).toHaveLength(CSV_PREVIEW_ROW_LIMIT)
    expect(rows[0]).toEqual(['r0'])
    expect(truncated).toBe(true)
  })

  it('exact-fit input is not truncated', () => {
    const text = Array.from({ length: CSV_PREVIEW_ROW_LIMIT }, (_, i) => `r${i}`).join('\n')
    const { rows, truncated } = parseCsv(text)
    expect(rows).toHaveLength(CSV_PREVIEW_ROW_LIMIT)
    expect(truncated).toBe(false)
  })
})
