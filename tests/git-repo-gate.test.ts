/**
 * git 三读动作的 locale 无关仓库门（PLAN-tool-issues #8，2026-10-28）。
 *
 * 旧形态：isNotRepo() 用英文正则匹配 stderr，而 git 说用户的语言——
 * 「致命错误：不是 Git 仓库」永远匹配不上，status/diff 的结构化 isRepo
 * 分支在中文环境形同虚设（原始 stderr 直穿模型，报告引的 4 条原始错误
 * 全部走这条路）；git_log 根本没有 catch；`git diff` 在非仓库里还会被
 * git 自己转成 --no-index 并倾泻整屏 usage。修复 = 动作前结构化预检
 * （rev-parse，与 locale 无关）+ cwd 存在性先行。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { invokeGitAction } from '../src/main/git/git.service'
import { formatGitResult } from '../src/renderer/src/agent/engine/git-tools'

const ROOT = mkdtempSync(join(tmpdir(), 'pulsemind-git-gate-'))
const REPO = join(ROOT, 'repo')
const PLAIN = join(ROOT, 'plain')
const GHOST = join(ROOT, 'does-not-exist')

mkdirSync(REPO)
spawnSync('git', ['init', '-q'], { cwd: REPO })
writeFileSync(join(REPO, 'a.txt'), 'hello\n')
spawnSync('git', ['-C', REPO, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'])
spawnSync('git', ['-C', REPO, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
mkdirSync(PLAIN)
writeFileSync(join(PLAIN, 'note.txt'), 'not a repo\n')

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('host repo gate: status/diff/log before any git runs', () => {
  it('status in a plain directory → structured isRepo:false (the shape the renderer already knows)', async () => {
    const out = await invokeGitAction({ action: 'status', cwd: PLAIN })
    expect(out.ok).toBe(true)
    expect(out.data).toMatchObject({ isRepo: false })
  })

  it('diff in a plain directory → isRepo:false, NO --no-index usage dump', async () => {
    const out = await invokeGitAction({ action: 'diff', cwd: PLAIN })
    expect(out.ok).toBe(true)
    expect(out.data).toMatchObject({ isRepo: false })
    expect(out.error).toBeUndefined()
  })

  it('log in a plain directory → structured 128 refusal with the escape hint (no raw stderr)', async () => {
    const out = await invokeGitAction({ action: 'log', cwd: PLAIN })
    expect(out.ok).toBe(false)
    expect(out.error?.code).toBe(128)
    expect(out.error?.message).toContain('not a git repository')
    expect(out.error?.message).toContain(PLAIN)
    expect(out.error?.message).not.toMatch(/fatal|致命|usage/)
  })

  it('a missing cwd is answered as a path problem, not a repo problem', async () => {
    for (const action of ['status', 'diff', 'log'] as const) {
      const out = await invokeGitAction({ action, cwd: GHOST })
      expect(out.ok, action).toBe(false)
      expect(out.error?.message, action).toContain('不存在')
      expect(out.error?.message, action).toContain(GHOST)
    }
  })

  it('a REAL repo passes the gate untouched — positive control', async () => {
    const status = await invokeGitAction({ action: 'status', cwd: REPO })
    expect(status.ok).toBe(true)
    expect(status.data).toMatchObject({ isRepo: true, branch: expect.any(String) })
    const diff = await invokeGitAction({ action: 'diff', cwd: REPO })
    expect(diff.ok).toBe(true)
    expect((diff.data as { isRepo: boolean }).isRepo).toBe(true)
    const log = await invokeGitAction({ action: 'log', cwd: REPO })
    expect(log.ok).toBe(true)
    expect((log.data as Array<{ summary: string }>)).toHaveLength(1)
  })
})

describe('renderer: the normalized 128 lands as the friendly line', () => {
  it('code 128 → "(not a git repository)" for every action; other errors keep the Git error prefix', () => {
    const notRepo = { ok: false, error: { code: 128, message: 'not a git repository: /x — run git init first' } }
    for (const name of ['git_status', 'git_diff', 'git_log', 'git_commit', 'git_restore']) {
      expect(formatGitResult(name, notRepo as never)).toBe('(not a git repository)')
    }
    const other = { ok: false, error: { code: 1, message: 'cwd 不存在或不是目录：/x — 先确认路径，或用 exec ls 查看' } }
    expect(formatGitResult('git_log', other as never)).toBe('Git error: cwd 不存在或不是目录：/x — 先确认路径，或用 exec ls 查看')
  })
})
