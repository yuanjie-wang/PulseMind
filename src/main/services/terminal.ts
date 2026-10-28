/**
 * Terminal service (PLAN-0.3.5 M1.4①): process spawning/streaming previously
 * inlined in terminal.handler.ts. The service layer is transport-agnostic —
 * callers supply an `emit` sink; the IPC handler bridges that to webContents,
 * the main-process agent host bridges it to registered listeners.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, createWriteStream, openSync, readSync, statSync, closeSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { ensureLaunchHooks, getHookEnv } from '../hooks-runner'
import { currentSessionSandbox, notifySessionBackgroundExit, type SessionSandboxContext } from '../sandbox/session-context'
import { isSubpath } from '../../shared/sandbox/path-jail'
import { auditStore } from '../storage/audit-store'
import { DATA_DIR } from '../storage/index'
import { createStreamDecoder } from './stream-decoder'
import {
  isSessionShellKey,
  parseControlLine,
  persistentCommandScript,
  persistentRestartNotice,
  persistentShellKey,
  usesPersistentShell,
} from './persistent-shell-protocol'

interface ProcessEntry {
  process: ChildProcess
  command: string
  createdAt: number
  stdout: string
  stderr: string
  /** Set on background entries (PLAN-coding-contract P0-3): the OS pid is the
   *  handle the model sees (exec_logs / exec_kill / the CommandCard kill). */
  osPid?: number
  background?: boolean
}

const processes = new Map<string, ProcessEntry>()
/** Background entries indexed by OS pid — svcExecKill's lookup. Membership ends
 *  when the process exits on its own; the SESSION's backgroundPids set (session
 *  context) outlives that so exec_logs can still read the log and discover the
 *  [exited code=N] line. */
const backgroundByPid = new Map<number, ProcessEntry>()

const OUTPUT_LIMIT = 1024 * 1024 // 1MB max output per process
const DEFAULT_TIMEOUT = 60_000 // 60s idle

/** The idle-timeout death notice, shared by both foreground paths
 *  (PLAN-tool-issues #10, 2026-10-28). The child is killed after producing
 *  nothing for the whole window; the old one-liner left the model to guess
 *  whether that meant "hung" or merely "quiet", and a long silent job (big
 *  grep, sleep-and-poll) got retried into the same wall. The notice names the
 *  rule and the escape hatch. The wall-clock cap keeps its own distinct line so
 *  the two deaths stay tellable apart. Probes match on `with no output`. */
export function idleTimeoutNotice(timeoutMs: number): string {
  const s = timeoutMs / 1000
  return `\n[Command timed out after ${s}s with no output — idle timeout: nothing reached stdout/stderr for ${s}s, so the process was killed; it may have been working quietly. For long-running or quiet jobs use background: true]`
}

/**
 * Absolute cap on a FOREGROUND command's total lifetime (PLAN-coding-contract
 * #4, ruling D2). The idle timer resets on every stdout/stderr data event, so a
 * chatty process (`npm run dev`, `watch`) never trips it and can hold a turn
 * open forever — this timer is never reset, turning "hangs indefinitely" into
 * "bounded failure". It deliberately does NOT apply to `background: true`
 * processes (P0-3 #13): their whole point is to outlive the turn, and
 * svcExecuteBackground sets no timers at all.
 *
 * Probe seam: PM_WALL_CLOCK_MAX_MS shortens the cap for
 * scripts/probe-terminal-limits.mjs (a real 900s wait per case is not a
 * runnable probe). Production never sets it, so the shipped cap is 900_000.
 */
export const WALL_CLOCK_MAX_MS = (() => {
  const raw = Number(process.env.PM_WALL_CLOCK_MAX_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 900_000
})()

/** Background process logs (P0-3 #12). Written under the app's own data dir —
 *  a deny root for the agent's `read` — so access goes through the narrow
 *  exec_logs(pid) channel, never through a path the model could guess. */
const PROC_LOG_DIR = join(DATA_DIR, 'tmp', 'proc-logs')
const PROC_LOG_MAX_BYTES = 8 * 1024 * 1024
const PROC_LOG_DEFAULT_TAIL = 8 * 1024
const PROC_LOG_MAX_TAIL = 64 * 1024

// --- Windows PowerShell output encoding ---
// PowerShell 5.1 writes piped output using [Console]::OutputEncoding, whose
// default is unreliable in a hidden no-console child (CREATE_NO_WINDOW): it can
// be the OEM codepage (GBK on Chinese systems) even when chcp reports 65001,
// and modern tools (git, node) emit UTF-8 regardless. Guessing the codepage
// misdecodes in both directions, so instead we force UTF-8 in the child; the
// pipe side — arbitrary chunk cuts plus legacy tools that still emit GBK on
// their own stdout — is decoded by stream-decoder.ts (strict UTF-8 → GBK).
const WIN_PS_UTF8_PREFIX = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; '

// Windows: Python's pipes default to the ANSI codepage (cp936 on Chinese
// Windows), the main GBK emitter left after WIN_PS_UTF8_PREFIX above — UTF-8
// mode makes it emit the bytes the pipe decoder expects.
const WIN_UTF8_ENV = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }

