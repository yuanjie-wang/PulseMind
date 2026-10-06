// ── Routine runner (PLAN-0.4.0 M4.5; batch primitive extraction PLAN-routine-batch) ──
// Executes a routine as a real conversation via the main-hosted session
// manager: output is inspectable, token usage lands in token_usage, and the
// per-routine run context (workspace / approval level / model) applies to the
// run's session — absent values fall back to exactly what a normal
// conversation gets (a minted session folder, the unattended default level,
// the active profile).
//
// Unattended approval policy (D13): runs have no user watching. When the agent
// hits an approval gate, the runner REJECTS the pending tool immediately and
// lets the model continue — the rejection (and reason) is recorded in the
// produced conversation. ask_user prompts are answered with a skip notice.
// Nothing ever hangs waiting for a user who isn't there.
//
// The unattended execution body is shared with the batch runner
// (batch-runner.ts): `executeUnattended` is the primitive — one run row, one
// conversation, the gates, the timeout, the settlement — and `start` is the
// single-run entry (assert params, mint the row, fire), keeping its handle in
// a registry so `stop` can interrupt it — the batch runner mints its own child
// rows and calls the primitive per row, suppressing the per-row notification
// and collecting settlements through `onSettled`.

import { BrowserWindow, Notification } from 'electron'
import { shortUuid } from '../utils/id'
import { agentSessionManager } from '../agent/session-manager'
import { routineStore } from '../storage/routine-store'
import { auditStore } from '../storage/audit-store'
import { saveConversation, setConversationApprovalMode, setConversationProfile } from '../storage/conversation.db'
import { resolveConversationWorkspace } from '../storage/conversation-workspace'
import { agentMessagesToConversation } from '../../renderer/src/utils/message-utils'
import { assertRunnableParams, renderRoutinePrompt } from '../../shared/routine/params'
import { DEFAULT_BATCH_TIMEOUT_MINUTES, effectiveTimeoutMinutes } from '../../shared/routine/batch'
import { postSettlementEvent } from './webhook-out'
import type { AgentEventData } from '../../shared/agent-protocol'
import type { AgentMessage } from '../../renderer/src/types/agent'
import type { Routine, RoutineRun } from '../../shared/types/routine'

/** Hard ceiling for one routine run (a hung run must not hold the slot forever).
 *  Derived from the shared batch default so the single-run ceiling and a batch
 *  row's default cannot drift apart — and only a routine WITHOUT a configured
 *  单次超时 lands here; with one, `effectiveTimeoutMinutes` is the ceiling. */
const RUN_TIMEOUT_MS = DEFAULT_BATCH_TIMEOUT_MINUTES * 60_000

/** After a stop is requested: how long the engine gets to report its terminal
 *  status before the row is settled anyway. stopExecution parks the engine at
 *  'idle' (settled by the listener below) — this net only matters for an
 *  engine wedged inside a tool call, and its cost is one late overwrite of an
 *  already-settled row, which finish() is idempotent against. */
const STOP_SETTLE_NET_MS = 10_000

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

/** Best-effort desktop notification — exported for the batch runner's one
 *  summary per batch (children stay silent through notifyOnFinish: false). */
