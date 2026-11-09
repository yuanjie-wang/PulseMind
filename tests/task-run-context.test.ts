// P1 任务共享内核（user 2026-11-08 裁定「任务抽象一层」）：运行上下文解析
// （workspaceDir/approvalMode/profileId）+ workflow 补齐授权/模型/定时。
// 钉：resolver 三级回落与列播种顺序（先于 createSession 的既有契约）、
// 引擎线程（stage 会话带授权/模型 pin、缺省仍 'auto'）、launch 门（白名单/
// required/定时路径单实例+failed 行）、调度 wiring（decideScheduleFire 复用、
// 内存 nextRunAt 不落盘、hasRunningForWorkflow）。

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

// ── resolver 纯逻辑面（mock DB setter + workspace mint） ──

const seeded: Array<{ convId: string; mode: string }> = []
const profileSeeds: Array<{ convId: string; profileId: string }> = []
let minted = 0

vi.mock('../src/main/storage/conversation.db', () => ({
  setConversationApprovalMode: vi.fn((convId: string, mode: string) => seeded.push({ convId, mode })),
  setConversationProfile: vi.fn((convId: string, profileId: string) => profileSeeds.push({ convId, profileId })),
}))
vi.mock('../src/main/storage/conversation-workspace', () => ({
  resolveConversationWorkspace: vi.fn(async () => {
    minted += 1
    return `/tmp/pm-mint-${minted}`
  }),
}))

import { assertApprovalMode, resolveTaskRunContext } from '../src/main/task/run-context'

describe('resolveTaskRunContext', () => {
  beforeEach(() => {
    seeded.length = 0
    profileSeeds.length = 0
    minted = 0
  })

  it('workspace 三级回落：显式 > 任务配置 > mint', async () => {
    const a = await resolveTaskRunContext('c1', { workspaceDir: '/task/dir' }, 'outside-ask', '/explicit/dir')
    expect(a.workspaceDir).toBe('/explicit/dir')
    const b = await resolveTaskRunContext('c2', { workspaceDir: '/task/dir' }, 'outside-ask')
    expect(b.workspaceDir).toBe('/task/dir')
    const c = await resolveTaskRunContext('c3', {}, 'outside-ask')
    expect(c.workspaceDir).toBe('/tmp/pm-mint-1')
  })

  it('授权档播种先于 createSession（解析即播种；缺省档来自调用方字面量）', async () => {
    const r = await resolveTaskRunContext('c1', {}, 'outside-ask')
    expect(r.approvalMode).toBe('outside-ask')
    expect(seeded).toEqual([{ convId: 'c1', mode: 'outside-ask' }])
    const r2 = await resolveTaskRunContext('c2', { approvalMode: 'auto' }, 'outside-ask')
    expect(r2.approvalMode).toBe('auto')
  })

  it('模型仅 pin 时播种；profileId 缺席不调用 setConversationProfile', async () => {
    await resolveTaskRunContext('c1', { profileId: ' prof_1 ' }, 'auto')
    expect(profileSeeds).toEqual([{ convId: 'c1', profileId: 'prof_1' }])
    profileSeeds.length = 0
    const r = await resolveTaskRunContext('c2', {}, 'auto')
    expect(r.profileId).toBeUndefined()
    expect(profileSeeds).toEqual([])
  })

  it('assertApprovalMode 白名单（与 routine.handler 同语义）', () => {
    expect(assertApprovalMode('auto')).toBe('auto')
    expect(() => assertApprovalMode('yolo')).toThrow('非法授权档位')
  })
})

// ── wiring 扫描 ──

