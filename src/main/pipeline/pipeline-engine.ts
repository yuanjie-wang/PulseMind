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
import { saveConversation } from '../storage/conversation.db'
import { resolveTaskRunContext } from '../task/run-context'
import { agentMessagesToConversation } from '../../renderer/src/utils/message-utils'
import { parsePipelineResult, artifactPathError, PREFIX } from '../../shared/workflow/contract'
import { renderStagePrompt, resolveObjective } from '../../shared/workflow/render'
import { builtinRoutineVars } from '../../shared/routine/params'
import { validateWorkflow } from '../../shared/workflow/validate'
import { depthOf, isLoopEdge, loopEdgeKeys } from '../../shared/workflow/layout'
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
 *  ask 后事件网继续等下一个 completed）。
 *
 *  完成信号的主通道是 `finish_stage` 工具（2026-11-11）：引擎把最近一次合法
 *  调用记在阶段会话上，这里先读它；只有完全没有记录时才回落扫描末条 assistant
 *  正文的 PIPELINE_RESULT 契约行（弱模型 / 网关剥掉 tool_use 的兜底）。文本里
 *  另有一个合法契约而记录也在时，以记录为准——工具调用的参数已经过 schema 与
 *  词汇表双重校验，是「可机检的完成事件」，正文只是散文。 */
