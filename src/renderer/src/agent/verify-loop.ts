/**
 * The verify loop (2026-10-27, the 验证闭环 batch): the wiring that closes the
 * gap between "edit succeeded" and "the change works" for models that will not
 * run verification unprompted. Three pieces share this module because they read
 * the same facts about the workspace:
 *
 *  1. Verify-command detection — manifests at the workspace root name the
 *     commands the project ALREADY defines for building/testing/linting. The
 *     state block renders them as a `## Verify` line and the soft gate cites
 *     them, so the model never has to invent one (ENGINEERING_WORKFLOW #2's
 *     「never invent one」 made concrete). Detection probes at most five small
 *     manifest files and is TTL-cached per workspace: buildStateBlock runs on
 *     EVERY tool-loop iteration, so an uncached read here would multiply by the
 *     iteration count exactly like the git precheck that got deleted.
 *  2. The source-edit streak — the soft gate's counter. Writes/edits to
 *     source-code files arm it; a completed exec that looks like verification
 *     resets it. Deliberately a HINT, never a rejection (the 2026-10-27 soft
 *     gate shape: a legit flow must not be blocked).
 *  3. Test-output summary — a head line for exec results whose stdout matches
 *     a known test-runner format, surfacing the failure count and the first
 *     failing location. Pure transform: additive only, the raw output stays.
 *  4. Failure locations (PLAN-project-ide 刀一, 2026-10-31) — the verify
 *     panel's clickable anchors, the UI-side twin of item 3 sharing its
 *     honesty bar. Detection is reused wholesale: the panel and the model read
 *     the same cache, so they can never disagree about what the workspace
 *     defines.
 *
 * Office sessions are the design's blind spot by intent: no manifests in a
 * minted scratch workspace → detection returns [] → the Verify section stays
 * out, the streak disarms on its first check, and nothing in this module ever
 * reaches the model. The office-side nudge lives in the office_edit executor
 * (a spot-check hint), not here — different loop, different tools.
 */
import { getHost } from './host'

// ── 1. Verify-command detection ───────────────────────────────────────────

/** Detection results older than this re-probe. Long enough to amortize a
 *  marathon tool loop (hundreds of iterations share one probe), short enough
 *  that a user adding a package.json mid-session is picked up without a
 *  restart. Negative results (no manifests — the office case) are cached too:
 *  that is the common case and the one worth amortizing hardest. */
export const VERIFY_DETECTION_TTL_MS = 10 * 60_000

/** Cap on the rendered Verify line — a hint, not a menu (MAX_PROJECT_COMMANDS
 *  precedent). The most specific commands are the first detected. */
export const MAX_VERIFY_COMMANDS = 4

/** package.json script names that count as verification. `test` renders as
 *  `npm test` (the built-in alias); scoped variants (`test:unit`) keep their
 *  prefix so they stay runnable as written. */
const VERIFY_SCRIPT_NAME = /^(test|lint|typecheck|type-check|check|build)(:.+)?$/

const verifyCache = new Map<string, { at: number; cmds: string[] }>()

/** Test reset hook — the module cache must not leak a fixture workspace into
 *  the next test (expHintCache's reset precedent). */
export function resetVerifyCommandsCache(): void {
  verifyCache.clear()
}

/** The workspace's own verification commands, detected from its root
 *  manifests. Root ONLY — a nested package.json belongs to a sub-project the
 *  session may not even be jailed into. Order: node → cargo → go → python →
 *  make, capped at MAX_VERIFY_COMMANDS. */
