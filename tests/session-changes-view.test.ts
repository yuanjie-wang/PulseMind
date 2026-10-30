/**
 * 会话改动视图 + 地址栏标记（PLAN-ide-linkage 刀三，2026-10-30）。
 *
 * 树着色回答「在哪个目录」，这一刀补「一共改了啥」：改动列表行上的
 * 「查看 diff」走 git 读动作（pathspec 限定单文件、cwd=工作区）；台账不依赖
 * git，非仓库工作区列表照常可用并如实告知。git 侧用真仓库驱动（git-repo-gate
 * 同款 harness）——pathspec 参数是本刀唯一动过的服务面。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { invokeGitAction } from '../src/main/git/git.service'

const root = join(__dirname, '..')

const ROOT = mkdtempSync(join(tmpdir(), 'pulsemind-changes-view-'))
const REPO = join(ROOT, 'repo')
const PLAIN = join(ROOT, 'plain')

const GITC = ['-C', REPO, '-c', 'user.email=t@t', '-c', 'user.name=t']
mkdirSync(REPO)
writeFileSync(join(REPO, 'a.ts'), 'line one\nline two\n')
writeFileSync(join(REPO, 'b.ts'), 'untouched\n')
spawnSync('git', [...GITC, 'init', '-q'])
spawnSync('git', [...GITC, 'add', '.'])
spawnSync('git', [...GITC, 'commit', '-q', '-m', 'init'])
// 会话改了 a.ts，没碰 b.ts
writeFileSync(join(REPO, 'a.ts'), 'line one\nline two CHANGED\n')
mkdirSync(PLAIN)
writeFileSync(join(PLAIN, 'note.txt'), 'not a repo\n')

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('git diff 的单文件 pathspec（真仓库）', () => {
  it('files 限定单文件——diff 只含目标文件，未改文件不出现', async () => {
    const out = await invokeGitAction({ action: 'diff', cwd: REPO, files: [join(REPO, 'a.ts')] })
    expect(out.ok).toBe(true)
    const data = out.data as { isRepo: boolean; diff?: string }
    expect(data.isRepo).toBe(true)
    expect(data.diff).toContain('line two CHANGED')
    expect(data.diff).toContain('+++ b/a.ts')
    expect(data.diff).not.toContain('b.ts')
  })

  it('未改的文件 → 空 diff（面板据此显示「无未暂存改动」）', async () => {
    const out = await invokeGitAction({ action: 'diff', cwd: REPO, files: [join(REPO, 'b.ts')] })
    expect(out.ok).toBe(true)
    const data = out.data as { isRepo: boolean; diff?: string }
    expect(data.isRepo).toBe(true)
    expect(data.diff ?? '').toBe('')
  })

  it('非 git 仓库 → 结构化 isRepo:false（列表照常、diff 如实告知的依据）', async () => {
    const out = await invokeGitAction({ action: 'diff', cwd: PLAIN, files: [join(PLAIN, 'note.txt')] })
    expect(out.ok).toBe(true)
    expect(out.data).toMatchObject({ isRepo: false })
  })
})

describe('wiring 扫描', () => {
  const src = (p: string): string => readFileSync(join(root, p), 'utf8')

  it('WorkspaceTree：diff 面板走 gitInvoke 单文件 pathspec + 四态文案 + 仅过滤态放行 onDiff', () => {
    const tree = src('src/renderer/src/components/workbench/WorkspaceTree.tsx')
    expect(tree).toContain("action: 'diff', cwd: workspaceDir, files: [entry.path]")
    expect(tree).toContain('非 git 仓库——列表照常可用，但没有 diff 可看')
    expect(tree).toContain('无未暂存改动（可能已暂存，或文件已还原）')
    expect(tree).toContain('onDiff={onlyChanges ? showDiff : undefined}')
    // modified 行才有 diff 按钮（created 无 git 历史可比）
    expect(tree).toContain('onDiff && mark === ')
  })

  it('TreeRow diff 按钮不抢选择/展开（stopPropagation 纪律）', () => {
    const tree = src('src/renderer/src/components/workbench/WorkspaceTree.tsx')
    const diffBtn = tree.slice(tree.indexOf('查看 diff'))
    expect(diffBtn.slice(0, 300)).toContain('e.stopPropagation()')
  })

  it('WorkspaceAddressBar：不带改动标记（2026-10-30 裁定，ink 归树行与页签文字）', () => {
    // 刀三曾把台账点放上地址栏；2026-10-30 用户裁定地址栏只是名牌，圆点全撤
    // （会话改动的 created/modified ink 活在树行与页签的文字色上）。
    const bar = src('src/renderer/src/components/workbench/WorkspaceAddressBar.tsx')
    expect(bar).not.toContain('useSessionFileChangesStore')
    expect(bar).not.toContain('data-ws-change-dot')
    expect(bar).not.toContain('fileChangeMarks')
  })
})