/** Cross-platform process kill. On Windows, signals aren't supported — use `.kill()` or `taskkill`. */
function killProcess(entry: ProcessEntry, force = false): void {
  const { process: child } = entry
  if (child.killed) return

  if (process.platform === 'win32') {
    if (force) {
      // Force kill on Windows via taskkill
      execFile('taskkill', ['/F', '/T', '/PID', String(child.pid)], () => {
        /* ignore errors — process may already be dead */
      })
    } else {
      child.kill() // no signal on Windows
    }
  } else {
    child.kill(force ? 'SIGKILL' : 'SIGTERM')
  }
}

/** Resolve a cross-platform home directory for the default cwd. */
function getHomeDir(): string | undefined {
  return process.env.HOME || process.env.USERPROFILE || undefined
}

/** Materialize a spawn cwd that lives inside the session's workspace and does
 *  not exist yet. The conversation workspace is minted (named, persisted) at
 *  first session and only created at the first write — a shell command aimed
 *  into it is the other first use, and spawning with a missing cwd fails with
 *  a misleading "spawn <shell> ENOENT". Deliberately scoped to the workspace:
 *  a cwd outside it that does not exist keeps today's spawn error, because
 *  creating arbitrary model-named paths is not this service's call. */
function ensureWorkspaceCwd(cwd: string | undefined): void {
  if (!cwd) return
  const ctx = currentSessionSandbox()
  if (!ctx?.workspaceDir || !isSubpath(ctx.workspaceDir, cwd)) return
  if (existsSync(cwd)) return
  try {
    mkdirSync(cwd, { recursive: true })
  } catch {
    /* leave it to spawn to report the real failure */
  }
}

export interface TerminalEmitSink {
  output(processId: string, type: 'stdout' | 'stderr', data: string): void
  exit(processId: string, code: number | null, signal: string | null): void
  error(processId: string, message: string): void
}

// ── Persistent shell per engine (review P0-1, 2026-10-28) ────────────────────
//
// Agent `exec` (foreground, non-Windows) runs inside ONE long-lived shell per
// engine — keyed by session + the engine's conversationId, so a parent and its
// parallel sub-agents each hold their own — instead of a fresh `bash -c` per
// command. cd / export / source / nvm use carry over between commands. The
// wire format lives in persistent-shell-protocol.ts; the runtime contracts:
//
//  - The shell is spawned detached (its own process group) with FOUR stdio
//    pipes; fd 3 is the control channel the completion sentinel rides. stdout
//    and stderr stream raw, exactly as the per-command spawn did.
//  - fd 3 and the output pipes are read independently, so the sentinel can be
//    observed BEFORE the last stdout bytes of the same command — completion
//    waits for a short quiet window on the output streams (what the command
//    wrote is already in the kernel buffer and drains in a few ticks; nothing
//    new starts until the next command is written). A grandchild left behind
//    with `&` keeps writing after that and is dropped (or misattributed to the
//    next command) — background: true is the sanctioned shape, as before.
//  - One command in flight per shell (promise-chain lock). The per-command
//    processId facade is unchanged, so the terminal bus, the span filter and
//    the kill button work untouched.
//  - idle / wall-clock / 1MB cap keep their exact notices (probes match on
//    them); the kill is a PROCESS GROUP kill — the shell dies with the command
//    — and the next command rebuilds the shell at the last-known cwd (the
//    sentinel reports $PWD on every completion). Exported env is lost on a
//    rebuild; the restart notice says so. `exit` typed by the model is the
//    same path.
//  - Windows and the renderer IPC terminal keep the per-command spawn below
//    (usesPersistentShell). PM_PERSISTENT_SHELL=0 is the runtime kill switch.

const PERSISTENT_SHELL_BIN = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
/** Quiet window the output streams must hold after the sentinel before a
 *  command is declared complete, and the cap that keeps a chatty orphan from
 *  stalling the next command forever. */
const COMPLETION_DRAIN_MS = 4
const COMPLETION_DRAIN_MAX_MS = 200

interface InFlightCommand {
  processId: string
  emit: TerminalEmitSink
  stdoutLen: number
  bytesSeen: number
  idleTimer: NodeJS.Timeout | null
  wallTimer: NodeJS.Timeout | null
  drainTimer: NodeJS.Timeout | null
  resetIdle: () => void
  release: () => void
  killing: boolean
  finalized: boolean
  pendingNotice: string | null
  pendingSignal: 'SIGTERM' | 'SIGKILL' | null
}

interface PersistentShell {
  key: string
  sessionId: string
  child: ChildProcess
  outDecoder: ReturnType<typeof createStreamDecoder>
  errDecoder: ReturnType<typeof createStreamDecoder>
  ctlDecoder: ReturnType<typeof createStreamDecoder>
  ctlBuf: string
  inFlight: InFlightCommand | null
  dead: boolean
}

const persistentShells = new Map<string, PersistentShell>()
const persistentLocks = new Map<string, Promise<void>>()
/** Last $PWD each shell reported — outlives the shell so a rebuild resumes
 *  there, and is what a cwd-less `background: true` inherits. */
const persistentCwd = new Map<string, string>()
const inFlightByProcessId = new Map<string, PersistentShell>()

function clearCommandTimers(f: InFlightCommand): void {
  if (f.idleTimer) { clearTimeout(f.idleTimer); f.idleTimer = null }
  if (f.wallTimer) { clearTimeout(f.wallTimer); f.wallTimer = null }
  if (f.drainTimer) { clearTimeout(f.drainTimer); f.drainTimer = null }
}

