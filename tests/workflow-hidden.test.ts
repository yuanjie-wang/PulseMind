// 工作流展示门 `WORKFLOW_TASKS_UI` 的当前态是**开启**。
//
// 历史：2026-11-09 用户裁定「想尽快发 0.5.1，但是感觉工作流离可用还差很多，能先
// 隐藏吗」，于是整族展示面关闭；2026-11-13 放开（0.5.2）。所以这始终是**展示门**
// 而不是功能拆除：画布/归一/校验/运行器/调度器/store 一直在包里，翻转常量即整族
// 隐藏或恢复，两条路径都不碰数据。
//
// 门开着的时候反而更容易被合回默认值，所以断言一条不删，只是朝向翻了过来：
//   1. 常量就是 true，且全仓只有这一份（主进程与渲染端必须认同一个，否则会出现
//      「预览说能导、提交说不能」这种各说各话）；
//   2. 五处入口的 `if (WORKFLOW_TASKS_UI)` 还长在原位——重构时顺手删掉其中一处，
//      翻回 false 就会漏出一扇门；
//   3. 分享导入那条「渲染端不可信」的二次拒收与「预览恒 blocked」的推导仍在。它是
//      唯一会「凭空造出一条 workflow」的通道，删了以后就没法一键回退。
//
// 真渲染由三条功能探针钉住（它们在 bundle 期把常量 alias 成 true，证明「开着的
// 时候功能没坏」）。曾经还有一条 `scripts/probe-workflow-hidden.mjs`，在 false 态
// 里量「不翻转就看不见」——门开了之后它的每条断言都会恒红，故已退役，见文件末节。
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

describe('工作流展示门 · 常量与共享面', () => {
  const shared = read('src/shared/feature-flags.ts')
  const renderer = read('src/renderer/src/feature-flags.ts')

  it('常量在 shared/ 且为 true（主进程也要认同一份）', () => {
    expect(shared).toMatch(/export const WORKFLOW_TASKS_UI = true/)
    // 别在同一文件里加第二个开关：一处 false 就够让整个表面消失
    expect(shared).toContain('WORKFLOW_TASKS_UI')
    expect(shared.split('export const WORKFLOW_TASKS_UI').length - 1).toBe(1)
  })

  it('渲染端不另立常量，只转出 shared/ 的那一份', () => {
    expect(renderer).toContain("export { WORKFLOW_TASKS_UI } from '../../shared/feature-flags'")
    // 两处各写一份 = 主进程与渲染端可以各说各话（预览放行、提交拒收）
    expect(renderer).not.toMatch(/export const WORKFLOW_TASKS_UI/)
  })
})

