// ── Session exec allowlist keys (PLAN-coding-contract #6) ──
//
// The approval area's 「本会话总是允许」 stores a STABLE PREFIX of a shell
// command in the session context; `requiresApproval` then lets matching
// commands through without a click. This module owns everything about those
// keys that must behave identically in the engine (matching) and in the UI
// (deciding whether the button can be shown at all) — pure string logic, no
// host, no DOM.
//
// The matching rule is TOKEN-BOUNDARY, not string-prefix: `npm test` must hit
// `npm test -- --watch` (appended args are the same command) and must NOT hit
// `npm test:ci` (a different script whose content the user never approved).
// A string `startsWith` would happily pass the second one.

/** Shell operators that make a command non-allowlistable: a stored prefix in
 *  front of a `&&`/`;`/`|` chain or a redirect would approve arbitrary second
 *  halves, i.e. the allowlist would degenerate into allow-everything. Detected
 *  OUTSIDE quotes only — `npm run -- --filter="a|b"` is one command. */
export function hasShellOperators(command: string): boolean {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (inSingle || inDouble) continue
    if (c === '\n') return true
    if (c === ';' || c === '&' || c === '|' || c === '>' || c === '<' || c === '`') return true
    if (c === '$' && command[i + 1] === '(') return true
  }
  return false
}

/** The token sequence a command starts with, after normalization: whitespace
 *  folded, leading `VAR=value` env assignments skipped (`FOO=1 npm test` is the
 *  same command as `npm test` for approval purposes). */
export function commandTokens(command: string): string[] {
  const raw = command.trim().split(/\s+/).filter(Boolean)
  let i = 0
  while (i < raw.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[i])) i++
  return raw.slice(i)
}

/** Package managers where the subcommand needs one extra token (`npm run build`):
 *  the key keeps `run` + the script name, so an entry never degenerates to
 *  `npm run` (= every script). */
const RUN_SUBCOMMANDS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pnpm.exe', 'npm.cmd', 'yarn.cmd'])

/**
 * The canonical allowlist key for a command, or null when none can be computed
 * (operator chains, empty command). First token + subcommand — `npm test`,
 * `npm run build`, `git status`, bare `pytest` — token-joined with single
 * spaces so keys round-trip through the session set.
 *
 * The subcommand slot skips leading FLAGS (`pytest -q` keys as `pytest`, so a
 * later bare `pytest` matches; `git status --porcelain` keys as `git status`),
 * and the run-style package managers extend one slot further so an entry never
 * degenerates to `npm run` (= every script).
 */
export function commandAllowlistKey(command: string): string | null {
  if (hasShellOperators(command)) return null
  const tokens = commandTokens(command)
  if (tokens.length === 0) return null
  let depth = 1
  if (tokens.length > 1 && !tokens[1].startsWith('-')) depth = 2
  if (RUN_SUBCOMMANDS.has(tokens[0]) && tokens[1] === 'run') {
    depth = tokens.length > 2 && !tokens[2].startsWith('-') ? 3 : 2
  }
  return tokens.slice(0, depth).join(' ')
}

/** Whether `command` starts with any stored entry, token-wise. The entry is
 *  itself a key (1–3 tokens), so comparison walks the entry's tokens against
 *  the command's: appended args match, a longer token in the same position
 *  (`test:ci` vs `test`) does not. A command carrying operators never matches —
 *  an approved prefix must not ride past a `&&`/`;` chain it was never
 *  approved with (the write side refuses them; this is the matching side of
 *  the same rule). */
export function commandMatchesAllowlist(command: string, entries: Iterable<string>): boolean {
  if (hasShellOperators(command)) return false
  const tokens = commandTokens(command)
  if (tokens.length === 0) return false
  for (const entry of entries) {
    const entryTokens = entry.trim().split(/\s+/).filter(Boolean)
    if (entryTokens.length === 0 || entryTokens.length > tokens.length) continue
    let hit = true
    for (let i = 0; i < entryTokens.length; i++) {
      if (tokens[i] !== entryTokens[i]) { hit = false; break }
    }
    if (hit) return true
  }
  return false
}
