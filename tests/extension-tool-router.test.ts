/** `tool.call` → tab routing (PLAN-browser-extension M2.3).
 *
 * The router is where three failure modes get settled instead of stalling the
 * engine until its per-tool timeout: an unbound session, a tab whose content
 * script cannot answer, and a page CSP that blocks eval (CDP fallback). All
 * three are cheap to reproduce here with a stub chrome, so they are pinned. */

import { beforeEach, describe, expect, it } from 'vitest'
import type { ToolCallParams, ToolCallResultParams } from '../src/shared/agent-protocol'
import { bindTabSession } from '../src/extension/background/state'
import { routeToolCall } from '../src/extension/background/tool-router'
import { resetCspVerdict } from '../src/extension/background/cdp'

const TAB = 42
const SESSION = 'ws_1'

interface SentToTab {
  tabId: number
  msg: Record<string, unknown>
}

interface ChromeStub {
  sentToTab: SentToTab[]
  cdpEvals: string[]
  /** What the tab's content script answers with. */
  tabReply: unknown
  /** When set, chrome.tabs.sendMessage rejects with this. */
  sendError: Error | null
  hasDebugger: boolean
}

function installChromeStub(overrides: Partial<ChromeStub> = {}): ChromeStub {
  const bag: Record<string, unknown> = {}
  const stub: ChromeStub = {
    sentToTab: [],
    cdpEvals: [],
    tabReply: { ok: true, result: '已点击' },
    sendError: null,
    hasDebugger: true,
    ...overrides,
  }
  const area = (store: Record<string, unknown>): unknown => ({
    get: async (key: string) => ({ [key]: store[key] }),
    set: async (obj: Record<string, unknown>) => {
      Object.assign(store, obj)
    },
  })
  const chromeLike: Record<string, unknown> = {
    storage: { session: area(bag), local: area({}) },
    tabs: {
      sendMessage: async (tabId: number, msg: Record<string, unknown>) => {
        if (stub.sendError) throw stub.sendError
        stub.sentToTab.push({ tabId, msg })
        return stub.tabReply
      },
    },
  }
  if (stub.hasDebugger) {
    chromeLike.debugger = {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target: unknown, command: string, params: Record<string, unknown>) => {
        stub.cdpEvals.push(`${command}:${String(params.expression)}`)
        return { result: { value: 7 } }
      },
    }
  }
  ;(globalThis as unknown as { chrome: unknown }).chrome = chromeLike
  return stub
}

function makeParams(overrides: Partial<ToolCallParams> = {}): ToolCallParams {
  return { callId: 'c1', sessionId: SESSION, tool: 'page_click', args: { index: 3 }, ...overrides }
}

describe('extension tool router', () => {
  let stub: ChromeStub
  let results: ToolCallResultParams[]

  beforeEach(async () => {
    stub = installChromeStub()
    results = []
    resetCspVerdict(TAB)
    await bindTabSession(TAB, SESSION)
  })

  const route = (params: ToolCallParams): Promise<void> =>
    routeToolCall(params, { sendResult: (r) => results.push(r) })

  it('forwards the call to the tab that owns the session', async () => {
    await route(makeParams())

    expect(stub.sentToTab).toHaveLength(1)
    expect(stub.sentToTab[0].tabId).toBe(TAB)
    expect(stub.sentToTab[0].msg).toEqual({ type: 'pulsemind/page-tool', tool: 'page_click', args: { index: 3 } })
    expect(results[0]).toEqual({ callId: 'c1', ok: true, result: '已点击' })
  })

  it('refuses immediately when no tab is bound to the session', async () => {
    await route(makeParams({ sessionId: 'ws_unbound' }))

    expect(stub.sentToTab).toHaveLength(0)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('标签页已关闭')
  })

  it('refuses a tool outside the page family', async () => {
    await route(makeParams({ tool: 'exec' }))
    expect(results[0]).toMatchObject({ callId: 'c1', ok: false })
    expect(results[0].error).toContain('未知页面工具')
    expect(stub.sentToTab).toHaveLength(0)
  })

  it('turns a missing content script into an actionable error', async () => {
    stub.sendError = new Error('Could not establish connection. Receiving end does not exist.')
    await route(makeParams())

    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('刷新页面')
  })

  it('surfaces the content script\u2019s own failure verbatim', async () => {
    stub.tabReply = { ok: false, error: '索引 9 不存在或已失效' }
    await route(makeParams())

    expect(results[0]).toEqual({ callId: 'c1', ok: false, error: '索引 9 不存在或已失效' })
  })

  it('retries a CSP-blocked page_execute_js through the debugger', async () => {
    stub.tabReply = { ok: false, error: 'unsafe-eval refused', cspEvalBlocked: true }
    await route(makeParams({ tool: 'page_execute_js', args: { script: '() => 7' } }))

    expect(stub.cdpEvals).toHaveLength(1)
    expect(results[0]).toEqual({ callId: 'c1', ok: true, result: '7' })
  })

  it('skips the content script entirely once a tab is known to be CSP-strict', async () => {
    // First call: the direct path fails, CDP succeeds and records the verdict.
    stub.tabReply = { ok: false, error: 'unsafe-eval refused', cspEvalBlocked: true }
    await route(makeParams({ tool: 'page_execute_js', args: { script: '() => 7' } }))
    expect(stub.sentToTab).toHaveLength(1)

    // Second call goes straight to CDP — no wasted round-trip.
    await route(makeParams({ tool: 'page_execute_js', args: { script: '() => 8' } }))
    expect(stub.sentToTab).toHaveLength(1)
    expect(stub.cdpEvals).toHaveLength(2)

    // A navigation drops the verdict: the next call tries the fast path again.
    resetCspVerdict(TAB)
    await route(makeParams({ tool: 'page_execute_js', args: { script: '() => 9' } }))
    expect(stub.sentToTab).toHaveLength(2)
  })

  it('never routes a non-eval tool to the debugger, whatever the error says', async () => {
    stub.tabReply = { ok: false, error: 'unsafe-eval refused', cspEvalBlocked: true }
    await route(makeParams({ tool: 'page_click' }))

    expect(stub.cdpEvals).toHaveLength(0)
    expect(results[0].ok).toBe(false)
  })

  it('does not lose the call when the debugger permission is absent', async () => {
    installChromeStub({ tabReply: { ok: false, error: 'unsafe-eval refused', cspEvalBlocked: true }, hasDebugger: false })
    await bindTabSession(TAB, SESSION)
    await route(makeParams({ tool: 'page_execute_js', args: { script: '() => 7' } }))

    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('unsafe-eval')
  })
})
