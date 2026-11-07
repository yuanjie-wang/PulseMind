// PLAN-workflow-engine：流水线引擎。以 routine-runner 的 executeUnattended
// 为蓝本的三层：runStage（阶段执行器，事件网照抄 + 契约结算 + 早停激发臂）、
// runWorkflowInstance（从 entry 起按边表走）、pipelineEngine（FIFO 队列 +
// stop 句柄注册表）。
//
// 无人值守口径（D13 同款）：awaiting_approval → 自动拒 + 审计；
// awaiting_user_input → 自动答；awaiting_extension / awaiting_continue →
// stopExecution + 失败结算。授权缺省 'auto'（coding 需 exec 层跑测试，
// sop-runner 先例——模板可自行写回更严的档）。
//
// 早停判据是状态级 + 阶段出口契约：completed 但契约缺失/verdict 越表 →
// 同一会话 ask 继续激发（点明契约缺失语义），maxStageContinues 上限；
// 状态级失败（error/超时/轮限/停摆）不激发——引擎已死，激发无意义。
//
// git checkpoint（评审缺口①）：启动门拒脏仓库；每阶段结算落 commit；
// 实例 FAILED 回滚基线（只在实例结算时做一次——阶段级失败不回滚，fix
// 循环依赖前序阶段的落盘交付物）。

import { readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { shortUuid } from '../utils/id'
import { agentSessionManager } from '../agent/session-manager'
import { auditStore } from '../storage/audit-store'
import { saveConversation, setConversationApprovalMode } from '../storage/conversation.db'
import { agentMessagesToConversation } from '../../renderer/src/utils/message-utils'
import { parsePipelineResult, artifactPathError } from '../../shared/workflow/contract'
import { renderStagePrompt, resolveObjective } from '../../shared/workflow/render'
import { validateWorkflow } from '../../shared/workflow/validate'
import type { AgentEventData } from '../../shared/agent-protocol'
import type { AgentMessage } from '../../renderer/src/types/agent'
import type { StageOutcome, WorkflowDefinition, WorkflowNode } from '../../shared/workflow/types'
import { gitBaseline, gitCheckpointGate, gitResetToBaseline, gitStageCommit } from './git-checkpoint'
import { pipelineRunStore } from '../storage/pipeline-run-store'

const DEFAULT_STAGE_TIMEOUT_MINUTES = 30
const DEFAULT_MAX_STAGE_CONTINUES = 2
const DEFAULT_MAX_VISITS = 3
/** PIPELINE_RESULT 上一阶段交付物注入时逐文件读盘的帽内读取（render 层还会
 *  再截断到 20k）。 */
const ARTIFACT_READ_BYTES = 64_000

/** 当前在跑的实例 → 其阶段会话 id（stop 钩子的落点）。runStage 在铸会话时
 *  登记、结算时摘除。 */
const activeStageConvs = new Map<string, string>()

function stageTimeoutMs(workflow: WorkflowDefinition): number {
  return (workflow.params?.stageTimeoutMinutes ?? DEFAULT_STAGE_TIMEOUT_MINUTES) * 60_000
}

function maxStageContinues(workflow: WorkflowDefinition): number {
  return workflow.params?.maxStageContinues ?? DEFAULT_MAX_STAGE_CONTINUES
}

function maxVisits(workflow: WorkflowDefinition): number {
  return workflow.params?.defaultMaxVisits ?? DEFAULT_MAX_VISITS
}

/** 每阶段一个独立会话（一个环节一个独立会话的裁定）。pipe_ 前缀登记进
 *  conversation type 派生隐藏名单（routine_/sop_ 先例）。 */
function mintStageConvId(): string {
  const now = new Date()
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  return `pipe_${ts}_${shortUuid(6)}`
}

async function persistTranscript(convId: string, title: string): Promise<void> {
  try {
    const { messages } = await agentSessionManager.history(convId)
    if (!Array.isArray(messages) || messages.length === 0) return
    saveConversation(agentMessagesToConversation(messages as AgentMessage[], convId, title))
  } catch (err) {
    console.warn('[Pipeline] transcript persistence failed:', err)
  }
}

/** Last pending tool_use id in the session mirror — the thing awaiting approval
 *  (routine-runner 同款）。 */
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

/** 末条 assistant 消息全文（契约扫描面）。 */
async function lastAssistantText(convId: string): Promise<string> {
  const { messages } = await agentSessionManager.history(convId)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; contentBlocks?: Array<{ type: string; text?: string }> }
    if (msg.role !== 'assistant') continue
    return (msg.contentBlocks ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
  }
  return ''
}