function killShellGroup(shell: PersistentShell, force: boolean): void {
  const sig = force ? 'SIGKILL' : 'SIGTERM'
  const pid = shell.child.pid
  if (!pid) return
  // Negative pid = the whole process group (the shell is its leader thanks to
  // detached: true), so the foreground command and its children go with it.
  try { process.kill(-pid, sig) } catch { try { shell.child.kill(sig) } catch { /* already gone */ } }
}

/** Kill the command in flight (and, unavoidably, its shell). The exit handler
 *  owns the report: it flushes the tails, emits `notice`, then exit(null, sig). */
function killInFlight(shell: PersistentShell, notice: string | null, force: boolean): void {
  const f = shell.inFlight
  if (!f || f.killing || f.finalized) return
  f.killing = true
  f.pendingNotice = notice
  f.pendingSignal = force ? 'SIGKILL' : 'SIGTERM'
  clearCommandTimers(f)
  killShellGroup(shell, force)
  if (!force) setTimeout(() => { if (!shell.dead) killShellGroup(shell, true) }, 3000)
}

function flushShellTails(shell: PersistentShell, f: InFlightCommand): void {
  const outTail = shell.outDecoder.flush()
  if (outTail) f.emit.output(f.processId, 'stdout', outTail)
  const errTail = shell.errDecoder.flush()
  if (errTail) f.emit.output(f.processId, 'stderr', errTail)
}

function detachInFlight(shell: PersistentShell, f: InFlightCommand): void {
  clearCommandTimers(f)
  f.finalized = true
  shell.inFlight = null
  inFlightByProcessId.delete(f.processId)
}

function onShellOutput(shell: PersistentShell, type: 'stdout' | 'stderr', text: string): void {
  const f = shell.inFlight
  if (!f || !text || f.killing || f.finalized) return
  f.bytesSeen += text.length
  f.resetIdle()
  if (type === 'stdout') {
    const before = f.stdoutLen
    f.stdoutLen += text.length
    if (f.stdoutLen > OUTPUT_LIMIT) {
      // Same cap + kill + notice as the per-command path; the head that fits
      // still goes out so the kept prefix is in the result.
      const room = OUTPUT_LIMIT - before
      if (room > 0) f.emit.output(f.processId, 'stdout', text.slice(0, room))
      killInFlight(shell, '\n[Output limit exceeded: 1MB — the process was stopped; output past the cap was discarded, the kept head is in this result]', false)
      return
    }
  }
  f.emit.output(f.processId, type, text)
}

function completeCommand(shell: PersistentShell, f: InFlightCommand, code: number): void {
  detachInFlight(shell, f)
  flushShellTails(shell, f)
  f.emit.exit(f.processId, code, null)
  f.release()
}

function scheduleCompletion(shell: PersistentShell, f: InFlightCommand, code: number): void {
  // The command is done — only the drain remains, so the idle clock is moot.
  if (f.idleTimer) { clearTimeout(f.idleTimer); f.idleTimer = null }
  const deadline = Date.now() + COMPLETION_DRAIN_MAX_MS
  let seen = f.bytesSeen
  const tick = (): void => {
    f.drainTimer = null
    if (f.finalized || f.killing) return
    if (f.bytesSeen !== seen && Date.now() < deadline) {
      seen = f.bytesSeen
      f.drainTimer = setTimeout(tick, COMPLETION_DRAIN_MS)
      return
    }
    completeCommand(shell, f, code)
  }
  f.drainTimer = setTimeout(tick, COMPLETION_DRAIN_MS)
}

function onControlData(shell: PersistentShell, chunk: Buffer): void {
  shell.ctlBuf += shell.ctlDecoder.push(chunk)
  let nl: number
  while ((nl = shell.ctlBuf.indexOf('\n')) >= 0) {
    const line = shell.ctlBuf.slice(0, nl)
    shell.ctlBuf = shell.ctlBuf.slice(nl + 1)
    const parsed = parseControlLine(line)
    const f = shell.inFlight
    if (!parsed || !f || f.killing || f.finalized || parsed.id !== f.processId) continue
    persistentCwd.set(shell.key, parsed.cwd)
    scheduleCompletion(shell, f, parsed.code)
  }
}

function onShellExit(shell: PersistentShell, code: number | null, signal: NodeJS.Signals | null): void {
  shell.dead = true
  if (persistentShells.get(shell.key) === shell) persistentShells.delete(shell.key)
  const f = shell.inFlight
  if (!f || f.finalized) return
  detachInFlight(shell, f)
  flushShellTails(shell, f)
  if (f.pendingNotice) f.emit.output(f.processId, 'stderr', f.pendingNotice)
  f.emit.output(f.processId, 'stderr', persistentRestartNotice(f.killing ? undefined : code))
  if (f.killing) f.emit.exit(f.processId, null, f.pendingSignal)
  else f.emit.exit(f.processId, code, signal)
  f.release()
}

function onShellError(shell: PersistentShell, err: Error): void {
  shell.dead = true
  if (persistentShells.get(shell.key) === shell) persistentShells.delete(shell.key)
  const f = shell.inFlight
  if (!f || f.finalized) return
  detachInFlight(shell, f)
  // Mirror the per-command 'error' path: error + exit so the executor settles.
  f.emit.error(f.processId, `Failed to spawn process: ${err.message}`)
  f.emit.exit(f.processId, null, 'SIGTERM')
  f.release()
}

