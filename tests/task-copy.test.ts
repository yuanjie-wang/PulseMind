import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { copyName, duplicateTriggers } from '../src/renderer/src/components/routine/task-copy'
import type { RoutineTrigger } from '../src/shared/types/routine'

// ── 任务复制（2026-11-18）──
// 卡片上的「复制」只做两件有判断力的事：起名与触发器。两者都是纯函数，所以
// 契约钉在这里——它们错了不会崩，只会安静地产生「副本 副本 副本」或让两条
// 任务共用一个 webhook 端点（一次 POST 触发两条）。
//
// 接线部分同样需要钉：按钮存在不等于接对了回调，两个分支（routine/workflow）
// 各自的 onDuplicate 必须真的挂到 duplicateRoutine/duplicateWorkflow 上，否则
// 卡片点下去什么都不发生——这是纯 UI 接线，只有源码扫描能抓。

const read = (p: string): string => readFileSync(resolve(__dirname, '..', p), 'utf8')

describe('copyName', () => {
  it('新名字直接加后缀', () => {
    expect(copyName('每日晨报', '副本')).toBe('每日晨报 副本')
    expect(copyName('Daily report', 'copy')).toBe('Daily report copy')
  })

  it('已有副本后缀则递增，而不是叠加', () => {
    expect(copyName('每日晨报 副本', '副本')).toBe('每日晨报 副本 2')
    expect(copyName('每日晨报 副本 2', '副本')).toBe('每日晨报 副本 3')
    expect(copyName('Daily report copy', 'copy')).toBe('Daily report copy 2')
  })

  it('名字中间带「副本」二字不算后缀（只认结尾）', () => {
    expect(copyName('副本任务清单', '副本')).toBe('副本任务清单 副本')
    expect(copyName('整理副本资料', '副本')).toBe('整理副本资料 副本')
  })

  it('空名字与纯空白回落成后缀本身', () => {
    expect(copyName('', '副本')).toBe('副本')
    expect(copyName('   ', '副本')).toBe('副本')
  })

  it('后缀里的正则元字符按字面匹配', () => {
    expect(copyName('X (copy)', '(copy)')).toBe('X (copy) 2')
    expect(copyName('X (copy) 2', '(copy)')).toBe('X (copy) 3')
    // 元字符没有被当模式：`X copy` 不该被 `(copy)` 匹配
    expect(copyName('X copy', '(copy)')).toBe('X copy (copy)')
  })

  it('前后空白被修剪', () => {
    expect(copyName('  每日晨报  ', '副本')).toBe('每日晨报 副本')
  })
})

describe('duplicateTriggers', () => {
  it('webhook 令牌不随副本走——副本省略 token 让主进程现铸', () => {
    const out = duplicateTriggers([{ type: 'webhook', token: 'abc123' }])
    expect(out).toEqual([{ type: 'webhook' }])
    // 原数组不被改写（复制不能动源任务的端点身份）
    const src: RoutineTrigger[] = [{ type: 'webhook', token: 'abc123' }]
    duplicateTriggers(src)
    expect(src[0]).toEqual({ type: 'webhook', token: 'abc123' })
  })

  it('文件触发器原样带走，paths 是独立数组', () => {
    const src: RoutineTrigger[] = [{ type: 'file', paths: ['/a', '/b'], debounceMs: 2000 }]
    const out = duplicateTriggers(src)!
    expect(out).toEqual([{ type: 'file', paths: ['/a', '/b'], debounceMs: 2000 }])
    const file = out[0] as { type: 'file'; paths: string[] }
    expect(file.paths).not.toBe((src[0] as { paths: string[] }).paths)
  })

  it('两种触发器混排时各自按自己的规则处理', () => {
    const out = duplicateTriggers([
      { type: 'file', paths: ['/watch'] },
      { type: 'webhook', token: 'secret' },
    ])
    expect(out).toEqual([{ type: 'file', paths: ['/watch'] }, { type: 'webhook' }])
  })

  it('空/缺席 → undefined（不是空数组：省略键才是「没有触发器」）', () => {
    expect(duplicateTriggers(undefined)).toBeUndefined()
    expect(duplicateTriggers([])).toBeUndefined()
  })
})

