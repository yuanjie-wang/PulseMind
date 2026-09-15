// ── Knowledge search survives Windows: bundled rg + drive-colon parsing ──
// Two silent-failure modes on Windows, both fixed by src/main/utils/ripgrep.ts:
//
//   1. Binary: knowledge-store / knowledge-queries called bare `execFile('rg')`.
//      A packaged app has no rg on PATH — the bundled resources/bin/win32-x64/
//      rg.exe was already shipped but only reached the agent sessions. Search
//      resolved to zero results, without an error.
//   2. Parsing: `rg --no-heading -n` emits `path:line:content`, and both call
//      sites split at the FIRST colon. A Windows path (`C:\Users\...`) carries
//      its own drive colon, so absPath came out as "C" and every line was lost
//      even with rg present.
//
// The parser is pure and runs for real here; the absence of the bare-'rg'
// signature is asserted as source, because the stores need Electron's runtime
// to execute.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseRgLine, ripgrepBinary } from '../src/main/utils/ripgrep'

describe('parseRgLine', () => {
  it('splits a Unix path:line:content line', () => {
    const parsed = parseRgLine('/home/user/.pulsemind/knowledge/raw/a.md:12:hello world')
    expect(parsed).toEqual({
      absPath: '/home/user/.pulsemind/knowledge/raw/a.md',
      lineNum: 12,
      content: 'hello world',
    })
  })

  it('does not mistake the Windows drive colon for the separator', () => {
    const parsed = parseRgLine('C:\\Users\\user\\.pulsemind\\knowledge\\raw\\a.md:3:第一段')
    expect(parsed?.absPath).toBe('C:\\Users\\user\\.pulsemind\\knowledge\\raw\\a.md')
    expect(parsed?.lineNum).toBe(3)
    expect(parsed?.content).toBe('第一段')
  })

  it('keeps colons inside the content after the separator', () => {
    const parsed = parseRgLine('C:\\k\\b.md:7:时间 12:30 表示时间')
    expect(parsed?.absPath).toBe('C:\\k\\b.md')
    expect(parsed?.content).toBe('时间 12:30 表示时间')
  })

  it('survives digit runs inside the Windows path', () => {
    const parsed = parseRgLine('C:\\2024\\报告 v2.md:45:结论')
    expect(parsed?.absPath).toBe('C:\\2024\\报告 v2.md')
    expect(parsed?.lineNum).toBe(45)
  })

  it('trims content and rejects a non-numeric line number', () => {
    expect(parseRgLine('/tmp/a.md:9:  padded  ')?.content).toBe('padded')
    expect(parseRgLine('/tmp/a.md:x:no digits')).toBeNull()
  })

  it('rejects lines without a path:line: prefix', () => {
    expect(parseRgLine('--')).toBeNull()
    expect(parseRgLine('')).toBeNull()
    expect(parseRgLine('no separators at all')).toBeNull()
  })
})

describe('ripgrepBinary', () => {
  it('always yields a non-empty executable name or path', () => {
    const bin = ripgrepBinary()
    expect(typeof bin).toBe('string')
    expect(bin.length).toBeGreaterThan(0)
  })
})

describe('search call sites use the shared resolver', () => {
  const read = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8')

  it('knowledge-store spawns rg via ripgrepBinary and parses via parseRgLine', () => {
    const src = read('src/main/storage/knowledge-store.ts')
    expect(src).toContain("import { ripgrepBinary, parseRgLine } from '../utils/ripgrep'")
    expect(src).not.toContain("execFile('rg'")
    expect(src).toContain('execFile(ripgrepBinary()')
    expect(src).not.toContain("line.indexOf(':')")
  })

  it('knowledge-queries spawns rg via ripgrepBinary, parses via parseRgLine, and gates grep to Unix', () => {
    const src = read('src/main/services/knowledge-queries.ts')
    expect(src).toContain("import { ripgrepBinary, parseRgLine } from '../utils/ripgrep'")
    expect(src).not.toContain("execFile('rg'")
    expect(src).toContain('execFile(ripgrepBinary()')
    expect(src).toContain("process.platform !== 'win32') await tryGrep()")
  })
})
