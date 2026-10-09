/**
 * Repeat-call guard (PLAN-coding-contract, harness 反馈层): the engine had no
 * RUNTIME detection of a model asking the same question twice — identical tool
 * with byte-identical arguments — the shape behind wasted rounds (the mimo
 * spawn_agent re-dispatch of 2026-09 was its loudest form; the prompt-level
 * 「NEVER re-dispatch」 rule in tool-instructions can only discourage, never
 * detect). Detection is deliberately narrow so legitimate repeats never trip:
 *
 *   - `repeat`: the immediately PRECEDING call has the same signature AND
 *     succeeded. A legitimate repeat almost always has something in between
 *     (a read after an edit, tests after a fix) or follows an error (retrying
 *     a transient failure); back-to-back identical + success is a loop asking
 *     a question it was just answered.
 *   - `churn`: the same signature has reached CHURN_THRESHOLD calls within
 *     one turn — set above the edit→test→edit→test rhythm, where three
 *     identical `exec` calls is a normal fix loop.
 *
 * The hint rides the TOOL RESULT tail (experienceStatsLine precedent: the
 * cache contract keeps the system prompt byte-stable, and the model decides
 * its next move off the last bytes of a tool result). Advisory only — nothing
 * is blocked, and the wording gives an explicit out for the rare legitimate
 * cases (re-checking a flaky result, polling a condition).
 *
 * Scope: per turn. prepareTurn resets the guard with the other per-turn
 * counters; the sequence is NOT windowed because the churn count is only
 * honest over the whole turn (a shift would un-count early repeats).
 */

export type RepeatLevel = 'none' | 'repeat' | 'churn'

export const REPEAT_CALL_CHURN_THRESHOLD = 4

/** FNV-1a 32-bit, hex. Hand-rolled (no `node:crypto`): the engine is
 *  de-facto shared code and must import nothing platform-bound. Collision
 *  risk at 32 bits is irrelevant — a collision only over-warns, never blocks. */
export function fnv1a32(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** JSON with recursively sorted object keys, so key order in the model's
 *  arguments never changes the signature. Arrays keep their order — argument
 *  order IS the meaning for array-valued inputs. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

export function toolCallSignature(name: string, input: unknown): string {
  return `${name}#${fnv1a32(stableStringify(input))}`
}

export class RepeatCallGuard {
  private seq: { sig: string; isError: boolean }[] = []

  reset(): void {
    this.seq = []
  }

  record(sig: string, isError: boolean): { level: RepeatLevel; count: number } {
    const prev = this.seq[this.seq.length - 1]
    const count = this.seq.reduce((acc, e) => (e.sig === sig ? acc + 1 : acc), 0) + 1
    this.seq.push({ sig, isError })
    if (prev && prev.sig === sig && !prev.isError) return { level: 'repeat', count }
    if (count >= REPEAT_CALL_CHURN_THRESHOLD) return { level: 'churn', count }
    return { level: 'none', count }
  }
}

export function formatRepeatHint(level: RepeatLevel, count: number): string {
  if (level === 'repeat') {
    return `[repeat-call guard: identical call #${count} this turn — the immediately preceding identical call already succeeded (its result is just above), so this one returns the same bytes. Unless you are deliberately re-checking a flaky result, break the loop: change the arguments, use a different tool, or report the blocker instead of retrying.]`
  }
  if (level === 'churn') {
    return `[repeat-call guard: this exact call (same tool, byte-identical arguments) has now been made ${count} times this turn — earlier results are already in context. If each retry followed a fresh fix this is fine; otherwise you are circling: step back and change approach.]`
  }
  return ''
}
