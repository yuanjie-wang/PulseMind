// ── The auto-send edge rule (暂存消息何时自动发送) ──
// shouldDrainOnStatusChange IS the product decision set for the staged queue:
// only a `completed` turn end drains; error / pause / loop-limit never do; and
// the drain keys on the TRANSITION, so mount / switch / StrictMode re-runs are
// rebases, not sends. The consuming effect cannot be mounted (vitest is
// node-env), which is exactly why the rule lives in a pure function.

import { describe, it, expect } from 'vitest'
import {
  shouldDrainOnStatusChange,
  ACTIVE_TURN_STATUSES,
} from '../src/renderer/src/utils/staged-drain'

const obs = (convId: string | null, status: string) => ({ convId, status })

describe('never drains', () => {
  it('with no conversation open', () => {
    expect(shouldDrainOnStatusChange(obs('conv_a', 'streaming'), obs(null, 'completed'))).toBe(false)
    expect(shouldDrainOnStatusChange(null, obs(null, 'completed'))).toBe(false)
  })

  it('on a turn that ended in error (decision #2)', () => {
    expect(shouldDrainOnStatusChange(obs('conv_a', 'streaming'), obs('conv_a', 'error'))).toBe(false)
    expect(shouldDrainOnStatusChange(obs('conv_a', 'executing'), obs('conv_a', 'error'))).toBe(false)
  })

  it('on a pause (idle after stop)', () => {
    expect(shouldDrainOnStatusChange(obs('conv_a', 'streaming'), obs('conv_a', 'idle'))).toBe(false)
    expect(shouldDrainOnStatusChange(obs('conv_a', 'executing'), obs('conv_a', 'idle'))).toBe(false)
  })

  it('on awaiting_continue / awaiting_extension (abnormal ends)', () => {
    expect(shouldDrainOnStatusChange(obs('conv_a', 'streaming'), obs('conv_a', 'awaiting_continue'))).toBe(false)
    expect(shouldDrainOnStatusChange(obs('conv_a', 'executing'), obs('conv_a', 'awaiting_extension'))).toBe(false)
  })

  it('on a mid-turn status — the loop is not over yet', () => {
    expect(shouldDrainOnStatusChange(obs('conv_a', 'completed'), obs('conv_a', 'streaming'))).toBe(false)
    expect(shouldDrainOnStatusChange(obs('conv_a', 'streaming'), obs('conv_a', 'executing'))).toBe(false)
  })

  it('on completed → completed — a re-render / second notify is not an edge', () => {
    expect(shouldDrainOnStatusChange(obs('conv_a', 'completed'), obs('conv_a', 'completed'))).toBe(false)
  })

  it('on switch-into-anything-but-completed (coming back to a running or idle conv)', () => {
    expect(shouldDrainOnStatusChange(obs('conv_b', 'streaming'), obs('conv_a', 'streaming'))).toBe(false)
    expect(shouldDrainOnStatusChange(obs('conv_b', 'completed'), obs('conv_a', 'idle'))).toBe(false)
    expect(shouldDrainOnStatusChange(obs('conv_b', 'error'), obs('conv_a', 'error'))).toBe(false)
  })
})

describe('drains', () => {
  it('on the in-view busy → completed edge', () => {
    expect(shouldDrainOnStatusChange(obs('conv_a', 'streaming'), obs('conv_a', 'completed'))).toBe(true)
    expect(shouldDrainOnStatusChange(obs('conv_a', 'executing'), obs('conv_a', 'completed'))).toBe(true)
    expect(shouldDrainOnStatusChange(obs('conv_a', 'retrying'), obs('conv_a', 'completed'))).toBe(true)
  })

  it('on every awaiting_* park → completed — a park is mid-turn, its resume ends the turn', () => {
    expect(shouldDrainOnStatusChange(obs('conv_a', 'awaiting_approval'), obs('conv_a', 'completed'))).toBe(true)
    expect(shouldDrainOnStatusChange(obs('conv_a', 'awaiting_user_input'), obs('conv_a', 'completed'))).toBe(true)
  })

  it('on switch-into-completed — the turn ended while the view was elsewhere', () => {
    expect(shouldDrainOnStatusChange(obs('conv_b', 'streaming'), obs('conv_a', 'completed'))).toBe(true)
    expect(shouldDrainOnStatusChange(obs('conv_b', 'idle'), obs('conv_a', 'completed'))).toBe(true)
    expect(shouldDrainOnStatusChange(obs('conv_b', 'error'), obs('conv_a', 'completed'))).toBe(true)
  })

  it('on the FIRST observation when the status is completed (mount onto a just-finished turn)', () => {
    expect(shouldDrainOnStatusChange(null, obs('conv_a', 'completed'))).toBe(true)
  })

  it('does NOT drain on the first observation of a non-completed status (mount / switch base)', () => {
    expect(shouldDrainOnStatusChange(null, obs('conv_a', 'streaming'))).toBe(false)
    expect(shouldDrainOnStatusChange(null, obs('conv_a', 'idle'))).toBe(false)
    expect(shouldDrainOnStatusChange(null, obs('conv_a', 'error'))).toBe(false)
  })
})

describe('ACTIVE_TURN_STATUSES membership', () => {
  it('holds exactly the busy-turn statuses', () => {
    expect([...ACTIVE_TURN_STATUSES].sort()).toEqual(
      ['awaiting_approval', 'awaiting_user_input', 'executing', 'retrying', 'streaming'].sort()
    )
  })

  it('keeps the turn-END statuses out — the ones the user or a failure ended', () => {
    for (const s of ['idle', 'completed', 'error', 'awaiting_continue', 'awaiting_extension']) {
      expect(ACTIVE_TURN_STATUSES.has(s)).toBe(false)
    }
  })
})