function acquireShell(ctx: SessionSandboxContext, key: string): PersistentShell {
  const existing = persistentShells.get(key)
  if (existing && !existing.dead) return existing
  const remembered = persistentCwd.get(key)
  const startCwd = remembered && existsSync(remembered) ? remembered : (ctx.workspaceDir || getHomeDir())
  ensureWorkspaceCwd(startCwd)
  const env: NodeJS.ProcessEnv = { ...process.env, ...getHookEnv() }
  // A user BASH_ENV is the one file a non-interactive bash still sources —
  // not into the agent's shell.
  delete env.BASH_ENV
  const child = spawn(PERSISTENT_SHELL_BIN, [], {
    cwd: startCwd,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env,
    detached: true,
  })
  const shell: PersistentShell = {
    key,
    sessionId: ctx.sessionId,
    child,
    outDecoder: createStreamDecoder(),
    errDecoder: createStreamDecoder(),
    ctlDecoder: createStreamDecoder(),
    ctlBuf: '',
    inFlight: null,
    dead: false,
  }
  child.stdin?.on('error', () => { /* EPIPE after death — the exit handler owns the report */ })
  child.stdout?.on('data', (chunk: Buffer) => onShellOutput(shell, 'stdout', shell.outDecoder.push(chunk)))
  child.stderr?.on('data', (chunk: Buffer) => onShellOutput(shell, 'stderr', shell.errDecoder.push(chunk)))
  const ctl = child.stdio[3] as Readable | null | undefined
  ctl?.on('data', (chunk: Buffer) => onControlData(shell, chunk))
  child.on('exit', (code, signal) => onShellExit(shell, code, signal))
  child.on('error', (err) => onShellError(shell, err))
  persistentShells.set(key, shell)
  return shell
}

function beginCommand(
  shell: PersistentShell,
  processId: string,
  command: string,
  cwd: string | undefined,
  timeoutMs: number | undefined,
  emit: TerminalEmitSink,
  release: () => void,
): void {
  const effectiveTimeout = (timeoutMs != null && timeoutMs > 0) ? timeoutMs : DEFAULT_TIMEOUT
  const f: InFlightCommand = {
    processId, emit, stdoutLen: 0, bytesSeen: 0,
    idleTimer: null, wallTimer: null, drainTimer: null,
    resetIdle: () => {}, release,
    killing: false, finalized: false, pendingNotice: null, pendingSignal: null,
  }
  f.resetIdle = () => {
    if (f.finalized || f.killing) return
    if (f.idleTimer) clearTimeout(f.idleTimer)
    f.idleTimer = setTimeout(() => killInFlight(shell, idleTimeoutNotice(effectiveTimeout), false), effectiveTimeout)
  }
  shell.inFlight = f
  inFlightByProcessId.set(processId, shell)
  f.resetIdle()
  f.wallTimer = setTimeout(
    () => killInFlight(shell, `\n[Command exceeded the ${WALL_CLOCK_MAX_MS / 1000}s wall-clock limit (total duration)]`, true),
    WALL_CLOCK_MAX_MS,
  )
  try {
    shell.child.stdin?.write(persistentCommandScript(command, processId, cwd))
  } catch {
    /* a dead shell reports through its exit/error handler */
  }
}

async function execInPersistentShell(
  ctx: SessionSandboxContext,
  key: string,
  command: string,
  cwd: string | undefined,
  timeoutMs: number | undefined,
  emit: TerminalEmitSink,
): Promise<string> {
  const processId = randomUUID()
  auditStore.record({ scope: 'project', actor: ctx.sessionId, action: 'exec', target: command.slice(0, 160), decision: 'allowed' })
  // Serialize per shell: wait for the previous command's completion, and hand
  // the next caller OUR completion. The processId goes back as soon as the
  // command is on the wire — events flow through `emit` afterwards, exactly
  // like the per-command spawn.
  const prev = persistentLocks.get(key) ?? Promise.resolve()
  let released = false
  let release: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    release = () => { if (released) return; released = true; resolve() }
  })
  persistentLocks.set(key, done)
  await prev
  if (!command.trim()) {
    // `{ }` is a syntax error; an empty command has nothing to run. Async so
    // the caller claims the pid before the exit lands (the span parks early
    // events anyway — this just keeps the order the spawn path had).
    setImmediate(() => { emit.exit(processId, 0, null); release() })
    return processId
  }
  try {
    const shell = acquireShell(ctx, key)
    if (cwd) ensureWorkspaceCwd(cwd)
    beginCommand(shell, processId, command, cwd, timeoutMs, emit, release)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setImmediate(() => {
      emit.error(processId, `Failed to spawn process: ${message}`)
      emit.exit(processId, null, 'SIGTERM')
      release()
    })
  }
  return processId
}

/** Session teardown: kill every shell this session owns (its own and its
 *  sub-agents'), forget their cwd memory and locks. A command in flight is
 *  force-killed and reports through the exit handler like any other kill. */
