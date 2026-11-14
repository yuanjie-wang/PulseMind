// PLAN-workflow-context：handoff 纯函数单测。钉：目录铸造（绝对/相对/尾斜杠）、
// safeNodeId 防穿越矩阵（plan §3.2——plan-exchange 没做这层，工作流节点 id 用户
// 可改，不白名单化就能被构造成 ../../x 写出工作区）、契约渲染（顺序承诺 + 骨架）。

import { describe, expect, it } from 'vitest'
import {
  HANDOFF_SKELETON,
  formatHandoffContract,
  resolveWorkflowHandoff,
  safeNodeId,
} from '../src/shared/workflow/handoff'
import type { WorkflowNode } from '../src/shared/workflow/types'

describe('resolveWorkflowHandoff：目录铸造', () => {
  it('绝对路径 / 工作区相对路径 / dirRel 三坐标一致', () => {
    const h = resolveWorkflowHandoff('/home/u/proj', 'run_x7f2')
    expect(h.dir).toBe('/home/u/proj/.pulsemind/workflows/run_x7f2')
    expect(h.dirRel).toBe('.pulsemind/workflows/run_x7f2')
    expect(h.handoffPath('n1')).toBe('/home/u/proj/.pulsemind/workflows/run_x7f2/n1-handoff.md')
    expect(h.relative('n1')).toBe('.pulsemind/workflows/run_x7f2/n1-handoff.md')
  })

  it('workspace 尾斜杠不产生双斜杠（plan-exchange 同款归一）', () => {
    const h = resolveWorkflowHandoff('/home/u/proj/', 'run_x')
    expect(h.dir).toBe('/home/u/proj/.pulsemind/workflows/run_x')
  })

  it('runId 也过 safeNodeId（防御纵深：系统铸造之外不改语义）', () => {
    const h = resolveWorkflowHandoff('/ws', 'run_x')
    expect(h.dir).toBe('/ws/.pulsemind/workflows/run_x')
  })
})

describe('safeNodeId：防穿越矩阵', () => {
  it('合法 id 原样通过（validate 的 ID_RE 字符集都在白名单内）', () => {
    expect(safeNodeId('n1')).toBe('n1')
    expect(safeNodeId('code-node_2')).toBe('code-node_2')
    expect(safeNodeId('a.b')).toBe('a.b')
  })

  it('穿越形态一律打平：.. / ../x / a/b / 纯点串 / 空串', () => {
    expect(safeNodeId('..')).toBe('_')
    expect(safeNodeId('.')).toBe('_')
    expect(safeNodeId('../evil')).toBe('__evil') // '/' → '_'、首点 → '_'，组件里不再有相对路径段
    expect(safeNodeId('a/b')).toBe('a_b')
    expect(safeNodeId('a\\b')).toBe('a_b')
    expect(safeNodeId('...')).toBe('_')
    expect(safeNodeId('')).toBe('_')
  })

  it('端到端：任意 id 的 handoffPath 都落在铸造目录内（不逃出 .pulsemind）', () => {
    const h = resolveWorkflowHandoff('/ws', 'run_x')
    for (const id of ['..', '../../evil', 'a/b', 'n1']) {
      const p = h.handoffPath(id)
      expect(p.startsWith(`${h.dir}/`)).toBe(true)
      expect(p).not.toContain('../')
    }
  })
})

describe('formatHandoffContract：交接契约', () => {
  const node: WorkflowNode = { id: 'n1', title: '列出竞品清单', prompt: '抓清单', verdicts: ['pass'] }

  it('顺序承诺（先写文件再 finish）+ 绝对路径 + 「下游会直接读它」', () => {
    const h = resolveWorkflowHandoff('/ws', 'run_x')
    const text = formatHandoffContract(h, node)
    expect(text).toContain('finish_stage` 之前')
    expect(text).toContain('/ws/.pulsemind/workflows/run_x/n1-handoff.md')
    expect(text).toContain('下游阶段会直接读它')
    expect(text).toContain('不要另选路径或文件名')
  })

  it('骨架内联且阶段名已代入；五节齐全（多一节「下游须知」）', () => {
    const h = resolveWorkflowHandoff('/ws', 'run_x')
    const text = formatHandoffContract(h, node)
    expect(text).toContain('# 列出竞品清单 交接')
    expect(text).not.toContain('<阶段名>')
    for (const section of ['## 状态', '## 结论', '## 关键数据', '## 产物清单', '## 下游须知']) {
      expect(text).toContain(section)
    }
    expect(HANDOFF_SKELETON).toContain('## 下游须知')
  })
})
