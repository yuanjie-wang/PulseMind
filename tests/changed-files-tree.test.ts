/**
 * 「只看本会话改动」过滤（PLAN-ide-linkage 刀二，2026-10-30）。
 *
 * 判据是合成树而非活树过滤：树是懒加载的，重启/切会话后改动文件的祖先目录
 * 未必已列——过滤已加载层会静默漏行。合成树只从台账自建，任何时刻全量可用；
 * 路径是真实路径，行的选择/预览/悬停动作/着色全部照旧（键 = marks 同款
 * normalizeChangePath 拼写）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildChangedFilesTree, fileChangeMarks } from '../src/shared/agent-session/file-changes'
import type { SessionFileChange } from '../src/shared/agent-protocol'

const root = join(__dirname, '..')
const ch = (path: string, kind: SessionFileChange['kind'] = 'created'): SessionFileChange => ({ path, kind })

describe('buildChangedFilesTree', () => {
  it('深嵌套聚合 + 目录先于文件 + 各自字母序', () => {
    const { nodes, expanded } = buildChangedFilesTree(
      [
        ch('/ws/src/util/b.ts'),
        ch('/ws/a.md'),
        ch('/ws/src/util/a.ts', 'modified'),
        ch('/ws/src/main.py'),
      ],
      '/ws',
    )
    expect(nodes.map((n) => n.name)).toEqual(['src', 'a.md'])
    const src = nodes[0]
    expect(src.kind).toBe('modified') // 子树里有 modified 文件（util/a.ts）→ 整个子树 modified
    expect(src.children!.map((n) => n.name)).toEqual(['util', 'main.py'])
    const util = src.children![0]
    expect(util.kind).toBe('modified') // 有 modified 文件 → 整棵子树 modified（VS Code 规则）
    expect(util.children!.map((n) => n.path)).toEqual(['/ws/src/util/a.ts', '/ws/src/util/b.ts'])
    // 全部目录路径都在 expanded 里——视图默认全开
    expect(expanded).toEqual(['/ws/src', '/ws/src/util'])
  })

  it('同一目录多文件聚拢；同名去重（键唯一）', () => {
    const { nodes } = buildChangedFilesTree([ch('/ws/x/a.ts'), ch('/ws/x/b.ts'), ch('/ws/x/a.ts')], '/ws')
    expect(nodes[0].children!.map((n) => n.name)).toEqual(['a.ts', 'b.ts'])
  })

  it('混合 kind 的目录按最重着色（任一 modified → modified）', () => {
    const { nodes } = buildChangedFilesTree([ch('/ws/p/keep.ts', 'modified'), ch('/ws/p/new.ts')], '/ws')
    expect(nodes[0].kind).toBe('modified')
  })

  it('Windows 反斜杠拼写照常成树（目录键与 marks 键同款拼写）', () => {
    const { nodes, expanded } = buildChangedFilesTree([ch('C:\\ws\\pkg\\mod\\x.py', 'modified')], 'C:\\ws')
    expect(nodes).toHaveLength(1)
    expect(nodes[0].path).toBe('C:\\ws\\pkg')
    expect(nodes[0].children![0].path).toBe('C:\\ws\\pkg\\mod')
    expect(nodes[0].children![0].children![0].path).toBe('C:\\ws\\pkg\\mod\\x.py')
    expect(expanded).toEqual(['C:\\ws\\pkg', 'C:\\ws\\pkg\\mod'])
    // 与 paint map 的键完全对齐——行的着色由此保证
    const marks = fileChangeMarks([ch('C:\\ws\\pkg\\mod\\x.py', 'modified')], 'C:\\ws')
    expect(marks.has('C:\\ws\\pkg\\mod\\x.py')).toBe(true)
    expect(marks.has('C:\\ws\\pkg')).toBe(true)
  })

  it('工作区外条目不是树该展示的——跳过；全外则空树', () => {
    expect(buildChangedFilesTree([ch('/other/a.ts')], '/ws').nodes).toEqual([])
    expect(buildChangedFilesTree([], '/ws').nodes).toEqual([])
    expect(buildChangedFilesTree([ch('/ws/a.ts')], null).nodes).toEqual([])
  })

  it('归一化容错：`./`、双分隔符落回同一行', () => {
    const a = buildChangedFilesTree([ch('/ws/./a//b.md')], '/ws')
    const b = buildChangedFilesTree([ch('/ws/a/b.md')], '/ws')
    expect(a).toEqual(b)
  })
})

describe('WorkspaceTree 过滤开关 wiring', () => {
  const src = (p: string): string => readFileSync(join(root, p), 'utf8')

  it('合成树从台账自建（不从 current.entries 过滤——懒加载漏行是它存在的理由）', () => {
    const tree = src('src/renderer/src/components/workbench/WorkspaceTree.tsx')
    expect(tree).toContain('buildChangedFilesTree(changes, workspaceDir)')
    expect(tree).not.toMatch(/buildChangedFilesTree\(current/)
  })

  it('开关三要素：置灰条件 / 启用清搜索 / 计数徽标', () => {
    const tree = src('src/renderer/src/components/workbench/WorkspaceTree.tsx')
    expect(tree).toContain('disabled={!workspaceDir || changes.length === 0}')
    expect(tree).toContain('setQuery(\'\')')
    expect(tree).toContain('setSearch(null)')
    expect(tree).toContain('本会话改动 · ${changed.nodes.length} 个文件')
  })

  it('过滤态渲染合成树：隐藏搜索框 + 全开 expanded + 行点击走同一 onSelect', () => {
    const tree = src('src/renderer/src/components/workbench/WorkspaceTree.tsx')
    expect(tree).toContain('!onlyChanges && (')
    expect(tree).toContain('treeData={changedNodes}')
    expect(tree).toContain('expandedKeys={filterExpanded ?? changed.expanded}')
    // 过滤分支在搜索分支之前（过滤态下不落入搜索渲染）
    expect(tree.indexOf('onlyChanges ? (')).toBeGreaterThan(-1)
    expect(tree.indexOf('onlyChanges ? (')).toBeLessThan(tree.indexOf('searching ? ('))
  })
})
