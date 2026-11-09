/**
 * 用户裁定 2026-11-06 — 「我们的工作计划为什么只增不减」；2026-11-08 翻转其
 * 渲染侧（B）——「todo list 里的任务不要自动折叠」。
 *
 *   B  面板——2026-11-06 曾把全绿清单自动折叠成一行（completed && !expanded +
 *      跃迁复位 effect）。2026-11-08 裁定拆除自动臂：清单默认恒展开，进入
 *      completed 不收起；「已完成 · 收起」按钮保留为纯手动出口，且手动折叠态
 *      在清单离开 completed 时弹开，收起永不跨轮继承。结构性根因（清单跨阶段
 *      只增不减）由 reconcileTodo 的阶段重置臂解决（见 todo-plan.test.ts）。
 *   C  instructions——`fresh` 的判据原来写作「UNRELATED to the closed list」，
 *      于是「同一个大目标下的下一个阶段」都被判成「相关」，清单跨七个工作累积。
 *      判据改为 PHASE：阶段交付完就开新清单。
 *
 * 测试环境是 `node`（无 jsdom），所以折叠只能做源码级 wiring 断言；真正被钉住的
 * 是那条容易回退的状态机——默认展开、自动复位 effect 只弹开不收起。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const VIEW = 'src/renderer/src/components/workbench/PlanGraphView.tsx'
const INSTR = 'src/renderer/src/tools/tool-instructions.ts'

describe('todo panel — 恒展开，收起只留手动出口（B，2026-11-08 翻转）', () => {
  const src = read(VIEW)
  const todoView = src.slice(src.indexOf('function TodoListView'))

  it('默认展开——自动折叠臂已拆（useState(true)，无「进入 completed 即收起」的跃迁）', () => {
    expect(todoView).toContain('useState(true)')
    // 2026-11-06 的自动臂原文：completed 的 false→true 跃迁把清单收起来。
    expect(todoView).not.toMatch(/if \(plan\.completed && !wasCompleted\.current\) setDoneExpanded\(false\)/)
  })

  it('复位 effect 只弹开不收起——离开 completed 时清掉残留的手动折叠态', () => {
    expect(todoView).toContain('const wasCompleted = useRef(plan.completed)')
    expect(todoView).toMatch(/if \(!plan\.completed && wasCompleted\.current\) setDoneExpanded\(true\)/)
    expect(todoView).toContain('wasCompleted.current = plan.completed')
  })

  it('手动收起按钮仍在，折叠行报真实条数与 objective，不是写死的文案', () => {
    expect(todoView).toContain('data-todo-collapse-toggle')
    expect(todoView).toContain('`${plan.nodes.length} 条已完成`')
    expect(todoView).toContain('{plan.objective}')
  })

  it('图表视图（delegated DAG）不受影响，只有 todo 清单有折叠出口', () => {
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
