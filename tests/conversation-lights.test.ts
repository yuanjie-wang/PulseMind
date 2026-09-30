// ── Sidebar status-light mapping ──
// The sidebar's four-state conversation light derives from the mirrored
// agentStatus through statusToLight (user ruling 2026-09-30: 自动执行中 = ring,
// 等待用户反馈 = orange dot, 异常 = red dot, 任务完成未读 = green dot). Pure
// decision, so the whole taxonomy pins here — including the two shapes the
// old two-list implementation got wrong: 'retrying' counted as active (the
// amber dot could never win the row's running-first precedence) and
// 'awaiting_continue' (the 暂停 park) lit nothing at all.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  clearUnreadLight,
  foldConvLight,
  statusToLight,
  type ConversationLight
} from '../src/renderer/src/hooks/useConversationEngine'
import type { AgentStatus } from '../src/renderer/src/types/agent'

const lightOf = (status: AgentStatus): ConversationLight | null =>
  statusToLight(status.status, /* isRead */ false)

describe('statusToLight', () => {
  it('maps the auto-executing statuses to the spinning ring', () => {
    expect(lightOf({ status: 'streaming' })).toBe('running')
    expect(lightOf({ status: 'executing', toolUseId: 't1' })).toBe('running')
    expect(lightOf({ status: 'awaiting_extension', currentCount: 1, limit: 3 })).toBe('running')
  })

  it('maps every user-decision park to the orange waiting dot', () => {
    expect(lightOf({ status: 'awaiting_approval', tools: [] })).toBe('waiting')
    expect(lightOf({ status: 'awaiting_user_input', tools: [] })).toBe('waiting')
    // The 暂停 button's own status — 继续执行/停止任务 is also a user decision.
    expect(lightOf({ status: 'awaiting_continue' })).toBe('waiting')
  })

  it('maps api-level exceptions (retrying backoff, errored turn) to the red dot', () => {
    expect(lightOf({ status: 'retrying', message: 'boom', attempt: 1, maxRetries: 3, delay: 1000 })).toBe('error')
    expect(lightOf({ status: 'error', error: 'boom' })).toBe('error')
  })

  it('maps a completed turn to green only while unread', () => {
    expect(lightOf({ status: 'completed' })).toBe('unread')
    expect(statusToLight('completed', /* isRead */ true)).toBeNull()
  })

  it('leaves idle unlit', () => {
    expect(lightOf({ status: 'idle' })).toBeNull()
  })
})

describe('foldConvLight / clearUnreadLight', () => {
  it('folds a light in and removes it on null', () => {
    expect(foldConvLight({}, 'a', 'unread')).toEqual({ a: 'unread' })
    expect(foldConvLight({ a: 'unread' }, 'a', null)).toEqual({})
    expect(foldConvLight({ a: 'unread' }, 'b', 'error')).toEqual({ a: 'unread', b: 'error' })
  })

  it('bails out on no-op folds (same object back for React)', () => {
    const prev = { a: 'unread' as ConversationLight }
    expect(foldConvLight(prev, 'a', 'unread')).toBe(prev)
    expect(clearUnreadLight(prev, 'b')).toBe(prev)
  })

  it('opening a conversation clears ONLY the unread light (the 2026-09-30 green-dot bug)', () => {
    expect(clearUnreadLight({ a: 'unread' }, 'a')).toEqual({})
    // error/waiting/running track the status, not the reading — opening
    // the conversation must not extinguish them.
    expect(clearUnreadLight({ a: 'error' }, 'a')).toEqual({ a: 'error' })
    expect(clearUnreadLight({ a: 'waiting' }, 'a')).toEqual({ a: 'waiting' })
    expect(clearUnreadLight({ a: 'running' }, 'a')).toEqual({ a: 'running' })
  })

  it('the background-completion shape: running while watched, unread once left', () => {
    // The user's scenario: send a message (watched → running), switch away,
    // the turn completes → the completion must land as 未读, and opening the
    // conversation clears it.
    expect(statusToLight('completed', /* active elsewhere */ false)).toBe('unread')
    expect(clearUnreadLight(foldConvLight({}, 'a', 'unread'), 'a')).toEqual({})
  })
})

// ── Wiring scans ──
// The green-dot bug lived in a SEAM between hooks, invisible to pure-function
// tests: persistence's handleSelectConversation drives activeEngineIdRef
// directly and never routes through the engine hook's activateEngine, so the
// 未读 clear must ride the switch path itself. Source scans pin that seam
// (the office-tool-dispatch precedent: wiring facts scan the source).
describe('read-receipt wiring', () => {
  const persistenceSrc = readFileSync(new URL('../src/renderer/src/hooks/useConversationPersistence.ts', import.meta.url), 'utf-8')
  const controllerSrc = readFileSync(new URL('../src/renderer/src/hooks/useChatController.ts', import.meta.url), 'utf-8')

  it('handleSelectConversation clears the unread light where it drives the active-engine ref', () => {
    // The clear sits with the ref write — the one point every switch funnels through.
    expect(persistenceSrc).toMatch(/activeEngineIdRef\.current = key[\s\S]{0,200}markConversationRead\(key\)/)
  })

  it('useChatController wires the engine markConversationRead into persistence', () => {
    expect(controllerSrc).toContain('markConversationRead: engine.markConversationRead')
  })
})
