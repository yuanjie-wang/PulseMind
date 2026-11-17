// PLAN-workflow-context §3.5：git checkpoint 的三条 pathspec（真实临时 git 仓库）。
// 钉：① 启动门放过 untracked 的 .pulsemind/（否则第一次运行留下的 handoff 会让
// 同一 workspace 的第二次运行永久拒跑）；② 阶段快照不把 handoff 提交进用户仓库；
// ③ FAILED 回滚保留 .pulsemind/（排查证据不删）。真脏树照旧拒跑。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitBaseline, gitCheckpointProbe, gitResetToBaseline, gitStageCommit } from '../src/main/pipeline/git-checkpoint'

let dir = ''

function git(args: string): string {
  return execSync(args, { cwd: dir, encoding: 'utf-8' })
}

function seedHandoff(): void {
  mkdirSync(join(dir, '.pulsemind', 'workflows', 'run_x'), { recursive: true })
  writeFileSync(join(dir, '.pulsemind', 'workflows', 'run_x', 'n1-handoff.md'), '# n1 交接\n')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pm-git-pathspec-'))
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir })
  writeFileSync(join(dir, 'app.txt'), 'v1\n')
  execSync('git add -A && git commit -qm init', { cwd: dir })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('git checkpoint 三条 pathspec（PLAN-workflow-context §3.5）', () => {
  it('探测放过 untracked 的 .pulsemind/——pathspec 排除对 status 同样生效；真脏树不可用', async () => {
    expect(await gitCheckpointProbe(dir)).toEqual({ usable: true })
    seedHandoff()
    // handoff 在场不影响可用性（pathspec 排除）；真脏树 → 不可用（降级为无快照）
    expect(await gitCheckpointProbe(dir)).toEqual({ usable: true })
    writeFileSync(join(dir, 'app.txt'), 'v2\n')
    const probe = await gitCheckpointProbe(dir)
    expect(probe.usable).toBe(false)
    expect(probe.reason).toContain('未提交改动')
  })

  it('阶段快照：用户的改动进 commit，handoff 不进历史、保持 untracked', async () => {
    seedHandoff()
    writeFileSync(join(dir, 'app.txt'), 'v2\n')
    await gitStageCommit(dir, 'run_x', 'n1', 'pass')
    expect(git('git log --oneline')).toContain('pipeline(run_x): n1 pass')
    expect(git('git ls-files')).toContain('app.txt')
    expect(git('git ls-files .pulsemind')).toBe('')
    expect(git('git status --porcelain')).toContain('.pulsemind')
  })

  it('FAILED 回滚：工作区回到基线，.pulsemind/ 幸存（排查证据不删）', async () => {
    const baseline = await gitBaseline(dir)
    writeFileSync(join(dir, 'app.txt'), 'v2\n')
    await gitStageCommit(dir, 'run_x', 'n1', 'pass')
    seedHandoff()
    await gitResetToBaseline(dir, baseline!)
    expect(readFileSync(join(dir, 'app.txt'), 'utf-8')).toBe('v1\n')
    expect(existsSync(join(dir, '.pulsemind', 'workflows', 'run_x', 'n1-handoff.md'))).toBe(true)
  })
})
