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
import { parseRgLine, ripgrepBinary, buildRgSearchArgs } from '../src/main/utils/ripgrep'

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

// ── review_20261013 高2: the content channel (knowledge-store) pushed the
// query as a BARE positional argument — same hole M10-P0-1 closed on the wiki
// sibling (`--pre=/bin/sh` made rg run a program per searched file, measured).
// The fix is one shared builder; these are its real argv contracts, executed.
describe('buildRgSearchArgs — the query is a value on BOTH channels', () => {
  const DIR = '/k/raw'

  it('a --pre= query lands as the -e VALUE, never as a flag', () => {
    const args = buildRgSearchArgs('--pre=/bin/sh', DIR)
    expect(args[args.indexOf('--pre=/bin/sh') - 1]).toBe('-e')
    // `--` ends option parsing right before the search dir:
    const dashDash = args.indexOf('--')
    expect(dashDash).toBeGreaterThan(-1)
    expect(args[dashDash + 1]).toBe(DIR)
    expect(args[args.length - 1]).toBe(DIR)
    // No bare positional copy of the query anywhere outside the -e pair:
    expect(args.filter((a) => a === '--pre=/bin/sh')).toHaveLength(1)
  })

  it('a single term keeps the wiki channel shape (-F -e term)', () => {
    expect(buildRgSearchArgs('react', DIR)).toEqual(['-n', '--no-heading', '-i', '--max-columns', '300', '--max-count', '5', '-F', '-e', 'react', '--', DIR])
  })

  it('multi-term queries OR their terms fixed-string, then -- dir', () => {
    const args = buildRgSearchArgs('  react   hooks ', DIR)
    expect(args.slice(7)).toEqual(['-F', '-e', 'react', '-e', 'hooks', '--', DIR])
  })

  it('an empty/whitespace query still terminates options before the dir', () => {
    const args = buildRgSearchArgs('   ', DIR)
    expect(args[args.length - 2]).toBe('--')
    expect(args[args.length - 1]).toBe(DIR)
  })
})

describe('search call sites use the shared resolver', () => {
  const read = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8')

  it('knowledge-store spawns rg via ripgrepBinary and parses via parseRgLine', () => {
    const src = read('src/main/storage/knowledge-store.ts')
    expect(src).toContain("import { ripgrepBinary, parseRgLine, buildRgSearchArgs } from '../utils/ripgrep'")
    expect(src).not.toContain("execFile('rg'")
    expect(src).toContain('execFile(ripgrepBinary()')
    expect(src).not.toContain("line.indexOf(':')")
  })

  it('knowledge-queries spawns rg via ripgrepBinary, parses via parseRgLine, and gates grep to Unix', () => {
    const src = read('src/main/services/knowledge-queries.ts')
    expect(src).toContain("import { ripgrepBinary, parseRgLine, buildRgSearchArgs } from '../utils/ripgrep'")
    expect(src).not.toContain("execFile('rg'")
    expect(src).toContain('execFile(ripgrepBinary()')
    expect(src).toContain("process.platform !== 'win32')")
  })

  it('the content channel delegates to the shared builder too (M10-P0-1 fixed the wiki and missed this sibling — review_20261013 高2)', () => {
    const src = read('src/main/storage/knowledge-store.ts')
    expect(src).toContain("import { ripgrepBinary, parseRgLine, buildRgSearchArgs } from '../utils/ripgrep'")
    expect(src).toContain('buildRgSearchArgs(query, rawDir)')
    // The bare positional push — the injection itself — is gone from the file:
    expect(src).not.toMatch(/args\.push\(query\)/)
    expect(src).not.toContain("args.push('-F', '-e', query)")
  })
})
