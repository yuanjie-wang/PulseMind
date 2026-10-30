/**
 * 工作区目录树虚拟滚动（2026-10-30，用户报「打开较大的项目明显卡顿」）：
 *
 * rc-tree 只在传了 `height` 时才虚拟化——不传则展开后的每一行都是真实
 * DOM，每次展开/选中/台账 marks 重渲都全量走一遍，大项目几千行即卡。
 * 修法 = TreeScrollShell 自测内视口高度（ResizeObserver），主树拿到
 * height 后由 rc-tree 自己滚；首测前不渲染树（一帧空白好过几千行的
 * 非虚拟首绘）。搜索结果（帽 100 行）与「只看改动」树（会话台账，天然
 * 小）维持原样——阴性钉：`height={viewportH}` 全文件只许出现一次。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const code = readFileSync(join(root, 'src/renderer/src/components/workbench/WorkspaceTree.tsx'), 'utf8')

describe('TreeScrollShell：自测内视口高度', () => {
  it('shell 存在且用 ResizeObserver 量 clientHeight', () => {
    expect(code).toContain('function TreeScrollShell')
    expect(code).toContain('new ResizeObserver(() => setH(el.clientHeight))')
    expect(code).toContain('children(Math.max(0, h - 12))')
  })
})

describe('主树虚拟化', () => {
  it('主 DirectoryTree 拿 height，未量到前不渲染', () => {
    expect(code).toContain('<TreeScrollShell>')
    expect(code).toContain('height={viewportH}')
    expect(code).toContain('viewportH > 0 ? (')
  })

  it('height 只落主树一处——搜索树与改动树不虚拟化（阴性钉）', () => {
    expect(code.match(/height=\{viewportH\}/g)?.length).toBe(1)
    // 搜索结果与改动树的 DirectoryTree 保持原样（无 height 属性）。
    expect(code).toContain('treeData={searchCurrent.nodes}')
    expect(code).toContain('treeData={changedNodes}')
    expect(code.match(/<DirectoryTree/g)?.length).toBe(3)
  })
})
