// ── finish_stage implementation (2026-11-11 stage finish protocol) ──
// The pipeline stage's completion signal, promoted from a prose
// `PIPELINE_RESULT` line to a real tool call. The tool is only merged into a
// stage session's tool table (AgentEngineOptions.stageFinish), so this
// executor must not claim calls from ordinary chats.
//
// Validation is deterministic and lives in shared/workflow/finish-tool:
//   · invalid args  → ordinary tool error; the model corrects in the SAME
//                     turn (does not burn a maxStageContinues slot)
//   · valid args    → record the contract on the engine, return a short ack,
//                     and let execution-flow close the turn at batch end
// Settlement (pipeline-engine) reads the record first, then falls back to
// parsing the last assistant text — a weak model that never calls tools is
// still accepted through the old channel.

import type { ToolUseBlock } from '../../types/agent'
import type { ToolExecContext } from './context'
import { STAGE_FINISH_TOOL, validateStageFinishArgs } from '../../../../shared/workflow/finish-tool'

export async function execStageFinishTool(ex: ToolExecContext, t: ToolUseBlock): Promise<boolean> {
  if (t.name !== STAGE_FINISH_TOOL) return false

  const config = ex.opts.stageFinish
  // 没有阶段配置 = 这不是阶段会话。此时同名调用可能是用户工具工作室里自建的
  // finish_stage，不能抢占——交回 execOtherTool 的常规分派（真没有对应执行器
  // 时会得到 Unknown tool 的报错，同样是一条明面失败）。
  if (!config) return false

  const result = validateStageFinishArgs(t.input, config)
  if (!result.ok || !result.contract) {
    // Model-facing, actionable, same turn: a finish call that fails validation
    // must NOT settle the stage (a mistyped verdict would silently route the
    // pipeline down the wrong edge).
    const msg = result.error ?? `${STAGE_FINISH_TOOL} 参数不合法`
    t.output = msg
    t.exitCode = 1
    ex.addToolResult(t.id, msg, true)
    return true
  }

  if (!ex.recordStageFinish) {
    ex.addToolResult(t.id, `${STAGE_FINISH_TOOL} is not available in this session.`, true)
    t.exitCode = 1
    return true
  }

  const contract = result.contract
  ex.recordStageFinish(contract)
  const artifactNote = contract.artifacts.length > 0 ? `\n交付物：${contract.artifacts.join('、')}` : ''
  const msg = `阶段结果已记录：verdict=${contract.verdict}\n` + `summary：${contract.summary}${artifactNote}\n` + '本回合到此结束，本阶段将按该结果状态结算。'
  t.output = msg
  t.exitCode = 0
  ex.addToolResult(t.id, msg, false)
  return true
}
