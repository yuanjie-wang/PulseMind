import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shEscape, shSingleQuote } from '../src/renderer/src/agent/agent-utils'
import { buildCommandFromSkillInput, withDefaultSearchDir } from '../src/renderer/src/agent/command-builder'

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

// ── audit 2026-10-10 #2/#4/#5/#6（工具审计修复批）────────────────────────
describe('find 的注入面（read 档 = 永不审批，参数即命令串）', () => {
  it('type 白名单：f/d 原样，其他拼写不进命令串', () => {
    expect(buildCommandFromSkillInput('find', { pattern: 'x', search_dir: '/w', type: 'f' }, 'darwin', null)).toContain('-type f')
    expect(buildCommandFromSkillInput('find', { pattern: 'x', search_dir: '/w', type: 'd' }, 'darwin', null)).toContain('-type d')
    // 旧形状 `-type ${type}` 曾把任意拼写插进 shell 串——注入面闭合
    expect(buildCommandFromSkillInput('find', { search_dir: '/w', type: 'f; touch /tmp/pwned' }, 'darwin', null)).not.toContain('touch')
    expect(buildCommandFromSkillInput('find', { search_dir: '/w', type: 'f; touch /tmp/pwned' }, 'darwin', null)).toContain('-maxdepth')
  })

  it('extra_args 带元字符 → 拒绝为错误命令，不执行', () => {
    const cmd = buildCommandFromSkillInput('find', { search_dir: '/w', extra_args: `-o -name "x"; ${NEEDLE}` }, 'darwin', null)
    expect(cmd.startsWith('echo "Error:')).toBe(true)
    expect(cmd).not.toContain(NEEDLE)
  })

  it.runIf(process.platform !== 'win32')('extra_args 注入不执行（real /bin/sh）+ 旧形状负控', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-shq-find-'))
    const marker = join(dir, 'pwned')
    const cmd = buildCommandFromSkillInput('find', { search_dir: dir, extra_args: `; ${NEEDLE} ${marker}` }, 'darwin', null)
    try {
      spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf-8' })
      expect(existsSync(marker)).toBe(false)
      // Non-vacuity: the pre-fix raw interpolation really did split commands.
      // 旧形状：extra_args 被裸拼在 -maxdepth 与 -not 之间，`;` 因此分割出第二条命令。
      // 注入串只带 marker、不带 find 的尾部参数：GNU touch 先 getopt、撞上 -not 直接报
      // 非法选项且一个文件都不建（BSD touch 是边解析边建，先落盘再报错），带上它们会让
      // 这条负控在 Linux 上假失败（2026-11-07 CI 实测）。去掉后两个平台都真正落盘。
      const oldCmd = `find '${dir}' -maxdepth 5 ; ${NEEDLE} ${marker} 2>/dev/null | head -100`
      // cwd: dir 仍留着 —— 万一以后再有操作数落盘，也只会在临时目录里。
      spawnSync('/bin/sh', ['-c', oldCmd], { encoding: 'utf-8', cwd: dir })
      expect(existsSync(marker)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('普通 extra_args 谓词照原样通过（负控：-o -name 组合不受影响）', () => {
    const cmd = buildCommandFromSkillInput('find', { search_dir: '/w', extra_args: '-o -name "*.env*"' }, 'darwin', null)
    expect(cmd).toContain(`-o -name "*.env*"`)
    expect(cmd).toContain('-maxdepth')
  })

  // review_20261011 高1：`+` 终结符的 -exec 形态不含任何元字符，黑名单挡不住
  // ——read 档零审批跑任意命令。执行谓词家族按 token 整族拒绝。
  // review_20261015 高1：shell 在分词后还会做词中引号/反斜杠剥离——`-ex"e"c`/
  // `-e'x'ec`/`-ex\ec` 到 find 眼里都重建出 `-exec`（实测），只剥前导引号的
  // 判法全部漏过；`\-exec` 是转义连杠的第四种拼写。
  it.each([
    ["-name '*.sh' -exec sh {} +", '-exec sh {} +'],
    ['-name "*.sh" -execdir sh {} +', '-execdir'],
    ['-mtime -7 -ok rm {} +', '-ok rm'],
    ['-name x -fprint /tmp/out', '-fprint'],
    ['-name x -fprintf /tmp/out "%p"', '-fprintf'],
    ['-name x -fls /tmp/out', '-fls'],
    ['-name "*.log" -delete', '-delete'],
    ['-name x "-exec" sh {} +', '引号形态 "-exec"'],
    ['-name "*.sh" -ex"e"c sh {} +', '词中双引号 -ex"e"c'],
    ['-name x -e\'x\'ec sh {} +', '词中单引号 -e\'x\'ec'],
    ['-mtime -7 -ex\\ec sh {} +', '词中反斜杠 -ex\\ec'],
    ['\\-exec sh {} +', '转义连杠 \\-exec'],
  ])('写副作用谓词被拒：%s', (extraArgs) => {
    const cmd = buildCommandFromSkillInput('find', { search_dir: '/w', extra_args: extraArgs }, 'darwin', null)
    expect(cmd.startsWith('echo "Error:')).toBe(true)
    expect(cmd).not.toContain('sh {}')
    expect(cmd).not.toContain('-fprint /tmp/out')
  })

  it.runIf(process.platform !== 'win32')('非空对照：词中引号变体经真实 shell 确实重建出 -exec', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-shq-find-quote-'))
    try {
      writeFileSync(join(dir, 'a.txt'), 'x')
      // shell 剥掉词中引号后 find 收到的就是 `-exec`：echo 以匹配路径跑起来
      // ——证明该拼写不是「find 当错谓词安全失败」的形状，上面的整族拒绝钉的
      // 是真实可达的执行面。（`{}` 必须紧挨 `+`；嵌在别的词里 find 会以
      // no terminating ";" 拒掉整条谓词。）
      const probe = spawnSync('/bin/sh', ['-c', `find '${dir}' -name '*.txt' -ex"e"c echo {} +`], { encoding: 'utf-8' })
      expect(probe.stdout).toContain('a.txt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('普通谓词不受谓词拒绝误伤（-mtime/-size/-empty/-perm 全通过）', () => {
    const cmd = buildCommandFromSkillInput('find', { search_dir: '/w', extra_args: '-mtime -7 -size +1k -empty -perm 644' }, 'darwin', null)
    expect(cmd).not.toContain('Error:')
    expect(cmd).toContain('-mtime -7 -size +1k -empty -perm 644')
  })
})

describe('search 的 stderr 通道与默认目录', () => {
  it('rg 分支 stderr 并进输出（2>&1）——正则错误这类真实失败不再被吞成空输出', () => {
    const cmd = buildCommandFromSkillInput('search', { query: 'x', search_dir: '/w' }, 'darwin', '/usr/local/bin/rg')
    expect(cmd).toContain("2>&1 | head -100")
    expect(cmd).not.toContain('2>/dev/null | head')
  })

  it('grep 回退分支同样 2>&1（rg 臂与 else 臂都在）', () => {
    const cmd = buildCommandFromSkillInput('search', { query: 'x', search_dir: '/w' }, 'darwin', null)
    expect((cmd.match(/2>&1/g) || []).length).toBeGreaterThanOrEqual(2)
    expect(cmd).not.toContain('2>/dev/null;')
  })
})

describe('read 的 ~ 路径在引号里不展开 → 拼 $HOME', () => {
  it('POSIX：tail/xxd 的路径带 $HOME 前缀（与 list_dir 同款）', () => {
    const tail = buildCommandFromSkillInput('read', { file_path: '~/.pulsemind/mem.md' }, 'darwin', null)
    expect(tail).toContain(`tail -n +1 "$HOME`)
    const xxd = buildCommandFromSkillInput('read', { file_path: '~/.pulsemind/mem.md', binary: true }, 'darwin', null)
    expect(xxd).toContain(`xxd "$HOME`)
  })

  it('普通绝对路径不带 $HOME（负控）', () => {
    const cmd = buildCommandFromSkillInput('read', { file_path: '/tmp/a.txt' }, 'darwin', null)
    expect(cmd).toContain(`tail -n +1 "/tmp/a.txt"`)
    expect(cmd).not.toContain('$HOME')
  })

  it('getLineCount 同样拼 $HOME（~ 文件的行数统计不再恒 0）', async () => {
    const { setHost } = await import('../src/renderer/src/agent/host')
    const { ToolExecutor } = await import('../src/renderer/src/agent/tool-executors')
    let captured: string | null = null
    setHost({
      execCommandSync: async (cmd: string) => { captured = cmd; return { code: 0, output: '7 ~/x\n' } },
    } as never)
    const executor = new ToolExecutor({ platformInfo: { platform: 'darwin' } } as never, new Map(), {} as never, {} as never, () => {}, () => {})
    await (executor as unknown as { getLineCount(p: string): Promise<number> }).getLineCount('~/notes.md')
    // The variable must sit OUTSIDE the quotes to expand (full_20261011
    // M2-P1-3/X8): "\$HOME…" inside the double-quoted path is the shape read's
    // verified POSIX branch uses.
    expect(captured).toContain(`wc -l "$HOME`)
    expect(captured).not.toContain(`'$HOME`)
  })
})

describe('withDefaultSearchDir（search/find 的目录坐标）', () => {
  it('缺省回 workspace；无 workspace 时维持 "."（命令构造器的原默认）', () => {
    expect(withDefaultSearchDir({ query: 'x' }, '/ws')).toEqual({ query: 'x', search_dir: '/ws' })
    expect(withDefaultSearchDir({ query: 'x' })).toEqual({ query: 'x' })
  })

  it('相对路径挂 workspace（与主进程 file-ops resolvePath 同一坐标系）', () => {
    expect(withDefaultSearchDir({ query: 'x', search_dir: 'src' }, '/ws')).toEqual({ query: 'x', search_dir: '/ws/src' })
    expect(withDefaultSearchDir({ query: 'x', search_dir: '.' }, '/ws')).toEqual({ query: 'x', search_dir: '/ws' })
  })

  it('绝对路径与 ~ 原样（~ 由命令构造器的 $HOME 前缀展开）', () => {
    expect(withDefaultSearchDir({ query: 'x', search_dir: '/abs/dir' }, '/ws')).toEqual({ query: 'x', search_dir: '/abs/dir' })
    expect(withDefaultSearchDir({ query: 'x', search_dir: '~/docs' }, '/ws')).toEqual({ query: 'x', search_dir: '~/docs' })
  })

  it('Windows 工作区用反斜杠拼接', () => {
    expect(withDefaultSearchDir({ query: 'x', search_dir: 'src' }, 'C:\\ws')).toEqual({ query: 'x', search_dir: 'C:\\ws\\src' })
  })
})
