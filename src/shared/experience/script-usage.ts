/**
 * Static matcher tying a shell command back to the experience library it drew
 * from (PLAN-experience-outcome M1). The exec settlement calls this with the
 * FULL command string once the exit code is known — zero model cooperation,
 * the verdict is the real exit code, never a self-assessment.
 *
 * Two conditions, BOTH required:
 *  - the command names a companion script (`experiences/<name>/scripts/…`,
 *    either path separator, any quoting) — slugified names may be CJK, so the
 *    name class is "not a separator / whitespace / quote";
 *  - the command invokes `node` — PLAN-experience-scripts constrains every
 *    companion script to Node (Electron's embedded Node 20, zero npm deps),
 *    and requiring the runtime keeps a bare `cat`/`grep` of the script from
 *    inflating useCount, which feeds LRU eviction.
 *
 * Deliberate misses (honest gaps, never guesses): indirect invocation (a
 * script spawning another script), runtime indirection (`$NODE`), background
 * runs at the outcome layer (no exit code at the settlement point — usage
 * only, no verdict).
 */
export function matchExperienceScript(command: string): string | null {
  if (!command) return null
  if (!/\bnode\b/.test(command)) return null
  const m = command.match(/experiences[/\\]([^/\\'"\s]+)[/\\]scripts[/\\]/)
  return m?.[1] ?? null
}