describe('复制接线（源码扫描）', () => {
  const center = read('src/renderer/src/components/routine/RoutineCenter.tsx')

  it('两个分支的 onDuplicate 各自挂到对应的复制函数', () => {
    expect(center).toContain('onDuplicate: () => duplicateRoutine(routine)')
    expect(center).toContain('onDuplicate: () => duplicateWorkflow(wf)')
    // 卡片动作行有复制按钮，且走 card.onDuplicate（不是内联复制逻辑）
    expect(center).toContain('data-action="task-duplicate"')
    expect(center).toContain('onClick={card.onDuplicate}')
  })

  it('定时任务的副本先停用，手动任务保留 enabled（没有开关可以再打开）', () => {
    expect(center).toMatch(/enabled: routine\.schedule\?\.cron \? false : routine\.enabled/)
    expect(center).toMatch(/enabled: wf\.schedule\?\.cron \? false : wf\.enabled/)
  })

  it('workflow 副本换新 id——save 是 upsert，沿用模板 id 会覆盖原任务', () => {
    expect(center).toMatch(/id: `flow-\$\{Date\.now\(\)\}`/)
  })

  it('工作流模板分组仍在 workflow 门内，且点击走 openWorkflowTemplate', () => {
    expect(center).toContain('import { WORKFLOW_TEMPLATE_ENTRIES }')
    expect(center).toContain('data-workflow-template={template.id}')
    expect(center).toContain('onClick={() => openWorkflowTemplate(template.id)}')
    const at = center.indexOf('{WORKFLOW_TEMPLATE_ENTRIES.map(')
    expect(at).toBeGreaterThan(-1)
    // 整段在 WORKFLOW_TASKS_UI 门内：隐藏工作流时模板入口一起消失
    const before = center.slice(0, at)
    expect(before).toMatch(/\{WORKFLOW_TASKS_UI && \(\s*<>/)
  })

  it('模板点击导航带 workflowTemplateId（不是 workflowId）', () => {
    expect(center).toContain('workflowEditing: true, workflowTemplateId: templateId')
  })
})

describe('模板预填接线（源码扫描）', () => {
  const wizard = read('src/renderer/src/components/routine/TaskWizardPage.tsx')
  const nav = read('src/renderer/src/navigation/types.ts')
  const view = read('src/renderer/src/components/layout/ViewHost.tsx')

  it('导航参数声明 workflowTemplateId 并透传到向导', () => {
    expect(nav).toContain('workflowTemplateId?: string')
    expect(view).toContain('templateId={view.workflowTemplateId}')
  })

  it('预填按 kindProp 门控——向导内切换类型不该把 routine 模板 id 当 workflow 去取', () => {
    expect(wizard).toMatch(/if \(kindProp !== 'workflow' \|\| workflowId \|\| !templateId \|\| wfTemplateAppliedRef\.current\) return/)
  })

  it('模板取副本当草稿：换新 id、不落盘（保存前无副作用）', () => {
    expect(wizard).toContain("window.electronAPI.pipelineWorkflows('get', templateId)")
    expect(wizard).toMatch(/normalizeSimpleWorkflow\(\{ \.\.\.tpl, id: `flow-\$\{Date\.now\(\)\}` \}\)/)
    // 草稿路径不写存储：整段预填里只有 get，没有 save
    const start = wizard.indexOf('if (kindProp !== \'workflow\'')
    const effect = wizard.slice(start, start + 2000)
    expect(effect).not.toContain("pipelineWorkflows('save'")
  })
})

describe('i18n 键（两 locale 同源）', () => {
  const zh = read('src/renderer/src/i18n/locales/zh.ts')
  const en = read('src/renderer/src/i18n/locales/en.ts')
  const keys = ['workflowTemplates', 'workflowBadge', 'duplicate', 'copySuffix', 'duplicated']

  for (const key of keys) {
    it(`routine.${key} 在 zh/en 都存在`, () => {
      expect(zh).toContain(`${key}:`)
      expect(en).toContain(`${key}:`)
    })
  }
})
