/**
 * Persistent-shell wire protocol (review P0-1, 2026-10-28) — the pure half of
 * terminal.ts's per-engine shell, kept free of every main-process import so
 * vitest can pin it directly (terminal.ts drags in the SQLite audit store,
 * which plain Node cannot load).
 *
 * One command on the wire:
 *
 *     cd '<cwd>' && {            (the `cd … &&` prefix only when the call names a cwd)
 *     {                          (otherwise the group opens here)
 *     <command>
 *     } </dev/null
 *     __pm_code=$?; printf '__PM_DONE_<id>__ %d %s\n' '<id>' "$__pm_code" "$PWD" >&3
 *
 *   - The brace group is NOT a subshell, so cd/export/source inside the
 *     command persist in the shell — the whole point.
 *   - `</dev/null` on the group pins the command's stdin: without it `cat`, a
 *     REPL or `read` would consume the NEXT command line off the channel.
 *   - `cd … &&` makes a bad cwd abort the command (exit 1, cd's error on
 *     stderr) instead of silently running it in the wrong directory — the
 *     same "it did not run" outcome the per-command spawn had (ENOENT).
 *   - The sentinel goes to fd 3, the control channel, never to stdout: output
 *     streams raw and byte-exact, and nothing the command prints can forge a
 *     completion. $PWD rides along so the service always knows where the shell
 *     is (rebuild after a kill resumes there).
 */

export const PERSISTENT_SENTINEL_PREFIX = '__PM_DONE_'

/** POSIX single-quote: the only quoting that survives every byte, including
 *  `$`, backticks and whitespace; an embedded ' becomes '\'' . */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function persistentCommandScript(command: string, id: string, cwd?: string): string {
  const lines: string[] = []
  lines.push(cwd ? `cd ${shellSingleQuote(cwd)} && {` : '{')
  lines.push(command)
  lines.push('} </dev/null')
  lines.push(`__pm_code=$?; printf '${PERSISTENT_SENTINEL_PREFIX}%s__ %d %s\\n' ${shellSingleQuote(id)} "$__pm_code" "$PWD" >&3`)
  return lines.join('\n') + '\n'
}

const CONTROL_LINE_RE = new RegExp(`^${PERSISTENT_SENTINEL_PREFIX}([0-9a-fA-F-]+)__ (-?\\d+) (.*)$`)

export interface ControlLine {
  id: string
  code: number
  cwd: string
}

/** One fd-3 line → completion record, or null for anything else (a command
 *  that writes to fd 3 itself can only produce noise here, never a false
 *  completion for OUR id). */
export function parseControlLine(line: string): ControlLine | null {
  const m = CONTROL_LINE_RE.exec(line)
  if (!m) return null
  return { id: m[1], code: Number(m[2]), cwd: m[3] }
}

/** Routing predicate for svcExecuteCommand. Persistent only for agent sessions
 *  (the renderer IPC terminal has no session and must not share agent state),
 *  only off Windows (stdin-driven PowerShell has no fd-3 analog — it keeps the
 *  per-command spawn), and only while the runtime kill switch is not set. */
export function usesPersistentShell(platform: string, hasSession: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return hasSession && platform !== 'win32' && env.PM_PERSISTENT_SHELL !== '0'
}

/** Shell identity: session + the engine's conversationId. A parent and its
 *  parallel sub-agents share one session context (the sub-loop's ALS scope is
 *  the parent's) but must not share a shell — one agent's cd would move the
 *  others, and their execs would serialize. No conversationId → the session. */
export function persistentShellKey(sessionId: string, shellKey?: string): string {
  return shellKey ? `${sessionId}::${shellKey}` : sessionId
}

export function isSessionShellKey(key: string, sessionId: string): boolean {
  return key === sessionId || key.startsWith(`${sessionId}::`)
}

/** Appended to the dying command's stderr whenever the shell goes down with a
 *  command in flight (timeout, cap, kill, `exit`, crash). The next command
 *  rebuilds silently at the last-known cwd; only env is lost, so say exactly
 *  that. `code` is the shell's own exit status when it left on its own. */
export function persistentRestartNotice(code?: number | null): string {
  const why = code === undefined ? 'was restarted' : `exited (code=${code ?? 'null'}) and restarts for the next command`
  return `\n[The session shell ${why}: the working directory is kept, but variables exported by earlier commands are gone]`
}
