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
 *  `npm run` (= every script). Matched through baseCommandName, so the
 *  `.exe`/`.cmd`/`.bat` spellings collapse into one set. */
const RUN_SUBCOMMANDS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

/** Interpreters and shells (basename, extension stripped, lowercased): every
 *  argument after one is a program to execute, so NO prefix of such a command
 *  narrows anything — a stored `node` (approved as `node -e "console.log(1)"`
 *  or even `node --version`) would exempt `node evil.js`. Commands headed by
 *  one get no key: one-shot approval only. */
const INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'ksh', 'dash', 'ash', 'csh', 'tcsh', 'fish',
  'cmd', 'powershell', 'pwsh',
  'python', 'python2', 'python3', 'pypy', 'pypy3', 'ipython',
  'node', 'nodejs', 'deno', 'tsx', 'ts-node',
  'perl', 'ruby', 'irb', 'rscript', 'julia', 'lua', 'luajit', 'php', 'tclsh',
  'osascript', 'awk', 'gawk', 'expect',
])

/** Versioned interpreter binaries (`python3.12`, `php8.2`, `lua5.4`): the stem
 *  check keeps the set from chasing release numbers. */
const INTERPRETER_STEMS = ['python', 'pypy', 'lua', 'php']

/** Bare flags whose argument IS the program (`node -e`, `powershell -Command`,
 *  `zsh -lc`, `cmd /c`): with one in the second slot the payload is the command
 *  itself, so no prefix is safe — whatever binary heads the line. */
const EVAL_FLAGS = new Set(['-c', '-e', '--eval', '-lc', '-Command', '-command', '/c', '/k'])

/** Package runners that fetch and execute an arbitrary package (`npx tsc`,
 *  `npm exec -- tsc`, `pnpm dlx prettier`, `bun x vitest`): the key must pin
 *  the package, never the runner alone — an entry of bare `npm exec` would
 *  exempt `npm exec -- curl evil.sh` (npm exec downloads and runs any package). */
const PACKAGE_RUNNERS = new Set(['npx', 'bunx'])
const PACKAGE_RUN_SUBCOMMANDS = new Set(['exec', 'dlx', 'x'])

/** Wrappers whose tail is a PROGRAM to execute (`env FOO=1 bash -c …`,
 *  `sudo bash -c …` — the exact shape the command builder's own `sudo:true`
 *  produces on Linux — `timeout 10 curl …`, `corepack pnpm dlx …`): whatever
 *  sits behind the wrapper re-binds what runs, so no prefix of the line
 *  narrows anything. Keying them as wrapper + first tail token (`env bash`,
 *  `sudo bash`, `timeout 10`) meant one approval exempted the wrapper family
 *  whole — quote-shielded payloads included (review_20260929 高1). */
const WRAPPER_PREFIXES = new Set(['env', 'sudo', 'nohup', 'nice', 'stdbuf', 'timeout', 'command', 'xargs', 'corepack'])

function baseCommandName(token: string): string {
  const last = token.split(/[\\/]/).pop() ?? token
  return last.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
}

function isInterpreter(token: string): boolean {
  const name = baseCommandName(token)
  return INTERPRETERS.has(name) || INTERPRETER_STEMS.some(stem => name.startsWith(stem))
}