/** 读上一阶段声明的交付物（「存在即注入」，缺失不硬门——诚实缺口进 summary）。 */
async function readArtifacts(workspaceDir: string, artifacts: string[]): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = []
  for (const rel of artifacts) {
    if (artifactPathError(rel)) continue // 路径门：非法声明不读
    const abs = isAbsolute(rel) ? rel : join(workspaceDir, rel)
    try {
      const content = (await readFile(abs, 'utf-8')).slice(0, ARTIFACT_READ_BYTES)
      out.push({ path: rel, content })
    } catch {
      /* 缺失不硬门 */
    }
  }
  return out
}

/** 契约结算 + 早停激发臂。resolve 一次 = 阶段终局（激发路径不 finish——
 *  ask 后事件网继续等下一个 completed）。 */
function settleStage(
  convId: string,
  node: WorkflowNode,
  workflow: WorkflowDefinition,
  continuesRef: { count: number },
  finish: (o: StageOutcome) => void,
): void {
  void (async () => {
    const text = await lastAssistantText(convId)
    const contract = parsePipelineResult(text)
    if (contract && node.verdicts.includes(contract.verdict)) {
      finish({
        kind: 'settled',
        verdict: contract.verdict,
        summary: contract.summary,
        artifacts: contract.artifacts,
        conversationId: convId,
        continues: continuesRef.count,
      })
      return
    }
    // 早停（契约缺失 / verdict 越表）：激发臂——同一会话 ask 继续提示。
    if (continuesRef.count < maxStageContinues(workflow)) {
      continuesRef.count += 1
      const reason = contract
        ? `契约行 verdict「${contract.verdict}」不在本阶段出口词汇表 [${node.verdicts.join(', ')}] 内`
        : '结束消息中没有找到 PIPELINE_RESULT 契约行'
      try {
        await agentSessionManager.ask(
          convId,
          `你的阶段没有正确结束：${reason}。请继续完成本阶段工作，并在最后一条消息末尾单独输出一行契约（verdict 只能是 ${node.verdicts.join(' / ')} 之一）：
PIPELINE_RESULT: {"verdict":"<…>","summary":"<一句话总结>","artifacts":["<交付物相对路径>"]}`,
        )
      } catch (err) {
        finish({
          kind: 'failed',
          reason: `激发失败：${err instanceof Error ? err.message : String(err)}`,
          conversationId: convId,
          continues: continuesRef.count,
        })
      }
      return
    }
    finish({
      kind: 'failed',
      reason: contract
        ? `早停：verdict「${contract.verdict}」越出词汇表 [${node.verdicts.join(', ')}]，激发 ${continuesRef.count} 次后仍未收敛`
        : '早停：契约缺失，激发次数耗尽',
      conversationId: convId,
      continues: continuesRef.count,
    })
  })()
}

export interface RunStageOptions {
  /** pipeline_stage_runs 的行 id。 */
  stageRowId: string
  runId: string
  workflow: WorkflowDefinition
  node: WorkflowNode
  /** 1 起的访问计数。 */
  visit: number
  workspaceDir: string
  runObjective: string
  planPath: string
  planContent: string
  prev?: { verdict: string; summary: string; artifacts: string[] }
}

