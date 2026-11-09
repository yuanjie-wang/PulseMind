// 工作流画布编辑器（user 2026-11-08 裁定：拖拽画布编辑，JSON 只是产物；
// 三期裁定：画布只有 开始/结束/空白任务 三类节点，其它抽象不要）。
// wiring 扫描：画布页整页接管 + 保存走同一校验门（先归一）+ JSON UI 退出 +
// 单出线头/三入线头 + 属性面板模态框 + normalizeSimpleWorkflow 单测 + layout 纯函数单测。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { autoWorkflowLayout, countCrossings, depthOf, isLoopEdge, loopEdgeKeys } from '../src/shared/workflow/layout'
import { RESERVED_PLACEHOLDER_KEYS, STAGE_PLACEHOLDER_GROUPS, renderNodePrompt } from '../src/shared/workflow/render'
import { altSidesOf, inputSideOf } from '../src/renderer/src/components/routine/WorkflowCanvas'
import { normalizeSimpleWorkflow } from '../src/shared/workflow/simplify'
import type { WorkflowDefinition } from '../src/shared/workflow/types'

const ROOT = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

describe('workflow canvas wiring', () => {
  const center = read('src/renderer/src/components/routine/RoutineCenter.tsx')
  const canvas = read('src/renderer/src/components/routine/WorkflowCanvas.tsx')
  const wizard = read('src/renderer/src/components/routine/TaskWizardPage.tsx')

  it('任务中心：画布嵌入向导内容步，列表页挂 workflowEditing 路由', () => {
    expect(wizard).toContain('<WorkflowCanvas')
    expect(center).toContain('workflowEditing: true')
    // 编辑/新建意图由混排卡片上抛（P3：列表页不自持编辑态）。
    expect(center).toContain('openWorkflowEditor')
  })

  it('保存走三处同一门：向导 normalize → validate → save（P3 保存上收到壳）', () => {
    expect(wizard).toMatch(/normalizeSimpleWorkflow\(def\)/)
    expect(wizard).toMatch(/validateWorkflow\(normalized\)/)
    expect(wizard).toMatch(/pipelineWorkflows\('save', normalized\)/)
  })

  it('JSON UI 退出：向导无 CodeMirror/JSON 编辑器 Modal；画布是唯一编辑面', () => {
    expect(wizard).not.toContain('CodeMirrorEditor')
    expect(wizard).not.toContain('editorOpen')
    // 废弃 i18n 键不得回流。
    expect(read('src/renderer/src/i18n/locales/zh.ts')).not.toContain('editorTitle')
    expect(read('src/renderer/src/i18n/locales/en.ts')).not.toContain('editorTitle')
  })

  it('多出口：拖新线是追加，调度键取自拖出的出口线头（user 2026-11-09）', () => {
    // 旧行为 `edges.filter((e) => e.from !== from)` 会顶掉同起点的所有旧边——
    // 那条断言（「连线即替换」）已随需求反转，别再"恢复"。
    expect(canvas).not.toMatch(/filter\(\(e\) => e\.from !== from\)/)
    // when 不再恒写 'pass'：线头 id 是 `out:<verdict>`，拖哪个状态就连哪个分支
    // （agent 报这个状态时走这条边）。无 id 的旧线头回落 pass。
    expect(canvas).toMatch(/const when = verdictOfOutHandle\(conn\.sourceHandle\) \?\? 'pass'/)
    expect(canvas).toMatch(/d\.edges\.some\(\(e\) => e\.from === from && e\.when === when && e\.to === to\)/)
    expect(canvas).toMatch(/\{ \.\.\.d, edges: \[\.\.\.d\.edges, \{ from, when, to \}\] \}/)
  })

  it('开始芯片的连线 = 改写 entry（不进边表）', () => {
    expect(canvas).toMatch(/conn\.source === terminalNodeId\('START'\)/)
    expect(canvas).toMatch(/\{ \.\.\.d, entry: to \}/)
  })

  it('开始→入口的边是派生面：id start-entry，不可选中不进属性面板', () => {
    expect(canvas).toContain("id: 'start-entry'")
    // 不可选中就进不了面板（面板只认节点，见「点连线不开面板」那条）；
    // 键删的依据是 edges 里的 selected，所以它天然也删不掉。
    expect(canvas).toMatch(/id: 'start-entry',[\s\S]{0,400}?selectable: false/)
  })

  it('拖停写回 layout（画布就绪契约的写入面）', () => {
    expect(canvas).toContain('onNodeDragStop')
    expect(canvas).toMatch(/layout: \{ x: Math\.round\(node\.position\.x\), y: Math\.round\(node\.position\.y\) \}/)
  })

  it('三类节点归一在三处生效：向导打开 / 助手应用 / 保存', () => {
    expect(wizard).toMatch(/autoWorkflowLayout\(normalizeSimpleWorkflow\(blankWorkflow/)
    // 助手应用（2026-11-08）：提案合并后先归一、再校验、再过布局才灌进画布。
    expect(wizard).toMatch(/normalizeSimpleWorkflow\(applyWorkflowAssistantPatch\(patch, def\)\)/)
    expect(wizard).toMatch(/setDef\(autoWorkflowLayout\(normalized\)\)/)
    expect(wizard).toMatch(/normalizeSimpleWorkflow\(def\)/)
  })

  it('助手代建结果过 normalize + autoWorkflowLayout 后灌进画布（向导助手栏）', () => {
    expect(wizard).toMatch(/setDef\(autoWorkflowLayout\(normalized\)\)/)
    expect(wizard).toMatch(/validateWorkflow\(normalized\)/)
  })
})

describe('normalizeSimpleWorkflow（三类节点归一）', () => {
  const def = (partial: Partial<WorkflowDefinition>): WorkflowDefinition => ({
    id: 't',
    name: 't',
    entry: 'a',
    nodes: [],
    edges: [],
    ...partial,
  })

  it('自定义结果状态原样保留；缺失/全空回落 [pass]，去空去重', () => {
    // user 2026-11-09「让用户自定义成功、失败等结果状态，因为这会涉及到流程
    // 调度」：归一不得再把用户声明的词汇表折成单出口（旧行为，已撤）。
    const out = normalizeSimpleWorkflow(
      def({
        nodes: [
          { id: 'a', title: 'a', prompt: 'p', verdicts: ['pass', 'fail', 'blocked'] },
          { id: 'b', title: 'b', prompt: 'p', verdicts: ['  ok ', '', 'ok'] },
          { id: 'c', title: 'c', prompt: 'p', verdicts: [] },
          { id: 'd', title: 'd', prompt: 'p' } as never,
        ],
      }),
    )
    expect(out.nodes[0].verdicts).toEqual(['pass', 'fail', 'blocked'])
    expect(out.nodes[1].verdicts).toEqual(['ok'])
    expect(out.nodes[2].verdicts).toEqual(['pass'])
    expect(out.nodes[3].verdicts).toEqual(['pass'])
  })

  it('去往 FAILED/RETRY 的边丢弃；到节点的边与 DONE 保留（when 是调度键，不改写）', () => {
    const out = normalizeSimpleWorkflow(
      def({
        nodes: [
          { id: 'a', title: 'a', prompt: 'p', verdicts: ['pass', 'fail'] },
          { id: 'b', title: 'b', prompt: 'p', verdicts: ['pass'] },
        ],
        edges: [
          { from: 'a', when: 'pass', to: 'b' },
          { from: 'a', when: 'fail', to: 'FAILED' },
          { from: 'a', when: 'fail', to: 'b' },
          { from: 'b', when: 'pass', to: 'DONE' },
        ],
      }),
    )
    // 'fail' 是 a 声明的状态，指向 b 的边是合法的条件分支——留着。
    expect(out.edges).toEqual([
      { from: 'a', when: 'pass', to: 'b' },
      { from: 'a', when: 'fail', to: 'b' },
      { from: 'b', when: 'pass', to: 'DONE' },
    ])
  })

  it('when 不在起点词汇表里的悬空边丢弃（手改 JSON / 助手代建送进来的）', () => {
    const out = normalizeSimpleWorkflow(
      def({
        nodes: [
          { id: 'a', title: 'a', prompt: 'p', verdicts: ['pass'] },
          { id: 'b', title: 'b', prompt: 'p', verdicts: ['pass'] },
        ],
        edges: [
          { from: 'a', when: 'pass', to: 'b' },
          { from: 'a', when: 'boom', to: 'DONE' },
        ],
      }),
    )
    expect(out.edges).toEqual([{ from: 'a', when: 'pass', to: 'b' }])
  })

  it('同一节点多条出边全部保留（多出口），只有完全重复的连线才丢', () => {
    const out = normalizeSimpleWorkflow(
      def({
        nodes: [
          { id: 'a', title: 'a', prompt: 'p', verdicts: ['pass'] },
          { id: 'b', title: 'b', prompt: 'p', verdicts: ['pass'] },
        ],
        edges: [
          { from: 'a', when: 'pass', to: 'b' },
          { from: 'a', when: 'pass', to: 'DONE' },
          { from: 'a', when: 'pass', to: 'b' },
          { from: 'b', when: 'pass', to: 'a' },
        ],
      }),
    )
    expect(out.edges).toEqual([
      { from: 'a', when: 'pass', to: 'b' },
      { from: 'a', when: 'pass', to: 'DONE' },
      { from: 'b', when: 'pass', to: 'a' },
    ])
  })

  it('端点已死的边（节点被删/目标缺失）清除', () => {
    const out = normalizeSimpleWorkflow(
      def({
        nodes: [{ id: 'a', title: 'a', prompt: 'p', verdicts: ['pass'] }],
        edges: [{ from: 'a', when: 'pass', to: 'ghost' }],
      }),
    )
    expect(out.edges).toEqual([])
  })

  it('状态定义归一：键值 trim、空值丢、孤儿键（不在词汇表里）丢、表空整个字段不写', () => {
    // user 2026-11-09「定义结果状态时还需要明确状态定义」：verdictDefs 是可选的
    // 补充说明，归一口径与 verdicts 同源——状态名没了，说明就没有主语了。
    const out = normalizeSimpleWorkflow(
      def({
        nodes: [
          {
            id: 'a',
            title: 'a',
            prompt: 'p',
            verdicts: ['pass', 'fail'],
            verdictDefs: { ' pass ': '  产物齐备  ', fail: '   ', ghost: '已删除的状态', pass: '重复键不覆盖' },
          },
          { id: 'b', title: 'b', prompt: 'p', verdicts: ['pass'], verdictDefs: { ghost: '孤儿' } },
          { id: 'c', title: 'c', prompt: 'p', verdicts: ['pass'] },
        ],
      }),
    )
    expect(out.nodes[0].verdictDefs).toEqual({ pass: '产物齐备' })
    // 整表没有一条可用 → 字段整个不写（不是空对象，旧定义逐字节不变）。
    expect('verdictDefs' in out.nodes[1]).toBe(false)
    expect('verdictDefs' in out.nodes[2]).toBe(false)
  })
})

describe('inputSideOf（入线落点几何）', () => {
  const wf = (edges: WorkflowDefinition['edges'], layouts: Record<string, { x: number; y: number }>): WorkflowDefinition => ({
    id: 't',
    name: 't',
    entry: 'a',
    nodes: Object.keys(layouts).map((id) => ({ id, title: id, prompt: 'p', verdicts: ['pass'], layout: layouts[id] })),
    edges,
  })

  it('目标在右 → in-left（从左侧进）；在左 → in-right', () => {
    const def = wf([], { a: { x: 80, y: 80 }, right: { x: 700, y: 80 }, left: { x: -500, y: 80 } })
    expect(inputSideOf(def, 'a', 'right')).toBe('in-left')
    expect(inputSideOf(def, 'a', 'left')).toBe('in-right')
  })

  it('上下占优 → in-top（同列上下排布不被画成侧面横插）', () => {
    const def = wf([], { a: { x: 80, y: 80 }, below: { x: 100, y: 380 } })
    expect(inputSideOf(def, 'a', 'below')).toBe('in-top')
  })

  it('横向差压过 1.2 倍才走侧向（斜向偏下的仍进侧边）', () => {
    const def = wf([], { a: { x: 0, y: 0 }, diag: { x: 300, y: 200 } })
    // |300| > |200| * 1.2 = 240，且两卡横向不重叠（266 + 34 的间距）
    expect(inputSideOf(def, 'a', 'diag')).toBe('in-left')
    // 横向差同样够（300），但纵向差也大（280）：|300| < |280| * 1.2 = 336 → 顶入
    const steep = wf([], { a: { x: 0, y: 0 }, diag: { x: 300, y: 280 } })
    expect(inputSideOf(steep, 'a', 'diag')).toBe('in-top')
  })

  it('两卡横向重叠 → 一律顶入（侧端口与 stub 落点都被邻居卡埋住，选它必无路）', () => {
    // 卡宽是**外框** 266：200 的重叠里，侧端口（x=200/266）与外推 16px 的 stub
    // 都落在对方卡内部——路由只能无解、画出穿卡折线（2026-11-09 探针 §8 实锤）。
    const overlap = wf([], { a: { x: 0, y: 0 }, near: { x: 200, y: 40 } })
    expect(inputSideOf(overlap, 'a', 'near')).toBe('in-top')
    // 刚好错开（间距 34 > 0）就恢复侧向：门槛只看「有没有重叠」，不是要拉开很远。
    const apart = wf([], { a: { x: 0, y: 0 }, near: { x: 300, y: 40 } })
    expect(inputSideOf(apart, 'a', 'near')).toBe('in-left')
  })

  it('任一端没落位（新建未布局）回落 in-top', () => {
    const def = wf([], { a: { x: 80, y: 80 } })
    def.nodes.push({ id: 'fresh', title: 'f', prompt: 'p', verdicts: ['pass'] })
    expect(inputSideOf(def, 'a', 'fresh')).toBe('in-top')
    expect(inputSideOf(def, 'fresh', 'a')).toBe('in-top')
  })

  it('开始芯片用派生位算出真实选边（垂直派生位 → in-top；拖到左侧 → in-left）', () => {
    // 垂直布局的派生位 = 入口卡上方 90px、中轴线对齐 → 从入口的顶进。
    const def = wf([], { a: { x: 80, y: 80 } })
    expect(inputSideOf(def, 'START', 'a')).toBe('in-top')
    // 用户把开始芯片拖到左侧 → 落点跟着几何走（不是恒 in-top）。
    const moved = { ...def, terminalLayout: { start: { x: -400, y: 80 } } }
    expect(inputSideOf(moved, 'START', 'a')).toBe('in-left')
  })
})

describe('altSidesOf（换侧绕行的备选入口）', () => {
  const wf = (layouts: Record<string, { x: number; y: number }>): WorkflowDefinition => ({
    id: 't',
    name: 't',
    entry: 'a',
    nodes: Object.keys(layouts).map((id) => ({ id, title: id, prompt: 'p', verdicts: ['pass'], layout: layouts[id] })),
    edges: [],
  })

  it('主侧是左/右 → 先给对侧（「从右侧绕行」），再给顶入', () => {
    const def = wf({ a: { x: 80, y: 80 }, right: { x: 700, y: 80 }, left: { x: -500, y: 80 } })
    expect(inputSideOf(def, 'a', 'right')).toBe('in-left')
    expect(altSidesOf(def, 'a', 'right')).toEqual(['in-right', 'in-top'])
    expect(inputSideOf(def, 'a', 'left')).toBe('in-right')
    expect(altSidesOf(def, 'a', 'left')).toEqual(['in-left', 'in-top'])
  })

  it('主侧是顶 → 先给朝向源的那一侧，再给另一侧（排除主侧）', () => {
    const below = wf({ a: { x: 80, y: 80 }, b: { x: 400, y: 380 } })
    expect(inputSideOf(below, 'a', 'b')).toBe('in-top')
    expect(altSidesOf(below, 'a', 'b')).toEqual(['in-left', 'in-right'])
    // 源在右上方（dx < 0）→ 右侧优先。
    const leftward = wf({ a: { x: 100, y: 80 }, b: { x: -200, y: 380 } })
    expect(inputSideOf(leftward, 'a', 'b')).toBe('in-top')
    expect(altSidesOf(leftward, 'a', 'b')).toEqual(['in-right', 'in-left'])
  })

  it('两卡横向重叠 → 不给备选（侧端口两边同样被埋住，换过去只是换一个无解端口）', () => {
    const overlap = wf({ a: { x: 0, y: 0 }, near: { x: 200, y: 40 } })
    expect(altSidesOf(overlap, 'a', 'near')).toEqual([])
  })

  it('任一端没落位 → 不给备选（此时连主侧都只是回落 in-top）', () => {
    const def = wf({ a: { x: 80, y: 80 } })
    def.nodes.push({ id: 'fresh', title: 'f', prompt: 'p', verdicts: ['pass'] })
    expect(altSidesOf(def, 'a', 'fresh')).toEqual([])
    expect(altSidesOf(def, 'fresh', 'a')).toEqual([])
  })
})

describe('loopEdgeKeys（回边 = 闭合成环，画布与运行器单一真源）', () => {
  const def = (edges: WorkflowDefinition['edges'], ids: string[] = ['a', 'b', 'c', 'd']): WorkflowDefinition => ({
    id: 't',
    name: 't',
    entry: 'a',
    nodes: ids.map((id) => ({ id, title: id, prompt: 'p', verdicts: ['pass'] })),
    edges,
  })

  it('自环恒是回边；A→B→A 两条都闭合成环', () => {
    const self = def([{ from: 'a', when: 'pass', to: 'a' }])
    expect(isLoopEdge(loopEdgeKeys(self), { from: 'a', to: 'a' })).toBe(true)
    const cycle = def([
      { from: 'a', when: 'pass', to: 'b' },
      { from: 'b', when: 'pass', to: 'a' },
    ])
    const keys = loopEdgeKeys(cycle)
    expect(isLoopEdge(keys, { from: 'a', to: 'b' })).toBe(true)
    expect(isLoopEdge(keys, { from: 'b', to: 'a' })).toBe(true)
  })

  it('菱形长分支的汇入边不是回边（层深比较在这里会误判）', () => {
    // a→b→b2、a→c、c→d、b2→d：d 的 BFS 层深被短分支 c→d 压成 2，b2 也是 2；
    // 层深比较会把 b2→d 当回边，AND-join 就废了。
    const diamond = def(
      [
        { from: 'a', when: 'pass', to: 'b' },
        { from: 'a', when: 'pass', to: 'c' },
        { from: 'b', when: 'pass', to: 'b2' },
        { from: 'c', when: 'pass', to: 'd' },
        { from: 'b2', when: 'pass', to: 'd' },
      ],
      ['a', 'b', 'b2', 'c', 'd'],
    )
    const keys = loopEdgeKeys(diamond)
    expect(isLoopEdge(keys, { from: 'b2', to: 'd' })).toBe(false)
    expect(isLoopEdge(keys, { from: 'c', to: 'd' })).toBe(false)
    expect(isLoopEdge(keys, { from: 'a', to: 'b' })).toBe(false)
  })

  it('终态不参与闭合：A→DONE 恒不是回边，A→DONE 也不算环', () => {
    const keys = loopEdgeKeys(def([{ from: 'a', when: 'pass', to: 'DONE' }]))
    expect(keys.size).toBe(0)
  })
})

describe('autoWorkflowLayout', () => {
  const def = (partial: Partial<WorkflowDefinition>): WorkflowDefinition => ({
    id: 't',
    name: 't',
    entry: 'a',
    nodes: [],
    edges: [],
    ...partial,
  })

  // 垂直布局（user 2026-11-09「工作流默认用垂直布局，不要用水平」）：深度 →
  // 行（y，每层 +160），同层兄弟 → 列（x，每个 +300）；原点仍 (80,80)。
  it('BFS 分层（纵向）：入口 y=80 起，每层 +160；同层兄弟横向 +300', () => {
    const d = autoWorkflowLayout(
      def({
        entry: 'a',
        nodes: [
          { id: 'a', title: 'a', prompt: 'p', verdicts: ['pass'] },
          { id: 'b', title: 'b', prompt: 'p', verdicts: ['pass'] },
          { id: 'c', title: 'c', prompt: 'p', verdicts: ['pass'] },
        ],
        edges: [
          { from: 'a', when: 'pass', to: 'b' },
          { from: 'b', when: 'pass', to: 'c' },
        ],
      }),
    )
    expect(d.nodes.find((n) => n.id === 'a')!.layout).toEqual({ x: 80, y: 80 })
    expect(d.nodes.find((n) => n.id === 'b')!.layout).toEqual({ x: 80, y: 240 })
    expect(d.nodes.find((n) => n.id === 'c')!.layout).toEqual({ x: 80, y: 400 })
  })

  it('扇出：同层两个分支同 y、横向并排（不是竖着堆在同一列）', () => {
    const d = autoWorkflowLayout(
      def({
        entry: 'a',
        nodes: [
          { id: 'a', title: 'a', prompt: 'p', verdicts: ['pass'] },
          { id: 'b', title: 'b', prompt: 'p', verdicts: ['pass'] },
          { id: 'c', title: 'c', prompt: 'p', verdicts: ['pass'] },
        ],
        edges: [
          { from: 'a', when: 'pass', to: 'b' },
          { from: 'a', when: 'pass', to: 'c' },
        ],
      }),
    )
    expect(d.nodes.find((n) => n.id === 'b')!.layout).toEqual({ x: 80, y: 240 })
    expect(d.nodes.find((n) => n.id === 'c')!.layout).toEqual({ x: 380, y: 240 })
  })

  it('已有 layout 的节点原样保留（助手/历史坐标不动）', () => {
    const d = autoWorkflowLayout(
      def({
        entry: 'a',
        nodes: [
          { id: 'a', title: 'a', prompt: 'p', verdicts: ['pass'], layout: { x: 500, y: 300 } },
          { id: 'b', title: 'b', prompt: 'p', verdicts: ['pass'] },
        ],
        edges: [{ from: 'a', when: 'pass', to: 'b' }],
      }),
    )
    expect(d.nodes.find((n) => n.id === 'a')!.layout).toEqual({ x: 500, y: 300 })
    expect(d.nodes.find((n) => n.id === 'b')!.layout).toEqual({ x: 80, y: 240 })
  })

  it('RETRY 边不引入新层（回本节点）；DONE/FAILED 不算节点', () => {
    const d = autoWorkflowLayout(
      def({
        entry: 'a',
        nodes: [
          { id: 'a', title: 'a', prompt: 'p', verdicts: ['pass', 'fail'] },
          { id: 'b', title: 'b', prompt: 'p', verdicts: ['pass'] },
        ],
        edges: [
          { from: 'a', when: 'pass', to: 'b' },
          { from: 'a', when: 'fail', to: 'RETRY' },
          { from: 'b', when: 'pass', to: 'DONE' },
        ],
      }),
    )
    expect(d.nodes.find((n) => n.id === 'a')!.layout).toEqual({ x: 80, y: 80 })
    expect(d.nodes.find((n) => n.id === 'b')!.layout).toEqual({ x: 80, y: 240 })
  })

  it('不可达节点排在最深层的下一行，横向排队', () => {
    const d = autoWorkflowLayout(
      def({
        entry: 'a',
        nodes: [
          { id: 'a', title: 'a', prompt: 'p', verdicts: ['pass'] },
          { id: 'orphan1', title: 'o1', prompt: 'p', verdicts: ['pass'] },
          { id: 'orphan2', title: 'o2', prompt: 'p', verdicts: ['pass'] },
        ],
        edges: [],
      }),
    )
    // entry 恒可达（BFS 起点，深度 0）；无出边不改变可达性。
    expect(d.nodes.find((n) => n.id === 'a')!.layout).toEqual({ x: 80, y: 80 })
    // 孤儿行在最深层的下一行（80+1*160=240），横向排队。
    expect(d.nodes.find((n) => n.id === 'orphan1')!.layout).toEqual({ x: 80, y: 240 })
    expect(d.nodes.find((n) => n.id === 'orphan2')!.layout).toEqual({ x: 380, y: 240 })
  })

  it('全部已有 layout 时原 def 返回（零拷贝快路径）', () => {
    const input = def({
      entry: 'a',
      nodes: [{ id: 'a', title: 'a', prompt: 'p', verdicts: ['pass'], layout: { x: 1, y: 2 } }],
      edges: [],
    })
    expect(autoWorkflowLayout(input)).toBe(input)
  })

  it('force: true 全量重排（工具箱「自动整理」，已有坐标也重算）', () => {
    const input = def({
      entry: 'a',
      nodes: [
        { id: 'a', title: 'a', prompt: 'p', verdicts: ['pass'], layout: { x: 999, y: 999 } },
        { id: 'b', title: 'b', prompt: 'p', verdicts: ['pass'], layout: { x: -50, y: -50 } },
      ],
      edges: [{ from: 'a', when: 'pass', to: 'b' }],
    })
    const out = autoWorkflowLayout(input, { force: true })
    expect(out.nodes.find((n) => n.id === 'a')!.layout).toEqual({ x: 80, y: 80 })
    expect(out.nodes.find((n) => n.id === 'b')!.layout).toEqual({ x: 80, y: 240 })
  })

  // 层内重心排序（user 2026-11-09「连接线会有很多交叉的情况」）：同层节点
  // 不再按声明序排开，而是按上游/下游已定的横向序号取重心——声明序与拓扑
  // 邻居无关时，两条线会在层带中间交叉。
  describe('层内重心排序（减少连线交叉）', () => {
    /** id → 层内序号（x 轴第几列）。 */
    const columnsOf = (d: WorkflowDefinition): Map<string, number> => new Map(d.nodes.map((n) => [n.id, Math.round((n.layout!.x - 80) / 300)]))
    /** id → 声明序在**本层**里的位次（= 旧落位算法的横排次序）。 */
    const declarationColumns = (d: WorkflowDefinition): Map<string, number> => {
      const depth = depthOf(d)
      const seen = new Map<number, number>()
      const out = new Map<string, number>()
      for (const n of d.nodes) {
        const dep = depth.get(n.id)
        if (dep === undefined) continue
        const i = seen.get(dep) ?? 0
        out.set(n.id, i)
        seen.set(dep, i + 1)
      }
      return out
    }

    const crossed = def({
      entry: 'a',
      // 声明序刻意让两条下游「远左近右」：d 排在 e 前面，但 d 的上游是右边
      // 的 c——旧算法会给出 b(0)→e(1)、c(1)→d(0) 的交叉。
      nodes: [
        { id: 'a', title: 'a', prompt: 'p', verdicts: ['pass'] },
        { id: 'b', title: 'b', prompt: 'p', verdicts: ['pass'] },
        { id: 'c', title: 'c', prompt: 'p', verdicts: ['pass'] },
        { id: 'd', title: 'd', prompt: 'p', verdicts: ['pass'] },
        { id: 'e', title: 'e', prompt: 'p', verdicts: ['pass'] },
      ],
      edges: [
        { from: 'a', when: 'pass', to: 'b' },
        { from: 'a', when: 'pass', to: 'c' },
        { from: 'b', when: 'pass', to: 'e' },
        { from: 'c', when: 'pass', to: 'd' },
      ],
    })

    it('声明序落位有交叉，自动布局重排后交叉归零（且单调不增）', () => {
      const before = countCrossings(crossed, declarationColumns(crossed))
      expect(before).toBe(1)
      const out = autoWorkflowLayout(crossed)
      const after = countCrossings(out, columnsOf(out))
      expect(after).toBe(0)
      expect(after).toBeLessThanOrEqual(before)
      // 重心把 d 挪到右列、e 挪到左列（与各自上游对齐）。
      expect(out.nodes.find((n) => n.id === 'e')!.layout).toEqual({ x: 80, y: 400 })
      expect(out.nodes.find((n) => n.id === 'd')!.layout).toEqual({ x: 380, y: 400 })
    })

    it('本来就无交叉的菱形不被排乱（barycenter 平局时保持声明序）', () => {
      const diamond = def({
        entry: 'a',
        nodes: [
          { id: 'a', title: 'a', prompt: 'p', verdicts: ['pass'] },
          { id: 'b', title: 'b', prompt: 'p', verdicts: ['pass'] },
          { id: 'c', title: 'c', prompt: 'p', verdicts: ['pass'] },
          { id: 'd', title: 'd', prompt: 'p', verdicts: ['pass'] },
        ],
        edges: [
          { from: 'a', when: 'pass', to: 'b' },
          { from: 'a', when: 'pass', to: 'c' },
          { from: 'b', when: 'pass', to: 'd' },
          { from: 'c', when: 'pass', to: 'd' },
        ],
      })
      const out = autoWorkflowLayout(diamond)
      expect(countCrossings(out, columnsOf(out))).toBe(0)
      expect(out.nodes.find((n) => n.id === 'b')!.layout).toEqual({ x: 80, y: 240 })
      expect(out.nodes.find((n) => n.id === 'c')!.layout).toEqual({ x: 380, y: 240 })
      expect(out.nodes.find((n) => n.id === 'd')!.layout).toEqual({ x: 80, y: 400 })
    })

    it('已落位的节点不参与重排（无 layout 的兄弟仍按重心对齐）', () => {
      const partial = def({
        entry: 'a',
        nodes: [
          { id: 'a', title: 'a', prompt: 'p', verdicts: ['pass'], layout: { x: 80, y: 80 } },
          { id: 'b', title: 'b', prompt: 'p', verdicts: ['pass'], layout: { x: 380, y: 240 } },
          { id: 'c', title: 'c', prompt: 'p', verdicts: ['pass'] },
        ],
        edges: [
          { from: 'a', when: 'pass', to: 'b' },
          { from: 'a', when: 'pass', to: 'c' },
        ],
      })
      const out = autoWorkflowLayout(partial)
      expect(out.nodes.find((n) => n.id === 'b')!.layout).toEqual({ x: 380, y: 240 })
      // c 是唯一待落位节点 → 独占首列，不因 b 的坐标漂移。
      expect(out.nodes.find((n) => n.id === 'c')!.layout).toEqual({ x: 80, y: 240 })
    })
  })
})

describe('canvas toolbox & simple model', () => {
  const canvas = read('src/renderer/src/components/routine/WorkflowCanvas.tsx')
  const card = read('src/renderer/src/components/routine/WorkflowNodeCard.tsx')
  const dock = read('src/renderer/src/components/routine/WorkflowCanvasDock.tsx')
  const wizard = read('src/renderer/src/components/routine/TaskWizardPage.tsx')

  it('左侧工具箱已撤（画布吃满宽度）：添加/整理收成一列图标悬浮窗', () => {
    // user 2026-11-09：为了让画布有更多空间，箱子整块拿掉，面板浮在画布
    // 左缘、垂直居中、竖排、只有图标（文案退到 title/aria-label）。箱子
    // 的拖动落点链路（TOOLBOX_DRAG_MIME/onDrop）随之整条删除——添加钮
    // 落在当前视口中心，别把拖入那条死路拼回来。
    expect(canvas).not.toContain('<WorkflowToolbox')
    expect(canvas).not.toContain('TOOLBOX_DRAG_MIME')
    expect(canvas).not.toContain('wf-toolbox')
    expect(canvas).not.toContain('onDrop')
    expect(canvas).toContain('<WorkflowCanvasDock')
    expect(canvas).toContain('autoWorkflowLayout(d, { force: true })')
    // 悬浮窗：竖排图标钮 + 探针锚点，两个动作（添加/整理）。
    expect(dock).toContain('data-canvas-dock="workflow"')
    expect(dock).toContain('PlusOutlined')
    expect(dock).toContain('onAddNode')
    expect(dock).toContain('onTidy')
    // 面板定位住在画布 CSS 里（绝对定位贴左缘、垂直居中、竖排、压过 RF 图层）。
    expect(canvas).toContain('.wf-canvas-dock')
    expect(canvas).toMatch(/\.wf-canvas-dock \{[^}]*flex-direction: column/)
    expect(canvas).toMatch(/top: 50%; transform: translateY\(-50%\)/)
    expect(canvas).toContain('.wf-dock-btn')
  })

  it('缩放条里不再挂添加钮（同一功能只留一处入口）', () => {
    // 旧形态：<Controls> 的子节点塞了一个「添加环节」按钮，视觉上混进
    // 缩放三兄弟（user 2026-11-09 明确要删）。Controls 必须是自闭合空壳。
    expect(canvas).toMatch(/<Controls showInteractive=\{false\} \/>/)
    expect(canvas).not.toContain('wf-add-node-btn')
    // 死 i18n 键不得回流（文案已迁到 canvasAddNode/canvasTidy）。
    expect(read('src/renderer/src/i18n/locales/zh.ts')).not.toContain('toolboxTitle')
    expect(read('src/renderer/src/i18n/locales/en.ts')).not.toContain('toolboxTitle')
  })

  it('工作流级「全局目标」编辑栏已撤（user 2026-11-09），运行级覆盖仍在启动表单', () => {
    // 画布上方那块「全局目标（可空）」输入框整块拿掉；objective 字段本身
    // 不动（render 解析序 运行级 > 工作流级 > 空），启动表单仍可逐次覆盖。
    expect(wizard).not.toContain('canvasObjectivePlaceholder')
    expect(wizard).not.toMatch(/def\.objective/)
    expect(read('src/renderer/src/i18n/locales/zh.ts')).not.toContain('canvasObjectivePlaceholder')
    expect(read('src/renderer/src/i18n/locales/en.ts')).not.toContain('canvasObjectivePlaceholder')
    const runModal = read('src/renderer/src/components/routine/WorkflowRunModal.tsx')
    expect(runModal).toContain('objectivePlaceholder')
    expect(runModal).toContain('objective: runObjective.trim() || undefined')
    // 解析序没被改动：运行级目标缺省回落工作流级，再回落空。
    expect(read('src/shared/workflow/render.ts')).toContain('export function resolveObjective')
  })

  it('终态芯片可拖动：落点持久在 def.terminalLayout（缺席 = 派生位）', () => {
    expect(canvas).toMatch(/def\.terminalLayout\?\.start \?\?/)
    expect(canvas).toMatch(/terminalLayout: \{ \.\.\.d\.terminalLayout/)
    expect(canvas).not.toMatch(/draggable: false/)
  })

  it('三类节点形态：任务卡三入线头 + 每状态一个出口线头；START/DONE 芯片；FAILED/RETRY 芯片不回流', () => {
    // 出口 = 每个结果状态一根（user 2026-11-09）：id 是 `out:<verdict>`，画布
    // 从它的 id 反解调度键——旧的恒定 `id="pass"` 已废，别再写回去。
    expect(card).toContain("export const STAGE_OUT_HANDLE_PREFIX = 'out:'")
    expect(card).toMatch(/id=\{stageOutHandleId\(v\)\}/)
    expect(card).not.toContain('Handle id="pass"')
    // 三个入线头必须各带唯一 id：React Flow 的 handle 身份是 (nodeId, type, id)，
    // 去掉 id 会让三条入边挤到同一个落点、几何选边全失效。
    for (const id of ['in-top', 'in-left', 'in-right']) {
      expect(card).toContain(`id="${id}" type="target"`)
    }
    expect(card).toContain("'START'")
    expect(card).toContain("'DONE'")
    // 只允许注释提及退役抽象，不允许任何功能引用。
    expect(card).not.toMatch(/kind: 'FAILED'|kind: 'RETRY'|Handle[^>]*FAILED/)
    expect(canvas).not.toContain("terminalNodeId('FAILED')")
    expect(canvas).not.toContain("terminalNodeId('RETRY')")
  })

  it('卡上状态名逐根钉在自己那根出口线头正上方、且紧贴圆点（user 2026-11-09）', () => {
    // 「自定义的输出结果状态文字，距离连接端点太远了」指的是**卡上这行字**，
    // 不是连线标签。旧写法是 4px gap 的均分网格：网格分的是**内容盒**（卡左右
    // 各 12px padding、再扣列 gap），而出口 Handle 的 left 百分比分的是**padding
    // 盒**，所以文字中心与线头差几像素；纵向 text 底边距卡边 6+14=20px，圆点却
    // 正好压在那条边上。现在每个状态名绝对定位、left 用与 Handle 完全同一个
    // 表达式，行用负横向边距撑到 padding 盒，卡的 padding-bottom 收到 8px。
    expect(card).toMatch(/className=\{multi \? 'wf-stage-card has-verdicts' : 'wf-stage-card'\}/)
    // 同一个 (i+0.5)/n 表达式必须出现两次（状态名 + 出口 Handle）——两处各写
    // 一份必然漂移，那正是这个 bug 的形态。
    const alignExpr = '((i + 0.5) / verdicts.length) * 100'
    expect(card.split(alignExpr).length - 1).toBe(2)
    expect(card).toContain('maxWidth: `${100 / verdicts.length}%`')
    // 网格已废，别再长回来（display:grid / gridTemplateColumns 两种写法都堵）。
    expect(card).not.toContain('gridTemplateColumns')
    expect(canvas).not.toMatch(/\.wf-stage-verdicts \{[^}]*display: grid/)

    // 行撑到 padding 盒（线头的百分比按它算）+ 定高 14px，与文字 line-height 同值。
    expect(canvas).toContain('.wf-stage-verdicts { position: relative; height: 14px; margin: 0 -12px; }')
    // 单条状态名：绝对定位 + 水平居中回自己的锚点。
    expect(canvas).toMatch(/\.wf-stage-verdict \{\s*position: absolute; top: 0; transform: translateX\(-50%\);/)
    expect(canvas).toMatch(/\.wf-stage-verdict \{[^}]*line-height: 14px/)
    // 多出口卡的下内距收到 8px：文字底边距圆点上缘只留 3px（圆点半径 6、压在卡缘）。
    expect(canvas).toContain('.wf-stage-card.has-verdicts { padding-bottom: 8px; }')
  })

  it('入口徽标已撤、面板只由悬停编辑钮唤起（user 2026-11-09 两裁定）', () => {
    // ① 「去掉节点的【入口】标记」：开始芯片已经指到入口节点了，徽标是重复信息。
    expect(card).not.toContain('wf-entry-badge')
    expect(card).not.toContain('canvasEntryBadge')
    expect(read('src/renderer/src/i18n/locales/zh.ts')).not.toContain('canvasEntryBadge')
    expect(read('src/renderer/src/i18n/locales/en.ts')).not.toContain('canvasEntryBadge')
    // ② 点节点本体不再开面板；只有卡片内右上角的钮能开（悬停才露，CSS 管视觉）。
    expect(canvas).not.toMatch(/onNodeClick=/)
    expect(card).toContain('data-workflow-node-edit')
    expect(card).toMatch(/className="wf-node-edit nodrag nopan"/)
    expect(card).toMatch(/onEdit\(node\.id\)/)
    expect(canvas).toContain('const openNode = useCallback((id: string) => setEditingNodeId(id), [])')
    // CSS 承重：默认 opacity 0 + pointer-events none（不然透明钮仍能点到），
    // 悬停/选中/focus-visible 三态才露。
    expect(canvas).toMatch(/\.wf-node-edit:hover \{ color: var\(--pm-link\); \}/)
    expect(canvas).toMatch(/\.wf-stage-card:hover \.wf-node-edit,/)
    expect(canvas).toMatch(/pointer-events: none;/)
  })

  it('悬停区第二颗钮：编辑旁还有删除，同组显形、确认后才删（user 2026-11-09）', () => {
    // 两颗钮都是卡内绝对定位+静止态不可见不可点：共用一条 opacity/pointer-events
    // 规则，任何一颗单独漏掉都会变成「看得见点不到」或「点得到看不见」。
    expect(card).toContain('data-workflow-node-delete')
    expect(card).toMatch(/className="wf-node-delete nodrag nopan"/)
    expect(card).toMatch(/onDelete\(node\.id\)/)
    expect(canvas).toContain("deleteLabel: t('workflow.canvasDeleteNode')")
    // 删除钮在编辑钮左侧一格（22px 钮 + 4px 间距 → right: 32px）；显形三态与
    // 编辑钮同一组；hover 色走 --pm-error（--pm-danger 这个变量全仓不存在）。
    expect(canvas).toMatch(/\.wf-node-edit, \.wf-node-delete \{/)
    expect(canvas).toMatch(/\.wf-node-delete \{ right: 32px; \}/)
    expect(canvas).toMatch(/\.wf-stage-card:hover \.wf-node-delete,/)
    expect(canvas).toMatch(/\.wf-node-delete:hover \{ color: var\(--pm-error\); \}/)
    // 删除有连带后果（该节点的所有连线，entry 被删还会改入口），所以必须二次
    // 确认；悬停钮与面板脚注走同一个入口，不许两套确认话术。
    expect(canvas).toMatch(/const requestDeleteNode = /)
    expect(canvas).toContain('canvasDeleteNodeConfirm')
    expect(canvas).toMatch(/onClick=\{\(\) => requestDeleteNode\(selectedNode\.id\)\}/)
  })

  it('结果状态可在属性面板增删改：改名级联改写该状态的出边', () => {
    expect(canvas).toContain('canvasVerdictsLabel')
    expect(canvas).toContain('data-workflow-verdicts')
    expect(canvas).toContain('data-workflow-verdict-add')
    expect(canvas).toContain('data-workflow-verdict-row')
    // 改名必须级联：边的 when 是调度键，只改 nodes 会让边悬空（校验红、运行不可达）。
    expect(canvas).toMatch(/const renameVerdict = /)
    expect(canvas).toMatch(/e\.from === nodeId && e\.when === prev/)
    // 删状态连带删它的出边，且先确认（连线会一起消失）。
    expect(canvas).toMatch(/const removeVerdict = /)
    expect(canvas).toMatch(/canvasVerdictRemoveConfirm/)
    // 至少留一个状态：空词汇表会让卡片没有出口线头。
    expect(canvas).toMatch(/disabled=\{selectedNode\.verdicts\.length <= 1\}/)
    expect(card).not.toContain('wf-diamond')
    expect(card).not.toContain('verdictColor')
  })

  it('每个结果状态可以写一句定义，改名字跟着搬家、删状态一起删（user 2026-11-09）', () => {
    // 只给状态名，模型没有依据判断该报哪一个（「自定义的输出结果状态」那一刀的
    // 遗留）；定义表的键是状态名，所以三处级联必须同时做：写入、改名、删除。
    expect(canvas).toContain('data-workflow-verdict-name')
    expect(canvas).toContain('data-workflow-verdict-def')
    // 写入：空串 = 删键，整表空了写 undefined（不落空对象）。
    expect(canvas).toMatch(/const setVerdictDef = /)
    expect(canvas).toMatch(/if \(next\.trim\(\)\.length === 0\) delete defs\[name\]/)
    expect(canvas).toMatch(/Object\.keys\(defs\)\.length > 0 \? defs : undefined/)
    // 改名：定义跟着键搬到新名字下，否则保存时被 simplify 当孤儿键裁掉。
    expect(canvas).toMatch(/const moveVerdictDef = /)
    expect(canvas).toMatch(/defs && defs\[prev\] !== undefined \? moveVerdictDef\(defs, prev, next\) : defs/)
    // 删状态：连同它的定义一起删，表空就 delete 掉整个字段。
    expect(canvas).toMatch(/delete defs\[verdict\]/)
    expect(canvas).toMatch(/if \(Object\.keys\(defs\)\.length > 0\) next\.verdictDefs = defs/)
    // 卡面只放状态名：那句定义挂在 title 上，悬停可读。
    expect(card).toMatch(/title=\{def \? `\$\{v\}：\$\{def\}` : v\}/)
  })

  it('结果状态是「窄名 + 必填定义 + 删除」一行（user 2026-11-09）', () => {
    // 三项是一条裁定的三个面：名字短（它是线头 id 尾段/边 id 中段/prompt 契约值）、
    // 定义必填、两个输入 + 删除钮排在同一行。前一版是「名字一行、定义一行」的两行
    // 表单，名字输入还吃满整宽——状态名看起来比定义更重要，正好反了。
    //
    // 单行几何从源码切片断言：一行里只能有三个交互元素且顺序固定（名 → 定义 → 删），
    // 行容器不得是纵向流（否则又是一个字段一行）。
    const rowStart = canvas.indexOf('data-workflow-verdict-row')
    const rowEnd = canvas.indexOf('<Button type="dashed"', rowStart)
    expect(rowStart).toBeGreaterThan(-1)
    expect(rowEnd).toBeGreaterThan(rowStart)
    const row = canvas.slice(rowStart, rowEnd)
    expect(row.match(/<Input\b/g)).toHaveLength(2)
    expect(row.match(/<Button\b/g)).toHaveLength(1)
    expect(row.indexOf('data-workflow-verdict-name')).toBeLessThan(row.indexOf('data-workflow-verdict-def'))
    expect(row.indexOf('data-workflow-verdict-def')).toBeLessThan(row.indexOf('<Button'))
    expect(row).not.toContain('flexDirection')
    // 三处样式：行容器横向居中、名字定宽 104、定义占剩余宽度并能压缩到 0。
    expect(canvas).toContain("const VERDICT_ROW_STYLES: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }")
    expect(canvas).toContain("const VERDICT_NAME_STYLES: React.CSSProperties = { flex: '0 0 104px', width: 104 }")
    expect(canvas).toContain("const VERDICT_DEF_STYLES: React.CSSProperties = { flex: '1 1 auto', minWidth: 0 }")
    // 必填的可见面：空定义当场红框（不用等到点保存），且标 aria-required。
    expect(row).toContain("status={def.trim() ? undefined : 'error'}")
    expect(row).toContain('aria-required')
    // 占位文案不得再自我否认（旧文案写着「（可空）」），中英同步。
    const zhLocale = read('src/renderer/src/i18n/locales/zh.ts')
    const enLocale = read('src/renderer/src/i18n/locales/en.ts')
    expect(zhLocale).toContain("canvasVerdictDefPlaceholder: '状态定义（必填）：什么情况下报这个状态'")
    expect(enLocale).toContain("canvasVerdictDefPlaceholder: 'Definition (required): when is this state reported?'")
    for (const locale of [zhLocale, enLocale]) {
      expect(locale).not.toMatch(/canvasVerdictDefPlaceholder:[^\n]*(可空|optional)/i)
    }
    // 名字字段的占位表自带一句（旧文案复用了定义那一行）。
    expect(zhLocale).toContain("canvasVerdictNamePlaceholder: '状态名'")
  })

  it('保存门要求状态定义必填，助手侧只回显不拒（user 2026-11-09）', () => {
    // 写门比读/启严：用户落盘（saveWorkflow）传 requireVerdictDefs——缺定义
    // 的工作流不许进库。助手提案先用裸调用把结构性坏图挡在外面（toast + 不推
    // undo 帧），过门后**再跑一次**写门把 errors 回显到错误区：图已经落画布，
    // 缺定义的几个状态当场点名，用户不必等到保存才被拦。两次调用带同一个
    // 开关，但助手那次只报不拒——硬门仍只有 saveWorkflow 一处。
    expect(wizard).toMatch(/validateWorkflow\(normalized, \{ requireVerdictDefs: true \}\)/)
    expect(wizard).toMatch(/setWfErrors\(validateWorkflow\(normalized, \{ requireVerdictDefs: true \}\)\.errors\)/)
    const assistBlock = wizard.slice(wizard.indexOf('const workflowAssist = useFormAssistSession'), wizard.indexOf('const saveWorkflow'))
    // 拒绝仍然走裸调用：v.ok 判假时 setStep('content') + 不推 undo 帧。
    expect(assistBlock).toMatch(/const v = validateWorkflow\(normalized\)\n/)
    expect(assistBlock).toMatch(/if \(!v\.ok\) \{/)
    // 全文件恰好两处开关：保存门 + 助手侧回显。
    expect(wizard.match(/requireVerdictDefs: true/g)).toHaveLength(2)
    // 那一门的报错要能亮给用户：wfErrors 进内容步的告警条。
    expect(wizard).toMatch(/setWfErrors\(v\.errors\)/)
    // 模板必须自己过写门，否则用户打开模板、改一个字就再也存不下去。
    expect(read('src/main/storage/workflow-store.ts')).toMatch(/verdictDefs: \{/)
  })

  it('结束芯片是合法落点（user 2026-11-09「结束图标连线连不上」）', () => {
    // 根因：DONE 的 target Handle 上挂了 isConnectable={false}。`type="target"`
    // 本来就挡住了「从芯片起拖」，那一条只是把唯一的落点判死——任务卡的流出口
    // 拖过来会被 React Flow 当非法连接静默丢弃。任何 Handle 都不许再关连通性。
    expect(card).not.toMatch(/isConnectable=\{/)
    expect(canvas).not.toMatch(/isConnectable=\{/)
    expect(card).toMatch(/<Handle type="target" position=\{Position\.Top\} className="wf-handle-target" \/>/)
    // 落点映射：连到芯片 = 边表里的 'DONE'（不是 stripStage 出的 null）。
    expect(canvas).toMatch(/conn\.target === terminalNodeId\('DONE'\) \? 'DONE'/)
  })

  it('箭头「恰好接住」圆点：外径 12px 契约（border-box）与 ARROW_GAP = 外半径成对', () => {
    // user 2026-11-09 两轮反馈：先「连接端点会把箭头端点遮住」（终点在圆心，
    // 圆点把整枚箭头吞掉），回缩 8px 之后又「端点和箭头之前有间隙了，期望能够
    // 恰好接住」。结论是回缩量必须**等于圆点外半径**：尖正好落在圆点边缘。
    // 两条不变量一起钉，改一边忘另一边当场红：
    //   ① 圆点外径 = 12px 且 border-box——Chrome 把 1.5px 边框按设备像素取整，
    //      content-box 下外径会在 11px(DPR1)/12px(DPR2) 之间跳，箭头就忽贴忽离；
    //   ② route.ts 的 ARROW_GAP = 6 = 外径的一半。
    expect(canvas).toMatch(/\.wf-handle-target \{[^}]*box-sizing: border-box;[^}]*width: 12px; height: 12px;/)
    expect(canvas).toMatch(/\.wf-handle-source \{[^}]*box-sizing: border-box;[^}]*width: 12px; height: 12px;/)
    const route = read('src/shared/workflow/route.ts')
    expect(route).toMatch(/const ARROW_GAP = 6/)
    expect(route).not.toMatch(/const ARROW_GAP = 8/)
  })

  it('任务卡的线头外移一个边框宽：圆心落回卡的外缘盒（route.ts 的端口就在那儿）', () => {
    // 第三处偏差：.wf-stage-card 是 position: relative，RF 的 top/left/right/bottom: 0
    // 以它的**内边距盒**为基准，圆心比 route.ts 的端口（包装盒 = 卡外缘盒）内缩一个
    // 边框宽——箭头尖因此永远差 1px。四条边各外移一个边框宽，量取自同一个变量，
    // 改边框宽度不会漏改。芯片没有 position: relative、本来就贴边，所以用 > 子选择器
    // 而不是通配（通配会让芯片上的箭头反过来埋进圆点）。
    expect(canvas).toMatch(/--wf-card-border: 1px;/)
    expect(canvas).toMatch(/border: var\(--wf-card-border\) solid/)
    for (const side of ['top', 'bottom', 'left', 'right']) {
      expect(canvas).toContain(`.wf-stage-card > .react-flow__handle-${side} { ${side}: calc(-1 * var(--wf-card-border)); }`)
    }
  })

  it('回边判定走 shared/workflow：闭合成环（loopEdgeKeys），不是层深比较 → 虚线 + 循环标签', () => {
    // 层深比较会把菱形的长分支汇入边（B2→D，D 的 BFS 层深被短分支压平）误判
    // 成回边，运行器就会跳过 AND-join 的依赖门——单一真源在 shared/workflow/layout。
    expect(canvas).toContain("import { autoWorkflowLayout, isLoopEdge, loopEdgeKeys } from '../../../../shared/workflow/layout'")
    expect(canvas).not.toMatch(/\bdepthOf\b/)
    // 路径现在由 route.ts 算（正交折线），类型恒为自定义边——回边的差异化只剩
    // 虚线笔触与「循环」标签，bezier/smoothstep 两个内置生成器不再参与。
    expect(canvas).toContain('type: WORKFLOW_EDGE_TYPE')
    expect(canvas).not.toMatch(/'bezier'|'smoothstep'/)
    expect(canvas).toMatch(/strokeDasharray: '6 3'/)
    expect(canvas).toContain('edgeLoopSuffix')
  })

  it('连线走正交路由：最短 / 不穿卡 / 横平竖直 / 好看（user 2026-11-09）', () => {
    // 纯几何在 shared/workflow/route.ts（tests/workflow-routing 的 18 条钉子），
    // 画布这一侧负责三件接线的活：
    expect(canvas).toContain("from '../../../../shared/workflow/route'")
    // ① 矩形取**活体**节点几何——拖动中就是当帧坐标，尺寸用 RF 量出来的 measured
    //    （不是 def.layout，否则拖卡时线原地不动）。
    expect(canvas).toMatch(/x: node\.position\.x/)
    expect(canvas).toContain('node.measured?.width')
    expect(canvas).toMatch(/routeEdges\(nodes\.map\(flowRectOf\), routeSpecs, \{ fast: dragging \}\)/)
    // ② 端口与线头逐像素同源：出口 at = (i+0.5)/n（卡片 CSS 的 left:% 同一公式），
    //    入口按 inputSideOf 选边、DONE 只有顶入。
    expect(canvas).toMatch(/at: index >= 0 \? \(index \+ 0\.5\) \/ verdicts\.length : undefined/)
    expect(canvas).toMatch(/side: portSideOfHandle\(inputSideOf\(def, e\.from, e\.to\)\)/)
    expect(canvas).toMatch(/side: portSideOfHandle\(inputSideOf\(def, 'START', def\.entry\)\)/)
    // ③ 乘用的自定义边：数据只带 path + 标签锚点，标签交回 BaseEdge（顺带那条
    //    20px 命中条是「点连线选中」与探针找边主的依据）。
    expect(canvas).toMatch(/edgeTypes=\{workflowEdgeTypes\}/)
    const edgeFile = read('src/renderer/src/components/routine/WorkflowEdge.tsx')
    expect(edgeFile).toContain('export const WORKFLOW_EDGE_TYPE')
    expect(edgeFile).toContain('BaseEdge')
    expect(edgeFile).toContain('labelX={route.labelX}')
    // 端点矩形还没测量到位的边这一帧不画（data 缺席 → null），绝不退回内置
    // 生成器画一条穿卡的假线。
    expect(edgeFile).toContain('if (!route?.path) return null')
    // measured 跨 def 重建保留：否则每敲一个字节点都回落到兜底高度，连线闪一下。
    expect(canvas).toMatch(/const sized = measured\.has\(n\.id\) \? \{ \.\.\.n, measured: measured\.get\(n\.id\) \} : n/)
    // 边同步挂在路由结果上（不在节点同步里）：尺寸/位置一变就重画，不用重建节点。
    expect(canvas).toMatch(/if \(routes\.size === 0\) return/)
  })

  it('入线落点按几何选边：targetHandle 优先取路由采用的 toSide，几何主侧只是回落', () => {
    // 换侧绕行（2026-11-09）之后端点的真实位置由路由决定，targetHandle 必须跟着
    // toSide 走——否则线的端点与它挂的线头不是同一个，命中面错位。
    expect(canvas).toMatch(/handleOfSide\(routes\.get\(id\)\?\.toSide, inputSideOf\(def, e\.from, e\.to\)\)/)
    expect(canvas).toContain("e.to === 'DONE' ? undefined : handleOfSide(")
    // 开始→入口的派生边同样参与选边（它会自然从左侧进）。
    expect(canvas).toMatch(/handleOfSide\(routes\.get\('start-entry'\)\?\.toSide, inputSideOf\(def, 'START', def\.entry\)\)/)
    // 三侧 ↔ RouteSide 双向映射同一份（端口与线头逐像素同源）。
    expect(canvas).toMatch(/const handleOfSide = \(side: RouteSide \| undefined, fallback: string\): string =>/)
  })

  it('换侧绕行接在路由规格上：任务边带备选入口，派生边 start-entry 不带', () => {
    expect(canvas).toMatch(/altSides: e\.to === 'DONE' \? undefined : altSidesOf\(def, e\.from, e\.to\)\.map\(portSideOfHandle\)/)
    // 派生边不给备选：开始芯片正压在入口卡上方，绕不到侧面去。
    const start = canvas.indexOf('const specs: RouteEdgeSpec[] = [')
    const loop = canvas.indexOf('for (const e of def.edges)', start)
    expect(start).toBeGreaterThan(-1)
    expect(loop).toBeGreaterThan(start)
    expect(canvas.slice(start, loop)).not.toContain('altSides')
  })

  it('变量编辑：向导「基本信息」步可管理 inputs 声明（P3 由内容步迁入；与 routine 共用 VariableSection）', () => {
    // user 2026-11-08：两种模式的变量声明是**同一个编辑器**——行布局与文案
    // 以对话式任务为准，workflow 只多一个「多行」开关。逐字段内联编辑块
    // （add/remove/patchInput 三件套）已删，别再改回来。
    expect(wizard).toContain('VariableSection')
    expect(wizard).toContain('showMultiline')
    expect(wizard).toContain('wfInputsChange')
    expect(wizard).not.toContain('addInput')
    expect(wizard).not.toContain('patchInput')
    const form = read('src/renderer/src/components/routine/RoutineForm.tsx')
    expect(form).toContain('export function VariableSection')
    expect(form).toContain('data-variable-row')
    expect(form).toContain('添加变量')
    // 变量编辑器在内容步之前（基本信息步）——内容步只剩 objective + 画布。
    const basicsEditorIdx = wizard.indexOf('wfInputsChange')
    const contentStepIdx = wizard.indexOf("step === 'content' && kind === 'workflow'")
    expect(basicsEditorIdx).toBeGreaterThan(-1)
    expect(basicsEditorIdx).toBeLessThan(contentStepIdx)
    // 默认值列 = routine 变量 default 的同义字段（行在共享编辑器里）；
    // 启动表单预填同源。
    expect(form).toContain('默认值')
    expect(read('src/renderer/src/components/routine/WorkflowRunModal.tsx')).toContain('.filter((i) => i.default)')
    expect(canvas).toContain('STAGE_PLACEHOLDER_GROUPS')
  })

  it('环节指令的插入变量：与任务式对话同一控件，静态提示行已撤（user 2026-11-09）', () => {
    // 原话：「编辑节点时，要有类似对话式任务编辑时的插入变量功能，而不是用
    // 提示的方式告诉用户有哪些变量」——菜单接管提示行，机制走共用件。
    expect(canvas).toContain('InsertVariableSelect')
    expect(canvas).toContain('insertTokenAtCaret')
    expect(canvas).toContain('data-workflow-field="prompt"')
    expect(canvas).toContain('promptAreaRef')
    expect(canvas).not.toContain('promptHint')
    expect(canvas).not.toContain('RESERVED_PLACEHOLDER_KEYS')
    const form = read('src/renderer/src/components/routine/RoutineForm.tsx')
    const shared = read('src/renderer/src/components/routine/insert-variable.tsx')
    // 两侧必须同一份插入机制（各写一遍光标逻辑必然漂移）。
    expect(form).toContain('insertTokenAtCaret')
    expect(form).toContain('InsertVariableSelect')
    // 光标恢复顺序是承重的：setSelectionRange 先于 focus（先 focus 会把长
    // 文本视口拖到尾部，probe-routine-var-insert 钉住）。
    expect(shared.indexOf('setSelectionRange')).toBeLessThan(shared.indexOf('area.focus()'))
    expect(shared).toContain('requestAnimationFrame')
    // 动作不是状态：value 恒 null，选完回到占位文案。
    expect(shared).toContain('value={null}')
  })

  it('属性面板是模态框，不占画布面积（user 2026-11-09）', () => {
    // 原话：「工作流的属性面板，变成模态框，不固定在工作区占用面积」——
    // 旧形态是画布右侧常驻 320px 的 <aside>，一选中就永久吃掉画布宽度。
    // 现在：画布独占整行，面板走 antd Modal 浮层。
    expect(canvas).not.toContain('<aside')
    expect(canvas).toContain('data-workflow-canvas')
    // 面板体必须挂在 Modal 里（顺序门：锚点在 <Modal 之后）。
    const modalIdx = canvas.indexOf('<Modal')
    expect(modalIdx).toBeGreaterThan(-1)
    expect(canvas.indexOf('data-workflow-node-panel')).toBeGreaterThan(modalIdx)
    // destroyOnHidden 是承重的：antd 默认把关闭后的弹窗体留在 display:none
    // 的 .ant-modal-wrap 里，不销毁则「面板已关」在 DOM 上永远判假（探针
    // closeNodePanel 与读屏都会读到一份幽灵内容）。
    expect(canvas).toContain('destroyOnHidden')
    expect(canvas).not.toContain('destroyOnClose')
    // 编辑是即时的（直接写 def），没有「确定/取消」的草稿语义；脚注只有
    // 删除 + 关闭。旧的空态文案键已随常驻栏一起撤。
    expect(canvas).not.toContain('canvasPanelOk')
    expect(canvas).toContain('canvasPanelClose')
    expect(canvas).toContain('canvasDeleteNodeConfirm')
    expect(read('src/renderer/src/i18n/locales/zh.ts')).not.toContain('canvasPanelEmpty')
    expect(read('src/renderer/src/i18n/locales/en.ts')).not.toContain('canvasPanelEmpty')
    expect(read('src/renderer/src/i18n/locales/zh.ts')).toContain('canvasPanelClose')
    expect(read('src/renderer/src/i18n/locales/en.ts')).toContain('canvasPanelClose')
  })

  it('点连线不开面板；选中态蓝色高亮；Delete 键删选中的线/节点（user 2026-11-09 三裁定）', () => {
    // ① 「点击连接线不要弹模态框」：面板只认节点。RF 内部会在 onClick 之前
    //    addSelectedEdges，所以撤掉 onEdgeClick 之后「点一下线就选中」照旧成立，
    //    高亮全靠 .react-flow__edge.selected 这个类。
    expect(canvas).not.toContain('onEdgeClick')
    expect(canvas).toContain('open={!!selectedNode}')
    expect(canvas).not.toContain('selectedEdge')
    expect(canvas).not.toContain('edgeNodeName')
    // 连线专用的两个文案键随连线面板一起退场（留着就是邀请下一个人把它接回来）。
    for (const key of ['canvasEdgeLabel', 'canvasEdgeDelete']) {
      expect(canvas).not.toContain(key)
      expect(read('src/renderer/src/i18n/locales/zh.ts')).not.toContain(key)
      expect(read('src/renderer/src/i18n/locales/en.ts')).not.toContain(key)
    }

    // ② 「选中线之后，蓝色高亮」：颜色不写在边对象上，而是把 RF 自己的 CSS
    //    变量焊到主题色（它自带 .selected / :focus 两条消费规则）；宽度那档 RF
    //    没给变量，只能补一条规则。内联 style 会落在 <path> 上盖过样式表，所以
    //    buildFlowEdges 里不许再写死 strokeWidth——那正是选中变粗失效的写法。
    expect(canvas).toContain('--xy-edge-stroke-selected: var(--pm-link)')
    expect(canvas).toMatch(/\.react-flow__edge\.selected \.react-flow__edge-path/)
    expect(canvas).not.toContain('strokeWidth: 1.5')
    // 箭头跟着线变色：context-stroke 取引用元素的 stroke（RF 样式表里有
    // var(--xy-edge-stroke) 兜底，所以即便不认识也只是回落成灰色，不会隐形）。
    expect(canvas.match(/color: 'context-stroke'/g)).toHaveLength(2)

    // ③ 「选中线和节点，都可以通过 delete 键删除」：RF 自己的删除必须关着
    //    （它改内部 nodes/edges，def 才是唯一真源），键删走 def 的写回调。
    expect(canvas).toContain('deleteKeyCode={null}')
    expect(canvas).toContain("document.addEventListener('keydown', onKeyDown)")
    expect(canvas).toContain("return () => document.removeEventListener('keydown', onKeyDown)")
    expect(canvas).toContain('liveSelectionRef')
    // 阅读态不能误删：输入框里的 Backspace 只该删字，属性面板开着时键删也该让路。
    expect(canvas).toContain("e.key !== 'Delete' && e.key !== 'Backspace'")
    expect(canvas).toContain("['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)")
    expect(canvas).toContain('isContentEditable')
    expect(canvas).toContain('.ant-modal-wrap')
    expect(canvas).toContain('e.preventDefault()')
  })

  it('读图语言：聚焦淡化 + 终态配色 + 状态标签悬停才显（user 2026-11-09「交叉太多」）', () => {
    // ① 聚焦淡化：生成一条**跟随选中态**的样式串，不重建边对象——edges 的重建
    //    只在 [def, routes] 变时发生（那正是 selected 得以保留的机制），把淡化
    //    烘进边对象就得为每次点选再跑一遍 buildFlowEdges。
    expect(canvas).toContain('focusDimCss')
    expect(canvas).toMatch(/const focusDimCss = useMemo\(/)
    expect(canvas).toContain('opacity: 0.15;')
    // 只选节点时不压暗别的节点（它们正是这条线的上下文），选线时才要干净背景。
    expect(canvas).toContain('if (selEdges.size > 0) rules.push(')
    // 选择器打在 RF 挂在节点/边 <g> 上的 data-id 上（边 id 含 | 和 :，只能走
    // 属性选择器）；引号必须转义，否则一条用户改过名的边就能让整串 CSS 失效。
    expect(canvas).toContain('[data-id=')
    expect(canvas).toMatch(/replace\(\/"\/g, '\\\\"'\)/)
    // 样式串与静态样式同一 <style>（两条规则同源，优先级按源码顺序落定）。
    expect(canvas.indexOf('{CANVAS_STYLES}')).toBeLessThan(canvas.indexOf('{focusDimCss}'))

    // ② 终态配色：结果状态是用户自定义字符串，没有语义可上色；唯一有语义的是
    //    保留目标。颜色走 --xy-edge-stroke 变量（在 <g> 上覆盖），选中态的蓝
    //    因此仍由 RF 自己的 .selected 规则赢——不许用 !important 打架。
    expect(canvas).toMatch(/className: e\.to === 'DONE' \? 'wf-edge-done' : e\.to === 'FAILED' \? 'wf-edge-failed' : undefined/)
    expect(canvas).toContain('.react-flow__edge.wf-edge-done { --xy-edge-stroke: var(--pm-success')
    expect(canvas).toContain('.react-flow__edge.wf-edge-failed { --xy-edge-stroke: var(--pm-error)')
    expect(canvas).not.toMatch(/!\s*important\s*;/)

    // ③ 状态标签静止时隐藏：多状态节点每条出边都挂一个状态词，静止铺满画布
    //    正是「糊成一片」的主因；卡内 .wf-stage-verdicts 已把状态名与出口线头
    //    逐列对齐，悬停/选中/键盘聚焦再补齐线上的那一份。
    expect(canvas).toMatch(/\.react-flow__edge \.react-flow__edge-textwrapper \{ opacity: 0;/)
    expect(canvas).toMatch(/\.react-flow__edge:hover \.react-flow__edge-textwrapper,/)
    expect(canvas).toMatch(/\.react-flow__edge\.selected \.react-flow__edge-textwrapper,/)
    expect(canvas).toMatch(/\.react-flow__edge\.selectable:focus-visible \.react-flow__edge-textwrapper \{ opacity: 1; \}/)
  })
})

describe('STAGE_PLACEHOLDER_GROUPS（插入变量菜单的单一真源）', () => {
  const all = STAGE_PLACEHOLDER_GROUPS.flatMap((g) => [...g.keys])

  it('键集 ≡ RESERVED_PLACEHOLDER_KEYS + 内置四键（workspace/row 已在保留表内），无重复', () => {
    expect(new Set(all).size).toBe(all.length)
    expect(new Set(all)).toEqual(new Set([...RESERVED_PLACEHOLDER_KEYS, 'date', 'time', 'datetime', 'weekday']))
  })

  it('每个键都真被 renderNodePrompt 替换（菜单不会供出永远不被替换的 token）', () => {
    const builtins = Object.fromEntries(['date', 'time', 'datetime', 'weekday', 'workspace', 'row'].map((k) => [k, 'x']))
    for (const key of all) {
      const out = renderNodePrompt(`{{${key}}}`, { builtins })
      expect(out, key).not.toContain('{{')
    }
  })

  it('zh/en 两种语言都带全 var<Key> / varGroup<Group> 标签', () => {
    const locales = [read('src/renderer/src/i18n/locales/zh.ts'), read('src/renderer/src/i18n/locales/en.ts')]
    for (const src of locales) {
      for (const g of STAGE_PLACEHOLDER_GROUPS) {
        expect(src).toContain(`varGroup${g.group[0].toUpperCase()}${g.group.slice(1)}:`)
        for (const key of g.keys) {
          expect(src).toContain(`var${key[0].toUpperCase()}${key.slice(1)}:`)
        }
      }
      expect(src).toContain('insertVariable:')
    }
  })
})
