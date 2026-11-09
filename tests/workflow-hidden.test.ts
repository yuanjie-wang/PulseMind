// 0.5.1：工作流的展示面整族隐藏（`WORKFLOW_TASKS_UI = false`）。
//
// 动机（user 2026-11-09）：「想尽快发 0.5.1，但是感觉工作流离可用还差很多，能先
// 隐藏吗」。所以这是**展示门**，不是功能拆除：画布/归一/校验/运行器/调度器/store
// 全部原样在包里，翻转常量为 true 即完整恢复；v0.5.0 从未发布过 workflow 代码，
// 线上也就不存在需要迁移的数据。
//
// 本文件钉住的是「哪些入口真的闭上了」，以及一条纪律：**隐藏面不许在后端留一条
// 能铸记录的后门**——分享导入是唯一会「凭空造出一条 workflow」的通道（卡片点不
// 到就编辑不了，但导入能），所以它在预览与提交两侧都必须闭。
//
// 真渲染由两支探针分向钉住：三条功能探针把常量 alias 成 true（证明「翻转后
// 功能没坏」，见文件末节），`scripts/probe-workflow-hidden.mjs` 则一个字都不改
// 常量（证明「不翻转就看不见」——卡片是 .map 出来的、单选项是 options 数组拼
// 出来的，条件门写成什么样都可能照旧渲染，只有真挂载才算证据）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

describe('工作流展示门 · 常量与共享面', () => {
  const shared = read('src/shared/feature-flags.ts')
  const renderer = read('src/renderer/src/feature-flags.ts')

  it('常量在 shared/ 且为 false（主进程也要认同一份）', () => {
    expect(shared).toMatch(/export const WORKFLOW_TASKS_UI = false/)
    // 说明它只是展示门，翻转即恢复——别在同一文件里加第二个开关
    expect(shared).toContain('WORKFLOW_TASKS_UI')
    expect(shared.split('export const WORKFLOW_TASKS_UI').length - 1).toBe(1)
  })

  it('渲染端不另立常量，只转出 shared/ 的那一份', () => {
    expect(renderer).toContain("export { WORKFLOW_TASKS_UI } from '../../shared/feature-flags'")
    // 两处各写一份 = 主进程与渲染端可以各说各话（预览说 blocked、提交放行）
    expect(renderer).not.toMatch(/export const WORKFLOW_TASKS_UI/)
  })
})

