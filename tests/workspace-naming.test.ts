import { describe, it, expect } from 'vitest'
import { formatConversationDirName, conversationDirNameFor, nextConversationDirName } from '../src/shared/workspace-naming'

describe('formatConversationDirName', () => {
  it('formats yyyyMMddHHmmss in local time with zero padding', () => {
    expect(formatConversationDirName(new Date(2026, 8, 12, 9, 3, 7))).toBe('20260912090307')
    expect(formatConversationDirName(new Date(2026, 11, 31, 23, 59, 59))).toBe('20261231235959')
  })
})

describe('conversationDirNameFor', () => {
  it('strips the conv_ prefix from well-shaped ids', () => {
    expect(conversationDirNameFor('conv_20260912090307')).toBe('20260912090307')
  })
  it('returns null for canvas/spawn/other ids', () => {
    expect(conversationDirNameFor('canvas_ab12')).toBeNull()
    expect(conversationDirNameFor('spawn_xyz')).toBeNull()
    expect(conversationDirNameFor('conv_notatimestamp')).toBeNull()
  })
})

describe('nextConversationDirName', () => {
  it('returns the preferred name when free', () => {
    expect(nextConversationDirName([], '20260912090307')).toBe('20260912090307')
  })
  it('suffixes -2, -3 on collisions', () => {
    const taken = ['20260912090307', '20260912090307-2']
    expect(nextConversationDirName(taken, '20260912090307')).toBe('20260912090307-3')
  })
})
