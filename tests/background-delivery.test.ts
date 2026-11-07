/**
 * PLAN-background-tasks — B 完成事件面 + C 空闲自动投递 的钉子。
 *
 * 分层同 persistent-shell/search 批次：
 *  1. 纯逻辑：合成通知的 marker 契约（shared/background-notice.ts）与 mirror
 *     对 background_task / backgroundPid 的折叠（shared/agent-session/mirror）。
 *  2. wiring 扫描：deliverBackgroundNotice 的闸门矩阵与合成消息、background_task
 *     事件的发射点、渲染端三触发点与通知编排、审批不变量（background 分支先过
 *     write 门；promote 通道 agent-only）、设置归一化与 i18n。
 *
 * deliverBackgroundNotice 本体拖着主进程整棵依赖树（SQLite/浏览器服务），vitest
 * 的 node 环境跑不动它——闸门以「方法体内出现顺序」扫描钉死（与
 * engine-call-whitelist 的静态围栏同一手法），运行时行为由探针走查。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applySessionEvent, freshSessionState } from '../src/shared/agent-session/mirror'
import { BACKGROUND_NOTICE_MARKER, backgroundNoticeBody, isBackgroundNoticeText } from '../src/shared/background-notice'

const REPO = process.cwd()
const src = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

/** session-manager.ts 里 deliverBackgroundNotice 的方法体切片（到下一个成员为止）。 */
function deliveryBody(): string {
  const sm = src('src/main/agent/session-manager.ts')
  const start = sm.indexOf('async deliverBackgroundNotice')
  expect(start, 'deliverBackgroundNotice moved? re-scope the scan').toBeGreaterThan(0)
  const end = sm.indexOf('  /** Rebuild engine options', start)
  expect(end, 'the method after deliverBackgroundNotice moved? re-scope').toBeGreaterThan(start)
  return sm.slice(start, end)
}

describe('background-notice marker contract (shared/background-notice.ts)', () => {
  it('marker prefix identifies the synthetic message; body strips the marker', () => {
    expect(isBackgroundNoticeText(`${BACKGROUND_NOTICE_MARKER} 后台任务已完成`)).toBe(true)
    expect(isBackgroundNoticeText('普通用户消息')).toBe(false)
    expect(isBackgroundNoticeText(undefined)).toBe(false)
    expect(isBackgroundNoticeText(null)).toBe(false)
    expect(backgroundNoticeBody(`${BACKGROUND_NOTICE_MARKER} 后台任务已完成\n\n- pid=1`)).toBe('后台任务已完成\n\n- pid=1')
  })

  it('the composer uses THE shared marker, never an inline literal', () => {
    const sm = src('src/main/agent/session-manager.ts')
    expect(sm).toContain('BACKGROUND_NOTICE_MARKER')
    expect(sm).not.toContain("'[[background-notice]]")
  })
})

describe('deliverBackgroundNotice — the gate matrix (in-body order)', () => {
  const body = deliveryBody()

  it('gates in order: re-entry → notices empty → engine active → global slots', () => {
    const reentry = body.indexOf('this.deliveringBackground.has(sessionId)')
    const empty = body.indexOf('backgroundNotices.length === 0')
    const active = body.indexOf('isActiveStatus(entry.engine.agentStatus)')
    const slots = body.indexOf('this.runningLoops >= MAX_CONCURRENT_LOOPS')
    for (const idx of [reentry, empty, active, slots]) expect(idx, 'a gate went missing').toBeGreaterThan(-1)
    expect(reentry).toBeLessThan(empty)
    expect(empty).toBeLessThan(active)
    expect(active).toBeLessThan(slots)
  })

  it('returns the three-word contract: busy / nothing / delivered', () => {
    expect(body).toContain("return 'busy'")
    expect(body).toContain("return 'nothing'")
    expect(body).toContain("return 'delivered'")
  })

  it('re-entry is armed before any await and always disarmed (try/finally)', () => {
    const add = body.indexOf('this.deliveringBackground.add(sessionId)')
    const firstAwait = body.indexOf('await', add)
    expect(add, 'the re-entry flag must be set').toBeGreaterThan(-1)
    expect(firstAwait, 'the flag must be armed synchronously (before the first await)').toBeGreaterThan(add)
    expect(body).toContain('finally {')
    expect(body).toContain('this.deliveringBackground.delete(sessionId)')
  })

  it('the synthetic turn is ONE message: marker prefix + pid/code + inline 2KB log tail', () => {
    expect(body).toContain('entry.engine.backgroundNotices')
    // NOT drained here — the engine's own request builder drains the same
    // notices into the state block on this turn (双保险), and a user turn that
    // races in keeps its normal wake-up.
    expect(body).toContain('await this.ask(sessionId, content)')
    expect(body).toContain('svcExecLogs(n.pid, 2048)')
    expect(body).toContain('退出码')
    expect(body).toContain('不要重新执行这些命令')
  })

  it('the tail read runs inside the session sandbox (exec_logs pid authorization)', () => {
    expect(body).toContain('sessionSandbox.run(sandboxCtx, () => svcExecLogs(n.pid, 2048))')
  })
})

