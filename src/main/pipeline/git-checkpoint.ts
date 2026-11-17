// PLAN-workflow-engine：git checkpoint（评审缺口①，spawn git CLI，无新依赖）。
//
// - 实例启动探测 workspaceDir（PLAN-git-auto，user 2026-11-15「有 git 就用，
//   没有 git 也不强制」）：git 仓库在且工作树干净 ⇒ 快照/回滚/审计生效；否则
//   ⇒ 运行照常、baseline_commit 留空、日志留痕——git 是增强，不是门槛。
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

/** git 调用的看门狗（user 2026-11-15 实测：启动门/基线的 git 挂死 → 运行行
 *  孤儿在 running 停了 9 小时——门在 runStage 之前，它一卡整个 FIFO 都停）。
 *  超时杀掉子进程并按失败结算，调用方各自走 fail-safe（门拒跑 / baseline
 *  视为 null）。30s 对「大仓库 git add -A」足够宽裕，对「等一个永远不来的
 *  锁/凭据」是及时止损。 */
const GIT_TIMEOUT_MS = 30_000

function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (r: { ok: boolean; stdout: string; stderr: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      child.kill()
      done({ ok: false, stdout, stderr: `git ${args[0]} 超时（${GIT_TIMEOUT_MS / 1000}s）— 可能被锁或凭据提示卡住` })
    }, GIT_TIMEOUT_MS)
    child.stdout?.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr?.on('data', (d) => {
      stderr += String(d)
    })
    child.on('error', (err) => done({ ok: false, stdout, stderr: stderr + String(err) }))
    child.on('close', (code) => done({ ok: code === 0, stdout, stderr }))
  })
}

/** git 可用性探测（启动门 → 探测，user 2026-11-15「已经有 git 的就可以用，
 *  没有 git 也不强制」）：git 仓库在**且工作树干净** ⇒ 快照与回滚可用；否则
 *  ⇒ 运行照常、如实留痕（运行行 baseline_commit 空 + 日志），不再拒跑。
 *  status 带与 add/clean 同款的 pathspec 排除：untracked 的 .pulsemind/ 不判脏
 *  ——第一次运行留下的 handoff 不能让探测误判「脏」。 */
export async function gitCheckpointProbe(workspaceDir: string): Promise<{ usable: boolean; reason?: string }> {
  const repo = await runGit(workspaceDir, ['rev-parse', '--is-inside-work-tree'])
  if (!repo.ok || repo.stdout.trim() !== 'true') return { usable: false, reason: '工作区不是 git 仓库' }
  const status = await runGit(workspaceDir, ['status', '--porcelain', '--', '.', ':!.pulsemind'])
  if (!status.ok) return { usable: false, reason: `git status 执行失败：${status.stderr.slice(0, 200)}` }
  if (status.stdout.trim().length > 0) return { usable: false, reason: '工作树有未提交改动（快照会把它们混进基线）' }
  return { usable: true }
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