export async function detectVerifyCommands(workspaceDir: string): Promise<string[]> {
  const now = Date.now()
  const hit = verifyCache.get(workspaceDir)
  if (hit && now - hit.at < VERIFY_DETECTION_TTL_MS) return hit.cmds
  const read = async (name: string): Promise<string | null> => {
    try {
      const text = await getHost().readFile(`${workspaceDir}/${name}`)
      return text ?? null
    } catch {
      return null
    }
  }
  const cmds: string[] = []
  const pkg = await read('package.json')
  if (pkg) {
    try {
      const scripts = Object.keys((JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {}).filter((n) => VERIFY_SCRIPT_NAME.test(n))
      // Priority order before the per-source cap: the runners a failing change
      // needs first (test, then lint/typecheck/check) must not lose their slot
      // to a build script that happens to be declared earlier.
      const rank = (n: string): number => (/^test/.test(n) ? 0 : /^(lint|typecheck|type-check|check)/.test(n) ? 1 : 2)
      scripts.sort((a, b) => rank(a) - rank(b))
      for (const name of scripts.slice(0, 3)) {
        cmds.push(name === 'test' ? 'npm test' : `npm run ${name}`)
      }
    } catch {
      /* malformed manifest — skip it, the other probes still run */
    }
  }
  if (cmds.length < MAX_VERIFY_COMMANDS && (await read('Cargo.toml'))) cmds.push('cargo test')
  if (cmds.length < MAX_VERIFY_COMMANDS && (await read('go.mod'))) cmds.push('go test ./...')
  const pyproject = await read('pyproject.toml')
  if (cmds.length < MAX_VERIFY_COMMANDS && pyproject) {
    // A pytest config section is the strong signal; a pytest mention in the
    // TOML body (dependency lists, tool tables) is accepted as a weaker one —
    // worst case the model runs pytest and learns there are no tests.
    if (/\[tool\.pytest[.\]]/.test(pyproject) || /^\s*pytest\b/m.test(pyproject)) cmds.push('pytest')
  }
  const makefile = await read('Makefile')
  if (cmds.length < MAX_VERIFY_COMMANDS && makefile) {
    for (const m of makefile.matchAll(/^(test|check|lint)\s*:/gm)) {
      cmds.push(`make ${m[1]}`)
      if (cmds.length >= MAX_VERIFY_COMMANDS) break
    }
  }
  const out = cmds.slice(0, MAX_VERIFY_COMMANDS)
  verifyCache.set(workspaceDir, { at: now, cmds: out })
  return out
}

// ── 2. The source-edit streak ─────────────────────────────────────────────

/** Consecutive source-file writes/edits after which the streak hint fires
 *  (once per session). Three edits is the smallest shape that reads as "a
 *  change set" rather than a one-off fix. */
export const VERIFY_STREAK_THRESHOLD = 3

/** Extensions that mark a file as code the verify loop applies to. Office
 *  deliverables and notes deliberately do not count — their loop is the
 *  office_edit spot-check hint, and a docx write must never arm this gate. */
const SOURCE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.swift',
  '.scala',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cc',
])

/** Whether a (resolved) path counts toward the verify streak. The app's own
 *  scratch namespace is excluded — throwaway files under .pulsemind/tmp are
 *  not the change set the hint is about, whatever their extension. */
export function isSourceFilePath(fp: string): boolean {
  const norm = fp.replace(/\\/g, '/')
  if (norm.includes('/.pulsemind/')) return false
  const dot = norm.lastIndexOf('.')
  if (dot <= norm.lastIndexOf('/')) return false // no extension (the dot sits in a dir name)
  return SOURCE_EXTS.has(norm.slice(dot).toLowerCase())
}

/** Whether a completed exec command counts as having run verification. Kept
 *  GENEROUS on purpose: a false positive here merely resets a counter (the
 *  hint fires a little later than it could have), while a false negative
 *  makes the hint fire after the model DID verify — the one shape that would
 *  teach distrust. Mirrors the detection vocabulary plus the runners the
 *  detection cannot name (jest/vitest invoked directly, gradle/mvn). */
