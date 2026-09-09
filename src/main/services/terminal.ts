/**
 * Terminal service (PLAN-0.3.5 M1.4①): process spawning/streaming previously
 * inlined in terminal.handler.ts. The service layer is transport-agnostic —
 * callers supply an `emit` sink; the IPC handler bridges that to webContents,
 * the main-process agent host bridges it to registered listeners.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { getHookEnv } from '../hooks-runner'

interface ProcessEntry {
  process: ChildProcess
  command: string
  createdAt: number
  stdout: string
  stderr: string
}

const processes = new Map<string, ProcessEntry>()

const OUTPUT_LIMIT = 1024 * 1024 // 1MB max output per process
const DEFAULT_TIMEOUT = 60_000 // 60s

// --- Windows PowerShell output encoding ---
// PowerShell 5.1 writes piped output using [Console]::OutputEncoding, whose
// default is unreliable in a hidden no-console child (CREATE_NO_WINDOW): it can
// be the OEM codepage (GBK on Chinese systems) even when chcp reports 65001,
// and modern tools (git, node) emit UTF-8 regardless. Guessing the codepage
// misdecodes in both directions, so instead we force UTF-8 in the child and
// decode the pipe as UTF-8.
const WIN_PS_UTF8_PREFIX = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; '

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

export interface TerminalEmitSink {
  output(processId: string, type: 'stdout' | 'stderr', data: string): void
  exit(processId: string, code: number | null, signal: string | null): void
  error(processId: string, message: string): void
}

/** Spawn a streaming command. Returns the processId; output arrives via `emit`. */
export function svcExecuteCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs: number | undefined,
  emit: TerminalEmitSink,
): string {
  const processId = randomUUID()

  // Use powershell.exe on Windows (has Unix aliases: ls, cat, pwd, cp, mv, rm);
  // /bin/bash on Unix/macOS.
  const isWin = process.platform === 'win32'
  const [shell, shellArgs] = isWin
    ? ['powershell.exe', ['-NoProfile', '-Command', `${WIN_PS_UTF8_PREFIX}${command}`]]
    : [process.env.SHELL || '/bin/bash', ['-c', command]]

  const child = spawn(shell, shellArgs, {
    cwd: cwd || getHomeDir(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...getHookEnv() },
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

  // Idle timeout — resets on every stdout/stderr data event.
  // Only kills the process if no output is received for the duration.
  const effectiveTimeout = (timeoutMs != null && timeoutMs > 0) ? timeoutMs : DEFAULT_TIMEOUT
  let idleTimer: NodeJS.Timeout | null = null

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (!child.killed) {
        killProcess(entry)
        emit.output(processId, 'stderr', `\n[Command timed out after ${effectiveTimeout / 1000}s with no output]`)
        emit.exit(processId, null, 'SIGTERM')
        processes.delete(processId)
      }
    }, effectiveTimeout)
  }

  resetIdleTimer()

  // stdout
  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      resetIdleTimer()
      const text = chunk.toString('utf-8')
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
      const text = chunk.toString('utf-8')
      entry.stderr += text
      emit.output(processId, 'stderr', text)
    })
  }

  // Exit
  child.on('exit', (code, signal) => {
    if (idleTimer) clearTimeout(idleTimer)
    processes.delete(processId)
    emit.exit(processId, code, signal)
  })

  // Error (if process can't be spawned at all)
  child.on('error', (err) => {
    if (idleTimer) clearTimeout(idleTimer)
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
export function svcExecSync(command: string, cwd?: string, timeoutMs?: number): Promise<{ output: string; code: number | null }> {
  const isWin = process.platform === 'win32'
  const [shell, shellArgs] = isWin
    ? ['powershell.exe', ['-NoProfile', '-Command', `${WIN_PS_UTF8_PREFIX}${command}`]]
    : [process.env.SHELL || '/bin/bash', ['-c', command]]

  return new Promise((resolve) => {
    const child = spawn(shell, shellArgs, {
      cwd: cwd || getHomeDir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...getHookEnv() },
      windowsHide: true,
      timeout: 0  // Timeout managed by idle timer below
    })

    let output = ''

    // Idle timeout — resets on every stdout/stderr data event
    const effectiveTimeout = (timeoutMs != null && timeoutMs > 0) ? timeoutMs : DEFAULT_TIMEOUT
    let idleTimer: NodeJS.Timeout | null = null

    function resetIdleTimer(): void {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        killProcess({ process: child } as ProcessEntry)
        output += `\n[Command timed out after ${effectiveTimeout / 1000}s with no output]`
        resolve({ output, code: null })
      }, effectiveTimeout)
    }

    resetIdleTimer()

    child.stdout?.on('data', (chunk: Buffer) => {
      resetIdleTimer()
      output += chunk.toString('utf-8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      resetIdleTimer()
      output += chunk.toString('utf-8')
    })
    child.on('error', () => {
      if (idleTimer) clearTimeout(idleTimer)
      resolve({ output, code: null })
    })
    child.on('exit', (code) => {
      if (idleTimer) clearTimeout(idleTimer)
      resolve({ output, code })
    })
  })
}
