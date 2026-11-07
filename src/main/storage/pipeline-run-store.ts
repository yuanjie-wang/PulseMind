// PLAN-workflow-engine：pipeline_runs / pipeline_stage_runs 的读写面。
// RoutineCenter 的运行记录（3s 轮询 PIPELINE_RUNS）读这里；pipeline-engine
// 在实例/阶段边界写这里。

import type { PipelineRun, PipelineRunStatus, PipelineStageRun } from '../../shared/workflow/types'
import { getDb } from './database'

interface PipelineRunRow {
  id: string
  workflow_id: string
  workflow_name: string
  objective: string | null
  baseline_commit: string | null
  workspace_dir: string | null
  status: string
  current_node: string | null
  started_at: string
  finished_at: string | null
  error: string | null
}

interface PipelineStageRow {
  id: string
  run_id: string
  node_id: string
  verdict: string | null
  continues: number
  conversation_id: string | null
  started_at: string
  finished_at: string | null
  error: string | null
  artifacts_json: string | null
}

function rowToRun(r: PipelineRunRow): PipelineRun {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    workflowName: r.workflow_name,
    objective: r.objective ?? '',
    ...(r.baseline_commit ? { baselineCommit: r.baseline_commit } : {}),
    workspaceDir: r.workspace_dir ?? '',
    status: r.status as PipelineRunStatus,
    ...(r.current_node ? { currentNode: r.current_node } : {}),
    startedAt: r.started_at,
    ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
    ...(r.error ? { error: r.error } : {}),
  }
}

function rowToStage(r: PipelineStageRow): PipelineStageRun {
  let artifacts: string[] | undefined
  try {
    const parsed = r.artifacts_json ? (JSON.parse(r.artifacts_json) as unknown) : undefined
    if (Array.isArray(parsed)) artifacts = parsed.filter((a): a is string => typeof a === 'string')
  } catch {
    /* keep undefined */
  }
  return {
    id: r.id,
    runId: r.run_id,
    nodeId: r.node_id,
    ...(r.verdict ? { verdict: r.verdict } : {}),
    continues: r.continues,
    ...(r.conversation_id ? { conversationId: r.conversation_id } : {}),
    startedAt: r.started_at,
    ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(artifacts ? { artifacts } : {}),
  }
}

export const pipelineRunStore = {
  createRun(run: Omit<PipelineRun, 'id'> & { id: string }): PipelineRun {
    getDb()
      .prepare(
        `INSERT INTO pipeline_runs (id, workflow_id, workflow_name, objective, baseline_commit, workspace_dir, status, current_node, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.workflowId,
        run.workflowName,
        run.objective || null,
        run.baselineCommit ?? null,
        run.workspaceDir ?? null,
        run.status,
        run.currentNode ?? null,
        run.startedAt,
      )
    return run
  },

  updateRun(id: string, patch: Partial<Pick<PipelineRun, 'status' | 'currentNode' | 'finishedAt' | 'error' | 'baselineCommit'>>): void {
    getDb()
      .prepare(
        `UPDATE pipeline_runs SET
           status = COALESCE(?, status),
           current_node = COALESCE(?, current_node),
           finished_at = COALESCE(?, finished_at),
           error = COALESCE(?, error),
           baseline_commit = COALESCE(?, baseline_commit)
         WHERE id = ?`,
      )
      .run(patch.status ?? null, patch.currentNode ?? null, patch.finishedAt ?? null, patch.error ?? null, patch.baselineCommit ?? null, id)
  },

  getRun(id: string): PipelineRun | null {
    const row = getDb().prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(id) as PipelineRunRow | undefined
    return row ? rowToRun(row) : null
  },

  /** 运行记录列表（RoutineCenter 3s 轮询）：行 = plan 实例，展开 = 节点行。 */
  listRuns(limit = 50): PipelineRun[] {
    const rows = getDb().prepare('SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT ?').all(limit) as PipelineRunRow[]
    return rows.map(rowToRun)
  },

  startStage(stage: Omit<PipelineStageRun, 'id'> & { id: string }): void {
    getDb()
      .prepare(
        `INSERT INTO pipeline_stage_runs (id, run_id, node_id, continues, conversation_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(stage.id, stage.runId, stage.nodeId, stage.continues, stage.conversationId ?? null, stage.startedAt)
  },

  finishStage(id: string, patch: { verdict?: string; conversationId?: string; finishedAt: string; error?: string; artifacts?: string[] }): void {
    getDb()
      .prepare(
        `UPDATE pipeline_stage_runs SET
           verdict = COALESCE(?, verdict),
           conversation_id = COALESCE(?, conversation_id),
           finished_at = ?,
           error = COALESCE(?, error),
           artifacts_json = COALESCE(?, artifacts_json)
         WHERE id = ?`,
      )
      .run(
        patch.verdict ?? null,
        patch.conversationId ?? null,
        patch.finishedAt,
        patch.error ?? null,
        patch.artifacts ? JSON.stringify(patch.artifacts) : null,
        id,
      )
  },

  /** 一次实例的全部节点行（展开面），按开始时间正序。 */
  listStagesOf(runId: string): PipelineStageRun[] {
    const rows = getDb().prepare('SELECT * FROM pipeline_stage_runs WHERE run_id = ? ORDER BY started_at').all(runId) as PipelineStageRow[]
    return rows.map(rowToStage)
  },
}
