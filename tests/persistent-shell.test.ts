/**
 * Persistent shell per engine (review P0-1, 2026-10-28).
 *
 * Three layers, same as the search batch:
 *  1. The wire protocol (persistent-shell-protocol.ts) — pure, pinned directly:
 *     script shape (brace group, </dev/null, cd &&, fd-3 sentinel), control
 *     line parsing, the routing predicate, shell keys, the restart notice.
 *  2. A REAL bash driven with the production script builder (no Electron, no
 *     service) — the protocol's three load-bearing claims: cd/export persist
 *     through the brace group, stdin is pinned (`cat` returns), the sentinel
 *     rides fd 3 and stdout stays clean.
 *  3. Wiring scans — the service routes through the protocol, BOTH dispatch
 *     sites and the background path pass the engine's conversationId, session
 *     dispose reaps, the renderer IPC terminal does NOT get a persistent shell,
 *     and the exec manual teaches the new semantics.
 *
 * The service itself (timers, kill → rebuild, drain, serialization, cwd
 * memory, reap) runs only under ELECTRON_RUN_AS_NODE because terminal.ts
 * drags in the SQLite audit store: scripts/probe-persistent-shell.mjs.
 */
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PERSISTENT_SENTINEL_PREFIX,
  isSessionShellKey,
  parseControlLine,
  persistentCommandScript,
  persistentRestartNotice,
  persistentShellKey,
  shellSingleQuote,
  usesPersistentShell,
} from '../src/main/services/persistent-shell-protocol'
import { toolInstructions } from '../src/renderer/src/tools/tool-instructions'

const ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const src = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8')

describe('persistentCommandScript — the wire shape', () => {
  it('no cwd: brace group, stdin pinned to /dev/null, sentinel on fd 3, trailing newline', () => {
    const s = persistentCommandScript('echo hi', ID)
    expect(s).toBe(
      `{\necho hi\n} </dev/null\n__pm_code=$?; printf '${PERSISTENT_SENTINEL_PREFIX}%s__ %d %s\\n' '${ID}' "$__pm_code" "$PWD" >&3\n`,
    )
  })

  it('with cwd: `cd <q> && {` so a bad directory aborts the command instead of running it elsewhere', () => {
    const s = persistentCommandScript('npm test', ID, '/w/packages/core')
    expect(s.startsWith(`cd '/w/packages/core' && {\nnpm test\n} </dev/null\n`)).toBe(true)
  })

  it('cwd is POSIX single-quoted — an embedded quote cannot close the word', () => {
    const s = persistentCommandScript('pwd', ID, "/tmp/it's here")
    expect(s.startsWith(`cd '/tmp/it'\\''s here' && {`)).toBe(true)
    expect(shellSingleQuote(`a'b`)).toBe(`'a'\\''b'`)
    expect(shellSingleQuote('$HOME `x`')).toBe(`'$HOME \`x\`'`)
  })

  it('multi-line commands (heredocs) ride inside the group untouched', () => {
    const cmd = "osascript << 'OSAEOF'\ndo shell script \"x\"\nOSAEOF"
    const s = persistentCommandScript(cmd, ID)
    expect(s).toContain(`{\n${cmd}\n} </dev/null\n`)
  })

  it('the sentinel captures $? BEFORE $PWD expands and never names stdout', () => {
    const s = persistentCommandScript('true', ID)
    const last = s.trimEnd().split('\n').pop()!
    expect(last.startsWith('__pm_code=$?;')).toBe(true)
    expect(last.endsWith('>&3')).toBe(true)
    expect(last).not.toContain('>&1')
  })
})

describe('parseControlLine', () => {
  it('parses id, exit code and cwd (cwd may hold spaces)', () => {
    expect(parseControlLine(`${PERSISTENT_SENTINEL_PREFIX}${ID}__ 0 /Users/me/my project`)).toEqual({ id: ID, code: 0, cwd: '/Users/me/my project' })
    expect(parseControlLine(`${PERSISTENT_SENTINEL_PREFIX}${ID}__ 127 /tmp`)).toEqual({ id: ID, code: 127, cwd: '/tmp' })
  })

  it('rejects everything else — noise on fd 3 never completes a command', () => {
    expect(parseControlLine('')).toBeNull()
    expect(parseControlLine('hello')).toBeNull()
    expect(parseControlLine(`${PERSISTENT_SENTINEL_PREFIX}${ID}__`)).toBeNull()
    expect(parseControlLine(`${PERSISTENT_SENTINEL_PREFIX}${ID}__ x /tmp`)).toBeNull()
    expect(parseControlLine(`  ${PERSISTENT_SENTINEL_PREFIX}${ID}__ 0 /tmp`)).toBeNull()
  })

  it('round-trips the script builder output format', () => {
    // What bash prints for the printf in persistentCommandScript.
    const printed = `${PERSISTENT_SENTINEL_PREFIX}${ID}__ 3 /w`
    expect(parseControlLine(printed)?.code).toBe(3)
  })
})

