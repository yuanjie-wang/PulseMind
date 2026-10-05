import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { shEscape, shSingleQuote } from '../src/renderer/src/agent/agent-utils'
import { buildCommandFromSkillInput } from '../src/renderer/src/agent/command-builder'

// review_20261005 P1-02/P1-03: shEscape targets "…" contexts and does not
// escape ', yet command-builder interpolated its output inside '…' — one raw '
// closed the quoting and everything after it ran as shell grammar ("user
// approved A, executed B"; the attacker is model output, so approval does not
// help). These tests pin the fix three ways: the quote function itself, the
// built tool commands (a POSIX lexer asserts the payload only ever appears
// INSIDE single quotes), and — where a shell exists — a real /bin/sh
// round-trip, including the negative control showing the old construction
// really did split into two commands.

const PAYLOAD = "a'; touch /tmp/pwned; 'b"
const NEEDLE = 'touch /tmp/pwned'

/** Real POSIX single-quote lexing: inside '…' nothing is special; outside,
 *  `\x` is an escape pair (that is exactly the `'\''` idiom's third char).
 *  Reports every place `needle` occurs and whether all of them were quoted. */
function needleQuoting(cmd: string, needle: string): { occurred: boolean; allInside: boolean } {
  let single = false
  let occurred = false
  let allInside = true
  for (let i = 0; i < cmd.length; i++) {
    if (cmd.startsWith(needle, i)) {
      occurred = true
      if (!single) allInside = false
      i += needle.length - 1
      continue
    }
    const c = cmd[i]
    if (single) {
      if (c === "'") single = false
      continue
    }
    if (c === "'") { single = true; continue }
    if (c === '\\') i++
  }
  return { occurred, allInside }
}

/** Non-vacuity: the lexer flags the PRE-FIX construction — shEscape inside a
 *  manual '…' wrap — as broken, so the assertions below cannot pass vacuously. */
function oldStyle(s: string): string {
  return `'${shEscape(s)}'`
}

describe('shSingleQuote', () => {
  it('quotes plain values identically to the old wrap', () => {
    expect(shSingleQuote('foo')).toBe("'foo'")
    expect(shSingleQuote('*.ts')).toBe("'*.ts'")
  })

  it('closes every raw quote via the apostrophe-escape idiom', () => {
    expect(shSingleQuote("it's")).toBe(`'it'\\''s'`)
    expect(shSingleQuote(PAYLOAD)).toBe(`'a'\\''; touch /tmp/pwned; '\\''b'`)
    // shEscape leaves ' untouched — the exact hole the old code rode through.
    expect(shEscape("it's")).toBe("it's")
  })

  it.runIf(process.platform !== 'win32')('round-trips through a real /bin/sh', () => {
    const out = execFileSync('/bin/sh', ['-c', `printf %s ${shSingleQuote(PAYLOAD)}`], { encoding: 'utf-8' })
    expect(out).toBe(PAYLOAD)
  })

  it.runIf(process.platform !== 'win32')('negative control: the old wrap really splits commands', () => {
    const r = spawnSync('/bin/sh', ['-c', oldStyle("a'; echo INJECTED; 'b")], { encoding: 'utf-8' })
    expect(r.stdout).toContain('INJECTED')
  })
})

describe('buildCommandFromSkillInput: payloads stay inside single quotes', () => {
  it('search — rg branch (ripgrepPath set)', () => {
    const cmd = buildCommandFromSkillInput('search', { query: PAYLOAD, search_dir: '/tmp/w' }, 'darwin', '/usr/local/bin/rg')
    expect(needleQuoting(cmd, NEEDLE)).toEqual({ occurred: true, allInside: true })
  })

  it('search — fallback branch (no ripgrepPath)', () => {
    const cmd = buildCommandFromSkillInput('search', { query: PAYLOAD, search_dir: '/tmp/w' }, 'darwin', null)
    expect(needleQuoting(cmd, NEEDLE)).toEqual({ occurred: true, allInside: true })
  })

  it('find — pattern and search_dir', () => {
    const cmd = buildCommandFromSkillInput('find', { pattern: PAYLOAD, search_dir: `/tmp/a${PAYLOAD}` }, 'darwin', null)
    expect(needleQuoting(cmd, NEEDLE)).toEqual({ occurred: true, allInside: true })
  })

  it('ask_user — linux zenity/kdialog', () => {
    const cmd = buildCommandFromSkillInput('ask_user', { prompt: PAYLOAD, choices: 'a, b' }, 'linux', null)
    expect(needleQuoting(cmd, NEEDLE)).toEqual({ occurred: true, allInside: true })
  })

  it('ask_user — macOS osascript -e (found while fixing P1-02; the prompt rode a single-quoted arg)', () => {
    const cmd = buildCommandFromSkillInput('ask_user', { prompt: PAYLOAD }, 'darwin', null)
    expect(needleQuoting(cmd, NEEDLE)).toEqual({ occurred: true, allInside: true })
    // AppleScript string still well-formed for quotes: the prompt's " is escaped.
    expect(cmd).toContain('display dialog')
  })

  it('negative controls: the old construction fails the lexer', () => {
    expect(needleQuoting(oldStyle(PAYLOAD), NEEDLE)).toEqual({ occurred: true, allInside: false })
    expect(needleQuoting(oldStyle('/tmp/w'), 'x')).toEqual({ occurred: false, allInside: true })
  })

  it('benign values build byte-identical commands (allowlist keys unchanged)', () => {
    const cmd = buildCommandFromSkillInput('search', { query: 'foo', search_dir: '.', include: '*.ts', exclude: '*.spec.ts' }, 'darwin', '/usr/local/bin/rg')
    expect(cmd).toContain(` -n --no-heading -i --max-columns 200 'foo' '.'`)
    expect(cmd).toContain(` -g '*.ts'`)
    expect(cmd).toContain(` -g '!*.spec.ts'`)
  })

  it('$-bearing values no longer gain a stray backslash (the old shEscape also corrupted them)', () => {
    const cmd = buildCommandFromSkillInput('find', { pattern: 'file_$1', search_dir: '.' }, 'darwin', null)
    expect(cmd).toContain(`-iname 'file_$1'`)
  })
})

describe('getLineCount (read tool metadata)', () => {
  it.runIf(process.platform !== 'win32')('wc path single-quotes the file path — $() can no longer substitute', async () => {
    const { setHost } = await import('../src/renderer/src/agent/host')
    const { ToolExecutor } = await import('../src/renderer/src/agent/tool-executors')

    let captured: string | null = null
    setHost({
      execCommandSync: async (cmd: string) => {
        captured = cmd
        return { code: 0, output: '42 /tmp/whatever\n' }
      },
    } as never)

    const executor = new ToolExecutor(
      { platformInfo: { platform: 'darwin' } } as never,
      new Map(), {} as never, {} as never,
      () => {}, () => {},
    )
    const count = await (executor as unknown as { getLineCount(p: string): Promise<number> })
      .getLineCount('x"; $(touch /tmp/pwned).txt')

    expect(count).toBe(42)
    expect(needleQuoting(captured!, NEEDLE)).toEqual({ occurred: true, allInside: true })
    // Non-vacuity: the old double-quote-only build put $(…) in command-substitution range.
    expect(needleQuoting(`wc -l "x\\"; \\$(touch /tmp/pwned).txt"`, NEEDLE)).toEqual({ occurred: true, allInside: false })
  })
})
