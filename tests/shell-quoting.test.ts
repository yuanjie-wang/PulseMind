import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  // review_20261006 高1: the P1-02 fix took the rg arms and missed the grep
  // fallback's --include/--exclude — double-quoted globs let `$( )` substitute
  // (real /bin/sh PoC: touch executed). And the fallback is the DEFAULT path on
  // a macOS box without ripgrep, not a corner.
  it('search — grep fallback: include/exclude globs stay inside single quotes', () => {
    const payload2 = `x'; ${NEEDLE}2; 'y`
    const cmd = buildCommandFromSkillInput('search', {
      query: 'x', search_dir: '/tmp/w',
      include: `${PAYLOAD}, *.ts`,
      exclude: payload2,
    }, 'darwin', null)
    expect(needleQuoting(cmd, NEEDLE)).toEqual({ occurred: true, allInside: true })
    expect(needleQuoting(cmd, `${NEEDLE}2`)).toEqual({ occurred: true, allInside: true })
    expect(cmd).toContain(`--include='*.ts'`)
  })

  it.runIf(process.platform !== 'win32')('search — grep fallback: $() in --include does not substitute (real /bin/sh, rg forced absent)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-shq-grep-'))
    const marker = join(dir, 'pwned')
    const cmd = buildCommandFromSkillInput('search', {
      query: 'x', search_dir: dir, include: `$(${NEEDLE} ${marker})`,
    }, 'darwin', null)
    try {
      // Strip PATH so `command -v rg` fails and the grep arm actually runs.
      const noRgEnv = { PATH: '/usr/bin:/bin' }
      spawnSync('/bin/sh', ['-c', cmd], { env: noRgEnv })
      expect(existsSync(marker)).toBe(false)
      // Non-vacuity: the pre-fix double-quoted form really did substitute.
      const oldCmd = `grep -rn "x" '${dir}' --include="$(${NEEDLE} ${marker})" 2>/dev/null`
      spawnSync('/bin/sh', ['-c', oldCmd], { env: noRgEnv })
      expect(existsSync(marker)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

// review_20261007 高1: the exec sudo-darwin arm put cwd into '…' via
// replace(/'/g, "\\'") — POSIX single quotes do not honor \', so one raw ' in
// cwd closed the wrap and the rest ran with administrator privileges (real
// /bin/sh PoC in the review). The command is built in two layers: fullCmd is
// sh-quoted, then the whole line is re-escaped for the AppleScript "…" literal
// (\\ → \\\\, " → \"), which `do shell script` un-escapes before handing the
// string to /bin/sh. Lexing therefore happens on the UN-escaped sh-level
// string, not on the heredoc bytes.
describe('buildCommandFromSkillInput: exec sudo darwin — cwd stays one shell word', () => {
  function shLevelOf(built: string): string {
    const m = built.match(/do shell script "([\s\S]*)" with administrator privileges/)
    expect(m).toBeTruthy()
    return m![1].replace(/\\\\/g, '\\').replace(/\\"/g, '"')
  }

  it('cwd payload stays inside single quotes at the sh layer', () => {
    const cmd = buildCommandFromSkillInput('exec', { command: 'echo SAFE_MARKER_ONLY', cwd: `/tmp/a${PAYLOAD}`, sudo: true }, 'darwin', null)
    expect(needleQuoting(shLevelOf(cmd), NEEDLE)).toEqual({ occurred: true, allInside: true })
    expect(cmd).toContain('with administrator privileges')
  })

  it.runIf(process.platform !== 'win32')('cwd injection does not execute (real /bin/sh)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-shq-sudo-'))
    const marker = join(dir, 'pwned')
    // The payload balances itself with a trailing comment: once the early-closed
    // wrap puts `; touch …;` in command position, `#` eats the leftover wrap
    // quote so /bin/sh parses to completion (an unbalanced payload aborts the
    // whole -c string before anything runs).
    const cwd = `${dir}/a'; touch ${marker}; #'`
    const cmd = buildCommandFromSkillInput('exec', { command: `echo SAFE_MARKER_ONLY > ${join(dir, 'out')}`, cwd, sudo: true }, 'darwin', null)
    try {
      const r = spawnSync('/bin/sh', ['-c', shLevelOf(cmd)], { encoding: 'utf-8' })
      // The whole payload is one word: cd fails (no such dir), && short-circuits,
      // and the smuggled touch never reaches command position.
      expect(existsSync(marker)).toBe(false)
      expect(r.stderr).not.toContain('command not found')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')('negative control: the old backslash-quote build really executes the smuggled command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-shq-sudo-old-'))
    const marker = join(dir, 'pwned')
    const cwd = `${dir}/a'; touch ${marker}; #'`
    // The pre-fix construction, reduced to the sh level it ran at: the \'
    // "escape" is a literal backslash inside single quotes, so the raw '
    // still closes the wrap and the rest becomes shell grammar.
    const oldFullCmd = `cd '${cwd.replace(/'/g, "\\'")}' && echo SAFE`
    try {
      spawnSync('/bin/sh', ['-c', oldFullCmd], { encoding: 'utf-8' })
      expect(existsSync(marker)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