describe('usesPersistentShell — routing predicate', () => {
  it('agent session off Windows → persistent', () => {
    expect(usesPersistentShell('darwin', true, {})).toBe(true)
    expect(usesPersistentShell('linux', true, {})).toBe(true)
  })
  it('no session (renderer IPC terminal) → per-command spawn', () => {
    expect(usesPersistentShell('darwin', false, {})).toBe(false)
  })
  it('Windows → per-command spawn (stdin PowerShell has no fd-3 analog)', () => {
    expect(usesPersistentShell('win32', true, {})).toBe(false)
  })
  it('PM_PERSISTENT_SHELL=0 is the runtime kill switch; any other value is ignored', () => {
    expect(usesPersistentShell('darwin', true, { PM_PERSISTENT_SHELL: '0' })).toBe(false)
    expect(usesPersistentShell('darwin', true, { PM_PERSISTENT_SHELL: '1' })).toBe(true)
    expect(usesPersistentShell('darwin', true, { PM_PERSISTENT_SHELL: 'off' })).toBe(true)
  })
})

describe('shell keys — one shell per engine, reaped per session', () => {
  it('conversationId separates a parent from its sub-agents; no id → the session', () => {
    expect(persistentShellKey('sess', 'conv_a')).toBe('sess::conv_a')
    expect(persistentShellKey('sess', 'sub_b')).toBe('sess::sub_b')
    expect(persistentShellKey('sess')).toBe('sess')
    expect(persistentShellKey('sess', '')).toBe('sess')
  })
  it('isSessionShellKey matches the session and every engine under it, not a prefix-sharing session', () => {
    expect(isSessionShellKey('sess', 'sess')).toBe(true)
    expect(isSessionShellKey('sess::sub_b', 'sess')).toBe(true)
    expect(isSessionShellKey('sess2', 'sess')).toBe(false)
    expect(isSessionShellKey('sess2::x', 'sess')).toBe(false)
  })
})

describe('persistentRestartNotice', () => {
  it('kill path (no code) vs the shell leaving on its own (code)', () => {
    expect(persistentRestartNotice()).toContain('was restarted')
    expect(persistentRestartNotice(7)).toContain('exited (code=7)')
    expect(persistentRestartNotice(null)).toContain('exited (code=null)')
    for (const n of [persistentRestartNotice(), persistentRestartNotice(0)]) {
      expect(n.startsWith('\n[')).toBe(true)
      expect(n).toContain('working directory is kept')
      expect(n).toContain('exported by earlier commands are gone')
    }
  })
})

// ── real bash, production script builder, no service ───────────────────────
interface Driven { stdout: string; stderr: string; ctl: string; exitCode: number | null }

function driveBash(scripts: string[], settleMs = 400): Promise<Driven> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true })
    const r: Driven = { stdout: '', stderr: '', ctl: '', exitCode: null }
    child.stdout!.on('data', (d: Buffer) => { r.stdout += d.toString() })
    child.stderr!.on('data', (d: Buffer) => { r.stderr += d.toString() })
    ;(child.stdio[3] as NodeJS.ReadableStream).on('data', (d: Buffer) => { r.ctl += d.toString() })
    for (const s of scripts) child.stdin!.write(s)
    setTimeout(() => {
      child.stdin!.end()
      child.on('exit', (code) => { r.exitCode = code; resolve(r) })
      setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ } }, 1500)
    }, settleMs)
  })
}