describe('工作流展示门 · 渲染端五处入口', () => {
  it('路由：view.workflowEditing 需要开关为真，陈旧导航态落到任务列表', () => {
    const view = read('src/renderer/src/components/layout/ViewHost.tsx')
    expect(view).toContain("import { WORKFLOW_TASKS_UI } from '../../feature-flags'")
    expect(view).toMatch(/view\.workflowEditing && WORKFLOW_TASKS_UI/)
    // workflow 分支仍在（翻转即恢复），只是被同一行的门挡住
    expect(view).toContain('<LazyTaskWizardPage kind="workflow"')
  })

  it('任务中心：列表不拉、卡片不进网格、两个 workflow 模态不挂', () => {
    const center = read('src/renderer/src/components/routine/RoutineCenter.tsx')
    expect(center).toContain("import { WORKFLOW_TASKS_UI } from '../../feature-flags'")
    // 拉取在门内（不拉才不会渲染卡片，也不会白跑 IPC）
    expect(center).toMatch(/if \(WORKFLOW_TASKS_UI\) \{\s*const wf = \(await window\.electronAPI\.pipelineWorkflows\('list'\)\)/)
    expect(center).toMatch(/if \(WORKFLOW_TASKS_UI\) for \(const wf of workflows\)/)
    // 运行/批量两个模态只在有卡片时才可能打开，但门一起挂上（不靠「反正点不到」）
    expect(center).toContain('{WORKFLOW_TASKS_UI && workflowRunModal}')
    expect(center).toContain('{WORKFLOW_TASKS_UI && (')
    // 卡片构建（含它的 onExport/onDelete 动作）整段在门内
    const loop = center.slice(center.indexOf('if (WORKFLOW_TASKS_UI) for (const wf of workflows)'))
    const body = loop.slice(0, loop.indexOf('cards.sort('))
    expect(body).toContain("key: `workflow:${wf.id}`")
    expect(body).toContain("onExport: () => exportItem('workflow', wf.id)")
  })

  it('时间线：pipeline 那份 feed 不拉（workflow 行整族不进列表）', () => {
    const side = read('src/renderer/src/components/routine/UnifiedRunsSidebar.tsx')
    expect(side).toContain("import { WORKFLOW_TASKS_UI } from '../../feature-flags'")
    const reload = side.slice(side.indexOf('const reload = useCallback'), side.indexOf('useEffect('))
    expect(reload).toMatch(/if \(WORKFLOW_TASKS_UI\) \{[\s\S]*pipelineRuns\(/)
    // routine 那份 feed 在门外的位置：隐藏工作流不该连累日常任务的运行历史
    expect(reload.indexOf('routineRuns')).toBeGreaterThan(reload.indexOf('pipelineRuns'))
  })

  it('向导：新建态只给对话式任务；编辑 workflow 时那个选项必须还在', () => {
    const wizard = read('src/renderer/src/components/routine/TaskWizardPage.tsx')
    expect(wizard).toContain("import { WORKFLOW_TASKS_UI } from '../../feature-flags'")
    // 编辑态的类型行是「看得到、点不动」（2026-11-09 裁定），所以 workflow 选项
    // 由 `WORKFLOW_TASKS_UI || kind === 'workflow'` 决定——只按开关删会让存量
    // workflow 的编辑态连自己的类型都显示不出来。
    expect(wizard).toMatch(/\.\.\.\(WORKFLOW_TASKS_UI \|\| kind === 'workflow'/)
    expect(wizard).toContain("label: t('task.kindWorkflow')")
    // 新建态的默认 kind 仍是 routine（没有 workflow 选项可选）
    expect(wizard).toContain("useState<TaskKind>(kindProp)")
  })
})

describe('工作流展示门 · 分享导入不许开后门', () => {
  const handler = read('src/main/ipc/share.handler.ts')

  it('主进程用同一份常量（预览与提交不能各说各话）', () => {
    expect(handler).toContain("import { WORKFLOW_TASKS_UI } from '../../shared/feature-flags'")
  })

  it('预览：workflow 条目照常列出，但恒 blocked 且点名原因', () => {
    // 用户得知道自己选的文件里有什么——把它整条藏起来会变成「导入静默少了一条」
    const branch = handler.slice(handler.indexOf('const v = workflowPreview('), handler.indexOf('return { previews, conflicts }'))
    expect(branch).toContain('const hidden = !WORKFLOW_TASKS_UI')
    expect(branch).toMatch(/const blocked = hidden \|\| \(v\?\.blocked \?\? true\)/)
    expect(branch).toContain('当前版本暂未开放工作流任务')
    // 被 hidden 挡住的条目不再参与「名称冲突 → 可覆盖」的交互
    expect(branch).toMatch(/nameConflict: !!conflictId && !blocked/)
  })

  it('提交：workflow 分支先拒（渲染端不可信），且不铸 id、不落 store', () => {
    const commit = handler.slice(handler.indexOf('SHARE_IMPORT_COMMIT'), handler.length)
    const wfBranch = commit.slice(commit.indexOf("} else {\n          // WORKFLOW_TASKS_UI=false"), commit.indexOf('workflowStore.save({ ...def, id, name })'))
    expect(wfBranch).toContain('if (!WORKFLOW_TASKS_UI) throw new Error')
    // 拒绝点在铸 id 之前——先拒后造，顺序反了就是一条幽灵记录的诞生过程
    expect(wfBranch.indexOf('if (!WORKFLOW_TASKS_UI)')).toBeLessThan(wfBranch.indexOf('workflowStore.save('))
    // 导入纪律不变：仍走 store（测试 share-import 的裸写负扫依赖这一点）
    expect(commit).toContain('workflowStore.save(')
  })
})

describe('工作流展示门 · 探针把开关钉成 true', () => {
  // 探针要证明「翻转开关后功能照旧」，所以它们必须跑在工作流可见的那一态。
  // 少了这个 stub，探针会静默地测不到任何 workflow 表面（选择器全部落空）。
  const probes = ['scripts/probe-workflow-wizard.mjs', 'scripts/probe-routine-layout.mjs', 'scripts/probe-task-card-pills.mjs']

  for (const rel of probes) {
    it(`${rel} 在 bundle 期把 WORKFLOW_TASKS_UI 注解成 true`, () => {
      const src = read(rel)
      expect(src).toContain('force-workflow-ui')
      expect(src).toContain("export const WORKFLOW_TASKS_UI = true")
      expect(src).toMatch(/plugins: \[forceWorkflowUi\]/)
    })
  }

  it('隐藏面探针相反：绝不 alias 常量，跑的就是 false 那一态', () => {
    const src = read('scripts/probe-workflow-hidden.mjs')
    // 一旦照抄那三条的 stub，这个探针就会在「工作流可见」的一态里量「看不见」，
    // 每个断言都恒真——最坏的一种绿。
    expect(src).not.toContain('force-workflow-ui')
    expect(src).not.toContain("WORKFLOW_TASKS_UI = true")
    // 它必须挂真实组件（假组件上量不出任何东西）
    expect(src).toContain('import RoutineCenter')
    expect(src).toContain('import TaskWizardPage')
    // 两个数据源调用数为 0 是核心证据之一：不拉 = 不渲染
    expect(src).toContain("window.__apiCalls('pipelineWorkflows')")
    expect(src).toContain("window.__apiCalls('pipelineRuns')")
  })
})