export function isVerifyExecCommand(command: string): boolean {
  return /(?:^|[\s&|;(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|type-check|check|build)\b|npm\s+test\b|vitest|jest\b|pytest|go\s+test|cargo\s+(?:test|clippy|check)|ruff\b|eslint|mypy|\bmake\s+(?:test|check|lint)\b|gradlew?\s+test|mvn\s+test|tsc\b/.test(
    command,
  )
}

/** The streak hint appended to the triggering tool result. Names the detected
 *  commands so the recovery is one command away — the gate teaches, it does
 *  not scold. */
export function verifyStreakHint(cmds: string[]): string {
  return `(Note: ${VERIFY_STREAK_THRESHOLD}+ source files edited this session with no verification run yet — this workspace defines: ${cmds.map((c) => `\`${c}\``).join(' · ')}. Run the relevant one before claiming the work done.)`
}

/** The office_edit spot-check hint (the loop's office branch): document edits
 *  have no test suite, so verification IS reading the result back. */
export function officeSpotCheckHint(): string {
  return '(Note: document edits applied — before reporting done, spot-check the affected paragraphs/cells/slides with office_read to confirm they landed as intended.)'
}

// ── 3. Test-output summary ────────────────────────────────────────────────

export interface TestSummary {
  /** One head line, e.g. `Tests: 3 failed, 120 passed · first failure: src/a.test.ts:42`. */
  line: string
}

/** Parse a test runner's stdout into a one-line summary. Returns null unless
 *  the output confidently matches a KNOWN format — the confidence bar is a
 *  count line (or Go's FAIL marker), not a loose keyword, because a false
 *  match prints a lying header over real output. Additive only: the caller
 *  keeps stdout verbatim behind the summary.
 *
 *  Location anchors are format-honest: go prints `file:line` inside its first
 *  `--- FAIL:` block (searched only there, so later pass noise cannot win);
 *  vitest/jest/pytest FAIL lines name only the FILE (vitest chains the suite
 *  after ` > `, pytest appends `::test - msg`), so the file is the anchor — a
 *  real one, never an invented line number. */
export function summarizeTestOutput(stdout: string): TestSummary | null {
  if (!stdout) return null
  const s = stdout.slice(0, 200_000) // bound the scan; runner headers live in the first screenfuls
  const failFile = (): string | null => {
    const fail = s.match(/^[ \t]*(?:FAIL|FAILED)\s+(.+)$/m)
    if (!fail) return null
    const file = fail[1]
      .trim()
      .split(/\s+>\s+|\s+-\s+|::/)[0]
      .trim()
    return file && !/\s/.test(file) ? file : null
  }
  const goFirstFailure = (): string | null => {
    const fail = s.match(/^--- FAIL:\s+(\S+)/m)
    if (!fail) return null
    const start = s.indexOf(fail[0])
    const loc = s.slice(start, start + 2000).match(/\n\s+(\S+\.go):(\d+)/)
    return loc ? `${loc[1]}:${loc[2]}` : fail[1]
  }
  const failureLine = (counts: string, loc: string | null): TestSummary => ({ line: `Tests: ${counts}${loc ? ` · first failure: ${loc}` : ''}` })
  const failed = (f: number, p: number | null, loc: string | null): TestSummary => failureLine(p === null ? `${f} failed` : `${f} failed, ${p} passed`, loc)
  const passed = (n: number): TestSummary => ({ line: `Tests: ${n} passed` })

  // vitest: ` Tests  3 failed | 120 passed | 5 skipped (128)` / green ` Tests  120 passed`
  const vitest = s.match(/^\s*Tests?\s+(\d+)\s+failed\s*\|\s*(\d+)\s+passed/m)
  if (vitest) return failed(Number(vitest[1]), Number(vitest[2]), failFile())
  const vitestGreen = s.match(/^\s*Tests?\s+(\d+)\s+passed/m)
  if (vitestGreen) return passed(Number(vitestGreen[1]))
  // jest: `Tests: 3 failed, 120 passed, 128 total` / green `Tests: 128 passed, 128 total`
  const jest = s.match(/^Tests:\s*(\d+)\s+failed(?:,\s*(\d+)\s+passed)?/m)
  if (jest) return failed(Number(jest[1]), jest[2] !== undefined ? Number(jest[2]) : null, failFile())
  const jestGreen = s.match(/^Tests:\s*(\d+)\s+passed/m)
  if (jestGreen) return passed(Number(jestGreen[1]))
  // pytest: `3 failed, 120 passed, 2 errors in 1.23s` (also inside the `= … =` banner) / green `120 passed in 0.9s`
  const pytest = s.match(/(?:^|\s)(\d+)\s+failed(?:,\s*(\d+)\s+passed)?(?:,\s*\d+\s+errors?)?\s+in\s+[\d.]+s/m)
  if (pytest) return failed(Number(pytest[1]), pytest[2] !== undefined ? Number(pytest[2]) : null, failFile())
  const pytestGreen = s.match(/(?:^|\s)(\d+)\s+passed\s+in\s+[\d.]+s/m)
  if (pytestGreen) return passed(Number(pytestGreen[1]))
  // cargo: `test result: FAILED. 3 passed; 2 failed; 0 ignored` / green `test result: ok. 120 passed; 0 failed`
  const cargo = s.match(/test result:\s*FAILED\.\s*(\d+)\s*passed;\s*(\d+)\s*failed/)
  if (cargo) return failed(Number(cargo[2]), Number(cargo[1]), failFile())
  const cargoGreen = s.match(/test result:\s*ok\.\s*(\d+)\s*passed/)
  if (cargoGreen) return passed(Number(cargoGreen[1]))
  // go: a `--- FAIL: TestName` block under a package-level FAIL. Counts are
  // package-level, so the summary names failing TESTS; green is `ok` lines
  // with no FAIL marker.
  if (/^--- FAIL:/m.test(s)) {
    const names = [...s.matchAll(/^--- FAIL:\s+(\S+)/gm)].slice(0, 3).map((m) => m[1])
    return failureLine(`go test failures (${names.join(', ')})`, goFirstFailure())
  }
  if (/^ok\s/m.test(s) && !/^FAIL\b/m.test(s)) {
    const pkgs = [...s.matchAll(/^ok\s+/gm)].length
    if (pkgs > 0) return { line: `Tests: go test passed (${pkgs} package${pkgs === 1 ? '' : 's'})` }
  }
  return null
}

// ── 4. Failure locations (the verify panel, PLAN-project-ide 刀一) ─────────

export interface TestFailureLocation {
  /** File path as the runner printed it — workspace-relative in practice. */
  path: string
  /** Present ONLY when the runner itself printed a line number. */
  line?: number
}

/** Cap on the clickable failure list — a suite with hundreds of failures must
 *  not turn the strip into a wall; the raw output below stays the full truth. */
export const MAX_TEST_FAILURES = 20

/**
 * Clickable failure anchors from a test runner's stdout — the panel-side twin
 * of summarizeTestOutput, sharing its vocabulary and its honesty bar: go keeps
 * the `file:line` printed inside each `--- FAIL:` block; vitest/jest/pytest
 * keep only the FILE the FAIL/FAILED line names (their fail lines carry no
 * trustworthy line number — one is never invented); rustc keeps the
 * `--> file:line:col` it prints for compile errors (a `cargo test` run can
 * fail at compile before any test executes). Test names are NOT paths and are
 * never offered as ones. Dedupes, first-appearance order, capped.
 */
export function parseTestFailures(stdout: string): TestFailureLocation[] {
  if (!stdout) return []
  const s = stdout.slice(0, 200_000)
  const out: TestFailureLocation[] = []
  const seen = new Set<string>()
  const push = (raw: string, line?: number): void => {
    const path = raw.trim()
    if (!path || /\s/.test(path) || path.includes('>')) return
    const key = line != null ? `${path}:${line}` : path
    if (seen.has(key)) return
    seen.add(key)
    out.push(line != null ? { path, line } : { path })
  }
  // go: the location lives inside each --- FAIL: block (first 2000 chars of
  // it, mirroring summarize's goFirstFailure window).
  const goStarts = [...s.matchAll(/^--- FAIL:\s+(\S+)/gm)]
  for (let i = 0; i < goStarts.length; i++) {
    const start = goStarts[i].index ?? 0
    const end = i + 1 < goStarts.length ? (goStarts[i + 1].index ?? s.length) : s.length
    const loc = s.slice(start, Math.min(end, start + 2000)).match(/\n\s+(\S+\.go):(\d+)/)
    if (loc) push(loc[1], Number(loc[2]))
  }
  // vitest / jest / pytest: FAIL/FAILED lines name the file — same split as
  // summarize's failFile() (the `>` suite chain, pytest's `::test` and
  // ` - msg` peeled off the first token).
  for (const m of s.matchAll(/^[ \t]*(?:FAIL|FAILED)\s+(.+)$/gm)) {
    const file = m[1]
      .trim()
      .split(/\s+>\s+|\s+-\s+|::/)[0]
      .trim()
    if (file) push(file)
  }
  // rustc compile errors (`cargo test` failing before any test executes).
  for (const m of s.matchAll(/^\s*-->\s+(\S+):(\d+):\d+/gm)) {
    push(m[1], Number(m[2]))
  }
  return out.slice(0, MAX_TEST_FAILURES)
}