export function notify(title: string, body: string): void {
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
async function persistTranscript(convId: string, title: string): Promise<void> {
  try {
    const { messages } = await agentSessionManager.history(convId)
    if (!Array.isArray(messages) || messages.length === 0) return
    saveConversation(agentMessagesToConversation(messages as AgentMessage[], convId, title))
  } catch (err) {
    console.warn('[RoutineRunner] transcript persistence failed:', err)
  }
}

export interface UnattendedRunOptions {
  /** The routine_runs row this execution settles (single or batch child). */
  runId: string
  routine: Routine
  convId: string
  params?: Record<string, string>
  /** Conversation title in the runs store; default `[日常] ${routine.name}`. */
  transcriptLabel?: string
  /** Batch row number (1-based) — feeds {{row}}. A single run leaves it unset
   *  and the token stays visible, per the placeholder rule. */
  row?: string
  /** Pre-resolved working directory. The batch runner resolves each row's
   *  minted folder SERIALLY (concurrent mints interleave read-then-persist and
   *  would claim one same-second name); single runs leave it unset and resolve
   *  here, exactly as before. */
  workspaceDir?: string
  /** Default true; batch children stay silent — the batch notifies once. */
  notifyOnFinish?: boolean
  /** Hard ceiling for THIS run in ms; absent = RUN_TIMEOUT_MS. The batch
   *  runner passes each row's configured 单次超时 (normalized to whole
   *  minutes at the start/resume door); a single run passes the routine's own
   *  configured value through the same `effectiveTimeoutMinutes` chain, so the
   *  config bounds both shapes of run. */
  timeoutMs?: number
  /** The batch pool's slot-release point: fires after the run row is finished
   *  AND the transcript is persisted (both halves of "this row is inspectable").
   *  `skipped` (PLAN-routine-triggers M1) carries this run's auto-handled
   *  approval/question counts — the batch parent aggregates them for the one
   *  settlement webhook. Optional params keep every existing consumer valid. */
  onSettled?: (status: 'success' | 'failed', error?: string, skipped?: { approvals: number; questions: number }) => void
}

export interface UnattendedRunHandle {
  /** Abort the run: stop the engine and settle the row — failed with 「用户停止」,
   *  unless the turn actually completed in the race window. No-op after settlement. */
  stop(): void
}

/** The one unattended execution body every routine run goes through. Fire and
 *  forget: resolves once the session is created and the prompt dispatched —
 *  the run itself settles later, via events (or the timeout / stop net). */
export function executeUnattended(opts: UnattendedRunOptions): UnattendedRunHandle {
  const { routine, convId } = opts
  let settled = false
  let stopRequested = false
  let unsubscribe: (() => void) | null = null
  const stopNet: { t?: NodeJS.Timeout } = {}
  // D13 auto-handled calls the user never saw (PLAN-routine-triggers M1):
  // approvals rejected + questions skipped. They ride the settlement
  // notification and the webhook event — an unattended run must be able to
  // tell the user afterwards WHAT nobody approved.
  const skipped = { approvals: 0, questions: 0 }
  const finish = (status: 'success' | 'failed', error?: string): void => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    if (stopNet.t) clearTimeout(stopNet.t)
    unsubscribe?.()
    routineStore.finishRun(opts.runId, { status, conversationId: convId, error })
    // The unattended window ends with the run: drop the create-time pins
    // (approval level AND model) so post-run continuations in the run
    // transcript follow the conversation's own stored choices — the columns
    // seeded above, so what the composer shows is what the run used. The pins
    // held while nobody was watching; they must not outlive that (a surviving
    // profile pin would also silence the user's own model pick until restart).
    agentSessionManager.releaseRunPins(convId)
    // Persist before announcing: a click-through must find the conversation.
    void persistTranscript(convId, opts.transcriptLabel ?? `[日常] ${routine.name}`).then(() => {
      if (opts.notifyOnFinish !== false) {
        const skippedNote = skipped.approvals + skipped.questions > 0
          ? `（审批跳过 ${skipped.approvals} · 提问跳过 ${skipped.questions}）`
          : ''
        notify(
          status === 'success' ? `日常任务完成：${routine.name}` : `日常任务失败：${routine.name}`,
          (status === 'success' ? '点击查看结果' : (error ?? '').slice(0, 120)) + skippedNote,
        )
        void postSettlementEvent({
          event: 'routine.settled',
          routineId: routine.id,
          runId: opts.runId,
          conversationId: convId,
          status,
          error,
          skipped: { ...skipped },
          finishedAt: new Date().toISOString(),
        })
      }
      opts.onSettled?.(status, error, { ...skipped })
    })
  }
  // Production values are whole minutes (normalizeBatchTimeoutMinutes), so the
  // message reads clean; a direct caller passing sub-minute ms just gets a
  // fraction there — the ceiling itself is still exact.
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS
  const timeout = setTimeout(() => {
    void agentSessionManager.engineCall(convId, 'stopExecution', []).catch(() => {})
    finish('failed', `运行超时（${timeoutMs / 60000} 分钟）`)
  }, timeoutMs)

  // Unattended gates: reject approvals, answer ask_user, stop on loop limits.
  const onEvent = (sessionId: string, data: AgentEventData): void => {
    if (sessionId !== convId || settled) return
    if (stopRequested && data.type === 'status' && (data.status === 'idle' || data.status === 'completed' || data.status === 'error')) {
      // The stop's own settlement: 'idle' is what stopExecution parks the
      // engine at; a 'completed' in the race window means the row genuinely
      // finished — it stays a success, not a casualty of the stop.
      if (data.status === 'completed') finish('success')
      else if (data.status === 'error') finish('failed', data.error ?? '任务执行出错')
      else finish('failed', '用户停止')
      return
    }
    if (data.type === 'status' && data.status === 'awaiting_approval') {
      skipped.approvals += 1
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
      skipped.questions += 1
      void findPendingToolUseId(convId).then((toolUseId) => {
        if (toolUseId) void agentSessionManager.engineCall(convId, 'respondToTool', [toolUseId, '（无人值守运行：已自动跳过此提问）'])
      })
    } else if (data.type === 'status' && data.status === 'awaiting_extension') {
      // Unattended: nobody will click 继续. stopExecution only parks the engine
      // at idle — it emits no done/error — so the run must be settled HERE;
      // removing the settlement hangs the row 'running' until the timeout
      // marks it failed. The settlement itself is a FAILURE (2026-09-29): the
      // old finish('success') made a task that burned its whole loop budget
      // read as 成功 in run history — the one arm of this switch that left no
      // trace, while the timeout arm settles as failed.
      void agentSessionManager.engineCall(convId, 'stopExecution', []).catch(() => {})
      finish('failed', `任务触及单回合轮次上限（${data.currentCount ?? '?'}/${data.limit ?? '?'} 轮）仍未完成`)
    } else if (data.type === 'status' && data.status === 'awaiting_continue') {
      // Same settlement discipline; the wording names the actual park — the
      // engine stopped to wait for a user decision (pause / plan confirmation)
      // that nobody in an unattended run will make.
      void agentSessionManager.engineCall(convId, 'stopExecution', []).catch(() => {})
      finish('failed', '任务在无人值守运行中等待用户决策（暂停或计划确认），已停止')
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

  void (async () => {
    try {
      // Run context (user-configured per routine): an explicit workspace runs
      // as-is; otherwise the run mints its own session folder under the global
      // workspace — the SAME resolution a normal conversation gets. It must be
      // resolved HERE: clientId 'routine' fails doCreateSession's
      // isLocalUiSession gate, so the session manager would never resolve a
      // project/global workspace for this session on its own. In batch mode a
      // routine without a pinned dir therefore mints one folder PER ROW (the
      // runner resolves them serially — see batch-runner).
      const workspaceDir = opts.workspaceDir?.trim()
        || routine.workspaceDir?.trim()
        || await resolveConversationWorkspace(convId)
      // Seed the conversation's OWN columns with the run context (user
      // 2026-09-27: continuing a run's conversation must carry the 授权/模型
      // the run ran with). The opts below pin the values only for the run's
      // window — releaseRunPins drops them at settlement and a restart drops
      // them with the process — while the run transcript's composer and every
      // post-run resolution read these columns. The approval level is always
      // recorded (the effective one); the model only when the routine pinned
      // one (absent = the active profile at run time, a run-time resolution,
      // not this conversation's choice). The setters stub-insert the row (the
      // transcript itself is persisted only at settlement) and later saves
      // never touch binding columns. Straight to the DB layer, NOT
      // setApprovalMode/setSessionProfile — a scheduled run must not rewrite
      // the global last-used values.
      setConversationApprovalMode(convId, routine.approvalMode ?? 'outside-ask')
      const pinnedProfileId = routine.profileId?.trim() || undefined
      if (pinnedProfileId) setConversationProfile(convId, pinnedProfileId)
      await agentSessionManager.createSession(convId, {
        title: opts.transcriptLabel ?? `[日常] ${routine.name}`,
        clientId: 'routine',
        workspaceDir,
        // Approval level (user 2026-09-21: the run context is selectable, the
        // default stays the unattended one). Whatever the level, the gates
        // above answer them without a user: 'outside-ask' rejects exec-tier
        // calls, 'always-ask' rejects writes+exec (a read-only run), 'auto'
        // gates nothing. Written as a literal and not DEFAULT_APPROVAL_MODE,
        // which happens to equal it today — a run nobody is watching must not
        // start widening because a UI default moved.
        approvalMode: routine.approvalMode ?? 'outside-ask',
        // Model pin: the session pins the routine's profile, so a global 模型
        // switch mid-run cannot move it; a deleted profile falls back to the
        // active one inside resolveProfile.
        profileId: pinnedProfileId,
      })
      // A stop requested while createSession was still in flight never reached
      // the engine (the session did not exist yet, so the engineCall no-oped)
      // — dispatching the prompt anyway would run the whole task with the
      // gates about to be torn down by the stop's own settlement. Settle the
      // row here instead; finish clears the stop net and releases the pin
      // (review_20260922 M2).
      if (stopRequested) {
        finish('failed', '用户停止')
        return
      }
      await agentSessionManager.ask(convId, renderRoutinePrompt(routine, opts.params, { workspaceDir, row: opts.row }))
    } catch (err) {
      finish('failed', err instanceof Error ? err.message : String(err))
    }
  })()

  return {
    stop(): void {
      if (settled || stopRequested) return
      stopRequested = true
      void agentSessionManager.engineCall(convId, 'stopExecution', []).catch(() => {})
      stopNet.t = setTimeout(() => finish('failed', '用户停止'), STOP_SETTLE_NET_MS)
    },
  }
}

/** In-flight single runs by run id — what 停止 reaches. Batch rows are NOT
 *  here: the batch runner holds their handles in its own state map and stops
 *  them through routineBatchRunner.stop. An entry lives exactly as long as its
 *  run: it is removed on settlement (onSettled, after the transcript is
 *  persisted) — NOT on stop itself, because the row keeps reading 运行中 for
 *  the beat it takes stopExecution to park the engine, and a second click in
 *  that window must be a harmless repeat rather than an error toast. */
const activeSingleRuns = new Map<string, UnattendedRunHandle>()

export const routineRunner = {
  /** Fire-and-forget execution; resolves immediately with the run record while
   *  the run continues in the background (scheduler ticks must not block).
   *  The conversation id is generated here so it lands in the run row from the
   *  start — run-history can attach to the live session mid-run. */
  start(routine: Routine, trigger: RoutineRun['trigger'], params?: Record<string, string>): RoutineRun {
    // A run whose required params resolved blank would execute a mangled prompt
    // (「检查  仓库的漏洞」) with nothing warning — refuse here instead. A manual
    // run throws so the click surfaces the reason; a scheduled fire has nobody
    // to tell, so it lands in run history as a failed run carrying it. The
    // 单次超时 rides the same door for the same reason (a hand-edited routine
    // whose timeout is out of range refuses the run rather than running under a
    // ceiling the user did not choose), and it is the task's config — a single
    // run inherits it exactly like a batch row does.
    let timeoutMs: number
    try {
      assertRunnableParams(routine, params)
      timeoutMs = effectiveTimeoutMinutes(routine.batch) * 60_000
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (trigger === 'manual') throw err
      const run = routineStore.startRun(routine.id, trigger, '')
      routineStore.finishRun(run.id, { status: 'failed', error: message })
      return run
    }
    const convId = `routine_${Date.now()}_${shortUuid(6)}`
    const run = routineStore.startRun(routine.id, trigger, convId)
    activeSingleRuns.set(run.id, executeUnattended({
      runId: run.id,
      routine,
      convId,
      params,
      timeoutMs,
      // The pool's slot-release point doubles as registry cleanup: once the
      // row is finished AND its transcript persisted there is nothing left
      // for 停止 to interrupt.
      onSettled: () => activeSingleRuns.delete(run.id),
    }))
    return run
  },

  /** 停止 an in-flight single run: interrupt the engine (stopExecution) and
   *  settle the row 「用户停止」 through the primitive's own handle — the event
   *  listener keys off `stopRequested`, so stopping any other way would leave
   *  the row 'running' until its timeout. Repeating the stop while the first
   *  one is still landing is a no-op inside the handle. No live handle at all
   *  (already settled, a batch parent/child, a row from before a restart) →
   *  throws, so a stale 运行中 row's click says why instead of silently doing
   *  nothing. */
  stop(runId: string): void {
    const handle = activeSingleRuns.get(runId)
    if (!handle) throw new Error('该运行已不在进行中')
    const run = routineStore.getRun(runId)
    if (run) auditStore.record({ scope: 'routine', actor: run.routineId, action: 'run.stop', target: runId, decision: 'allowed' })
    handle.stop()
  },
}
