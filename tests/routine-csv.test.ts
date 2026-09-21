/** CSV parser behind the routine batch mode (PLAN-routine-batch M1).
 *
 * RFC 4180 core (quotes, escaped quotes, embedded commas/newlines), delimiter
 * detection, BOM stripping and the blank-row drop the batch queue depends on
 * (a trailing newline must not enqueue a phantom conversation). */

import { describe, expect, it } from 'vitest'
import { detectDelimiter, parseCsv } from '../src/shared/routine/csv'

describe('parseCsv', () => {
  it('parses a plain table', () => {
    const t = parseCsv('repo,branch\na,b\nc,d\n')
    expect(t.headers).toEqual(['repo', 'branch'])
    expect(t.rows).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('accepts CRLF and lone-LF records', () => {
    expect(parseCsv('a,b\r\nc,d\r\n').rows).toEqual([['c', 'd']])
    expect(parseCsv('a,b\nc,d\n').rows).toEqual([['c', 'd']])
  })

  it('keeps a trailing empty field (h,a, → ["h","",""])', () => {
    expect(parseCsv('h\na,\n').rows).toEqual([['a', '']])
  })

  it('handles quoted fields with commas, newlines and escaped quotes', () => {
    const t = parseCsv('name,note\n"row, with comma","line1\nline2"\n"He said ""hi""",x\n')
    expect(t.rows).toEqual([
      ['row, with comma', 'line1\nline2'],
      ['He said "hi"', 'x'],
    ])
  })

  it('keeps CRLF verbatim inside a quoted multi-line cell', () => {
    const t = parseCsv('a\r\n"b\r\nc"\r\n')
    expect(t.rows).toEqual([['b\r\nc']])
  })

  it('is lenient with a quote appearing mid-field', () => {
    expect(parseCsv('h\na"b,c\n').rows).toEqual([['a"b', 'c']])
  })

  it('parses a quoted empty field as an empty cell, not a field break', () => {
    expect(parseCsv('h\na,"",c\n').rows).toEqual([['a', '', 'c']])
  })

  it('strips a BOM before the header row', () => {
    expect(parseCsv('\uFEFFrepo,branch\na,b\n').headers).toEqual(['repo', 'branch'])
  })

  it('drops fully-blank rows (trailing newline enqueues no phantom row)', () => {
    const t = parseCsv('h\nr1\n\n\nr2\n')
    expect(t.rows).toEqual([['r1'], ['r2']])
    expect(parseCsv('h\nr1\n').rows).toEqual([['r1']])
  })

  it('treats an empty file as header-less (callers report it)', () => {
    const t = parseCsv('')
    expect(t.headers).toEqual([])
    expect(t.rows).toEqual([])
  })

  it('trims header whitespace but leaves cell values alone', () => {
    const t = parseCsv(' repo , branch \n a , b \n')
    expect(t.headers).toEqual(['repo', 'branch'])
    expect(t.rows).toEqual([[' a ', ' b ']])
  })

  it('honors an explicit delimiter over detection', () => {
    expect(parseCsv('a;b\n1;2\n', { delimiter: ';' }).rows).toEqual([['1', '2']])
  })
})

describe('detectDelimiter', () => {
  it('picks the comma by default and on ties', () => {
    expect(detectDelimiter('a,b,c\n')).toBe(',')
    expect(detectDelimiter('a;b,c\n')).toBe(',')
  })

  it('detects semicolon and tab headers', () => {
    expect(detectDelimiter('repo;branch\n')).toBe(';')
    expect(detectDelimiter('repo\tbranch\n')).toBe('\t')
  })

  it('ignores delimiters inside quoted header cells', () => {
    // The sentence's commas live inside a quoted cell; the real separator wins.
    expect(detectDelimiter('"a,b,c,and more";x\n')).toBe(';')
  })
})