describe('task kernel wiring', () => {
  const engine = read('src/main/pipeline/pipeline-engine.ts')
  const runner = read('src/main/routine/routine-runner.ts')
  const launch = read('src/main/pipeline/launch.ts')
  const scheduler = read('src/main/routine/routine-scheduler.ts')
  const handler = read('src/main/ipc/pipeline.handler.ts')

  it('两侧执行器共用同一 resolver（routine-runner + pipeline-engine）', () => {
    expect(runner).toContain('resolveTaskRunContext')
    expect(runner).toContain("'outside-ask'")
    expect(engine).toContain('resolveTaskRunContext')
    expect(engine).toContain("'auto'")
    // routine-runner 不得再直调列 setter（红线：全部经共享内核）。
    expect(runner).not.toContain('setConversationApprovalMode(')
  })

  it('引擎实例级 mint：workspaceDir 缺席时锚点解析一次 + 写回 run 行', () => {
    expect(engine).toMatch(/let workspaceDir = opts\.workspaceDir\?\.trim\(\)/)
    expect(engine).toMatch(/updateRun\(opts\.runId, \{ workspaceDir \}\)/)
    expect(engine).toMatch(/approvalMode: opts\.approvalMode,\n\s+profileId: opts\.profileId/)
  })

  it('launch：三级合并（参数 > 定义 > 缺省）+ required 门 + 定时单实例', () => {
    expect(launch).toMatch(/opts\.approvalMode \?\? workflow\.approvalMode \?\? 'auto'/)
    expect(launch).toMatch(/opts\.profileId\?\.trim\(\) \|\| workflow\.profileId\?\.trim\(\)/)
    // required 门按「无人可问」判定：定时/文件/webhook 三档同门（集合成员），
    // 手动运行才抛错。
    expect(launch).toMatch(/UNATTENDED_TRIGGERS\.has\(trigger\)/)
    expect(launch).toMatch(/plans\.length > 0 \? plans\.map/)
    expect(launch).toMatch(/assertApprovalMode/)
  })

  it('handler 走 launch 路径，params 携带授权/模型覆盖', () => {
    expect(handler).toContain('launchWorkflowRun(')
    expect(handler).toContain('approvalMode?: string')
    expect(handler).toContain('profileId?: string')
    expect(handler).not.toContain('至少提供一个 plan 文件路径')
  })

  it('调度：workflow 段复用 decideScheduleFire + 内存 nextRunAt（不落盘）+ overlap 门', () => {
    expect(scheduler).toContain('tickWorkflows')
    expect(scheduler).toMatch(/decideScheduleFire/)
    expect(scheduler).toMatch(/workflowNextRunAt = new Map</)
    expect(scheduler).toMatch(/pipelineRunStore\.hasRunningForWorkflow/)
    expect(scheduler).toContain("launchWorkflowRun({ workflow: wf, trigger: 'schedule' })")
    // 不写回 workflow JSON（画布保存撞车红线）。
    expect(scheduler).not.toMatch(/workflowStore\.update/)
  })

  it('PipelineRun.trigger 落库：DDL/迁移/行映射三面同在', () => {
    expect(read('src/main/storage/database.ts')).toContain('ALTER TABLE pipeline_runs ADD COLUMN trigger TEXT')
    const store = read('src/main/storage/pipeline-run-store.ts')
    expect(store).toContain('trigger')
    expect(store).toContain('hasRunningForWorkflow')
    expect(read('src/shared/workflow/types.ts')).toMatch(/trigger\?: 'manual' \| 'schedule'/)
  })

  it('WorkflowDefinition 新字段：类型在、validate 保持宽容', () => {
    expect(read('src/shared/workflow/types.ts')).toMatch(/approvalMode\?: SandboxApprovalMode/)
    expect(read('src/shared/workflow/types.ts')).toMatch(/schedule\?: \{ cron: string/)
    const validate = read('src/shared/workflow/validate.ts')
    expect(validate).not.toContain('schedule')
  })

  it('preload/bridge 签名同步（approvalMode/profileId）', () => {
    expect(read('src/preload/index.ts')).toMatch(/approvalMode\?: string; profileId\?: string/)
    expect(read('src/shared/types/electron-bridge.ts')).toMatch(/approvalMode\?: string; profileId\?: string/)
  })

  it('UI 两处入口：启动表单覆盖选择器（WorkflowRunModal）+ 向导运行设置（P3 自画布上收）', () => {
    const runModal = read('src/renderer/src/components/routine/WorkflowRunModal.tsx')
    expect(runModal).toMatch(/APPROVAL_OPTIONS/)
    expect(runModal).toMatch(/approvalMode: runApproval/)
    const wizard = read('src/renderer/src/components/routine/TaskWizardPage.tsx')
    expect(wizard).toContain('TaskRunContextFields')
    // workflow 的调度 shim 把 friendly 调度器的 cron 写回 def.schedule。
    expect(wizard).toMatch(/schedule: cron \? \{ cron, catchUp: next\.catchUp \} : undefined/)
  })

  // 卡片统一（user 2026-11-09）：两类任务共用同一颗启用开关，所以工作流的
  // `enabled` 必须是真开关——类型里有、调度器读、事件触发读、IPC 有 toggle op。
  // 任一处漏掉，「关掉」就只是卡片上的一个视觉状态。
  it('工作流 enable 位：类型 + 调度器 + 事件触发 + toggle op 四面同在', () => {
    expect(read('src/shared/workflow/types.ts')).toMatch(/enabled\?: boolean/)
    const scheduler = read('src/main/routine/routine-scheduler.ts')
    expect(scheduler).toMatch(/enabled: wf\.enabled !== false/)
    const triggers = read('src/main/task/task-triggers.ts')
    expect(triggers).toMatch(/enabled: w\.enabled !== false/)
    // toggle 只改启用位（外带 taskTriggerManager.sync() 让 watcher 随之来去）。
    expect(handler).toMatch(/case 'toggle':/)
    expect(handler).toMatch(/workflowStore\.save\(\{ \.\.\.wf, enabled: !!enabled \}\)/)
    // 两个桥面同步加 op，否则渲染端调不动。
    expect(read('src/preload/index.ts')).toMatch(/'list' \| 'get' \| 'save' \| 'delete' \| 'toggle'/)
    expect(read('src/shared/types/electron-bridge.ts')).toMatch(/'list' \| 'get' \| 'save' \| 'delete' \| 'toggle'/)
  })
})
