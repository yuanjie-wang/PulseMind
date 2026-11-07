/**
 * 用户裁定 2026-11-06 — 「我们的工作计划为什么只增不减」。
 *
 * 两个独立根因，两处独立修复：
 *   B  面板——清单全绿后仍逐行画出 28 条历史。prompt 侧其实早已只注入一行摘要，
 *      所以问题全在渲染层：面板的职责是「现在进展到哪」，没有任何 open 条目时
 *      那 28 行是纯噪声。折叠后明细留在一击之外，且清单若离开 completed（续写
 *      一条）会自己弹开。
 *   C  instructions——`fresh` 的判据原来写作「UNRELATED to the closed list」，
 *      于是「同一个大目标下的下一个阶段」都被判成「相关」，清单跨七个工作累积。
 *      判据改为 PHASE：阶段交付完就开新清单。
 *
 * 测试环境是 `node`（无 jsdom），所以折叠只能做源码级 wiring 断言；真正被钉住的
 * 是那条容易回退的状态机——折叠条件是 completed && !expanded，且 expanded 在
 * false→true 跃迁时必须复位。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const VIEW = 'src/renderer/src/components/workbench/PlanGraphView.tsx'
const INSTR = 'src/renderer/src/tools/tool-instructions.ts'

describe('todo panel — 全绿折叠（B）', () => {
  const src = read(VIEW)
  const todoView = src.slice(src.indexOf('function TodoListView'))

  it('折叠只发生在 completed 且用户尚未展开时', () => {
    expect(todoView).toContain('plan.completed && !doneExpanded')
    expect(todoView).toContain('data-todo-collapsed')
    expect(todoView).toContain('data-todo-collapse-toggle')
  })

  it('折叠态在 false→true 跃迁时复位，续写一条新条目会自己弹开', () => {
    // 只在「刚变成 completed」那一刻复位。若每轮都复位，用户手动展开后会立刻
    // 被收起；若从不复位，一份新交付的清单会继承上一次的展开态。
    expect(todoView).toContain('const wasCompleted = useRef(plan.completed)')
    expect(todoView).toMatch(/if \(plan\.completed && !wasCompleted\.current\) setDoneExpanded\(false\)/)
    expect(todoView).toContain('wasCompleted.current = plan.completed')
  })

  it('折叠行报的是真实条数与 objective，不是写死的文案', () => {
    expect(todoView).toContain('`${plan.nodes.length} 条已完成`')
    expect(todoView).toContain('{plan.objective}')
  })

  it('图表视图（delegated DAG）不受影响，只有 todo 清单折叠', () => {
    const graphView = src.slice(0, src.indexOf('function TodoListView'))
    expect(graphView).not.toContain('data-todo-collapsed')
    expect(graphView).not.toContain('doneExpanded')
  })
})

describe('todo_write instructions — fresh 判据是阶段而非项目（C）', () => {
  const src = read(INSTR)

  it('判据从「与已关闭清单无关」改成「新阶段」', () => {
    expect(src).toContain('A fresh list is a new PHASE, not a new project')
    // 旧判据是那个 bug 本身：它让同一目标下的下一阶段永远不满足条件。
    expect(src).not.toContain('UNRELATED to the closed list')
  })

  it('保留 fresh:true 这个出口，并给出「阶段边界被漏掉」的识别信号', () => {
    expect(src).toContain('fresh: true')
    expect(src).toContain('The tell that you missed a boundary')
    expect(src).toContain('settled rows are not what the panel is for')
  })

  it('续写语义未被误伤：closed 清单仍可追加/复活条目', () => {
    expect(src).toContain('it stays CONTINUABLE')
    expect(src).toContain('an item without an id appends')
  })
})