describe('工作流展示门 · 渲染端五处入口', () => {
  it('路由：view.workflowEditing 走 workflow 分支，同门挡着陈旧导航态', () => {
    const view = read('src/renderer/src/components/layout/ViewHost.tsx')
    expect(view).toContain("import { WORKFLOW_TASKS_UI } from '../../feature-flags'")
    expect(view).toMatch(/view\.workflowEditing && WORKFLOW_TASKS_UI/)
    expect(view).toContain('<LazyTaskWizardPage kind="workflow"')
  })

  it('任务中心：列表照拉、卡片进网格、两个 workflow 模态同门', () => {
    const center = read('src/renderer/src/components/routine/RoutineCenter.tsx')
    expect(center).toContain("import { WORKFLOW_TASKS_UI } from '../../feature-flags'")
    // 拉取在门内：翻回 false 时不拉，才既不渲染卡片也不白跑 IPC
    expect(center).toMatch(/if \(WORKFLOW_TASKS_UI\) \{\s*const wf = \(await window\.electronAPI\.pipelineWorkflows\('list'\)\)/)
    expect(center).toMatch(/if \(WORKFLOW_TASKS_UI\) for \(const wf of workflows\)/)
    // 运行/批量两个模态只在有卡片时才可能打开，门一起挂上（不靠「反正点不到」）
    expect(center).toContain('{WORKFLOW_TASKS_UI && workflowRunModal}')
    expect(center).toContain('{WORKFLOW_TASKS_UI && (')
    // 卡片构建（含它的 onExport/onDelete 动作）整段在门内
    const loop = center.slice(center.indexOf('if (WORKFLOW_TASKS_UI) for (const wf of workflows)'))
    const body = loop.slice(0, loop.indexOf('cards.sort('))
    expect(body).toContain("key: `workflow:${wf.id}`")
    expect(body).toContain("onExport: () => exportItem('workflow', wf.id)")
  })

  it('时间线：pipeline 那份 feed 同门，routine 那份在门外', () => {
    const side = read('src/renderer/src/components/routine/UnifiedRunsSidebar.tsx')
    expect(side).toContain("import { WORKFLOW_TASKS_UI } from '../../feature-flags'")
    const reload = side.slice(side.indexOf('const reload = useCallback'), side.indexOf('useEffect('))
    expect(reload).toMatch(/if \(WORKFLOW_TASKS_UI\) \{[\s\S]*pipelineRuns\(/)
    // routine 那份 feed 在门外的位置：隐藏工作流不该连累日常任务的运行历史
    expect(reload.indexOf('routineRuns')).toBeGreaterThan(reload.indexOf('pipelineRuns'))
  })

  it('向导：新建态给两个类型选项；编辑 workflow 时那个选项恒在', () => {
    const wizard = read('src/renderer/src/components/routine/TaskWizardPage.tsx')
    expect(wizard).toContain("import { WORKFLOW_TASKS_UI } from '../../feature-flags'")
    // 类型行是「看得到、点不动」（2026-11-09 裁定）：新建态可选，编辑态 disabled。
    // workflow 选项由 `WORKFLOW_TASKS_UI || kind === 'workflow'` 决定——只按开关删
    // 会让存量 workflow 的编辑态连自己的类型都显示不出来。
    expect(wizard).toMatch(/\.\.\.\(WORKFLOW_TASKS_UI \|\| kind === 'workflow'/)
    expect(wizard).toContain("label: t('task.kindWorkflow')")
    // 新建态的默认 kind 仍是 routine（进来先落在对话式任务上）
    expect(wizard).toContain("useState<TaskKind>(kindProp)")
  })
})

describe('工作流展示门 · 分享导入的二次拒收仍在', () => {
  const handler = read('src/main/ipc/share.handler.ts')

  it('主进程用同一份常量（预览与提交不能各说各话）', () => {
    expect(handler).toContain("import { WORKFLOW_TASKS_UI } from '../../shared/feature-flags'")
  })

  it('预览：workflow 条目照常列出，重名冲突只在没被挡住时可覆盖', () => {
    // 用户得知道自己选的文件里有什么——把它整条藏起来会变成「导入静默少了一条」
    const branch = handler.slice(handler.indexOf('const v = workflowPreview('), handler.indexOf('return { previews, conflicts }'))
    expect(branch).toContain('const hidden = !WORKFLOW_TASKS_UI')
    expect(branch).toMatch(/const blocked = hidden \|\| \(v\?\.blocked \?\? true\)/)
    expect(branch).toContain('当前版本暂未开放工作流任务')
    // 被 hidden 挡住的条目不再参与「名称冲突 → 可覆盖」的交互
    expect(branch).toMatch(/nameConflict: !!conflictId && !blocked/)
  })

  it('提交：workflow 分支先过门再铸 id，不落 store 前面那道拒收不许挪', () => {
    const commit = handler.slice(handler.indexOf('SHARE_IMPORT_COMMIT'), handler.length)
    const wfBranch = commit.slice(commit.indexOf("} else {\n          // WORKFLOW_TASKS_UI=false"), commit.indexOf('workflowStore.save({ ...def, id, name })'))
    expect(wfBranch).toContain('if (!WORKFLOW_TASKS_UI) throw new Error')
    // 拒绝点在铸 id 之前——顺序反了就是一条幽灵记录的诞生过程
    expect(wfBranch.indexOf('if (!WORKFLOW_TASKS_UI)')).toBeLessThan(wfBranch.indexOf('workflowStore.save('))
    // 导入纪律不变：仍走 store（测试 share-import 的裸写负扫依赖这一点）
    expect(commit).toContain('workflowStore.save(')
  })
})

describe('工作流展示门 · 探针取向', () => {
  // 探针要证明「开着的时候功能照旧」。门现在是 true，stub 已退化成 no-op，但绝不
  // 能删：一旦有人把门翻回 false，这三条探针会在没有 stub 的一态里静默测不到任何
  // workflow 表面（选择器全部落空，最坏的一种绿）。
  const probes = ['scripts/probe-workflow-wizard.mjs', 'scripts/probe-routine-layout.mjs', 'scripts/probe-task-card-pills.mjs']

  for (const rel of probes) {
    it(`${rel} 在 bundle 期把 WORKFLOW_TASKS_UI 注解成 true`, () => {
      const src = read(rel)
      expect(src).toContain('force-workflow-ui')
      expect(src).toContain("export const WORKFLOW_TASKS_UI = true")
      expect(src).toMatch(/plugins: \[forceWorkflowUi\]/)
    })
  }

  it('隐藏面探针已退役（它量的是一个不存在的状态）', () => {
    // 门开了以后「不翻转就看不见」不再成立，那条探针的每条断言都会恒红。留着它比
    // 删掉更糟：红着的探针会被加进 skip 名单，然后没人再读它的结论。
    expect(existsSync(join(ROOT, 'scripts/probe-workflow-hidden.mjs'))).toBe(false)
  })
})
