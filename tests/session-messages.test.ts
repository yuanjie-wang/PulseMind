import { describe, it, expect } from 'vitest'
import { applyMessagesAppend } from '../src/renderer/src/utils/session-messages'

describe('applyMessagesAppend', () => {
  it('appends new items at the end', () => {
    expect(applyMessagesAppend(['a'], 1, ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('replaces from fromIndex when the stream resends overlapping items', () => {
    expect(applyMessagesAppend(['a', 'b', 'c'], 1, ['B'])).toEqual(['a', 'B'])
  })

  it('ignores a zero-item append instead of truncating the mirror', () => {
    // A brand-new session announces itself with { fromIndex: 0, items: [] }
    // before its history is hydrated. Applying that literally would wipe a
    // mirror that was populated optimistically from the DB.
    const mirror = ['m1', 'm2', 'm3']
    expect(applyMessagesAppend(mirror, 0, [])).toBe(mirror)
  })

  it('ignores a zero-item append at any offset', () => {
    const mirror = ['m1', 'm2']
    expect(applyMessagesAppend(mirror, 2, [])).toBe(mirror)
    expect(applyMessagesAppend(mirror, 5, [])).toBe(mirror)
  })

  it('appends onto an empty mirror', () => {
    expect(applyMessagesAppend([], 0, ['a'])).toEqual(['a'])
  })
})
