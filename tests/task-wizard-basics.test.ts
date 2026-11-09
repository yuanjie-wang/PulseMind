// 基本信息步的任务类型（user 2026-11-09 两条裁定：先「如果对存量任务进行编辑，在
// 【基本信息】页签中现在看不到任务类型，期望能看到，但是不能修改」，再「期望就是用
// 单选框」——中间那版编辑态只读 chip 已被推翻）。
//
// 旧写法 `{!updateId && !wfUpdateId && (…任务类型…)}` 让编辑态整块消失。
// 现在：标签行恒常驻，控件始终是**同一个** Radio.Group——
//   - 新建态：可选，切 kind 走 switchKind；
//   - 编辑态：`disabled`（看得到、点不动），值仍是这条任务真实的类型。
// 类型在这里不是可编辑字段：routine 与 workflow 是两个运行器/两个 store，改类型等于
// 换一个任务；编辑态置灰而不是藏起来，是因为用户要能确认自己在编辑哪一种任务。
//
// 这是源码层的接线钉；真渲染（两种编辑态各自预选正确、radio disabled、新建态点得动）
// 在 scripts/probe-workflow-wizard.mjs §12。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

const WIZARD = 'src/renderer/src/components/routine/TaskWizardPage.tsx'

/** The 基本信息 step's JSX, sliced off at the next step block so scans can't
 *  wander into unrelated markup (e.g. the assistant column). */
function basicsBlock(): string {
  const src = read(WIZARD)
  const start = src.indexOf("{step === 'basics' && (")
  const end = src.indexOf("{step === 'content' && kind === 'routine' && (")
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('基本信息步 · 任务类型在编辑态可见但不可改', () => {
  it('标签行常驻：不再被 !updateId && !wfUpdateId 门掉', () => {
    const block = basicsBlock()
    // 一处且仅一处标签（注释里提到这个词不算；别在别处再长一个副本）
    expect(block.split('>任务类型<').length - 1).toBe(1)
    expect(block).not.toMatch(/\{!updateId && !wfUpdateId &&/)
  })

  it('控件就是那一个单选组：两臂共用，不分叉成只读文本', () => {
    const block = basicsBlock()
    expect(block.split('<Radio.Group').length - 1).toBe(1)
    // 编辑态没有第二条渲染分支（只读 chip 已被用户推翻——别再长回来）
    expect(block).not.toContain('editingTask ? (')
    expect(block).not.toContain('kindLocked')
    expect(block).toContain('<Radio.Group')
    expect(block).toContain("value: 'routine'")
    expect(block).toContain("value: 'workflow'")
  })

  it('编辑态只是把同一组置灰：disabled = editingTask，onChange 仍是 switchKind', () => {
    const block = basicsBlock()
    expect(block).toContain('disabled={editingTask}')
    expect(block).toContain('switchKind(e.target.value as TaskKind)')
    expect(block).toContain("t('task.kindRoutine')")
    expect(block).toContain("t('task.kindWorkflow')")
    // 探针锚点
    expect(block).toContain('data-pm-task-kind')
  })

  it('editingTask 由两条编辑通道派生（标题与类型行同一份判据）', () => {
    const src = read(WIZARD)
    expect(src).toContain('const editingTask = !!(updateId || wfUpdateId)')
    // 标题用的是同一份判据，不再各写一次
    expect(src).toContain("editingTask ? t('task.wizardEdit') : t('task.wizardCreate')")
    expect(src).not.toContain('updateId || wfUpdateId ?')
  })

  it('i18n：两个类型键成对且非空，chip 遗留键已撤', () => {
    const zh = read('src/renderer/src/i18n/locales/zh.ts')
    const en = read('src/renderer/src/i18n/locales/en.ts')
    for (const src of [zh, en]) {
      for (const key of ['kindRoutine', 'kindWorkflow']) {
        expect(src).toMatch(new RegExp(`${key}: '[^']+'`))
      }
      // 只读 chip 已随裁定退场，说明文案一并删掉（留着就是邀请它回来）
      expect(src).not.toContain('kindLocked')
    }
    expect(zh).toContain("kindRoutine: '对话式任务'")
    expect(zh).toContain("kindWorkflow: '工作流'")
  })
})
