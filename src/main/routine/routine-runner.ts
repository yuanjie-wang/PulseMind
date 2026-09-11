// ── Routine runner (PLAN-0.4.0 M4.5) ──
// Executes a routine as a real conversation via the main-hosted session
// manager: output is inspectable, token usage lands in token_usage, and the
// project binding (if any) applies the project's workspace + sandbox.
//
// Unattended approval policy (D13): runs have no user watching. When the agent
// hits an approval gate, the runner REJECTS the pending tool immediately and
// lets the model continue — the rejection (and reason) is recorded in the
// produced conversation. ask_user prompts are answered with a skip notice.
// Nothing ever hangs waiting for a user who isn't there.

import { BrowserWindow, Notification } from 'electron'
import { randomUUID } from 'node:crypto'
import { agentSessionManager } from '../agent/session-manager'
import { routineStore } from '../storage/routine-store'
import { auditStore } from '../storage/audit-store'
import type { AgentEventData } from '../../shared/agent-protocol'
import type { Routine, RoutineRun } from '../../shared/types/routine'

/** Hard ceiling for one routine run (a hung run must not hold the slot forever). */
const RUN_TIMEOUT_MS = 15 * 60_000

export function renderRoutinePrompt(routine: Routine, params?: Record<string, string>): string {
  let prompt = routine.prompt
  for (const p of routine.params ?? []) {
    const value = params?.[p.key] ?? p.default ?? ''
    prompt = prompt.replaceAll(`{{${p.key}}}`, value)
  }
  return prompt
}

/** Last pending tool_use id in the session mirror — the thing awaiting approval. */
async function findPendingToolUseId(sessionId: string): Promise<string | null> {
  const { messages } = await agentSessionManager.history(sessionId)
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = (messages[i] as { contentBlocks?: Array<{ type: string; id?: string; status?: string }> }).contentBlocks ?? []
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j]
      if (b.type === 'tool_use' && b.status === 'pending' && b.id) return b.id
    }
  }
  return null
}

function notify(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title, body })
    notification.on('click', () => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    })
    notification.show()
  } catch { /* notifications are best-effort */ }
}

export const routineRunner = {
  /** Fire-and-forget execution; resolves immediately with the run record while
   *  the run continues in the background (scheduler ticks must not block). */
  start(routine: Routine, trigger: RoutineRun['trigger'], params?: Record<string, string>): RoutineRun {
    const run = routineStore.startRun(routine.id, trigger)
    void this.execute(run, routine, params)
    return run
  },

  async execute(run: RoutineRun, routine: Routine, params?: Record<string, string>): Promise<void> {
    const convId = `routine_${Date.now()}_${randomUUID().slice(0, 6)}`
    let settled = false
    let unsubscribe: (() => void) | null = null
    const finish = (status: RoutineRun['status'], error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      unsubscribe?.()
      routineStore.finishRun(run.id, { status, conversationId: convId, error })
      notify(
        status === 'success' ? `日常任务完成：${routine.name}` : `日常任务失败：${routine.name}`,
        status === 'success' ? '点击查看结果' : (error ?? '').slice(0, 120),
      )
    }
    const timeout = setTimeout(() => {
      void agentSessionManager.engineCall(convId, 'stopExecution', []).catch(() => {})
      finish('failed', `运行超时（${RUN_TIMEOUT_MS / 60000} 分钟）`)
    }, RUN_TIMEOUT_MS)

    // Unattended gates: reject approvals, answer ask_user, stop on loop limits.
    const onEvent = (sessionId: string, data: AgentEventData): void => {
      if (sessionId !== convId || settled) return
      if (data.type === 'status' && data.status === 'awaiting_approval') {
        auditStore.record({
          scope: 'routine',
          actor: routine.id,
          action: 'exec',
          target: convId,
          decision: 'rejected',
          metaJson: JSON.stringify({ reason: 'unattended auto-reject (D13)' }),
        })
        void findPendingToolUseId(convId).then((toolUseId) => {
          if (toolUseId) void agentSessionManager.engineCall(convId, 'rejectTool', [toolUseId])
        })
      } else if (data.type === 'status' && data.status === 'awaiting_user_input') {
        void findPendingToolUseId(convId).then((toolUseId) => {
          if (toolUseId) void agentSessionManager.engineCall(convId, 'respondToTool', [toolUseId, '（无人值守运行：已自动跳过此提问）'])
        })
      } else if (data.type === 'status' && (data.status === 'awaiting_continue' || data.status === 'awaiting_extension')) {
        void agentSessionManager.engineCall(convId, 'stopExecution', []).catch(() => {})
      } else if (data.type === 'done') {
        finish('success')
      } else if (data.type === 'error') {
        finish('failed', data.message)
      }
    }
    unsubscribe = agentSessionManager.onEvent(onEvent)

    try {
      await agentSessionManager.createSession(convId, { title: `[日常] ${routine.name}`, clientId: 'routine' })
      await agentSessionManager.ask(convId, renderRoutinePrompt(routine, params))
    } catch (err) {
      finish('failed', err instanceof Error ? err.message : String(err))
    }
  },
}
