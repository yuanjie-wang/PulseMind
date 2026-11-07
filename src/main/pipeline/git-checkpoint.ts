// PLAN-workflow-engine：git checkpoint（评审缺口①，spawn git CLI，无新依赖）。
//
// - 实例启动检查 workspaceDir：非 git 仓库或工作树脏 → 报错拒跑（不把用户
//   未提交内容混进流水线快照，fail-safe）。
// - 记录基线 commit；每阶段结算（success/fail）后 `git add -A && git commit`。
// - 实例 FAILED → `git reset --hard <baseline>` 回滚；DONE → 保留提交链。
// - 回滚只在实例结算时做一次；阶段级失败不回滚（fix 循环依赖前序阶段的
//   落盘状态——test-failures.md / review-findings.md 必须活着传给下一阶段）。

import { spawn } from 'node:child_process'

function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr?.on('data', (d) => {
      stderr += String(d)
    })
    child.on('error', (err) => resolve({ ok: false, stdout, stderr: stderr + String(err) }))
    child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }))
  })
}

/** git 仓库检测 + 工作树干净检测（启动门）。返回拒绝原因或 null。 */
export async function gitCheckpointGate(workspaceDir: string): Promise<string | null> {
  const repo = await runGit(workspaceDir, ['rev-parse', '--is-inside-work-tree'])
  if (!repo.ok || repo.stdout.trim() !== 'true') return '工作区不是 git 仓库（gitCheckpoint 缺省开启，把 params.gitCheckpoint 设为 false 可跳过）'
  const status = await runGit(workspaceDir, ['status', '--porcelain'])
  if (!status.ok) return `git status 执行失败：${status.stderr.slice(0, 200)}`
  if (status.stdout.trim().length > 0) return '工作树不干净：请先提交或暂存当前改动，流水线不会把它们混进快照'
  return null
}

/** 基线 commit（启动门通过后调用）。 */
export async function gitBaseline(workspaceDir: string): Promise<string | null> {
  const head = await runGit(workspaceDir, ['rev-parse', 'HEAD'])
  return head.ok ? head.stdout.trim() : null
}

/** 阶段结算快照：add -A + commit（消息 `pipeline(<runId>): <nodeId> <verdict>`）。
 *  没有改动时 commit 非零退出——那不是失败，静默放行。 */
export async function gitStageCommit(workspaceDir: string, runId: string, nodeId: string, verdict: string): Promise<void> {
  await runGit(workspaceDir, ['add', '-A'])
  const commit = await runGit(workspaceDir, ['commit', '-m', `pipeline(${runId}): ${nodeId} ${verdict}`])
  if (!commit.ok && !/nothing to commit/.test(commit.stdout + commit.stderr)) {
    console.warn('[git-checkpoint] stage commit failed:', commit.stderr.slice(0, 200))
  }
}

/** 实例 FAILED 的回滚（只在实例结算时做一次）。 */
export async function gitResetToBaseline(workspaceDir: string, baseline: string): Promise<void> {
  await runGit(workspaceDir, ['reset', '--hard', baseline])
  await runGit(workspaceDir, ['clean', '-fd'])
}