/** 阶段执行器：铸会话、渲染 prompt、事件网、超时兜底、契约结算。 */
export async function runStage(opts: RunStageOptions): Promise<StageOutcome> {
  const { workflow, node } = opts
  const convId = mintStageConvId()
  activeStageConvs.set(opts.runId, convId)
  const startedAt = new Date().toISOString()
  pipelineRunStore.startStage({
    id: opts.stageRowId,
    runId: opts.runId,
    nodeId: node.id,
    continues: 0,
    startedAt,
  })

  let settled = false
  let unsubscribe: (() => void) | null = null
  const continuesRef = { count: 0 }
  let resolveOutcome: ((o: StageOutcome) => void) | null = null
  const outcomePromise = new Promise<StageOutcome>((resolve) => {
    resolveOutcome = resolve
  })

  // 占位符渲染（{{prevArtifacts}} 在入口读盘——上一阶段结算后落盘状态活着）。
  const prompt = renderStagePrompt(node, {
    runObjective: opts.runObjective,
    workflowObjective: workflow.objective,
    planPath: opts.planPath,
    planContent: opts.planContent,
    workspace: opts.workspaceDir,
    prevVerdict: opts.prev?.verdict,
    prevSummary: opts.prev?.summary,
    prevArtifacts: opts.prev ? await readArtifacts(opts.workspaceDir, opts.prev.artifacts) : undefined,
    visit: opts.visit,
  })

  const finish = (o: StageOutcome): void => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    unsubscribe?.()
    activeStageConvs.delete(opts.runId)
    pipelineRunStore.finishStage(opts.stageRowId, {
      finishedAt: new Date().toISOString(),
      ...(o.kind === 'settled' ? { verdict: o.verdict, conversationId: o.conversationId, artifacts: o.artifacts } : { error: o.reason }),
      ...(o.conversationId ? { conversationId: o.conversationId } : {}),
    })
    if (o.conversationId) {
      // 转写落库（run-history 同款打开路径的跳转目标）+ 释放无人值守 pins。
      void persistTranscript(o.conversationId, `[流水线] ${workflow.name} · ${node.title}`)
      agentSessionManager.releaseRunPins(o.conversationId)
    }
    // git checkpoint：阶段结算（success/fail 都落 commit——fix 循环要靠
    // 前序阶段的落盘状态）。gitCheckpoint: false 全跳过。**commit 落定后才
    // resolve**——实例层的 FAILED 回滚（git reset --hard）与本阶段提交是
    // 同仓并发，提交若在 reset 之后落地会把回滚冲掉。
    void (async () => {
      if ((workflow.params?.gitCheckpoint ?? true) && o.conversationId) {
        await gitStageCommit(opts.workspaceDir, opts.runId, node.id, o.kind === 'settled' ? o.verdict : 'failed')
      }
      resolveOutcome?.(o)
    })()
  }

  const timeoutMs = stageTimeoutMs(workflow)
  const timeout = setTimeout(() => {
    void agentSessionManager.engineCall(convId, 'stopExecution', []).catch(() => {})
    finish({ kind: 'failed', reason: `阶段超时（${timeoutMs / 60000} 分钟）`, conversationId: convId, continues: continuesRef.count })
  }, timeoutMs)

  const onEvent = (sessionId: string, data: AgentEventData): void => {
    if (sessionId !== convId || settled) return
    if (data.type === 'status' && data.status === 'awaiting_approval') {
      // D13：无人值守，审批自动拒 + 审计。
      auditStore.record({
        scope: 'pipeline',
        actor: opts.runId,
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
        if (toolUseId) void agentSessionManager.engineCall(convId, 'respondToTool', [toolUseId, '（流水线运行：已自动跳过此提问）'])
      })
    } else if (data.type === 'status' && data.status === 'awaiting_extension') {
      void agentSessionManager.engineCall(convId, 'stopExecution', []).catch(() => {})
      finish({
        kind: 'failed',
        reason: `阶段触及单回合轮次上限（${data.currentCount ?? '?'}/${data.limit ?? '?'} 轮）仍未完成`,
        conversationId: convId,
        continues: continuesRef.count,
      })
    } else if (data.type === 'status' && data.status === 'awaiting_continue') {
      void agentSessionManager.engineCall(convId, 'stopExecution', []).catch(() => {})
      finish({ kind: 'failed', reason: '阶段在无人值守运行中等待用户决策（暂停或计划确认），已停止', conversationId: convId, continues: continuesRef.count })
    } else if (data.type === 'status' && data.status === 'completed') {
      // completed = 契约结算面（激发臂在 settleStage 内）。
      settleStage(convId, node, workflow, continuesRef, finish)
    } else if (data.type === 'status' && data.status === 'error') {
      // 状态级失败不激发（引擎已死，激发无意义）。
      finish({ kind: 'failed', reason: data.error ?? '阶段执行出错', conversationId: convId, continues: continuesRef.count })
    } else if (data.type === 'error') {
      finish({ kind: 'failed', reason: data.message, conversationId: convId, continues: continuesRef.count })
    }
  }
  unsubscribe = agentSessionManager.onEvent(onEvent)

  void (async () => {
    try {
      // 授权缺省 'auto'（coding 需 exec 层跑测试，sop-runner 先例）。
      setConversationApprovalMode(convId, 'auto')
      await agentSessionManager.createSession(convId, {
        title: `[流水线] ${workflow.name} · ${node.title}`,
        clientId: 'routine',
        workspaceDir: opts.workspaceDir,
        approvalMode: 'auto',
      })
      await agentSessionManager.ask(convId, prompt)
    } catch (err) {
      finish({ kind: 'failed', reason: err instanceof Error ? err.message : String(err), conversationId: convId, continues: continuesRef.count })
    }
  })()

  return outcomePromise
}