export function svcReapSessionShells(sessionId: string): void {
  for (const [key, shell] of [...persistentShells]) {
    if (!isSessionShellKey(key, sessionId)) continue
    persistentShells.delete(key)
    if (shell.inFlight) {
      killInFlight(shell, null, true)
    } else {
      killShellGroup(shell, false)
      setTimeout(() => { if (!shell.dead) killShellGroup(shell, true) }, 3000)
    }
  }
  for (const key of [...persistentCwd.keys()]) if (isSessionShellKey(key, sessionId)) persistentCwd.delete(key)
  for (const key of [...persistentLocks.keys()]) if (isSessionShellKey(key, sessionId)) persistentLocks.delete(key)
}

/** The last directory the engine's shell reported, if it has run anything. */
function persistentShellCwd(ctx: SessionSandboxContext | null, shellKey: string | undefined): string | undefined {
  if (!ctx) return undefined
  const remembered = persistentCwd.get(persistentShellKey(ctx.sessionId, shellKey))
  return remembered && existsSync(remembered) ? remembered : undefined
}

// Detached shells are not reaped by the OS when main exits (that is what
// detached means) — they would read EOF on stdin and leave on their own, but a
// foreground command would run to completion first. Sweep them on the way out.
process.once('exit', () => {
  for (const shell of persistentShells.values()) killShellGroup(shell, true)
})

/** Spawn a streaming command. Returns the processId; output arrives via `emit`.
 *  Async only to gate the spawn on the launch hooks (both callers — the IPC
 *  handler and the main-process agent host — already await).
 *
 *  Agent sessions off Windows run inside the engine's persistent shell above;
 *  `shellKey` (the engine's conversationId) tells sub-agents apart. Everything
 *  else — Windows, the renderer IPC terminal — takes the per-command spawn. */
export async function svcExecuteCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs: number | undefined,
  emit: TerminalEmitSink,
  shellKey?: string,
): Promise<string> {
  // Launch hooks may still be running when the first command arrives (they no
  // longer block window creation) — their env (hookEnv + login-shell PATH)
  // must be in place before the first subprocess spawns.
  await ensureLaunchHooks()
  const sessionCtx = currentSessionSandbox()
  if (sessionCtx && usesPersistentShell(process.platform, true)) {
    return execInPersistentShell(sessionCtx, persistentShellKey(sessionCtx.sessionId, shellKey), command, cwd, timeoutMs, emit)
  }
  const processId = randomUUID()

  // Use powershell.exe on Windows (has Unix aliases: ls, cat, pwd, cp, mv, rm);
  // /bin/bash on Unix/macOS.
  const isWin = process.platform === 'win32'
  const [shell, shellArgs] = isWin
    ? ['powershell.exe', ['-NoProfile', '-Command', `${WIN_PS_UTF8_PREFIX}${command}`]]
    : [process.env.SHELL || '/bin/bash', ['-c', command]]

  // Agent sessions confine the DEFAULT cwd to the workspace; approval + audit
  // are the controls (the former OS-level hard isolation is gone with projects).
  // DOCUMENTED ASYMMETRY — do not "fix" silently (2026-10-10 audit #11): an
  // EXPLICIT cwd from the agent is NOT jailed here, while the renderer IPC
  // channel (ipc/terminal.handler.ts gateRendererExecution) mechanically
  // rejects one outside the workspace. The handler's jail exists because a
  // renderer reach-around (XSS) has no approval ladder to answer to; the
  // agent's exec sits on the exec rung and answers to the user at every level
  // above 'auto', and a shell can `cd` (or read absolute paths) anywhere
  // anyway — a cwd jail on THIS path would be theater, so the controls here
  // are the ladder and the audit row above.
  const sandboxCtx = currentSessionSandbox()
  const effectiveCwd = cwd || sandboxCtx?.workspaceDir || getHomeDir()
  ensureWorkspaceCwd(effectiveCwd)
  if (sandboxCtx) {
    auditStore.record({ scope: 'project', actor: sandboxCtx.sessionId, action: 'exec', target: command.slice(0, 160), decision: 'allowed' })
  }

  const child = spawn(shell, shellArgs, {
    cwd: effectiveCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...getHookEnv(), ...(isWin ? WIN_UTF8_ENV : {}) },
    // On Windows, prevent console window from flashing
    windowsHide: true
  })

  const entry: ProcessEntry = {
    process: child,
    command,
    createdAt: Date.now(),
    stdout: '',
    stderr: ''
  }

  processes.set(processId, entry)

  // Per-stream decoders: hold incomplete sequences across chunk cuts, fall
  // back to GBK for tools that ignore the UTF-8 prefix above.
  const outDecoder = createStreamDecoder()
  const errDecoder = createStreamDecoder()

  // Idle timeout — resets on every stdout/stderr data event.
  // Only kills the process if no output is received for the duration.
  const effectiveTimeout = (timeoutMs != null && timeoutMs > 0) ? timeoutMs : DEFAULT_TIMEOUT
  let idleTimer: NodeJS.Timeout | null = null

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (!child.killed) {
        killProcess(entry)
        const outTail = outDecoder.flush()
        if (outTail) {
          entry.stdout += outTail
          emit.output(processId, 'stdout', outTail)
        }
        const errTail = errDecoder.flush()
        if (errTail) emit.output(processId, 'stderr', errTail)
        emit.output(processId, 'stderr', idleTimeoutNotice(effectiveTimeout))
        emit.exit(processId, null, 'SIGTERM')
        processes.delete(processId)
      }
    }, effectiveTimeout)
  }

  resetIdleTimer()

  // Wall-clock cap (P0-2 #4, ruling D2): absolute, never reset, `timeout` cannot
  // raise it. Distinct death reason so the model can tell a silent hang from a
  // long-running job that outlived the cap.
  const wallTimer: NodeJS.Timeout = setTimeout(() => {
    if (!child.killed && child.exitCode === null) {
      if (idleTimer) clearTimeout(idleTimer)
      killProcess(entry, true)
      const outTail = outDecoder.flush()
      if (outTail) {
        entry.stdout += outTail
        emit.output(processId, 'stdout', outTail)
      }
      const errTail = errDecoder.flush()
      if (errTail) emit.output(processId, 'stderr', errTail)
      emit.output(processId, 'stderr', `\n[Command exceeded the ${WALL_CLOCK_MAX_MS / 1000}s wall-clock limit (total duration)]`)
      emit.exit(processId, null, 'SIGKILL')
      processes.delete(processId)
    }
  }, WALL_CLOCK_MAX_MS)

  // stdout
  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      resetIdleTimer()
      const text = outDecoder.push(chunk)
      if (!text) return // incomplete sequence held for the next chunk
      entry.stdout += text
      if (entry.stdout.length > OUTPUT_LIMIT) {
        // Cap + kill is the runaway guard (a chatty process must not outlive
        // its own noise). Flush the decoder first — the kill lands mid-stream
        // and the held incomplete sequence would otherwise be lost (the idle/
        // wall paths below flush the same way). The model-facing recovery for
        // a cut-up JSON is the tool-result offload: the captured head rides
        // addToolResult's budget, whose marker points at the trunc/ read-back
        // file — keep this line factual about WHAT happened.
        const tail = outDecoder.flush()
        if (tail) entry.stdout += tail
        entry.stdout = entry.stdout.slice(0, OUTPUT_LIMIT)
        killProcess(entry)
        emit.output(processId, 'stderr', '\n[Output limit exceeded: 1MB — the process was stopped; output past the cap was discarded, the kept head is in this result]')
        return
      }
      emit.output(processId, 'stdout', text)
    })
  }

  // stderr
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      resetIdleTimer()
      const text = errDecoder.push(chunk)
      if (!text) return
      entry.stderr += text
      emit.output(processId, 'stderr', text)
    })
  }

  // Exit
  child.on('exit', (code, signal) => {
    if (idleTimer) clearTimeout(idleTimer)
    clearTimeout(wallTimer)
    processes.delete(processId)
    const outTail = outDecoder.flush()
    if (outTail) {
      entry.stdout += outTail
      emit.output(processId, 'stdout', outTail)
    }
    const errTail = errDecoder.flush()
    if (errTail) emit.output(processId, 'stderr', errTail)
    emit.exit(processId, code, signal)
  })

  // Error (if process can't be spawned at all)
  child.on('error', (err) => {
    if (idleTimer) clearTimeout(idleTimer)
    clearTimeout(wallTimer)
    processes.delete(processId)
    emit.error(processId, `Failed to spawn process: ${err.message}`)
    // Also emit exit so the renderer's tool result callback fires
    emit.exit(processId, null, 'SIGTERM')
  })

  return processId
}

