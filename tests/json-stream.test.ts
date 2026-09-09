import { describe, expect, it } from 'vitest'
import { IncrementalJsonTracker } from '../src/renderer/src/agent/json-stream'

function feedCharByChar(tracker: IncrementalJsonTracker, s: string): Array<{ justCompleted: boolean; value?: unknown }> {
  const results: Array<{ justCompleted: boolean; value?: unknown }> = []
  for (const ch of s) results.push(tracker.push(ch))
  return results
}

describe('IncrementalJsonTracker', () => {
  it('completes exactly once at the closing brace when fed char-by-char', () => {
    const t = new IncrementalJsonTracker()
    const results = feedCharByChar(t, '{"command":"ls -la"}')
    const completions = results.filter(r => r.justCompleted)
    expect(completions).toHaveLength(1)
    expect(completions[0].value).toEqual({ command: 'ls -la' })
    expect(t.isComplete()).toBe(true)
  })

  it('ignores braces inside string values (no false completion)', () => {
    const t = new IncrementalJsonTracker()
    const results = feedCharByChar(t, '{"body":"func() { return {a:1}; }"}')
    const completions = results.filter(r => r.justCompleted)
    expect(completions).toHaveLength(1)
    expect(completions[0].value).toEqual({ body: 'func() { return {a:1}; }' })
  })

  it('handles escaped quotes and escapes inside strings', () => {
    const t = new IncrementalJsonTracker()
    const results = feedCharByChar(t, '{"content":"line1\\"quoted\\" \\\\ {not-a-brace}"}')
    const completions = results.filter(r => r.justCompleted)
    expect(completions).toHaveLength(1)
    expect(completions[0].value).toEqual({ content: 'line1"quoted" \\ {not-a-brace}' })
  })

  it('tracks nested objects and arrays to true completion', () => {
    const t = new IncrementalJsonTracker()
    const r = t.push('{"file_path":"/a/b","opts":{"nested":[1,2,{"deep":true}]}}')
    expect(r.justCompleted).toBe(true)
    expect(r.value).toEqual({ file_path: '/a/b', opts: { nested: [1, 2, { deep: true }] } })
  })

  it('incomplete input never reports completion', () => {
    const t = new IncrementalJsonTracker()
    const r1 = t.push('{"file_path":"/x/y"')
    const r2 = t.push(',"more"')
    expect(r1.justCompleted).toBe(false)
    expect(r2.justCompleted).toBe(false)
    expect(t.isComplete()).toBe(false)
    expect(t.accumulated()).toBe('{"file_path":"/x/y","more"')
  })

  it('multi-chunk streaming equals single-chunk feeding', () => {
    const whole = '{"a":{"b":[1,2,3]},"c":"}{"}'
    const t1 = new IncrementalJsonTracker()
    const single = t1.push(whole)
    const t2 = new IncrementalJsonTracker()
    const parts = whole.match(/.{1,3}/gs) ?? []
    let last = { justCompleted: false, value: undefined as unknown }
    for (const p of parts) last = t2.push(p)
    expect(single).toEqual(last)
    expect(last.value).toEqual({ a: { b: [1, 2, 3] }, c: '}{' })
  })

  it('push after completion is a no-op (final stop handler re-parses from accumulated())', () => {
    const t = new IncrementalJsonTracker()
    t.push('{"x":1}')
    const again = t.push('garbage after close')
    expect(again.justCompleted).toBe(false)
    expect(t.accumulated()).toBe('{"x":1}')
    expect(JSON.parse(t.accumulated())).toEqual({ x: 1 })
  })

  it('balanced-looking but invalid JSON does not count as complete', () => {
    const t = new IncrementalJsonTracker()
    // starts with a bare number then braces — bracket-balanced scan would only
    // complete on depth-0 close; malformed input must not produce a value
    const r = t.push('42')
    expect(r.justCompleted).toBe(false)
    expect(t.isComplete()).toBe(false)
  })
})