describe.runIf(process.platform !== 'win32')('real bash driven with the production script', () => {
  it('cd + export inside one command are visible to the next; the sentinel reports the new $PWD', async () => {
    const r = await driveBash([
      persistentCommandScript('cd /tmp && export PM_T_FOO=42', 'aaaaaaaa-0000-0000-0000-000000000001'),
      persistentCommandScript('echo "pwd=$(pwd) foo=$PM_T_FOO"', 'aaaaaaaa-0000-0000-0000-000000000002'),
    ])
    expect(r.stdout).toBe('pwd=/tmp foo=42\n')
    const lines = r.ctl.trim().split('\n').map(parseControlLine)
    expect(lines.map((l) => l?.code)).toEqual([0, 0])
    expect(lines[0]?.cwd).toBe('/tmp')
    expect(lines[1]?.id).toBe('aaaaaaaa-0000-0000-0000-000000000002')
  })

  it('stdin is pinned: `cat` returns at once instead of eating the next command; a failing command reports its code', async () => {
    const r = await driveBash([
      persistentCommandScript('cat; echo after-cat', 'aaaaaaaa-0000-0000-0000-000000000003'),
      persistentCommandScript('false', 'aaaaaaaa-0000-0000-0000-000000000004'),
      persistentCommandScript('echo still-alive', 'aaaaaaaa-0000-0000-0000-000000000005'),
    ])
    expect(r.stdout).toBe('after-cat\nstill-alive\n')
    expect(r.ctl.trim().split('\n').map((l) => parseControlLine(l)?.code)).toEqual([0, 1, 0])
  })

  it('stdout carries no sentinel bytes — the control channel is fd 3 alone', async () => {
    const r = await driveBash([persistentCommandScript('printf "中文 ok\\n"', 'aaaaaaaa-0000-0000-0000-000000000006')])
    expect(r.stdout).toBe('中文 ok\n')
    expect(r.stdout).not.toContain(PERSISTENT_SENTINEL_PREFIX)
    expect(r.ctl).toContain(PERSISTENT_SENTINEL_PREFIX)
  })

  it('a bad explicit cwd aborts the command (exit 1, cd error on stderr) rather than running it in the old directory', async () => {
    const r = await driveBash([
      persistentCommandScript('echo RAN', 'aaaaaaaa-0000-0000-0000-000000000007', '/nonexistent/pm-dir'),
    ])
    expect(r.stdout).not.toContain('RAN')
    expect(r.stderr).toMatch(/No such file or directory/)
    expect(parseControlLine(r.ctl.trim())?.code).toBe(1)
  })
})