describe('background_task event face (B)', () => {
  it('payloads carries the exit member as one line', () => {
    const p = src('src/shared/agent-protocol/payloads.ts')
    expect(p).toContain("| { type: 'background_task'; phase: 'exit'; pid: number; code: number | null }")
  })

  it('the backgroundExit listener emits the event right after enqueueing the wake-up', () => {
    const sm = src('src/main/agent/session-manager.ts')
    const i = sm.indexOf('setSessionBackgroundExitListener((sessionId')
    expect(i, 'the listener registration moved?').toBeGreaterThan(0)
    const block = sm.slice(i, i + 1200)
    expect(block).toContain('enqueueBackgroundNotice')
    expect(block).toContain("type: 'background_task', phase: 'exit', pid, code")
    const enqueue = block.indexOf('enqueueBackgroundNotice')
    const emit = block.indexOf("type: 'background_task'")
    expect(emit, 'the event must ride the same exit beat').toBeGreaterThan(enqueue)
  })

  it('the mirror folds it explicitly (consumed-and-ignored, not unknown)', () => {
    const m = src('src/shared/agent-session/mirror.ts')
    expect(m).toContain("case 'background_task':")
    const i = m.indexOf("case 'background_task':")
    expect(m.slice(i, i + 800)).toContain('return false')
  })

  it('tool_status carries backgroundPid over the wire and the fold patches it', () => {
    const p = src('src/shared/agent-protocol/payloads.ts')
    expect(p).toContain('backgroundPid?: number }>')
    const sm = src('src/main/agent/session-manager.ts')
    expect(sm).toContain('backgroundPid: tu.backgroundPid')
    const m = src('src/shared/agent-session/mirror.ts')
    expect(m).toContain('u.backgroundPid !== undefined ? { backgroundPid: u.backgroundPid }')
  })
})

describe('mirror behavior (unit)', () => {
  it('background_task folds to false and leaves the state untouched', () => {
    const st = freshSessionState()
    st.messages = [{ id: 'm1', role: 'assistant', contentBlocks: [{ type: 'text', text: 'hi' }], createdAt: 'now' }]
    const before = st.messages
    expect(applySessionEvent(st, { type: 'background_task', phase: 'exit', pid: 42, code: 0 })).toBe(false)
    expect(st.messages).toBe(before)
    expect(st.agentStatus).toEqual({ status: 'idle' })
  })

  it('tool_status patches backgroundPid onto the mirrored block', () => {
    const st = freshSessionState()
    st.messages = [{
      id: 'm1',
      role: 'assistant',
      contentBlocks: [{ type: 'tool_use', id: 't1', name: 'exec', input: { command: 'sleep 30' }, status: 'running' }],
      createdAt: 'now',
    }]
    const ok = applySessionEvent(st, {
      type: 'tool_status',
      updates: [{ messageId: 'm1', toolUseId: 't1', status: 'completed', exitCode: 0, backgroundPid: 4242 }],
    })
    expect(ok).toBe(true)
    const block = st.messages[0].contentBlocks[0] as { backgroundPid?: number; status?: string }
    expect(block.backgroundPid).toBe(4242)
    expect(block.status).toBe('completed')
  })
})

describe('approval invariant — background buys no bypass (裁定 4)', () => {
  it('execSkillCommand: the write gate scans BEFORE the background branch AND the promotion continuation', () => {
    const d = src('src/renderer/src/agent/executors/domain-tools.ts')
    const fn = d.indexOf('export async function execSkillCommand')
    const body = d.slice(fn, d.indexOf('\n}', fn))
    const gate = body.indexOf('detectShellFileWrite(t.input.command)')
    const bgBranch = body.indexOf('t.input?.background === true')
    const promoted = body.indexOf("outcome === 'promoted'")
    expect(gate).toBeGreaterThan(-1)
    expect(bgBranch).toBeGreaterThan(gate)
    expect(promoted).toBeGreaterThan(gate)
  })

  it('approveTool released path keeps the same gate; promotion happens AFTER approval by construction', () => {
    const f = src('src/renderer/src/agent/engine/execution-flow.ts')
    const fn = f.indexOf('approveTool = async')
    const body = f.slice(fn, f.indexOf('promoteReleasedTool', fn))
    const gate = body.indexOf('detectShellFileWrite(targetBlock.input.command)')
    const register = body.indexOf('registerForegroundExec(toolUseId')
    expect(gate).toBeGreaterThan(-1)
    expect(register, 'the promotion handle registers after the gate, on the released path').toBeGreaterThan(gate)
    // The released-path promotion settles via the host move (promoteReleasedTool):
    // nothing is re-spawned, so no executeBackground call exists anywhere on it.
    const promote = f.indexOf('promoteReleasedTool = (toolUseId')
    const promoteBody = f.slice(promote, f.indexOf('rejectTool =', promote))
    expect(promoteBody).toContain('getHost().promoteToBackground(processId)')
    expect(promoteBody).not.toContain('executeBackground(')
  })

  it('the promote IPC channel is agent-only (renderer reach-around throws)', () => {
    const h = src('src/main/ipc/terminal.handler.ts')
    const i = h.indexOf('TERMINAL_PROMOTE_BACKGROUND')
    expect(h.slice(i, i + 300)).toContain('agent-only')
  })
})

