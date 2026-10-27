/**
 * The exec file-write gate (2026-10-27): the manual's 「never create or
 * modify files with shell redirection or heredoc」 as code. detectShellFileWrite
 * is the pure detector; the two dispatch sites (execSkillCommand's fallback
 * for auto-run calls, approveTool's shell default for released calls) scan
 * the model-authored `command` before any shell sees it. Source scans pin the
 * wiring — the same discipline html-card-wiring uses.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { detectShellFileWrite, shellFileWriteRejection } from '../src/renderer/src/agent/command-builder'

const ROOT = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

describe('detectShellFileWrite: trips', () => {
  const trip = (cmd: string): string => detectShellFileWrite(cmd) ?? '(no trip)'

  it('redirect into a file — the whole point of the gate', () => {
    expect(trip('ls > out.txt')).toMatch(/^>/)
    expect(trip('sqlite3 db ".dump" > dump.sql')).toMatch(/^>/)
    expect(trip('echo hi >output.log')).toMatch(/^>/)
    expect(trip('npm test > /tmp/result.txt 2>&1')).toMatch(/^>/)
    expect(trip('cat a b > merged.md')).toMatch(/^>/)
  })

  it('append redirect', () => {
    expect(trip('echo line >> notes.md')).toMatch(/^>>/)
    expect(trip('cmd >>"$HOME/写文件"')).toMatch(/^>>/)
  })

  it('heredoc and both-streams', () => {
    expect(detectShellFileWrite('cat << EOF\nhi\nEOF')).toMatch(/heredoc/)
    expect(detectShellFileWrite('bash -s <<< "x"')).toMatch(/heredoc/)
    expect(detectShellFileWrite('make all &> build.log')).toMatch(/&>/)
  })

  it('tee and the PowerShell writers — redirection by another name', () => {
    expect(detectShellFileWrite('make test | tee results.txt')).toMatch(/tee/)
    expect(detectShellFileWrite('sort x |tee out')).toMatch(/tee/)
    expect(detectShellFileWrite('Get-Process | Out-File p.txt')).toMatch(/Out-File/)
    expect(detectShellFileWrite('Set-Content -Path a.txt -Value x')).toMatch(/Set-Content/)
    expect(detectShellFileWrite('Add-Content log.txt hi')).toMatch(/Add-Content/)
  })

  it('a > inside [[ ]] or (( )) is a COMPARISON, not a redirect', () => {
    expect(detectShellFileWrite('[[ $v > 1.0 ]] && echo newer')).toBeNull()
    expect(detectShellFileWrite('if ((count > 3)); then echo many; fi')).toBeNull()
  })
})

describe('detectShellFileWrite: clean commands must pass', () => {
  it('fd duplication and null devices keep silencing idioms working', () => {
    expect(detectShellFileWrite('npm test 2>&1 | tail -20')).toBeNull()
    expect(detectShellFileWrite('cmd >&2')).toBeNull()
    expect(detectShellFileWrite('grep -r foo . >/dev/null 2>&1')).toBeNull()
    expect(detectShellFileWrite('build.exe > NUL')).toBeNull()
    expect(detectShellFileWrite('Write-Host hi > $null')).toBeNull()
  })

  it('quoted > is data — formats, prompts, comparisons', () => {
    expect(detectShellFileWrite('git log --pretty=format:"%h > %s"')).toBeNull()
    expect(detectShellFileWrite("echo 'a > b'")).toBeNull()
    expect(detectShellFileWrite('git commit -m "a > b"')).toBeNull()
    expect(detectShellFileWrite('grep -e "a>b" file')).toBeNull()
  })

  it('ordinary exec fare: compilers, git, package managers, pipes', () => {
    expect(detectShellFileWrite('npm run build')).toBeNull()
    expect(detectShellFileWrite('git add -A && git commit -m "fix" && git push')).toBeNull()
    expect(detectShellFileWrite('python3 script.py --input data.csv')).toBeNull()
    expect(detectShellFileWrite('find . -name "*.ts" | head -50')).toBeNull()
    expect(detectShellFileWrite('diff <(ls a) <(ls b)')).toBeNull()
    // `tee --help` trips: the word-level scan cannot tell help from `tee -a f`,
    // and fail-closed is the contract (a model wanting help has `man tee`).
    expect(detectShellFileWrite('tee --help')).toMatch(/tee/)
    expect(detectShellFileWrite('sort words.txt | uniq -c')).toBeNull()
  })

  it('escapes and subshell oddities stay fail-closed or harmless', () => {
    expect(detectShellFileWrite('echo "path: a\\>b"')).toBeNull() // escaped inside quotes
    // a redirect inside $() trips (fail-closed noise at worst)
    expect(detectShellFileWrite('echo $(x > y)')).not.toBeNull()
  })
})

describe('shellFileWriteRejection', () => {
  it('the rejection text names the trip and teaches the recovery', () => {
    const msg = shellFileWriteRejection('> (redirect)')
    expect(msg).toContain('rejected')
    expect(msg).toContain('> (redirect)')
    expect(msg).toContain('write/edit')
  })
})

describe('wiring: both dispatch sites scan the model-authored command', () => {
  it('execSkillCommand (auto path) gates before the background branch', () => {
    const src = read('src/renderer/src/agent/executors/domain-tools.ts')
    expect(src).toContain('detectShellFileWrite')
    const gate = src.indexOf('detectShellFileWrite(t.input.command)')
    const bg = src.indexOf('background === true')
    expect(gate).toBeGreaterThan(-1)
    expect(bg).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(bg)
  })

  it('approveTool (released-call path) carries the same gate', () => {
    const src = read('src/renderer/src/agent/engine/execution-flow.ts')
    expect(src).toContain('detectShellFileWrite(targetBlock.input.command)')
    // before the terminal span STARTS (the import line also names it — anchor
    // on the usage)
    const gate = src.indexOf('detectShellFileWrite(targetBlock.input.command)')
    const spanUse = src.indexOf('const span = beginTerminalSpan')
    expect(gate).toBeGreaterThan(-1)
    expect(spanUse).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(spanUse)
  })

  it('the exec manual states the rule as enforced, not as a plea', () => {
    const manual = read('src/renderer/src/tools/tool-instructions.ts')
    // backticks are escaped in the source template literal — match around them
    expect(manual).toContain('Files are written only by')
    expect(manual).toContain('— enforced:')
    expect(manual).toContain('/dev/null')
    expect(manual).not.toContain('Never create or modify files with shell redirection')
  })
})