/**
 * The canonical allowlist key for a command, or null when none can be computed
 * (operator chains, empty command, or a command family where no prefix is
 * safe — see below). First token + subcommand — `npm test`, `npm run build`,
 * `git status`, bare `pytest` — token-joined with single spaces so keys
 * round-trip through the session set.
 *
 * The subcommand slot skips leading FLAGS (`pytest -q` keys as `pytest`, so a
 * later bare `pytest` matches; `git status --porcelain` keys as `git status`)
 * and the run-style package managers extend one slot further so an entry never
 * degenerates to `npm run` (= every script).
 *
 * Three families return null — the command can only ever be approved ONE AT A
 * TIME, because a stored prefix of them exempts arbitrary code:
 * - interpreters/shells (`bash -c "…"`, `node evil.js`, `powershell -Command`):
 *   every later argument is a program, so even the bare binary is the whole
 *   family (review_20260928 高2);
 * - any command whose second token is an eval flag (`-c`/`-e`/`-Command`/…):
 *   the payload IS the command;
 * - wrapper-prefixed lines (`env bash -c …`, `sudo bash -c …`, `timeout 10 …`)
 *   and any line whose second token is an interpreter: the wrapper or the head
 *   binary re-binds what the tail runs, so the interpreter/eval-flag defense
 *   cannot sit on fixed slots (review_20260929 高1);
 * - package runners, unless the key pins the package (`npm exec tsc`, never
 *   bare `npm exec`; flags before the package are one-shot).
 */
export function commandAllowlistKey(command: string): string | null {
  if (hasShellOperators(command)) return null
  const tokens = commandTokens(command)
  if (tokens.length === 0) return null
  if (RUN_SUBCOMMANDS.has(baseCommandName(tokens[0]))) {
    // The runner itself is a meta-executor: the key must pin a subcommand (and
    // for `run`, the script). Flags in the second slot configure the runner
    // (`npm --prefix ./app test`) — pinning nothing there would exempt the
    // whole runner, so those are one-shot too.
    if (tokens.length === 1 || tokens[1].startsWith('-')) return null
    if (PACKAGE_RUN_SUBCOMMANDS.has(tokens[1])) {
      // `npm exec [--] <pkg>` / `pnpm dlx <pkg>` / `bun x <pkg>` — the package
      // is what makes the entry narrow.
      const pkg = tokens[2] === '--' ? tokens[3] : tokens[2]
      return pkg && !pkg.startsWith('-') ? `${tokens[0]} ${tokens[1]} ${pkg}` : null
    }
    if (tokens[1] === 'run') {
      return tokens.length > 2 && !tokens[2].startsWith('-') ? tokens.slice(0, 3).join(' ') : null
    }
    return `${tokens[0]} ${tokens[1]}`
  }
  if (PACKAGE_RUNNERS.has(baseCommandName(tokens[0]))) {
    return tokens.length > 1 && !tokens[1].startsWith('-') ? `${tokens[0]} ${tokens[1]}` : null
  }
  if (WRAPPER_PREFIXES.has(baseCommandName(tokens[0]))) return null
  if (tokens.length > 1 && EVAL_FLAGS.has(tokens[1])) return null
  if (isInterpreter(tokens[0]) || (tokens.length > 1 && isInterpreter(tokens[1]))) return null
  let depth = 1
  if (tokens.length > 1 && !tokens[1].startsWith('-')) depth = 2
  return tokens.slice(0, depth).join(' ')
}

/** Whether `command` is approved by any stored entry. Both sides go through
 *  the SAME key function (review_20260929 中1): the stored entry IS a key, so
 *  comparing it against the candidate's own key is one normalization applied
 *  to both ends — `npm exec -- tsc` and `npm exec tsc` share the key
 *  `npm exec tsc`, while the old token-wise compare failed the stored entry
 *  against the exact command the user had just approved. A command the key
 *  function refuses (interpreter/wrapper-headed, operators) matches nothing —
 *  one-shot approval, the matching-side half of the wrapper fix: an entry an
 *  older version stored (`env bash`) can no longer be ridden by any command.
 *  Appended arguments still hit: the candidate's key collapses them
 *  (`npm test -- --watch` keys as `npm test`), while a longer token in a
 *  keyed slot (`test:ci` vs `test`) keys differently — the token boundary
 *  lives inside the key function now, single-sourced. */
export function commandMatchesAllowlist(command: string, entries: Iterable<string>): boolean {
  if (hasShellOperators(command)) return false
  const key = commandAllowlistKey(command)
  if (key === null) return false
  for (const entry of entries) {
    if (commandAllowlistKey(entry) === key) return true
  }
  return false
}