// ── wiring ─────────────────────────────────────────────────────────────────
describe('wiring', () => {
  const terminal = src('src/main/services/terminal.ts')

  it('svcExecuteCommand routes agent sessions through the persistent shell, keyed by session + shellKey', () => {
    expect(terminal).toMatch(/if \(sessionCtx && usesPersistentShell\(process\.platform, true\)\)/)
    expect(terminal).toContain('persistentShellKey(sessionCtx.sessionId, shellKey)')
    expect(terminal).toContain("stdio: ['pipe', 'pipe', 'pipe', 'pipe']")
    expect(terminal).toContain('detached: true')
    expect(terminal).toContain('process.kill(-pid, sig)')
  })

  it('timers reuse the exact death notices probes match on, and the cap keeps its text', () => {
    expect(terminal).toContain('killInFlight(shell, idleTimeoutNotice(effectiveTimeout), false)')
    expect(terminal).toMatch(/killInFlight\(shell, `\\n\[Command exceeded the \$\{WALL_CLOCK_MAX_MS \/ 1000\}s wall-clock limit \(total duration\)\]`, true\)/)
    expect((terminal.match(/\[Output limit exceeded: 1MB — the process was stopped/g) ?? []).length).toBe(2)
  })

  it('svcKillCommand reaches an in-flight persistent command before the legacy process map', () => {
    const i = terminal.indexOf('export function svcKillCommand')
    const body = terminal.slice(i, terminal.indexOf('\n}\n', i))
    expect(body.indexOf('inFlightByProcessId.get(processId)')).toBeGreaterThan(-1)
    expect(body.indexOf('inFlightByProcessId.get(processId)')).toBeLessThan(body.indexOf('processes.get(processId)'))
  })

  it('a cwd-less background command inherits the engine shell\'s cwd; the shell sweep runs on process exit', () => {
    expect(terminal).toContain('const effectiveCwd = cwd || persistentShellCwd(sandboxCtx, shellKey) || sandboxCtx?.workspaceDir || getHomeDir()')
    expect(terminal).toMatch(/process\.once\('exit', \(\) => \{\s*for \(const shell of persistentShells\.values\(\)\) killShellGroup\(shell, true\)/)
    expect(terminal).toContain('delete env.BASH_ENV')
  })

  it('main-host forwards shellKey on both the foreground and background host calls', () => {
    const host = src('src/main/agent/main-host.ts')
    expect(host).toMatch(/executeCommand: async \(command, cwd, timeoutMs, shellKey\) =>/)
    expect(host).toMatch(/\}, shellKey\),/)
    expect(host).toContain('executeBackground: async (command, cwd, shellKey) => svcExecuteBackground(command, cwd, shellKey)')
  })

  it('BOTH dispatch sites pass the engine\'s conversationId — auto path and approval release — plus the background path', () => {
    const domain = src('src/renderer/src/agent/executors/domain-tools.ts')
    expect(domain).toContain('getHost().executeBackground(command, cwd || undefined, ex.opts.conversationId)')
    expect(domain).toMatch(/getHost\(\)\.executeCommand\(command, cwd \|\| undefined, [^\n]*, ex\.opts\.conversationId\)/)
    const flow = src('src/renderer/src/agent/engine/execution-flow.ts')
    expect(flow).toContain('getHost().executeCommand(resolvedCommand, resolvedCwd || undefined, timeoutMs, this.engine.opts.conversationId)')
  })

  it('session dispose reaps the session\'s shells right after its background pids', () => {
    const sm = src('src/main/agent/session-manager.ts')
    expect(sm).toContain('svcReapSessionShells as reapSessionShells')
    const i = sm.indexOf("case 'dispose':")
    const block = sm.slice(i, i + 1200)
    expect(block.indexOf('reapBackgroundPids(')).toBeGreaterThan(-1)
    expect(block.indexOf('reapSessionShells(sessionId)')).toBeGreaterThan(block.indexOf('reapBackgroundPids('))
  })

  it('the renderer IPC terminal never passes a shellKey (no persistent shell for the user terminal)', () => {
    const handler = src('src/main/ipc/terminal.handler.ts')
    expect(handler).toMatch(/svcExecuteCommand\(command, gate\.cwd, timeoutMs, \{/)
    expect(handler).not.toContain('shellKey')
  })

  it('bridge type carries shellKey on executeCommand and executeBackground', () => {
    const bridge = src('src/shared/types/electron-bridge.ts')
    expect(bridge).toContain('executeCommand: (command: string, cwd?: string, timeoutMs?: number, shellKey?: string) => Promise<string>')
    expect(bridge).toContain('executeBackground: (command: string, cwd?: string, shellKey?: string) => Promise<{ pid: number }>')
  })

  it('exec manual teaches persistence, the /dev/null stdin, the restart cost and the Windows exception', () => {
    const body = toolInstructions.exec
    expect(body).toContain('The shell persists across calls (macOS/Linux)')
    expect(body).toContain('`cd`, `export`, `source .venv/bin/activate`, `nvm use` carry over')
    expect(body).toContain("A command's stdin is /dev/null")
    expect(body).toContain('exported variables are gone')
    expect(body).toContain('`background: true` starts where the shell currently is')
    expect(body).toContain('On Windows every command still starts fresh')
  })
})

// ── PLAN-background-tasks A：运行中「转入后台」的持久 shell 路径 ──────────────
// 整只 shell 脱离 per-engine 注册表：输出与 fd-3 哨兵改挂以 shell pid 为键的
// proc log，backgroundByPid 背 shell pid（exec_logs/exec_kill/exit 通知全复用
// pid 基建），下条命令落新 shell（persistentCwd 恢复 cwd，export 丢失是接受的
// 代价）。服务本体跑不动（audit store 依赖 Electron ABI）——锁释放、新 shell、
// 哨兵迟到、续缓冲四个契约按 wiring 扫描钉死，运行时由 probe-persistent-shell
// 的真机走查承担。
describe('foreground promotion — the persistent-shell path (PLAN-background-tasks A)', () => {
  const terminal = src('src/main/services/terminal.ts')

  it('svcPromoteToBackground detaches the shell: registry out, lock released, log opened under the SHELL pid', () => {
    const start = terminal.indexOf('export function svcPromoteToBackground')
    const body = terminal.slice(start, terminal.indexOf('export function svcListDetachedShellRuns', start))
    // 两条路径同函数：先查持久 shell 的在飞命令，再查 per-command spawn 表。
    const shellPath = body.indexOf('inFlightByProcessId.get(processId)')
    const spawnPath = body.indexOf('processes.get(processId)')
    expect(shellPath).toBeGreaterThan(-1)
    expect(spawnPath).toBeGreaterThan(shellPath)
    expect(body).toContain('persistentShells.delete(shell.key)')
    expect(body).toContain('const log = openProcLog(shellPid)')
    expect(body).toContain('backgroundByPid.set(shellPid, entry)')
    expect(body).toContain('ctx?.backgroundPids.add(shellPid)')
    expect(body).toContain('f.release()')
  })

  it('the detached shell keeps streaming into the log; the late sentinel closes the run and pushes the session', () => {
    const outFn = terminal.indexOf('function onShellOutput')
    const outBody = terminal.slice(outFn, terminal.indexOf('function completeCommand', outFn))
    // 无在飞命令时唯一的合法写者是被转后台的 run——输出续写进 proc log。
    expect(outBody).toContain('shell.detachedTo.log.write(text)')
    const ctlFn = terminal.indexOf('function onDetachedControl')
    const ctlBody = terminal.slice(ctlFn, terminal.indexOf('function onControlData', ctlFn))
    expect(ctlBody).toContain('run.log.writeExitLine(parsed.code)')
    expect(ctlBody).toContain('notifySessionBackgroundExit(shell.sessionId, shellPid, parsed.code)')
    expect(ctlBody).toContain('backgroundByPid.delete(shellPid)')
    // 哨兵命中后 shell 已空闲——退役，避免一次转后台漏一只 bash。
    expect(ctlBody).toContain('killShellGroup(shell, false)')
  })

  it('a shell death with a detached run still closes it (exit line + session push, code=null)', () => {
    const exitFn = terminal.indexOf('function onShellExit')
    const body = terminal.slice(exitFn, terminal.indexOf('function onShellError', exitFn))
    expect(body).toContain('shell.detachedTo')
    expect(body).toContain('run.log.writeExitLine(null)')
    expect(body).toContain('notifySessionBackgroundExit(shell.sessionId, shellPid, null)')
  })

  it('the promoted entry kills by process GROUP (the command is the shell\'s child)', () => {
    const killFn = terminal.indexOf('function killProcess(')
    const body = terminal.slice(killFn, terminal.indexOf('function getHomeDir', killFn))
    expect(body).toContain('entry.groupKill')
    expect(body).toContain('process.kill(-child.pid, sig)')
  })

  it('the promoted foreground run re-seats into the background channels on the per-command path', () => {
    const start = terminal.indexOf('export function svcPromoteToBackground')
    const body = terminal.slice(start, terminal.indexOf('export function svcListDetachedShellRuns', start))
    expect(body).toContain('entry.background = true')
    expect(body).toContain('entry.promotedLog = log')
    expect(body).toContain('entry.sinkRef!.current = {')
    // 计时器清干净：idle/wall 任一都不得在转后台后再杀进程。
    expect(body).toContain('clearTimeout(entry.idleTimer)')
    expect(body).toContain('clearTimeout(entry.wallTimer)')
  })

  it('both exec dispatch sites register a promotion handle; the auto path settles with the background envelope', () => {
    const domain = src('src/renderer/src/agent/executors/domain-tools.ts')
    expect(domain).toContain('registerForegroundExec(t.id, {')
    expect(domain).toContain("resolve('promoted')")
    expect(domain).toContain('getHost().promoteToBackground(claimedPid)')
    const flow = src('src/renderer/src/agent/engine/execution-flow.ts')
    expect(flow).toContain('registerForegroundExec(toolUseId, {')
    expect(flow).toContain('promoteReleasedTool = (toolUseId: string): boolean')
  })
})

// 持久 shell 强制 /bin/bash 后，svcExecuteBackground 仍走 $SHELL——前台过的
// `grep --include=*.ts` 在后台死于 zsh nomatch（~96 次历史失败，10-10 一天 46 次，
// 10-28 18:44 仍真实发生）。background 只跑工具写的命令（main-host 一方），
// 与持久 shell 同源；svcExecSync / svcExecuteCommand 无会话路径同时服务
// 用户终端面板，$SHELL 是用户自己的 shell，刻意保留。
describe('background uses the agent-side shell, the user terminal keeps $SHELL (Z1-r)', () => {
  it('svcExecuteBackground spawns PERSISTENT_SHELL_BIN, not $SHELL', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const src = readFileSync(new URL('../src/main/services/terminal.ts', import.meta.url), 'utf-8')
    const start = src.indexOf('export async function svcExecuteBackground')
    const fn = src.slice(start, src.indexOf('export async function', start + 10))
    expect(fn).toContain('PERSISTENT_SHELL_BIN')
    expect(fn).not.toContain('process.env.SHELL')
    expect(fn).toContain('terminal never gets here')
  })

  it('the user-terminal paths keep their own shell (a future cleanup must not eat it)', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const src = readFileSync(new URL('../src/main/services/terminal.ts', import.meta.url), 'utf-8')
    // svcExecSync + svcExecuteCommand legacy: dual-use with the user terminal.
    expect(src.match(/process\.env\.SHELL/g)?.length).toBe(2)
  })
})
