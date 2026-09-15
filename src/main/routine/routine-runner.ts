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
import { shortUuid } from '../utils/id'
import { agentSessionManager } from '../agent/session-manager'
import { routineStore } from '../storage/routine-store'
import { auditStore } from '../storage/audit-store'
import { saveConversation } from '../storage/conversation.db'
import { agentMessagesToConversation } from '../../renderer/src/utils/message-utils'
import type { AgentEventData } from '../../shared/agent-protocol'
import type { AgentMessage } from '../../renderer/src/types/agent'
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

/** Write the run's transcript into the conversations store — main-hosted
 *  sessions have no renderer to persist for them, and run-history click-through
 *  reads from this store. The conversation carries the 'routine' type (derived
 *  from its id), so it never surfaces in the user's chat list or search. */
async function persistTranscript(convId: string, routine: Routine): Promise<void> {
  try {
    const { messages } = await agentSessionManager.history(convId)
    if (!Array.isArray(messages) || messages.length === 0) return
    saveConversation(agentMessagesToConversation(messages as AgentMessage[], convId, `[日常] ${routine.name}`))
  } catch (err) {
    console.warn('[RoutineRunner] transcript persistence failed:', err)
  }
}

export const routineRunner = {
  /** Fire-and-forget execution; resolves immediately with the run record while
   *  the run continues in the background (scheduler ticks must not block).
   *  The conversation id is generated here so it lands in the run row from the
   *  start — run-history can attach to the live session mid-run. */
  start(routine: Routine, trigger: RoutineRun['trigger'], params?: Record<string, string>): RoutineRun {
    const convId = `routine_${Date.now()}_${shortUuid(6)}`
    const run = routineStore.startRun(routine.id, trigger, convId)
    void this.execute(run, routine, convId, params)
    return run
  },

  async execute(run: RoutineRun, routine: Routine, convId: string, params?: Record<string, string>): Promise<void> {
    let settled = false
    let unsubscribe: (() => void) | null = null
    const finish = (status: RoutineRun['status'], error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      unsubscribe?.()
      routineStore.finishRun(run.id, { status, conversationId: convId, error })
      // Persist before announcing: a click-through must find the conversation.
      void persistTranscript(convId, routine).then(() => {
        notify(
          status === 'success' ? `日常任务完成：${routine.name}` : `日常任务失败：${routine.name}`,
          status === 'success' ? '点击查看结果' : (error ?? '').slice(0, 120),
        )
      })
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
        // Unattended: nobody will click 继续. stopExecution only parks the
        // engine at idle — it emits no done/error — so the run must be settled
        // here or it hangs 'running' until the timeout marks it failed.
        void agentSessionManager.engineCall(convId, 'stopExecution', []).catch(() => {})
        finish('success')
      } else if (data.type === 'status' && data.status === 'completed') {
        // A finished loop is reported as a status, not a 'done' event — the
        // main-hosted session manager never emits 'done'/'error' (only the ws
        // protocol defines them), so settlement must key off statuses.
        finish('success')
      } else if (data.type === 'status' && data.status === 'error') {
        finish('failed', data.error ?? '任务执行出错')
      } else if (data.type === 'done') {
        finish('success')
      } else if (data.type === 'error') {
        finish('failed', data.message)
      }
    }
    unsubscribe = agentSessionManager.onEvent(onEvent)

    try {
      await agentSessionManager.createSession(convId, {
        title: `[日常] ${routine.name}`,
        clientId: 'routine',
        // A scheduled run has no conversation of its own to have chosen a level,
        // so pin the unattended default explicitly: calls that leave the
        // workspace stay gated and the runner rejects them (D13) rather than
        // silently letting an unwatched run do anything. Written as a literal
        // and not DEFAULT_APPROVAL_MODE, which happens to equal it today — a run
        // nobody is watching must not start widening because a UI default moved.
        approvalMode: 'outside-ask',
      })
      await agentSessionManager.ask(convId, renderRoutinePrompt(routine, params))
    } catch (err) {
      finish('failed', err instanceof Error ? err.message : String(err))
    }
  },
}
