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
import { ensureLaunchHooks, getHookEnv } from '../hooks-runner'
import { currentSessionSandbox } from '../sandbox/session-context'
import { isSubpath } from '../../shared/sandbox/path-jail'
import { auditStore } from '../storage/audit-store'
import { DATA_DIR } from '../storage/index'
import { createStreamDecoder } from './stream-decoder'

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

/** Spawn a streaming command. Returns the processId; output arrives via `emit`.
 *  Async only to gate the spawn on the launch hooks (both callers — the IPC
 *  handler and the main-process agent host — already await). */
export async function svcExecuteCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs: number | undefined,
  emit: TerminalEmitSink,
): Promise<string> {
  // Launch hooks may still be running when the first command arrives (they no
  // longer block window creation) — their env (hookEnv + login-shell PATH)
  // must be in place before the first subprocess spawns.
  await ensureLaunchHooks()
  const processId = randomUUID()

  // Use powershell.exe on Windows (has Unix aliases: ls, cat, pwd, cp, mv, rm);
  // /bin/bash on Unix/macOS.
  const isWin = process.platform === 'win32'
  const [shell, shellArgs] = isWin
    ? ['powershell.exe', ['-NoProfile', '-Command', `${WIN_PS_UTF8_PREFIX}${command}`]]
    : [process.env.SHELL || '/bin/bash', ['-c', command]]

  // Agent sessions confine the default cwd to the workspace; approval + audit
  // are the controls (the former OS-level hard isolation is gone with projects).
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
        emit.output(processId, 'stderr', `\n[Command timed out after ${effectiveTimeout / 1000}s with no output]`)
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
        entry.stdout = entry.stdout.slice(0, OUTPUT_LIMIT)
        killProcess(entry)
        emit.output(processId, 'stderr', '\n[Output limit exceeded: 1MB]')
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

/** Kill a running process by id (escalates to force-kill after 3s). */
export function svcKillCommand(processId: string): void {
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
        output += `\n[Command timed out after ${effectiveTimeout / 1000}s with no output]`
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
//    settled, so no tool_status event will ever fire — exec_logs doubles as the
//    death-discovery channel (no exit push in v1).

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
 *  executingProcessId, whose five kill-on-cleanup sites must never reap it. */
export async function svcExecuteBackground(command: string, cwd?: string): Promise<{ pid: number; processId: string }> {
  await ensureLaunchHooks()
  const isWin = process.platform === 'win32'
  const [shell, shellArgs] = isWin
    ? ['powershell.exe', ['-NoProfile', '-Command', `${WIN_PS_UTF8_PREFIX}${command}`]]
    : [process.env.SHELL || '/bin/bash', ['-c', command]]

  const sandboxCtx = currentSessionSandbox()
  const effectiveCwd = cwd || sandboxCtx?.workspaceDir || getHomeDir()
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
  })
  child.on('exit', (code) => {
    log.write(outDecoder.flush())
    log.write(errDecoder.flush())
    log.writeExitLine(code)
    processes.delete(processId)
    if (pid > 0) backgroundByPid.delete(pid)
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