/** Kill a running process by id (escalates to force-kill after 3s). A
 *  persistent-shell command is killed with its shell (group kill); the shell's
 *  exit handler reports it and the next command rebuilds. */
export function svcKillCommand(processId: string): void {
  const shell = inFlightByProcessId.get(processId)
  if (shell) {
    killInFlight(shell, null, false)
    return
  }
  const entry = processes.get(processId)
  if (!entry || entry.process.killed) return

  killProcess(entry)
  setTimeout(() => {
    killProcess(entry, true)
  }, 3000)
}

/**
 * One-shot command execution: spawn, collect output, return on exit.
 * Unlike svcExecuteCommand, this does NOT stream output — it waits for the
 * process to complete and returns the full result.
 */
export async function svcExecSync(command: string, cwd?: string, timeoutMs?: number): Promise<{ output: string; code: number | null }> {
  const isWin = process.platform === 'win32'
  const [shell, shellArgs] = isWin
    ? ['powershell.exe', ['-NoProfile', '-Command', `${WIN_PS_UTF8_PREFIX}${command}`]]
    : [process.env.SHELL || '/bin/bash', ['-c', command]]

  // Same launch-hook gate as svcExecuteCommand above.
  await ensureLaunchHooks()
  return new Promise((resolve) => {
    ensureWorkspaceCwd(cwd)
    const child = spawn(shell, shellArgs, {
      cwd: cwd || getHomeDir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...getHookEnv(), ...(isWin ? WIN_UTF8_ENV : {}) },
      windowsHide: true,
      timeout: 0  // Timeout managed by idle timer below
    })

    let output = ''
    const outDecoder = createStreamDecoder()
    const errDecoder = createStreamDecoder()
    // Output cap (P0-2 #4b): this path used to be a bare `output += text` with
    // no OUTPUT_LIMIT check, so a chatty command accumulated memory without
    // bound. Same 1MB behavior as svcExecuteCommand: slice, kill, say so.
    let outputCapped = false
    const flushDecoders = (): void => {
      if (outputCapped) return
      output += outDecoder.flush() + errDecoder.flush()
    }
    const appendOutput = (text: string): void => {
      if (!text || outputCapped) return
      output += text
      if (output.length > OUTPUT_LIMIT) {
        output = output.slice(0, OUTPUT_LIMIT)
        output += '\n[Output limit exceeded: 1MB]'
        outputCapped = true
        killProcess({ process: child } as ProcessEntry, true)
      }
    }

    // Idle timeout — resets on every stdout/stderr data event
    const effectiveTimeout = (timeoutMs != null && timeoutMs > 0) ? timeoutMs : DEFAULT_TIMEOUT
    let idleTimer: NodeJS.Timeout | null = null

    function resetIdleTimer(): void {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        killProcess({ process: child } as ProcessEntry)
        flushDecoders()
        output += idleTimeoutNotice(effectiveTimeout)
        resolve({ output, code: null })
      }, effectiveTimeout)
    }

    // Wall-clock cap — same absolute semantics as svcExecuteCommand above.
    const wallTimer: NodeJS.Timeout = setTimeout(() => {
      if (idleTimer) clearTimeout(idleTimer)
      killProcess({ process: child } as ProcessEntry, true)
      flushDecoders()
      output += `\n[Command exceeded the ${WALL_CLOCK_MAX_MS / 1000}s wall-clock limit (total duration)]`
      resolve({ output, code: null })
    }, WALL_CLOCK_MAX_MS)

    resetIdleTimer()

    child.stdout?.on('data', (chunk: Buffer) => {
      resetIdleTimer()
      appendOutput(outDecoder.push(chunk))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      resetIdleTimer()
      appendOutput(errDecoder.push(chunk))
    })
    child.on('error', () => {
      if (idleTimer) clearTimeout(idleTimer)
      clearTimeout(wallTimer)
      flushDecoders()
      resolve({ output, code: null })
    })
    child.on('exit', (code) => {
      if (idleTimer) clearTimeout(idleTimer)
      clearTimeout(wallTimer)
      flushDecoders()
      resolve({ output, code })
    })
  })
}