describe('renderer orchestration (C) — three triggers, one idempotent entry', () => {
  it('useChatController wires all three triggers through deliverBackground', () => {
    const c = src('src/renderer/src/hooks/useChatController.ts')
    expect(c).toContain('agentSessionDeliverBackground')
    expect(c).toMatch(/shouldDrainOnStatusChange\(prev, \{ convId, status \}\)/)
    // busy→idle edge reuses the staged-drain predicate; switch-back is its own effect.
    const matches = c.match(/void deliverBackground\(convId\)/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(3)
  })

  it('notify fires only for a NOT-watched conversation; popout windows opt out', () => {
    const c = src('src/renderer/src/hooks/useChatController.ts')
    expect(c).toContain('agentSessionNotifyBackgroundComplete')
    expect(c).toContain("options.savesEnabled === false")
  })

  it('the engine hook decrements on exit and increments on the backgroundPid diff', () => {
    const h = src('src/renderer/src/hooks/useConversationEngine.ts')
    expect(h).toContain("data.type === 'background_task' && data.phase === 'exit'")
    expect(h).toContain('bgPidsRef.current.get(sessionId)')
    expect(h).toMatch(/typeof u\.backgroundPid !== 'number'/)
    expect(h).toContain("agentSessionEngineCall(convId, 'promoteToolToBackground'")
  })

  it('the transcript renders the synthetic message as a system row, not a user bubble', () => {
    const g = src('src/renderer/src/components/chat/MessageGroup.tsx')
    expect(g).toContain('isBackgroundNoticeText')
    expect(g).toContain('data-background-notice=""')
    expect(g).toContain('backgroundNoticeBody(')
  })

  it('the sidebar gutter paints the running count when no light is lit', () => {
    const r = src('src/renderer/src/components/layout/ConversationRows.tsx')
    expect(r).toContain('backgroundCounts')
    expect(r).toContain('data-bg-running={convKey}')
    expect(r).toMatch(/\} : backgroundCount > 0|\{!light && backgroundCount > 0/)
  })
})

describe('notification + settings (B)', () => {
  it('the notify handler gates on notifications.backgroundComplete (default on)', () => {
    const h = src('src/main/ipc/agent-session.handler.ts')
    expect(h).toContain('AGENT_SESSION_NOTIFY_BACKGROUND')
    expect(h).toContain("settings.notifications?.backgroundComplete === false")
  })

  it('the read-side normalize keeps the group spread and adds the one line', () => {
    const s = src('src/main/storage/settings-store.ts')
    expect(s).toContain('backgroundComplete: group.backgroundComplete !== false,')
  })

  it('settings type + both locales carry the keys', () => {
    expect(src('src/shared/types/settings.ts')).toContain('backgroundComplete?: boolean')
    const zh = src('src/renderer/src/i18n/locales/zh.ts')
    const en = src('src/renderer/src/i18n/locales/en.ts')
    for (const loc of [zh, en]) {
      expect(loc).toContain('notifyTitle:')
      expect(loc).toContain('notifyBody:')
      expect(loc).toContain('bgRunning:')
      expect(loc).toContain('backgroundComplete:')
      expect(loc).toContain('promoteToBackground:')
    }
  })
})

describe('promotion通路 wiring (A)', () => {
  it('dispatch whitelist knows the method and the engine delegates to both registries', () => {
    const sm = src('src/main/agent/session-manager.ts')
    expect(sm).toContain("case 'promoteToolToBackground':")
    const e = src('src/renderer/src/agent/AgentEngine.ts')
    expect(e).toContain('promoteForegroundExec(toolUseId)')
    expect(e).toContain('this.executionFlow.promoteReleasedTool(toolUseId)')
  })

  it('the auto-path executor settles the promoted result with the background envelope', () => {
    const d = src('src/renderer/src/agent/executors/domain-tools.ts')
    const fn = d.indexOf("outcome === 'promoted'")
    const body = d.slice(fn, d.indexOf('return true', fn))
    expect(body).toContain('getHost().promoteToBackground(claimedPid)')
    expect(body).toContain('t.backgroundPid = promoted.pid')
  })

  it('the host seam carries promoteToBackground end to end', () => {
    expect(src('src/renderer/src/agent/host/types.ts')).toContain("'promoteToBackground',")
    expect(src('src/shared/types/electron-bridge.ts')).toMatch(/promoteToBackground: \(processId: string\) => Promise<\{ pid: number \} \| null>/)
    expect(src('src/preload/index.ts')).toContain('TERMINAL_PROMOTE_BACKGROUND')
    expect(src('src/main/agent/main-host.ts')).toContain('promoteToBackground: async (processId) => svcPromoteToBackground(processId)')
  })
})
