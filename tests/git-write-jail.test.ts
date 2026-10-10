import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { invokeGitAction } from '../src/main/git/git.service'
import { sessionSandbox } from '../src/main/sandbox/session-context'

/**
 * git 写动作的 workspace jail（audit 2026-10-10 #3）：文件写被 path-jail 锁在
 * 会话 workspace 内，git_commit/git_restore 曾对磁盘任意 cwd 生效——同一档位
 * 下两条写路径的坐标不一致。jail 只在 agent 会话上下文（ALS）在场时执法；
 * 渲染进程的 git 面板没有会话，必须照旧可用。读动作（status/diff/log）不设
 * 防——读在沙盒语义里本就到处可读。
 */

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-git-jail-'))
  const r = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`)
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir })
  return dir
}

const SANDBOX = { sessionId: 'conv_jail', workspaceDir: '/definitely/not/a/ws', execAllowlist: new Set<string>(), backgroundPids: new Set<number>() }

describe('invokeGitAction — 写动作的会话 workspace jail', () => {
  it.runIf(process.platform !== 'win32')('会话在场 + cwd 在 workspace 外 → 拒绝，git 未被调用', async () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'f.txt'), 'x')
      const result = await sessionSandbox.run(SANDBOX, () =>
        invokeGitAction({ action: 'commit', cwd: dir, message: 'test: x', files: ['f.txt'] }),
      )
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.error.message).toContain('blocked by sandbox')
      // 拒绝发生在 execGit 之前：仓库里没有产生任何提交
      const log = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf-8' })
      // 空仓库 rev-list 失败（无提交）即证明
      expect(log.status).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')('会话在场 + cwd 在 workspace 内 → 正常提交（真仓库往返）', async () => {
    const ws = makeRepo()
    try {
      writeFileSync(join(ws, 'f.txt'), 'x')
      const result = await sessionSandbox.run(
        { ...SANDBOX, workspaceDir: ws },
        () => invokeGitAction({ action: 'commit', cwd: ws, message: 'test: x', files: ['f.txt'] }),
      )
      expect(result.ok).toBe(true)
      const log = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: ws, encoding: 'utf-8' })
      expect(log.stdout.trim()).toBe('1')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')('无会话上下文（渲染面板）→ 任意 cwd 照旧可用', async () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'f.txt'), 'x')
      const result = await invokeGitAction({ action: 'commit', cwd: dir, message: 'test: x', files: ['f.txt'] })
      expect(result.ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')('读动作不设防：workspace 外的 status 照常返回', async () => {
    const dir = makeRepo()
    try {
      const result = await sessionSandbox.run(SANDBOX, () => invokeGitAction({ action: 'status', cwd: dir }))
      expect(result.ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restore 与 commit 同一裁定（会话在场 + workspace 外 → 拒绝）', async () => {
    const result = await sessionSandbox.run(SANDBOX, () =>
      invokeGitAction({ action: 'restore', cwd: '/tmp', files: ['x'], confirm: false }),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.message).toContain('blocked by sandbox')
  })
})