// ── Background process mode (PLAN-coding-contract P0-3) ──────────────────────
//
// `exec background:true` settles its tool result IMMEDIATELY with the OS pid;
// output streams to tmp/proc-logs/<pid>.log instead of any subscriber, and the
// model polls with exec_logs(pid) / reaps with exec_kill(pid). Three contracts
// matter here:
//  - The log lives under ~/.pulsemind — a read DENY root for the agent — so the
//    only door is the pid-keyed exec_logs channel (payload fact #8): never hand
//    the model a path, and never widen the deny roots to make one readable.
//  - The disk log carries its own size cap (~8MB): the renderer-side 1MB limit
//    governs in-memory strings only, and a dev server inside a TTL window can
//    write far more than that.
//  - On exit the log tail gains `[exited code=N]`: the tool result already
//    settled, so no tool_status event will ever fire. Since 2026-10-28 the exit
//    moment ALSO pushes a wake-up notice to the owning session's engine
//    (notifySessionBackgroundExit → session-manager → engine queue → the next
//    request's state block) — the model no longer has to remember to poll;
//    exec_logs stays the full-output discovery channel.

/** Append-only background log handle: content stops at the cap (with a marker
 *  line), while the exit line below still lands — it is the death signal. */
interface ProcLog {
  write(text: string): void
  writeExitLine(code: number | null): void
  close(): void
}

function openProcLog(pid: number): ProcLog {
  let stream: WriteStream
  try {
    mkdirSync(PROC_LOG_DIR, { recursive: true })
    stream = createWriteStream(join(PROC_LOG_DIR, `${pid}.log`), { flags: 'a' })
  } catch {
    // An unwritable log must not lose the process — output is just dropped.
    return { write: () => {}, writeExitLine: () => {}, close: () => {} }
  }
  let bytes = 0
  let capped = false
  const write = (text: string): void => {
    if (!text || capped) return
    bytes += Buffer.byteLength(text)
    stream.write(text)
    if (bytes >= PROC_LOG_MAX_BYTES) {
      capped = true
      stream.write(`\n[log truncated at ${PROC_LOG_MAX_BYTES} bytes — process still running, output no longer recorded]`)
    }
  }
  return {
    write,
    writeExitLine: (code) => {
      stream.write(`\n[exited code=${code ?? 'null'}]\n`)
      stream.end()
    },
    close: () => stream.end(),
  }
}

/** Spawn a command that outlives the turn. Resolves as soon as the process is
 *  UP — no timers, no idle/wall-clock kills (P0-3 #13): longevity is the point.
 *  The pid registers in the session's backgroundPids (exec_logs/exec_kill only
 *  answer for those) and is deliberately NOT reported to the engine's
 *  executingProcessId, whose five kill-on-cleanup sites must never reap it.
 *
 *  A cwd-less call starts where the engine's persistent shell currently is
 *  (`shellKey` = the engine's conversationId): the model's earlier `cd` moved
 *  the foreground, and a dev server launched right after must not land back in
 *  the workspace root. Falls through to the workspace when no shell has run. */