// ── 实例执行 ─────────────────────────────────────────────────────────

export interface RunInstanceOptions {
  runId: string
  workflow: WorkflowDefinition
  planPath: string
  workspaceDir: string
  /** 运行级目标（启动表单传入，可空 → 工作流级 → 空）。 */
  runObjective?: string
}

export interface RunInstanceResult {
  status: 'success' | 'failed'
  error?: string
}

async function readPlanContent(planPath: string, workspaceDir: string): Promise<string> {
  const abs = isAbsolute(planPath) ? planPath : join(workspaceDir, planPath)
  try {
    return await readFile(abs, 'utf-8')
  } catch (err) {
    throw new Error(`plan 文件不可读：${planPath}（${err instanceof Error ? err.message : String(err)}）`)
  }
}

/** 从 entry 起按边表走。串行、单实例在跑（FIFO 队列在 pipelineEngine）。 */
export async function runWorkflowInstance(opts: RunInstanceOptions): Promise<RunInstanceResult> {
  const { workflow } = opts
  const v = validateWorkflow(workflow)
  if (!v.ok) return { status: 'failed', error: `工作流校验失败：${v.errors.join('；')}` }

  const runObjective = resolveObjective({ runObjective: opts.runObjective, workflowObjective: workflow.objective })
  const planContent = await readPlanContent(opts.planPath, opts.workspaceDir)

  // git checkpoint 启动门：非 git 仓库或工作树脏 → 报错拒跑。
  let baseline: string | null = null
  if (workflow.params?.gitCheckpoint ?? true) {
    const gateError = await gitCheckpointGate(opts.workspaceDir)
    if (gateError) return { status: 'failed', error: gateError }
    baseline = await gitBaseline(opts.workspaceDir)
    if (baseline) pipelineRunStore.updateRun(opts.runId, { baselineCommit: baseline })
  }

  const visits = new Map<string, number>()
  let current: string = workflow.entry
  let prev: { verdict: string; summary: string; artifacts: string[] } | undefined
  let stageSeq = 0

  for (;;) {
    const node = workflow.nodes.find((n) => n.id === current)
    if (!node) return { status: 'failed', error: `边表指向不存在的节点：${current}` }
    const visit = (visits.get(node.id) ?? 0) + 1
    visits.set(node.id, visit)
    if (visit > maxVisits(workflow)) {
      const error = `节点 ${node.id} 访问达上限（${maxVisits(workflow)}），实例终止`
      pipelineRunStore.updateRun(opts.runId, { status: 'failed', currentNode: node.id, finishedAt: new Date().toISOString(), error })
      if (baseline) await gitResetToBaseline(opts.workspaceDir, baseline)
      return { status: 'failed', error }
    }

    pipelineRunStore.updateRun(opts.runId, { currentNode: node.id })
    const outcome = await runStage({
      stageRowId: `pstage_${opts.runId}_${++stageSeq}_${shortUuid(4)}`,
      runId: opts.runId,
      workflow,
      node,
      visit,
      workspaceDir: opts.workspaceDir,
      runObjective,
      planPath: opts.planPath,
      planContent,
      prev,
    })

    if (outcome.kind === 'failed') {
      const error = `阶段 ${node.id} 失败：${outcome.reason}`
      pipelineRunStore.updateRun(opts.runId, { status: 'failed', currentNode: node.id, finishedAt: new Date().toISOString(), error })
      if (baseline) await gitResetToBaseline(opts.workspaceDir, baseline)
      return { status: 'failed', error }
    }

    prev = { verdict: outcome.verdict, summary: outcome.summary, artifacts: outcome.artifacts }
    const edge = workflow.edges.find((e) => e.from === node.id && e.when === outcome.verdict)
    const target = edge?.to ?? 'FAILED' // 无出边 = 默认 FAILED（fail-safe）
    if (target === 'DONE') {
      pipelineRunStore.updateRun(opts.runId, { status: 'success', currentNode: node.id, finishedAt: new Date().toISOString() })
      return { status: 'success' }
    }
    if (target === 'FAILED') {
      const error = `阶段 ${node.id} 报告 verdict「${outcome.verdict}」，边表指向 FAILED`
      pipelineRunStore.updateRun(opts.runId, { status: 'failed', currentNode: node.id, finishedAt: new Date().toISOString(), error })
      if (baseline) await gitResetToBaseline(opts.workspaceDir, baseline)
      return { status: 'failed', error }
    }
    current = target === 'RETRY' ? node.id : target
  }
}