function settleStage(
  convId: string,
  node: WorkflowNode,
  workflow: WorkflowDefinition,
  continuesRef: { count: number },
  finish: (o: StageOutcome) => void,
): void {
  void (async () => {
    const record = agentSessionManager.getStageFinishRecord(convId)
    const textContract = parsePipelineResult(await lastAssistantText(convId))
    // 有效记录优先；记录越表（工作流在运行中被改过词汇表）时仍接受一个合法的
    // 文本契约——否则那条陈旧记录会把激发臂永远挡在门外，改对也无法收敛。
    const contract = [record, textContract].find((c) => c && node.verdicts.includes(c.verdict)) ?? record ?? textContract
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
        ? `完成信号 verdict「${contract.verdict}」不在本阶段出口词汇表 [${node.verdicts.join(', ')}] 内`
        : '结束回合里没有找到完成信号：既没有调用 finish_stage，也没有在正文里输出 PIPELINE_RESULT 契约行'
      try {
        await agentSessionManager.ask(
          convId,
          `你的阶段没有正确结束：${reason}。请继续完成本阶段工作；完成后调用 \`finish_stage\` 工具声明结果（verdict 只能是 ${node.verdicts.join(' / ')} 之一，summary 一句话总结，artifacts 是交付物相对路径）。如果工具不可用，才在最后一条消息末尾单独输出一行契约：
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

/** 出口状态词汇表注入（user 2026-11-09 自定义结果状态）。
 *  默认单出口 ['pass'] 的工作流**一个字节都不加**——内置模板的 prompt 里本来
 *  就写着 pass，再补一段说明只是噪音，也让老会话的 prompt 保持逐字不变。
 *  自定义了词汇表时把合法状态与契约行模板补在指令末尾：阶段 prompt 是模型
 *  唯一的规格来源，词汇表只出现在早停修复消息里（settleStage）等于让模型先
 *  猜错一轮再被纠正，白烧一个 continue 名额。
 *  状态**定义**（`verdictDefs`）一起带上（user 2026-11-09「定义结果状态时还需要
 *  明确状态定义」）：只给名字的话 success / failed 的分界线全靠模型猜，而这条
 *  出口是调度键——猜错就走错分支。没有定义的状态只列名字。 */
function stageContractNote(node: WorkflowNode): string {
  if (node.verdicts.length <= 1 && (node.verdicts[0] ?? 'pass') === 'pass') return ''
  const example = node.verdicts[0] ?? 'pass'
  const defined = node.verdicts.some((v) => (node.verdictDefs?.[v] ?? '').trim().length > 0)
  const list = defined
    ? [
        '本阶段的结果状态只能取下面这些，按定义判断该报哪一个：',
        ...node.verdicts.map((v) => {
          const def = (node.verdictDefs?.[v] ?? '').trim()
          return def ? `- ${v}：${def}` : `- ${v}`
        }),
      ].join('\n')
    : `本阶段的结果状态只能取：${node.verdicts.join(' / ')}。`
  return [
    '',
    '---',
    list,
    '完成本阶段时调用 `finish_stage` 工具声明结果，verdict 必须逐字取自上面的状态名（大小写照抄）；调用成功后本阶段立即结算，不要再用普通文本声明完成。',
    '如果工具不可用（或网关不转发工具调用），才在最后一条消息末尾单独输出一行契约作为兜底：',
    `${PREFIX} {"verdict":"${example}","summary":"<一句话总结>","artifacts":["<交付物相对路径>"]}`,
  ].join('\n')
}

/** 一条上游的结算声明（artifacts 是相对路径，尚未读盘）。 */
interface StageUpstreamRef {
  id: string
  title: string
  verdict: string
  summary: string
  artifacts: string[]
}

/** 结算 + 读盘后的上游（runStage 的 prev 元素）。读盘发生在本节点的阶段
 *  开跑之前，看到的是前序阶段落盘的最终状态。 */
interface StageUpstream {
  id: string
  title: string
  verdict: string
  summary: string
  artifacts: Array<{ path: string; content: string }>
}

/** 上游汇总 → 渲染输入。单上游与多上游之前的行为逐字一致；多上游的摘要
 *  按【节点标题】分段，verdict 去重后 '/' 连接，交付物按路径去重拼接。 */
function mergePrevForPrompt(prev: StageUpstream[] | undefined): {
  verdict: string
  summary: string
  artifacts: Array<{ path: string; content: string }>
} | undefined {
  if (!prev || prev.length === 0) return undefined
  if (prev.length === 1) {
    const one = prev[0]
    return { verdict: one.verdict, summary: one.summary, artifacts: one.artifacts }
  }
  const seen = new Set<string>()
  const artifacts: Array<{ path: string; content: string }> = []
  for (const u of prev) {
    for (const a of u.artifacts) {
      if (seen.has(a.path)) continue
      seen.add(a.path)
      artifacts.push(a)
    }
  }
  return {
    verdict: [...new Set(prev.map((u) => u.verdict))].join(' / '),
    summary: prev.map((u) => `【${u.title}】\n${u.summary}`).join('\n\n'),
    artifacts,
  }
}

export interface RunStageOptions {
  /** pipeline_stage_runs 的行 id。 */
  stageRowId: string
  runId: string
  workflow: WorkflowDefinition
  node: WorkflowNode
  /** 1 起的访问计数。 */
  visit: number
  /** 实例解析后的工作区（runWorkflowInstance 已保证非空，各阶段共享）。 */
  workspaceDir: string
  runObjective: string
  /** 任务共享内核 P1：授权档/模型 pin（缺席 = 缺省 'auto' / 激活档）。 */
  approvalMode?: import('../../shared/sandbox/policy').SandboxApprovalMode
  profileId?: string
  /** plan 可选（user 2026-11-08 二期：plan 只是可能的输入之一，不再硬性前置）。 */
  planPath?: string
  planContent?: string
  /** 用户自定义输入变量（WorkflowDefinition.inputs 声明的键的取值）。 */
  vars?: Record<string, string>
  /** 批量实例的 1-based 行号（内置 {{row}}；单次运行缺席 = token 保持可见）。 */
  row?: string
  /** 上游结算（入口节点/无入边 = 缺席）。多分支汇入时是数组：AND-join
   *  在全部前向上游结算后一次交给本阶段。 */
  prev?: StageUpstream[]
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

  // 占位符渲染（{{prevArtifacts}} 在入口读盘——调用侧已按上游逐个读完）。
  const prevRender = mergePrevForPrompt(opts.prev)
  const prompt =
    renderStagePrompt(node, {
      runObjective: opts.runObjective,
      workflowObjective: workflow.objective,
      planPath: opts.planPath,
      planContent: opts.planContent,
      workspace: opts.workspaceDir,
      prevVerdict: prevRender?.verdict,
      prevSummary: prevRender?.summary,
      prevArtifacts: prevRender?.artifacts,
      visit: opts.visit,
      vars: opts.vars,
      builtins: builtinRoutineVars({ workspaceDir: opts.workspaceDir, row: opts.row }),
    }) + stageContractNote(node)

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
      // 运行上下文走任务共享内核（routine 同一 resolver）：授权档缺省仍
      // 'auto'（coding 需 exec 层跑测试，sop-runner 先例），模型 pin 来自
      // 工作流定义/启动参数（缺席 = 激活档）。列播种先于 createSession，
      // 续聊沿用运行时授权/模型的契约与 routine 同源。
      const resolved = await resolveTaskRunContext(
        convId,
        { workspaceDir: opts.workspaceDir, approvalMode: opts.approvalMode, profileId: opts.profileId },
        'auto',
      )
      await agentSessionManager.createSession(convId, {
        title: `[流水线] ${workflow.name} · ${node.title}`,
        clientId: 'routine',
        workspaceDir: resolved.workspaceDir,
        approvalMode: resolved.approvalMode,
        ...(resolved.profileId ? { profileId: resolved.profileId } : {}),
        // 阶段完成协议（2026-11-11）：本会话的工具表合并 finish_stage，参数
        // schema 的 verdict enum 直接取本节点出口词汇表；引擎记录的最近一次
        // 合法调用由 settleStage 优先读取（文本 PIPELINE_RESULT 降为兜底）。
        stageFinish: {
          verdicts: node.verdicts,
          ...(node.verdictDefs ? { verdictDefs: node.verdictDefs } : {}),
        },
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
  /** plan 可选：缺省/空 = 实例不读 plan（渲染端给（未提供 plan 内容）空态）。 */
  planPath?: string
  /** 手动路径由启动面传入；定时路径缺席 = 实例级 mint 一次（锚点会话只落
   *  workspace 列、零消息不进任何列表），各阶段共享同一目录（git 门所需）。 */
  workspaceDir?: string
  /** 运行级目标（启动表单传入，可空 → 工作流级 → 空）。 */
  runObjective?: string
  /** 用户自定义输入变量的取值（整个运行共用一份）。 */
  vars?: Record<string, string>
  /** 任务共享内核 P1：授权档/模型 pin（缺省链：启动参数 > 定义 > 'auto'/激活档）。 */
  approvalMode?: import('../../shared/sandbox/policy').SandboxApprovalMode
  profileId?: string
  /** 批量实例的行号（P2；单次/plan 队列缺席）。 */
  row?: string
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

/** 从 entry 起按边表走。串行、单实例在跑（FIFO 队列在 pipelineEngine）。
 *
 *  调度是**就绪队列 + 前向依赖集**（user 2026-11-09 多出口/多入口）：一个
 *  节点可以连出多条'pass'边（分支），也可以被多条入边汇入。分出的分支按
 *  就绪顺序逐个执行（分支之间是串行的——同一个 agent 栈不并发），汇入多条
 *  前向边的节点要等**所有前向上游**都结算后才跑一次（AND-join），上下文
 *  汇总各分支的 verdict/摘要/交付物。回边（isLoopEdge）不算前向依赖，否则
 *  一个回踢就能把汇聚点锁死；回边只强制重跑目标节点本身（maxVisits 兜底），
 *  它已完成的下游不连带重跑——真正的循环要靠 verdict 分支，而简化模型里
 *  只有 'pass'，所以今天不存在可用的循环工作流，这不是回归。 */
export async function runWorkflowInstance(opts: RunInstanceOptions): Promise<RunInstanceResult> {
  const { workflow } = opts
  const v = validateWorkflow(workflow)
  if (!v.ok) return { status: 'failed', error: `工作流校验失败：${v.errors.join('；')}` }

  const runObjective = resolveObjective({ runObjective: opts.runObjective, workflowObjective: workflow.objective })
  // 实例级运行上下文：workspaceDir 显式传入即用（手动路径）；定时路径在此
  // mint 一次（锚点 pipe_ 会话只落 workspace 列、零消息不进任何列表），
  // 目录写回 run 行供展开面显示。授权/模型 pin 逐阶段由 resolveTaskRunContext
  // 播种（runStage 内），这里只透传声明值。
  let workspaceDir = opts.workspaceDir?.trim()
  if (!workspaceDir) {
    const anchor = mintStageConvId()
    const resolved = await resolveTaskRunContext(anchor, { approvalMode: opts.approvalMode, profileId: opts.profileId }, 'auto')
    workspaceDir = resolved.workspaceDir
    pipelineRunStore.updateRun(opts.runId, { workspaceDir })
  }
  const planContent = opts.planPath ? await readPlanContent(opts.planPath, workspaceDir) : undefined

  // git checkpoint 启动门：非 git 仓库或工作树脏 → 报错拒跑。
  let baseline: string | null = null
  if (workflow.params?.gitCheckpoint ?? true) {
    const gateError = await gitCheckpointGate(workspaceDir)
    if (gateError) return { status: 'failed', error: gateError }
    baseline = await gitBaseline(workspaceDir)
    if (baseline) pipelineRunStore.updateRun(opts.runId, { baselineCommit: baseline })
  }

  const failRun = async (error: string, currentNode: string): Promise<RunInstanceResult> => {
    pipelineRunStore.updateRun(opts.runId, { status: 'failed', currentNode, finishedAt: new Date().toISOString(), error })
    if (baseline) await gitResetToBaseline(workspaceDir, baseline)
    return { status: 'failed', error }
  }

  const depth = depthOf(workflow)
  const loopKeys = loopEdgeKeys(workflow)
  const nodeById = new Map(workflow.nodes.map((n) => [n.id, n]))
  // 前向依赖集：每个节点要等哪些**前向**上游先结算（回边豁免）。
  const waiting = new Map<string, Set<string>>()
  for (const n of workflow.nodes) waiting.set(n.id, new Set())
  for (const e of workflow.edges) {
    if (!nodeById.has(e.from) || !nodeById.has(e.to)) continue
    if (isLoopEdge(loopKeys, e)) continue
    waiting.get(e.to)!.add(e.from)
  }

  const queue: string[] = []
  const queued = new Set<string>()
  const done = new Set<string>()
  /** 没被走到的分支上的节点：依赖已了结但没有任何上游上下文推进来。
   *  它们不执行、也不算死锁（那是条件分支的正常面）。 */
  const skipped = new Set<string>()
  const arrivals = new Map<string, StageUpstreamRef[]>()
  const enqueue = (id: string): void => {
    if (done.has(id) || queued.has(id)) return
    queued.add(id)
    queue.push(id)
  }
  /** 回边 / RETRY 的强制重入：目标已完成也再排一次（maxVisits 兜底）。
   *   arrivals 不动——回边来源刚推进来的那一条就是重入节点的上游上下文。
   *   skipped 必须清掉：被跳过的节点此刻重入是真要跑。 */
  const forceEnqueue = (id: string): void => {
    done.delete(id)
    skipped.delete(id)
    const idx = queue.indexOf(id)
    if (idx !== -1) queue.splice(idx, 1)
    queued.delete(id)
    enqueue(id)
  }
  /** 定点传播：依赖集刚清空的节点，有上游上下文 ⇒ 入队；一条都没有 ⇒ 这支
   *  没被走到（条件分支的对侧），标记 skipped 并解锁自己的前向目标——否则
   *  对侧分支会永久挂着、最后被误判「等待上游但未执行」。 */
  const propagate = (): void => {
    for (let changed = true; changed; ) {
      changed = false
      for (const n of workflow.nodes) {
        if (done.has(n.id) || queued.has(n.id) || skipped.has(n.id)) continue
        if (!depth.has(n.id)) continue // 不可达节点不参与调度
        const deps = waiting.get(n.id)
        if (!deps || deps.size > 0) continue
        if ((arrivals.get(n.id) ?? []).length > 0) {
          enqueue(n.id)
          changed = true
          continue
        }
        if (n.id === workflow.entry) continue // 入口无前向上游也要跑（首轮已入队）
        skipped.add(n.id)
        changed = true
        for (const e of workflow.edges) {
          if (e.from !== n.id || !nodeById.has(e.to)) continue
          if (isLoopEdge(loopKeys, e)) continue
          waiting.get(e.to)?.delete(n.id)
        }
      }
    }
  }

  const visits = new Map<string, number>()
  let stageSeq = 0
  let reachedDone = false
  let lastNodeId = workflow.entry
  enqueue(workflow.entry)

  for (;;) {
    const current = queue.shift()
    if (current === undefined) break
    queued.delete(current)
    if (done.has(current)) continue
    const node = nodeById.get(current)
    if (!node) return await failRun(`边表指向不存在的节点：${current}`, lastNodeId)
    lastNodeId = node.id

    const visit = (visits.get(node.id) ?? 0) + 1
    visits.set(node.id, visit)
    if (visit > maxVisits(workflow)) {
      const error = `节点 ${node.id} 访问达上限（${maxVisits(workflow)}），实例终止`
      return await failRun(error, node.id)
    }

    // 上游上下文：逐条读盘（多分支时各自读完交给 runStage 汇总）。
    const upstreams = await Promise.all(
      (arrivals.get(node.id) ?? []).map(async (u): Promise<StageUpstream> => ({
        ...u,
        artifacts: await readArtifacts(workspaceDir, u.artifacts),
      })),
    )
    arrivals.delete(node.id)

    pipelineRunStore.updateRun(opts.runId, { currentNode: node.id })
    const outcome = await runStage({
      stageRowId: `pstage_${opts.runId}_${++stageSeq}_${shortUuid(4)}`,
      runId: opts.runId,
      workflow,
      node,
      visit,
      workspaceDir,
      approvalMode: opts.approvalMode,
      profileId: opts.profileId,
      row: opts.row,
      runObjective,
      planPath: opts.planPath,
      planContent,
      vars: opts.vars,
      prev: upstreams,
    })

    if (outcome.kind === 'failed') {
      return await failRun(`阶段 ${node.id} 失败：${outcome.reason}`, node.id)
    }

    done.add(node.id)
    const upstreamRef: StageUpstreamRef = {
      id: node.id,
      title: node.title || node.id,
      verdict: outcome.verdict,
      summary: outcome.summary,
      artifacts: outcome.artifacts,
    }

    // 该节点**所有**匹配 verdict 的出边都要走（旧实现只走第一条，分支被静默丢弃）。
    const outEdges = workflow.edges.filter((e) => e.from === node.id && e.when === outcome.verdict)
    // 没有匹配出边 = fail-safe（结论无从调度，实例直接失败）。这不是「走到
    // FAILED 芯片」——终态芯片只有 DONE，报错要把状态名与补救动作都说清。
    if (outEdges.length === 0) {
      return await failRun(
        `阶段 ${node.id} 报告 verdict「${outcome.verdict}」，但该节点没有这个状态的出边（在画布上从「${outcome.verdict}」出口连一条线）`,
        node.id,
      )
    }

    for (const target of new Set(outEdges.map((e) => e.to))) {
      if (target === 'FAILED') {
        return await failRun(`阶段 ${node.id} 报告 verdict「${outcome.verdict}」，边表指向 FAILED`, node.id)
      }
      if (target === 'DONE') {
        // 不立即 return：其它分支还要跑完（AND-join 的汇入方也要看到它们）。
        reachedDone = true
        continue
      }
      if (target === 'RETRY') {
        forceEnqueue(node.id)
        continue
      }
      const list = arrivals.get(target) ?? []
      list.push(upstreamRef)
      arrivals.set(target, list)
      if (isLoopEdge(loopKeys, { from: node.id, to: target })) forceEnqueue(target)
    }

    // 没走到的分支也要结清：本节点对所有**前向**目标的依赖都已了结（不管走没
    // 走到那条边）。条件分支的对侧目标因此不会被永久挂着。
    for (const e of workflow.edges) {
      if (e.from !== node.id || !nodeById.has(e.to)) continue
      if (isLoopEdge(loopKeys, e)) continue
      waiting.get(e.to)?.delete(node.id)
    }
    propagate()
  }

  // 队列抽空收口：skipped 是「这支没被走到」，正常面；依赖集本来就空的未跑
  // 节点也一样（扇出时正常）。走到这里还挂着上游的只可能是前向图里有环没被判
  // 成回边（validate 已拦）——留着当防御网。不可达节点不参与。
  const blockedIds: string[] = []
  const blockedDetail: string[] = []
  for (const n of workflow.nodes) {
    if (done.has(n.id) || skipped.has(n.id) || !depth.has(n.id)) continue
    const unmet = [...(waiting.get(n.id) ?? [])]
    if (unmet.length === 0) continue
    blockedIds.push(n.id)
    blockedDetail.push(`${n.id}（上游：${unmet.join('、')}）`)
  }
  if (blockedIds.length > 0) {
    return await failRun(`节点等待上游但未执行：${blockedDetail.join('；')}`, blockedIds[0])
  }
  if (!reachedDone) {
    return await failRun(`实例走完边表但没有分支到达 DONE（最后执行：${lastNodeId}）`, lastNodeId)
  }

  pipelineRunStore.updateRun(opts.runId, { status: 'success', currentNode: lastNodeId, finishedAt: new Date().toISOString() })
  return { status: 'success' }
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
      workspaceDir: opts.workspaceDir ?? '',
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

  /** 撤销一个**尚未启动**的排队实例（P2 批量停止面）：从队列移除并把 run 行
   *  记为失败（无引擎调用）。已在飞的实例走 stop()。 */
  cancel(runId: string): boolean {
    const idx = this.queue.findIndex((q) => q.runId === runId)
    if (idx === -1) return false
    this.queue.splice(idx, 1)
    pipelineRunStore.updateRun(runId, { status: 'failed', finishedAt: new Date().toISOString(), error: '批量已停止（未启动）' })
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