export async function svcExecuteBackground(command: string, cwd?: string, shellKey?: string): Promise<{ pid: number; processId: string }> {
  await ensureLaunchHooks()
  const isWin = process.platform === 'win32'
  // Shell selection (PLAN-tool-issues Z1-r, 2026-10-28): this path runs
  // TOOL-written commands only (main-host executeBackground; the user's
  // terminal never gets here), so it uses the same agent-side binary as the
  // persistent shell. $SHELL here was the last zsh exposure — a background
  // `grep --include=*.ts` died on zsh's nomatch after the same command passed
  // in the foreground (~96 historical failures, 46 on 10-10 alone).
  const [shell, shellArgs] = isWin
    ? ['powershell.exe', ['-NoProfile', '-Command', `${WIN_PS_UTF8_PREFIX}${command}`]]
    : [PERSISTENT_SHELL_BIN, ['-c', command]]

  const sandboxCtx = currentSessionSandbox()
  const effectiveCwd = cwd || persistentShellCwd(sandboxCtx, shellKey) || sandboxCtx?.workspaceDir || getHomeDir()
  ensureWorkspaceCwd(effectiveCwd)
  if (sandboxCtx) {
    auditStore.record({ scope: 'project', actor: sandboxCtx.sessionId, action: 'exec', target: `[background] ${command.slice(0, 150)}`, decision: 'allowed' })
  }

  const child = spawn(shell, shellArgs, {
    cwd: effectiveCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...getHookEnv(), ...(isWin ? WIN_UTF8_ENV : {}) },
    windowsHide: true,
  })

  const processId = randomUUID()
  const pid = child.pid ?? -1
  const entry: ProcessEntry = { process: child, command, createdAt: Date.now(), stdout: '', stderr: '', osPid: pid, background: true }
  processes.set(processId, entry)
  if (pid > 0) {
    backgroundByPid.set(pid, entry)
    sandboxCtx?.backgroundPids.add(pid)
  }
  const log = openProcLog(pid)
  log.write(`$ ${command}\n`)

  const outDecoder = createStreamDecoder()
  const errDecoder = createStreamDecoder()
  child.stdout?.on('data', (chunk: Buffer) => log.write(outDecoder.push(chunk)))
  child.stderr?.on('data', (chunk: Buffer) => log.write(errDecoder.push(chunk)))
  child.on('error', (err) => {
    log.write(`\n[spawn error: ${err.message}]`)
    log.writeExitLine(null)
    processes.delete(processId)
    if (pid > 0) backgroundByPid.delete(pid)
    if (sandboxCtx) notifySessionBackgroundExit(sandboxCtx.sessionId, pid, null)
  })
  child.on('exit', (code) => {
    log.write(outDecoder.flush())
    log.write(errDecoder.flush())
    log.writeExitLine(code)
    processes.delete(processId)
    if (pid > 0) backgroundByPid.delete(pid)
    // 唤醒（2026-10-28）：the old contract made exec_logs the death-discovery
    // channel and the MODEL had to remember to poll — a finished build sat
    // invisible until the next unrelated turn. The exit moment is the one
    // point main knows (pid, code, owning session); the engine renders the
    // undelivered notices into its next request's state block (one-shot,
    // cache-tail-safe) so the model sees the completion without remembering.
    if (sandboxCtx) notifySessionBackgroundExit(sandboxCtx.sessionId, pid, code)
  })

  return { pid, processId }
}

/** Tail a background process's log — authorized ONLY for pids this session
 *  spawned (pid is an OS-global namespace; without the check exec_logs would be
 *  a global log reader and sessions could read each other's output). Returns
 *  null for a pid that is not ours; an own pid whose log does not exist yet is
 *  an empty-output success, not a miss. */
export function svcExecLogs(pid: number, tailBytes?: number): string | null {
  const ctx = currentSessionSandbox()
  if (!ctx || !ctx.backgroundPids.has(pid)) return null
  const want = Math.max(1, Math.min(tailBytes ?? PROC_LOG_DEFAULT_TAIL, PROC_LOG_MAX_TAIL))
  const logPath = join(PROC_LOG_DIR, `${pid}.log`)
  let size: number
  try {
    size = statSync(logPath).size
  } catch {
    return '' // authorized, nothing written yet
  }
  const start = Math.max(0, size - want)
  const length = size - start
  const buffer = Buffer.alloc(length)
  try {
    const fd = openSync(logPath, 'r')
    try {
      const read = readSync(fd, buffer, 0, length, start)
      return buffer.toString('utf8', 0, read)
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/** Kill one background process by pid — same session-scoped authorization as
 *  svcExecLogs. Returns false for a pid that is not ours or already exited. */
export function svcExecKill(pid: number): boolean {
  const ctx = currentSessionSandbox()
  if (!ctx || !ctx.backgroundPids.has(pid)) return false
  const entry = backgroundByPid.get(pid)
  if (!entry) return false
  killProcess(entry)
  setTimeout(() => killProcess(entry, true), 3000)
  return true
}

/** Session teardown: the engine's scalar cleanup never knew about these — reap
 *  them explicitly when the session is disposed (plan #16: only an explicit
 *  kill or the session end may collect a background process). */
export function svcReapBackgroundPids(pids: Iterable<number>): void {
  for (const pid of pids) {
    const entry = backgroundByPid.get(pid)
    if (!entry) continue
    killProcess(entry)
    setTimeout(() => killProcess(entry, true), 3000)
    backgroundByPid.delete(pid)
  }
}
