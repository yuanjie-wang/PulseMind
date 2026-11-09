// 工作流批量数据（P2 任务共享内核，user 2026-11-08 裁定「任务抽象一层」）。
//
// CSV → inputs 的映射/分析直接复用 shared/routine/batch 的纯函数（签名已放宽
// 到最小形状，WorkflowInputDef 天然满足）：一行 = 一次实例，header 名对应
// input key（首现列赢），多余列忽略、缺 required 列整批拒绝（语义与 routine
// 批量同源）。文件读取面在 main 侧 batch-source.loadTableSource（xlsx/GBK/
// 行帽全继承）。并发裁定：workflow 批量串行 FIFO——实例内部是多会话串行链，
// gitCheckpoint 每阶段 commit，同工作区多实例并发会撞仓。

import { analyzeCsvBatch, rowParamsAt, type CsvBatchAnalysis } from '../routine/batch'
import type { WorkflowInputDef } from './types'

export type WorkflowBatchAnalysis = CsvBatchAnalysis

export function analyzeWorkflowCsvBatch(headers: string[], rows: string[][], inputs?: WorkflowInputDef[]): WorkflowBatchAnalysis {
  return analyzeCsvBatch(headers, rows, inputs)
}

/** 一行的实例变量：仅产出映射到声明 input 的列（trim 后），{{row}} 行号由
 *  喂送器另行注入（RESERVED_PLACEHOLDER_KEYS，用户不可声明占用）。 */
export function workflowRowVars(headers: string[], rows: string[][], inputs: WorkflowInputDef[] | undefined, rowIndex: number): Record<string, string> {
  return rowParamsAt(headers, rows, inputs, rowIndex)
}
