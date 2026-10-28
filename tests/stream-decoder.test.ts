/** The terminal service's pipe decoder (stream-decoder.ts): two failure modes
 *  of a plain `chunk.toString('utf-8')` on a Windows child pipe — arbitrary
 *  chunk cuts splitting a multi-byte character, and legacy tools emitting GBK
 *  even after WIN_PS_UTF8_PREFIX forced PowerShell itself to UTF-8.
 *
 *  Non-vacuity is measured inside the decoder tests: every round-trip also
 *  runs the naive per-chunk `toString('utf-8')` over the SAME chunks and
 *  requires it to produce U+FFFD / garbage — so the naive implementation fails
 *  these cases rather than the assertions being satisfiable either way. The
 *  wiring scan at the bottom pins terminal.ts to the decoder (4 sites) and to
 *  the Windows Python UTF-8 env, and forbids raw chunk `.toString('utf-8')`. */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStreamDecoder } from '../src/main/services/stream-decoder'

// GBK bytes for 你好世界 — precondition-checked below so a wrong constant
// fails with a clear message instead of a decode mismatch.
const GBK_NI_HAO = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]) // 你好
const GBK_SHI_JIE = Buffer.from([0xca, 0xc0, 0xbd, 0xe7]) // 世界
const GBK_TEXT = Buffer.concat([GBK_NI_HAO, GBK_SHI_JIE])
const UTF8_TEXT = '你好，world！中文输出测试'

/** Feed `bytes` through a fresh decoder in slices of `size`, then flush. */
function feed(bytes: Buffer, size: number): { text: string; naive: string } {
  const dec = createStreamDecoder()
  const parts: string[] = []
  const naiveParts: string[] = []
  for (let i = 0; i < bytes.length; i += size) {
    const chunk = bytes.subarray(i, i + size)
    naiveParts.push(chunk.toString('utf-8'))
    const text = dec.push(chunk)
    if (text) parts.push(text)
  }
  const tail = dec.flush()
  if (tail) parts.push(tail)
  return { text: parts.join(''), naive: naiveParts.join('') }
}

describe('createStreamDecoder', () => {
  it('precondition: the GBK constants really decode to 你好世界', () => {
    expect(new TextDecoder('gbk').decode(GBK_TEXT)).toBe('你好世界')
  })

  it('round-trips UTF-8 split at every chunk size (naive decode does not)', () => {
    const bytes = Buffer.from(UTF8_TEXT, 'utf-8')
    for (let size = 1; size <= 8; size++) {
      const { text, naive } = feed(bytes, size)
      expect(text, `chunk size ${size}`).toBe(UTF8_TEXT)
      if (size <= 3) {
        // The naive comparator must fail these — a 3-byte char cut across
        // events is exactly the bug this decoder exists for.
        expect(naive, `naive at size ${size}`).not.toBe(UTF8_TEXT)
        expect(naive).toContain('�')
      }
    }
  })

  it('round-trips GBK split at every chunk size (naive UTF-8 does not)', () => {
    for (let size = 1; size <= 8; size++) {
      const { text, naive } = feed(GBK_TEXT, size)
      expect(text, `chunk size ${size}`).toBe('你好世界')
      // GBK pair bytes are never valid UTF-8, so naive fails at every size.
      expect(naive, `naive at size ${size}`).not.toBe('你好世界')
      expect(naive).toContain('�')
    }
  })

  it('decodes a whole GBK buffer in one push (the fallback commits)', () => {
    const dec = createStreamDecoder()
    expect(dec.push(GBK_TEXT)).toBe('你好世界')
    expect(dec.flush()).toBe('')
  })

  it('leaves pure ASCII byte-identical at any split', () => {
    const bytes = Buffer.from('$ npm test\nok 1 things\n', 'utf-8')
    for (let size = 1; size <= 7; size++) {
      expect(feed(bytes, size).text).toBe('$ npm test\nok 1 things\n')
    }
  })

  it('decides UTF-8 for a prefix and can still fall back to GBK afterwards', () => {
    const dec = createStreamDecoder()
    let out = dec.push(Buffer.from('cwd: ', 'utf-8'))
    // 你好 in GBK, one byte at a time — pair split across pushes.
    for (const b of GBK_NI_HAO) out += dec.push(Buffer.from([b]))
    out += dec.flush()
    expect(out).toBe('cwd: 你好')
  })

  it('holds an incomplete UTF-8 tail until the next push completes it', () => {
    const bytes = Buffer.from(UTF8_TEXT, 'utf-8')
    const dec = createStreamDecoder()
    // First 2 of the 3 bytes of 你 — nothing emittable yet.
    expect(dec.push(bytes.subarray(0, 2))).toBe('')
    // The completing byte arrives in the next chunk: whole text comes out.
    expect(dec.push(bytes.subarray(2))).toBe(UTF8_TEXT)
    expect(dec.flush()).toBe('')
  })

  it('strips a UTF-8 BOM even when split across pushes', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi', 'utf-8')])
    expect(feed(withBom, 1).text).toBe('hi')
    expect(feed(withBom, 99).text).toBe('hi')

    // TextDecoder drops a buffer-leading BOM on every decode() call, so a BOM
    // landing at the start of a later chunk is dropped too — generator noise,
    // never content anyone means to show.
    const dec = createStreamDecoder()
    let out = dec.push(Buffer.from('ab!', 'utf-8'))
    out += dec.push(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x', 'utf-8')]))
    out += dec.flush()
    expect(out).toBe('ab!x')
  })

  it('flush is idempotent and emits the held residue once', () => {
    const dec = createStreamDecoder()
    expect(dec.flush()).toBe('')
    expect(dec.push(Buffer.from([0xc4]))).toBe('') // lone GBK lead — held
    // End of stream, undecided: strict UTF-8 fails, the GBK fallback maps the
    // lone lead to U+FFFD rather than throwing or duplicating it later.
    expect(dec.flush()).toBe('�')
    expect(dec.flush()).toBe('')
  })
})

describe('terminal.ts wiring', () => {
  const REPO = process.cwd()
  const TERMINAL = join(REPO, 'src', 'main', 'services', 'terminal.ts')
  const src = readFileSync(TERMINAL, 'utf-8')

  it('decodes every pipe stream through createStreamDecoder (9 sites)', () => {
    expect(src).toContain("from './stream-decoder'")
    // svcExecuteCommand, svcExecSync and svcExecuteBackground each decode
    // stdout+stderr (PLAN-coding-contract P0-3 added the background pair); the
    // persistent shell (review P0-1) adds stdout+stderr+the fd-3 control pipe.
    expect((src.match(/createStreamDecoder\(\)/g) ?? []).length).toBe(9)
    // No raw per-chunk decode left anywhere in the service.
    expect(src).not.toMatch(/\.toString\(['"]utf-?8['"]\)/)
  })

  it('spawns every shell path with the Windows Python UTF-8 env', () => {
    expect(src).toContain('PYTHONUTF8')
    // One definition + three spawn spreads (svcExecuteCommand, svcExecSync,
    // svcExecuteBackground).
    expect((src.match(/WIN_UTF8_ENV/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect((src.match(/\.\.\.\(isWin \? WIN_UTF8_ENV : \{\}\)/g) ?? []).length).toBe(3)
  })
})
