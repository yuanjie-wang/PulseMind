import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RepeatCallGuard, formatRepeatHint, fnv1a32, toolCallSignature } from '../src/renderer/src/agent/engine/loop-guard'

// ── PLAN-coding-contract (harness 反馈层): the engine had no runtime detection
// of a model asking the SAME question twice — identical tool, byte-identical
// arguments. Detection is deliberately narrow (see loop-guard.ts header): only
// a back-to-back repeat after a SUCCESS is flagged `repeat`; only CHURN_THRESHOLD
// identical calls within one turn flag `churn`. The thresholds exist to keep the
// legitimate rhythms free: read → edit → read (verify after change), and
// exec test → edit fix → exec test → edit fix → exec test (3 identical calls).

describe('toolCallSignature — byte-identical arguments, order-free', () => {
  it('key order in the model\'s JSON never changes the signature', () => {
    expect(toolCallSignature('read', { file_path: '/a.ts', offset: 1 }))
      .toBe(toolCallSignature('read', { offset: 1, file_path: '/a.ts' }))
  })

  it('nesting sorts too; arrays keep their order (order IS meaning)', () => {
    const a = toolCallSignature('t', { ops: [{ file: 'a' }, { file: 'b' }], meta: { x: 1, y: 2 } })
    const b = toolCallSignature('t', { meta: { y: 2, x: 1 }, ops: [{ file: 'a' }, { file: 'b' }] })
    expect(a).toBe(b)
    const swapped = toolCallSignature('t', { ops: [{ file: 'b' }, { file: 'a' }], meta: { x: 1, y: 2 } })
    expect(a).not.toBe(swapped)
  })

  it('different tool names / arguments never collide', () => {
    expect(toolCallSignature('read', { file_path: '/a' })).not.toBe(toolCallSignature('list_dir', { file_path: '/a' }))
    expect(toolCallSignature('read', { file_path: '/a' })).not.toBe(toolCallSignature('read', { file_path: '/b' }))
  })

  it('fnv1a32 is deterministic and input-sensitive', () => {
    expect(fnv1a32('abc')).toBe(fnv1a32('abc'))
    expect(fnv1a32('abc')).not.toBe(fnv1a32('abd'))
  })
})

describe('RepeatCallGuard — the two detection tiers', () => {
  it('back-to-back identical call after a SUCCESS flags `repeat`', () => {
    const g = new RepeatCallGuard()
    const sig = toolCallSignature('search', { query: 'foo' })
    expect(g.record(sig, false).level).toBe('none')
    const second = g.record(sig, false)
    expect(second.level).toBe('repeat')
    expect(second.count).toBe(2)
  })

  it('a repeat after an ERROR is a legitimate retry — no flag (until churn)', () => {
    const g = new RepeatCallGuard()
    const sig = toolCallSignature('exec', { command: 'npm test' })
    expect(g.record(sig, true).level).toBe('none')
    expect(g.record(sig, false).level).toBe('none') // retry-after-error
  })

  it('read → edit → read (same args) is verification, not a loop', () => {
    const g = new RepeatCallGuard()
    const read = toolCallSignature('read', { file_path: '/a.ts' })
    const edit = toolCallSignature('edit', { file_path: '/a.ts', old_str: 'x', new_str: 'y' })
    expect(g.record(read, false).level).toBe('none')
    expect(g.record(edit, false).level).toBe('none')
    expect(g.record(read, false).level).toBe('none') // non-consecutive 2nd occurrence
  })

  it('the fix loop survives: exec test ×3 across edits only flags at the churn line', () => {
    const g = new RepeatCallGuard()
    const test = toolCallSignature('exec', { command: 'npm test' })
    const fix1 = toolCallSignature('edit', { old_str: 'a', new_str: 'b' })
    const fix2 = toolCallSignature('edit', { old_str: 'c', new_str: 'd' })
    const fix3 = toolCallSignature('edit', { old_str: 'e', new_str: 'f' })
    expect(g.record(test, false).level).toBe('none')
    expect(g.record(fix1, false).level).toBe('none')
    expect(g.record(test, false).level).toBe('none')
    expect(g.record(fix2, false).level).toBe('none')
    expect(g.record(test, false).level).toBe('none') // third run, still no flag
    expect(g.record(fix3, false).level).toBe('none')
    const fourth = g.record(test, false)
    expect(fourth.level).toBe('churn')
    expect(fourth.count).toBe(4)
  })

  it('reset clears the turn\'s slate (prepareTurn\'s contract)', () => {
    const g = new RepeatCallGuard()
    const sig = toolCallSignature('read', { file_path: '/a' })
    g.record(sig, false)
    g.record(sig, false)
    g.reset()
    expect(g.record(sig, false).level).toBe('none')
  })
})

describe('formatRepeatHint — the tool-result tail', () => {
  it('repeat names the count and gives an explicit out for legit re-checks', () => {
    const hint = formatRepeatHint('repeat', 2)
    expect(hint).toContain('identical call #2')
    expect(hint).toContain('flaky')
    expect(hint.startsWith('[repeat-call guard:')).toBe(true)
  })

  it('churn acknowledges the fix loop while naming the circling', () => {
    const hint = formatRepeatHint('churn', 4)
    expect(hint).toContain('4 times this turn')
    expect(hint).toContain('followed a fresh fix')
  })

  it('none renders nothing', () => {
    expect(formatRepeatHint('none', 1)).toBe('')
  })
})

// ── wiring: the guard must sit on the ONE ingestion point (addToolResult) and
// reset with the other per-turn counters — and it must stay OUT of the system
// prompt builder (cache contract: the hint rides tool results, nothing else).

describe('wiring — AgentEngine integration', () => {
  const ROOT = join(__dirname, '..')
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
  const engineSrc = read('src/renderer/src/agent/AgentEngine.ts')

  it('addToolResult records signatures off the call\'s own tool_use block', () => {
    expect(engineSrc).toContain('from \'./engine/loop-guard\'')
    expect(engineSrc).toContain('toolCallSignature(callBlock.name, callBlock.input)')
    expect(engineSrc).toContain('if (level !== \'none\') resultText = `${text}\\n${formatRepeatHint(level, count)}`')
  })

  it('prepareTurn resets the guard with the per-turn counters; loadConversation too', () => {
    expect(engineSrc.match(/this\.repeatGuard\.reset\(\)/g)?.length).toBe(2)
  })

  it('the system prompt builder never imports the guard (cache contract)', () => {
    expect(read('src/renderer/src/agent/system-prompt-builder.ts')).not.toContain('loop-guard')
  })
})
