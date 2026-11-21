// Branch picker actions, driven against REAL temporary git repositories.
// git.service.ts imports only node builtins + AsyncLocalStorage + path-jail,
// so no Electron ABI / esbuild bundle is needed here (unlike the DB layer).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { invokeGitAction } from '../src/main/git/git.service'
import { sessionSandbox } from '../src/main/sandbox/session-context'
import type { GitBranchList, GitStatusInfo } from '../src/shared/types/git'

const dirs: string[] = []
const makeDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'pm-git-branch-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const commit = (cwd: string, message: string): void => {
  git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', message)
}

const branchList = async (cwd: string): Promise<GitBranchList> => {
  const r = await invokeGitAction({ action: 'branch_list', cwd })
  expect(r.ok).toBe(true)
  return r.data as GitBranchList
}

describe('git branch picker actions', () => {
  it('非 repo 返回结构化 isRepo:false，UI 据此不渲染', async () => {
    const d = makeDir()
    const list = await branchList(d)
    expect(list.isRepo).toBe(false)
    expect(list.local).toEqual([])
    expect(list.remote).toEqual([])
  })

  it('空仓库：status 的分支名不能是 "No commits yet on main" 整句', async () => {
    const d = makeDir()
    git(d, 'init', '-q', '-b', 'main', '.')
    const r = await invokeGitAction({ action: 'status', cwd: d })
    expect(r.ok).toBe(true)
    expect((r.data as GitStatusInfo).branch).toBe('main')
    const list = await branchList(d)
    expect(list.current).toBe('main')
    expect(list.head).toBeNull()
    expect(list.local).toEqual([])
  })

  it('本地/远程分支列表：当前项、提交摘要、HEAD 短码', async () => {
    const d = makeDir()
    git(d, 'init', '-q', '-b', 'main', '.')
    commit(d, 'first commit: 中文标题')
    git(d, 'branch', 'feat/search-v2')
    git(d, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    const list = await branchList(d)
    expect(list.isRepo).toBe(true)
    expect(list.current).toBe('main')
    expect(list.detached).toBe(false)
    expect(list.head).toMatch(/^[0-9a-f]{7,}$/)
    expect(list.local.map((b) => b.name).sort()).toEqual(['feat/search-v2', 'main'])
    expect(list.local.find((b) => b.name === 'main')?.current).toBe(true)
    expect(list.local.find((b) => b.name === 'main')?.summary).toBe('first commit: 中文标题')
    expect(list.remote.map((b) => b.name)).toEqual(['origin/main'])
  })

  it('detached HEAD：current=null 且 head 给出短码', async () => {
    const d = makeDir()
    git(d, 'init', '-q', '-b', 'main', '.')
    commit(d, 'first')
    git(d, 'checkout', '-q', '--detach', 'HEAD')
    const list = await branchList(d)
    expect(list.detached).toBe(true)
    expect(list.current).toBeNull()
    expect(list.head).toMatch(/^[0-9a-f]{7,}$/)
  })

  it('switch 携带未提交改动（不静默丢弃），成功后 current 变化', async () => {
    const d = makeDir()
    git(d, 'init', '-q', '-b', 'main', '.')
    writeFileSync(join(d, 'a.txt'), 'one\n')
    git(d, 'add', 'a.txt')
    commit(d, 'first')
    git(d, 'branch', 'feat/x')
    writeFileSync(join(d, 'a.txt'), 'dirty\n')
    const r = await invokeGitAction({ action: 'switch', cwd: d, name: 'feat/x' })
    expect(r.ok).toBe(true)
    expect((await branchList(d)).current).toBe('feat/x')
    // git's own default behaviour: the uncommitted edit followed the user.
    const status = await invokeGitAction({ action: 'status', cwd: d })
    expect((status.data as GitStatusInfo).unstaged).toContain('a.txt')
  })

  it('branch_create 新建并切过去；非法分支名被拒', async () => {
    const d = makeDir()
    git(d, 'init', '-q', '-b', 'main', '.')
    commit(d, 'first')
    const ok = await invokeGitAction({ action: 'branch_create', cwd: d, name: 'fix/login' })
    expect(ok.ok).toBe(true)
    expect((await branchList(d)).current).toBe('fix/login')
    const bad = await invokeGitAction({ action: 'switch', cwd: d, name: '--no-such-option' })
    expect(bad.ok).toBe(false)
    const dots = await invokeGitAction({ action: 'branch_create', cwd: d, name: 'a..b' })
    expect(dots.ok).toBe(false)
  })

  it('写动作沿用 commit/restore 的 cwd jail', async () => {
    const d = makeDir()
    const other = makeDir()
    git(d, 'init', '-q', '-b', 'main', '.')
    commit(d, 'first')
    git(d, 'branch', 'feat/x')
    const r = await sessionSandbox.run(
      { sessionId: 's1', workspaceDir: other, execAllowlist: new Set(), backgroundPids: new Set() },
      () => invokeGitAction({ action: 'switch', cwd: d, name: 'feat/x' }),
    )
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('blocked by sandbox')
    // Read actions stay geography-free, same as status/diff/log.
    const read = await sessionSandbox.run(
      { sessionId: 's1', workspaceDir: other, execAllowlist: new Set(), backgroundPids: new Set() },
      () => invokeGitAction({ action: 'branch_list', cwd: d }),
    )
    expect(read.ok).toBe(true)
  })
})
