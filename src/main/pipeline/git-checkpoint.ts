// PLAN-workflow-engine：git checkpoint（评审缺口①，spawn git CLI，无新依赖）。
//
// - 实例启动检查 workspaceDir：非 git 仓库或工作树脏 → 报错拒跑（不把用户
//   未提交内容混进流水线快照，fail-safe）。
// - 记录基线 commit；每阶段结算（success/fail）后 `git add -A && git commit`。
// - 实例 FAILED → `git reset --hard <baseline>` 回滚；DONE → 保留提交链。
// - 回滚只在实例结算时做一次；阶段级失败不回滚（fix 循环依赖前序阶段的
//   落盘状态——test-failures.md / review-findings.md 必须活着传给下一阶段）。
//
// PLAN-workflow-context（2026-11-14）：handoff 交接文件落在
// `<workspace>/.pulsemind/workflows/<runId>/`，**三条 pathspec 必须同批**（缺一
// 不可，任何一条漏改都会出事）：
//  - add：漏了 → 每阶段的 handoff 被提交进用户的 git 仓库；
//  - clean：漏了 → 实例 FAILED 回滚把 handoff 删掉，排查证据全没；
//  - status 门：漏了 → 上次 run 留下的 untracked .pulsemind 判脏，**第二次
//    运行起永久报「工作树不干净」拒跑**（gitCheckpoint 缺省 true；plan-exchange
//    的 .pulsemind/plans/ 在存量代码上就会触发这个门）。
// 不能只靠 .gitignore：workspace 是用户自己的项目，无权假设它忽略了 .pulsemind/；
// pathspec 显式排除与用户的 ignore 配置无关。
// 范围注记：`git add -A`（不带 pathspec）是全仓级（git ≥2.0），加 `-- .
// ':!.pulsemind'` 后收窄为 workspaceDir 子树级——workspace == 仓库根（常态）时
// 无差；workspace 是仓库子目录时 checkpoint 范围随之收窄（与 clean 的 cwd
// 范围对齐）。要保全仓语义可换 `:(top)` 魔法前缀。

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

/** git 仓库检测 + 工作树干净检测（启动门）。返回拒绝原因或 null。
 *  status 带与 add/clean 同款的 pathspec 排除：untracked 的 .pulsemind/ 不判脏
 *  ——否则第一次运行留下的 handoff 会让同一 workspace 的第二次运行永久拒跑。 */
export async function gitCheckpointGate(workspaceDir: string): Promise<string | null> {
  const repo = await runGit(workspaceDir, ['rev-parse', '--is-inside-work-tree'])
  if (!repo.ok || repo.stdout.trim() !== 'true') return '工作区不是 git 仓库（gitCheckpoint 缺省开启，把 params.gitCheckpoint 设为 false 可跳过）'
  const status = await runGit(workspaceDir, ['status', '--porcelain', '--', '.', ':!.pulsemind'])
  if (!status.ok) return `git status 执行失败：${status.stderr.slice(0, 200)}`
  if (status.stdout.trim().length > 0) return '工作树不干净：请先提交或暂存当前改动，流水线不会把它们混进快照'
  return null
}

/** 基线 commit（启动门通过后调用）。 */
export async function gitBaseline(workspaceDir: string): Promise<string | null> {
  const head = await runGit(workspaceDir, ['rev-parse', 'HEAD'])
  return head.ok ? head.stdout.trim() : null
}

/** 阶段结算快照：add -A（排除 .pulsemind/）+ commit（消息
 *  `pipeline(<runId>): <nodeId> <verdict>`）。没有改动时 commit 非零退出——
 *  那不是失败，静默放行。 */
export async function gitStageCommit(workspaceDir: string, runId: string, nodeId: string, verdict: string): Promise<void> {
  await runGit(workspaceDir, ['add', '-A', '--', '.', ':!.pulsemind'])
  const commit = await runGit(workspaceDir, ['commit', '-m', `pipeline(${runId}): ${nodeId} ${verdict}`])
  if (!commit.ok && !/nothing to commit/.test(commit.stdout + commit.stderr)) {
    console.warn('[git-checkpoint] stage commit failed:', commit.stderr.slice(0, 200))
  }
}

/** 实例 FAILED 的回滚（只在实例结算时做一次）。clean 的 -e 排除 .pulsemind/
 *  ——handoff 是排查证据，回滚不能把它删掉。 */
export async function gitResetToBaseline(workspaceDir: string, baseline: string): Promise<void> {
  await runGit(workspaceDir, ['reset', '--hard', baseline])
  await runGit(workspaceDir, ['clean', '-fd', '-e', '.pulsemind'])
}
