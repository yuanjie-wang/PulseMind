// PLAN-workflow-engine：workflow-store + 模板播种。钉：两模板过同一校验门、
// 播种 never-overwrite（盘上已有同名文件绝不覆盖——用户编辑是用户内容）、
// layout 透传、save 的校验拒绝、id 消毒。

import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let homeDir = ''

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'pm-workflow-store-'))
  process.env.HOME = homeDir
  process.env.APPDATA = homeDir
  // DATA_DIR 在模块加载时定格——走 vi.resetModules 动态加载受污染实例。
})

async function freshStore() {
  const { vi } = await import('vitest')
  vi.resetModules()
  const mod = await import('../src/main/storage/workflow-store')
  return mod
}

describe('WORKFLOW_TEMPLATES', () => {
  it('两模板形态合法：过 validateWorkflow 门 + id 合法', async () => {
    const { WORKFLOW_TEMPLATES } = await freshStore()
    const { validateWorkflow } = await import('../src/shared/workflow/validate')
    expect(WORKFLOW_TEMPLATES).toHaveLength(2)
    for (const tpl of WORKFLOW_TEMPLATES) {
      const v = validateWorkflow(tpl)
      expect(v.errors, tpl.id).toEqual([])
      expect(v.warnings, tpl.id).toEqual([])
      // 模板必须自己过**写门**（user 2026-11-09「状态定义是必填的」）：用户从
      // 模板起稿、改一个字就要存盘，模板若缺定义则第一次保存就被拦下——那是
      // 把用户困在一个从模板来的、无法保存的工作流里。
      const writeGate = validateWorkflow(tpl, { requireVerdictDefs: true })
      expect(writeGate.errors, tpl.id).toEqual([])
    }
  })

  it('模板契约行形态与 formatPipelineResult 同源（教学段一字不差）', async () => {
    const { WORKFLOW_TEMPLATES } = await freshStore()
    const { PREFIX } = await import('../src/shared/workflow/contract')
    for (const tpl of WORKFLOW_TEMPLATES) {
      for (const node of tpl.nodes) {
        expect(node.prompt, `${tpl.id}/${node.id}`).toContain(PREFIX)
      }
    }
  })
})

describe('workflowStore + seedWorkflowTemplates', () => {
  it('播种落盘两个模板文件；再次播种绝不覆盖（用户编辑保留）', async () => {
    const mod = await freshStore()
    mod.seedWorkflowTemplates()
    const p = join(homeDir, '.pulsemind', 'workflows', 'coding-pipeline.json')
    expect(existsSync(p)).toBe(true)
    // 用户改了模板文件
    const original = JSON.parse(readFileSync(p, 'utf-8'))
    const edited = { ...original, name: '用户改过的名字' }
    writeFileSync(p, JSON.stringify(edited), 'utf-8')
    mod.seedWorkflowTemplates()
    expect(JSON.parse(readFileSync(p, 'utf-8')).name).toBe('用户改过的名字')
    rmSync(join(homeDir, '.pulsemind'), { recursive: true, force: true })
  })

  it('save 过校验门：非法工作流抛错带原因；合法的写盘并可 get/list', async () => {
    const mod = await freshStore()
    const good = {
      id: 'my-flow',
      name: '我的',
      entry: 'a',
      nodes: [{ id: 'a', title: 'A', prompt: 'p', verdicts: ['pass'] }],
      edges: [{ from: 'a', when: 'pass', to: 'DONE' }],
    }
    mod.workflowStore.save(good as never)
    expect(mod.workflowStore.get('my-flow')?.name).toBe('我的')
    expect(mod.workflowStore.list().map((w) => w.id)).toContain('my-flow')
    expect(() => mod.workflowStore.save({ ...good, edges: [{ from: 'a', when: 'SKIP', to: 'DONE' }] } as never)).toThrow(/verdicts/)
    rmSync(join(homeDir, '.pulsemind'), { recursive: true, force: true })
  })

  it('remove 的 id 消毒：路径穿越形态被拒', async () => {
    const mod = await freshStore()
    expect(() => mod.workflowStore.remove('../escape')).toThrow()
    expect(() => mod.workflowStore.remove('x.json')).toThrow()
  })

  it('layout 字段透传：save→get 往返不丢（画布就绪契约）', async () => {
    const mod = await freshStore()
    const withLayout = {
      id: 'canvas-ready',
      name: '画布',
      entry: 'a',
      nodes: [{ id: 'a', title: 'A', prompt: 'p', verdicts: ['pass'], layout: { x: 120, y: 80 } }],
      edges: [{ from: 'a', when: 'pass', to: 'DONE' }],
    }
    mod.workflowStore.save(withLayout as never)
    expect(mod.workflowStore.get('canvas-ready')?.nodes[0].layout).toEqual({ x: 120, y: 80 })
    rmSync(join(homeDir, '.pulsemind'), { recursive: true, force: true })
  })

  it('损坏文件读面宽容：list/get 跳过而不是抛', async () => {
    const mod = await freshStore()
    mod.seedWorkflowTemplates()
    mkdirSync(join(homeDir, '.pulsemind', 'workflows'), { recursive: true })
    writeFileSync(join(homeDir, '.pulsemind', 'workflows', 'broken.json'), '{not json', 'utf-8')
    expect(mod.workflowStore.list().some((w) => w.id === 'coding-pipeline')).toBe(true)
    expect(mod.workflowStore.get('broken')).toBeNull()
    rmSync(join(homeDir, '.pulsemind'), { recursive: true, force: true })
  })
})
