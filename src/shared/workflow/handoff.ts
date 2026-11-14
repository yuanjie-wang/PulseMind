// PLAN-workflow-context：工作流阶段间的 handoff 交接（shared 纯逻辑，零 fs）。
//
// 与 src/shared/plan/exchange.ts 同血统但**不共用一个模块**：plan 的 exchange
// 是子代理之间的报告区（exit check / violation envelope / CAS 记账），工作流的
// handoff 只有「写路径 → 注入路径」这一半——共用一个文件会让两边互相牵制。
//
// 目录：<workspaceDir>/.pulsemind/workflows/<runId>/，文件名 <safeNodeId>-handoff.md。
// 选 .pulsemind/ 而不是 ~/.pulsemind/：节点会话的沙箱以 workspace 为边界，handoff
// 必须落在节点读得到、写得了的地方。目录被 git checkpoint 显式排除
// （git-checkpoint.ts 三条 pathspec：add / clean / status 启动门）——不进用户仓库、
// 不被 FAILED 回滚清除。
//
// 谁来写：模型自己写，路径在「完成方式」契约里给它（与 plan 模式一致）。模型没写
// 时由引擎用 finish_stage 已收到的结算兜底回填（pipeline-engine 的 backfillHandoff）
// ——「下游永远有路径可读」，代价是可能只有骨架没有细节，所以上游交接块的提示语
// 写明「若交接过于简略，用 read 自行核查产物」。

import type { WorkflowNode } from './types'

/** 交接骨架：与 plan-exchange 的 REPORT_SKELETON 同血统，多一节「下游须知」
 *  （finish_stage 的可选 notes 字段落在这里；缺席时模型自行写「无」）。 */
export const HANDOFF_SKELETON = `# <阶段名> 交接

## 状态
verdict 名 + 一句原因

## 结论
3-5 句：本阶段回答了什么、给下游最重要的判断是什么

## 关键数据
下游需要的事实、数字、清单——写全，不要只写摘要；引用其他文件写相对路径

## 产物清单
本阶段写入工作区的文件（相对路径一行一个）；没有则写「无」

## 下游须知
关键决定 / 踩过的坑 / 未决问题；没有则写「无」`

export interface WorkflowHandoff {
  /** 绝对目录（引擎兜底回填用它 mkdir）。 */
  dir: string
  /** 工作区相对目录（预算裁剪的提示行用它指路）。 */
  dirRel: string
  /** 系统铸造，绝不由模型解析（plan-exchange 的铁律）。 */
  handoffPath(nodeId: string): string
  relative(nodeId: string): string
}

/** nodeId/runId 白名单化：只留 [\w.-]，`.`/`..` 形态一律打平（防写出工作区）。
 *  plan 的 reportPath 没做这层（它的节点 id 由系统铸造 n1..nN）；工作流节点 id
 *  来自画布、validate 的 ID_RE 虽已限 [A-Za-z][A-Za-z0-9_-]{0,63}，这里仍独立
 *  设防——本函数的读者是 shared 纯函数，不假设调用方都过了 validate。 */
export function safeNodeId(nodeId: string): string {
  const cleaned = nodeId.replace(/[^\w.-]/g, '_')
  // 文件名组件不能是「.」/「..」：压缩多点、首尾点打平——'..' → '_'，
  // '../etc' → '_etc'，'a..b' → 'a.b'（组件内部的点不构成相对路径段）。
  const flat = cleaned.replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, (m) => '_'.repeat(m.length))
  return flat || '_'
}

export function resolveWorkflowHandoff(workspaceDir: string, runId: string): WorkflowHandoff {
  const root = workspaceDir.replace(/[/\\]+$/, '')
  const dir = `${root}/.pulsemind/workflows/${safeNodeId(runId)}`
  const dirRel = `.pulsemind/workflows/${safeNodeId(runId)}`
  const fileFor = (nodeId: string): string => `${safeNodeId(nodeId)}-handoff.md`
  return {
    dir,
    dirRel,
    handoffPath: (nodeId) => `${dir}/${fileFor(nodeId)}`,
    relative: (nodeId) => `${dirRel}/${fileFor(nodeId)}`,
  }
}

/** 注入到「完成方式」段的交接契约：顺序承诺（finish_stage 结算即收回合，
 *  所以**先写文件再 finish**——顺序颠倒了会话就结束了）+ 路径 + 骨架 +
 *  一句「下游会直接读它」。 */
export function formatHandoffContract(h: WorkflowHandoff, node: WorkflowNode): string {
  return [
    `完成本阶段工作后、调用 \`finish_stage\` 之前，先把本阶段的交接文件写入：`,
    h.handoffPath(node.id),
    `（目录不存在会自动创建；不要另选路径或文件名）。下游阶段会直接读它——按下面的骨架写全，不要只写一句话：`,
    '',
    HANDOFF_SKELETON.replace('<阶段名>', node.title || node.id),
  ].join('\n')
}