// ── pipelineEngine：FIFO 队列 + stop 句柄 ────────────────────────────

interface QueuedInstance {
  runId: string
  opts: RunInstanceOptions
}

class PipelineEngine {
  private queue: QueuedInstance[] = []
  private draining = false
  /** 镜像 activeSingleRuns：当前实例的停止钩子。 */
  private stopHooks = new Map<string, () => void>()

  /** 入队一个实例（plan 文件顺序排队，全局一个实例在跑）。返回 false = 实例
   *  没能创建（工作流缺失/校验失败——错误已落 run 行）。 */
  enqueue(runId: string, opts: RunInstanceOptions): boolean {
    const v = validateWorkflow(opts.workflow)
    if (!v.ok) {
      pipelineRunStore.updateRun(runId, { status: 'failed', finishedAt: new Date().toISOString(), error: v.errors.join('；') })
      return false
    }
    this.queue.push({ runId, opts })
    void this.drain()
    return true
  }

  /** 启动表单的入口：创建 run 行 + 入队。 */
  start(runId: string, opts: RunInstanceOptions): boolean {
    pipelineRunStore.createRun({
      id: runId,
      workflowId: opts.workflow.id,
      workflowName: opts.workflow.name,
      objective: resolveObjective({ runObjective: opts.runObjective, workflowObjective: opts.workflow.objective }),
      workspaceDir: opts.workspaceDir,
      status: 'running',
      currentNode: opts.workflow.entry,
      startedAt: new Date().toISOString(),
    })
    return this.enqueue(runId, opts)
  }

  stop(runId: string): boolean {
    const hook = this.stopHooks.get(runId)
    if (!hook) return false
    hook()
    return true
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!
        // 失败不挡后续（run 行记 error，队列继续下一条 plan）。
        const result = await this.runOne(next)
        if (result.status === 'failed') {
          console.warn(`[Pipeline] instance ${next.runId} failed: ${result.error ?? ''}`)
        }
      }
    } finally {
      this.draining = false
    }
  }

  private async runOne(q: QueuedInstance): Promise<RunInstanceResult> {
    let stopRequested = false
    this.stopHooks.set(q.runId, () => {
      stopRequested = true
      const conv = activeStageConvs.get(q.runId)
      if (conv) void agentSessionManager.engineCall(conv, 'stopExecution', []).catch(() => {})
    })
    try {
      // runWorkflowInstance 不可中断地走完边表；stop 的语义是「停当前阶段」
      // ——阶段事件网收到 error/idle 后按失败结算，实例随后收口。
      const result = await runWorkflowInstance(q.opts)
      if (stopRequested && result.status === 'success') {
        // 竞态窗内的真实完成保持诚实：不把完成改写成失败。
        return result
      }
      return result
    } finally {
      this.stopHooks.delete(q.runId)
    }
  }
}

export const pipelineEngine = new PipelineEngine()
