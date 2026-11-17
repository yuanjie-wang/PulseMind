import { describe, expect, it, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setHost } from '../src/renderer/src/agent/host'
import { execMemoryTool } from '../src/renderer/src/agent/executors/domain-tools'
import { BUILT_IN_TOOLS } from '../src/renderer/src/tools/built-in-tools'
import { MEMORY_PAGE_TYPES } from '../src/shared/memory-pages'
import type { ToolExecContext } from '../src/renderer/src/agent/executors/context'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import type { PageOp, PageOpResult } from '../src/shared/memory-pages'

/**
 * memory_save 的手动写面边界（2026-11-16 user 裁定：memory_save 不考虑经验、
 * 只考虑记忆——内容类型与「关于用户」导向与 SessionReviewAgent 自动提取一致）。
 *
 * 三层：
 *   1. schema 层——type 枚举只有 preference/decision/fact，experience 出走
 *      （描述同 extraction 口径，decision 归长文桶，update 不改 type 已写明）；
 *   2. 执行器层（行为）——experience 显式拒绝（不静默回落 fact）、超长报错
 *      只指 decision、撞名回落按 holder 类型分流（经验页拒绝 / 记忆页 update
 *      用精确 title / title 无主时去 alias 重试 create）；
 *   3. 手册层——类型定义与 USER-LENS 导向同提取协议，supersede 承诺诚实化
 *      （同名 update 覆盖、不留谱系——手动路径没有 supersede op）。
 * 共享枚举 MEMORY_PAGE_TYPES 四元不动：store / 提取 / 编译代理仍管理经验页。
 */

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

const def = BUILT_IN_TOOLS.find((t) => t.name === 'memory_save')!

const toolUse = (input: Record<string, unknown>): ToolUseBlock =>
  ({ type: 'tool_use', id: 'tu1', name: 'memory_save', input }) as ToolUseBlock

const makeEx = () => {
  const results: Array<{ id: string; content: string; isError: boolean }> = []
  const ex = {
    addToolResult: (id: string, content: string, isError: boolean) => { results.push({ id, content, isError }) },
    notify: () => {},
  } as unknown as ToolExecContext
  return { ex, results }
}

/** mock host：applyMemoryPageOps 按脚本逐次应答，listMemoryPages 返回给定页。 */
function hostWith(opsScript: PageOpResult[][], pages: Array<Record<string, unknown>> = []) {
  const applyMemoryPageOps = vi.fn()
  for (const r of opsScript) applyMemoryPageOps.mockResolvedValueOnce(r)
  setHost({
    applyMemoryPageOps,
    listMemoryPages: vi.fn().mockResolvedValue(pages),
  } as unknown as PulseHost)
  return { applyMemoryPageOps }
}

const okResult = (op: PageOp): PageOpResult[] => [{ op, ok: true, pageId: 'p1' }]
const collide = (holderTitle: string): PageOpResult[] => [{
  op: { action: 'create', title: 'x' },
  ok: false,
  error: `撞名: ${holderTitle} ← ${holderTitle}（用 update/alias 修改既有页）`,
}]

beforeEach(() => {
  vi.clearAllMocks()
})

// ── 1. schema 层 ──────────────────────────────────────────────────────

describe('memory_save schema：type 枚举只余记忆三类（经验出走）', () => {
  it('enum 恰为 preference/decision/fact，无 experience', () => {
    expect(def.input_schema.properties.type.enum).toEqual(['fact', 'decision', 'preference'])
  })

  it('描述与提取协议同口径：decision 归长文桶、update 沿用旧页 type、导向=关于用户', () => {
    const d = def.description ?? ''
    expect(d).toContain('same bar as automatic extraction')
    expect(d).toContain("the page's type is kept")
    expect(d).toContain('never tooling/codebase/environment behavior')
    // 旧文案的 decision 分桶错误不再回来
    expect(d).not.toContain('experience (long playbook)')
  })

  it('content 属性：decision 长文，不带 experience；summary 属性在场（对齐提取协议必填项）', () => {
    const props = def.input_schema.properties as Record<string, { description?: string }>
    expect(props.content.description).toContain('For decision: full structured content')
    expect(props.content.description).not.toContain('decision/experience')
    expect(props.content.description).toContain('at most 100 characters')  // data-consistency 的 pin 依赖
    expect(props.summary?.description).toContain('max 50 chars')
  })

  it('共享枚举 MEMORY_PAGE_TYPES 四元不动——store/提取/编译代理仍管理经验页', () => {
    expect(MEMORY_PAGE_TYPES).toEqual(['preference', 'decision', 'fact', 'experience'])
  })
})

// ── 2. 执行器层（行为） ────────────────────────────────────────────────

describe('execMemoryTool：experience 显式拒绝与类型缺省', () => {
  it('type=experience 直接拒绝，不发任何 page op（不静默回落 fact）', async () => {
    const { applyMemoryPageOps } = hostWith([])
    const { ex, results } = makeEx()
    const t = toolUse({ title: 'X', content: 'Y', type: 'experience' })
    const handled = await execMemoryTool(ex, t)
    expect(handled).toBe(true)
    expect(applyMemoryPageOps).not.toHaveBeenCalled()
    expect(t.exitCode).toBe(1)
    expect(results[0].isError).toBe(true)
    expect(results[0].content).toContain('experiences are distilled automatically by session review')
  })

  it('type 缺省落 fact 且透传 summary（>50 字截断）', async () => {
    const { applyMemoryPageOps } = hostWith([okResult({ action: 'create' })])
    const { ex, results } = makeEx()
    const t = toolUse({ title: 'T', content: 'C', summary: '结'.repeat(60), aliases: ['a1'] })
    await execMemoryTool(ex, t)
    const op = applyMemoryPageOps.mock.calls[0][0][0] as PageOp
    expect(op.type).toBe('fact')
    expect(op.summary).toBe('结'.repeat(50))
    expect(op.aliases).toEqual(['a1'])
    expect(t.exitCode).toBe(0)
    expect(results[0].content).toBe('Saved memory page: "T" (fact)')
  })

  it('decision 长文放行；fact 超 100 字拒绝且报错只指 decision（不再指 experience）', async () => {
    const { applyMemoryPageOps } = hostWith([okResult({ action: 'create' })])
    const { ex } = makeEx()
    await execMemoryTool(ex, toolUse({ title: 'D', content: '长'.repeat(500), type: 'decision' }))
    expect((applyMemoryPageOps.mock.calls[0][0][0] as PageOp).type).toBe('decision')

    hostWith([])
    const { ex: ex2, results } = makeEx()
    const t = toolUse({ title: 'F', content: '长'.repeat(120), type: 'fact' })
    await execMemoryTool(ex2, t)
    expect(t.exitCode).toBe(1)
    expect(results[0].content).toContain('characters. Distill the conclusion')  // data-consistency 的 pin 依赖
    expect(results[0].content).toContain('use type "decision" for long content')
    expect(results[0].content).not.toContain('experience')
  })
})

describe('execMemoryTool：撞名回落按 holder 类型分流（手动路径不碰经验页）', () => {
  const holderPage = (extra: Record<string, unknown>) => ({
    id: 'h1', title: '部署流程', type: 'decision', aliases: ['deploy'],
    supersededBy: null, retiredAt: null, body: '', summary: null,
    links: [], files: null, createdAt: '', updatedAt: '', contentHash: '',
    ...extra,
  })

  it('holder 是经验页 → 拒绝并提示换标题，update 不发出', async () => {
    const { applyMemoryPageOps } = hostWith([collide('部署流程')], [holderPage({ type: 'experience' })])
    const { ex, results } = makeEx()
    const t = toolUse({ title: '部署流程', content: 'C', type: 'decision' })
    await execMemoryTool(ex, t)
    expect(applyMemoryPageOps).toHaveBeenCalledTimes(1)  // 只有 create 那一次
    expect(t.exitCode).toBe(1)
    expect(results[0].content).toContain('is taken by experience page')
    expect(results[0].content).toContain('pick a different title')
  })

  it('holder 是记忆页 → update，target 用 holder 的精确 title', async () => {
    const { applyMemoryPageOps } = hostWith([collide('部署流程'), okResult({ action: 'update' })], [holderPage({})])
    const { ex } = makeEx()
    const t = toolUse({ title: '部署流程', content: '完整修订稿', type: 'decision' })
    await execMemoryTool(ex, t)
    expect(applyMemoryPageOps).toHaveBeenCalledTimes(2)
    const updateOp = applyMemoryPageOps.mock.calls[1][0][0] as PageOp
    expect(updateOp.action).toBe('update')
    expect(updateOp.target).toBe('部署流程')
    expect(updateOp.content).toBe('完整修订稿')
    expect(t.exitCode).toBe(0)
  })

  it('title 无主（撞名源自新页 alias）→ 去 alias 重试 create，不透传 TARGET_NOT_FOUND', async () => {
    const { applyMemoryPageOps } = hostWith([collide('别的页'), okResult({ action: 'create' })], [holderPage({ title: '别的页', aliases: [] })])
    const { ex } = makeEx()
    const t = toolUse({ title: '新结论', content: 'C', aliases: ['deploy'], type: 'decision' })
    await execMemoryTool(ex, t)
    expect(applyMemoryPageOps).toHaveBeenCalledTimes(2)
    const retry = applyMemoryPageOps.mock.calls[1][0][0] as PageOp
    expect(retry.action).toBe('create')
    expect(retry.title).toBe('新结论')
    expect(retry.aliases).toEqual([])
    expect(t.exitCode).toBe(0)
  })
})

// ── 3. 手册层 ──────────────────────────────────────────────────────────

describe('memory_save 手册：导向同提取协议，supersede 承诺诚实化', () => {
  const manual = read('src/renderer/src/tools/tool-instructions.ts')
  const section = manual.slice(manual.indexOf('memory_save: `## memory_save'), manual.indexOf('context_compact:'))

  it('类型定义与 USER-LENS 导向在场（同 SessionReviewAgent A 节口径）', () => {
    expect(section).toContain('### Page types (same bar as automatic extraction)')
    expect(section).toContain('preference — how the user wants things done')
    expect(section).toContain('decision — a choice the USER made or ratified')
    expect(section).toContain('NEVER tooling behavior, codebase trivia')
    expect(section).toContain('must still be true OUTSIDE this project')
    expect(section).toContain('experiences are distilled automatically by session review')
  })

  it('旧的两处不实承诺/错桶文案不再回来', () => {
    expect(section).not.toContain('the old page stays in lineage')
    expect(section).not.toContain('decision/experience pages')
    // 诚实版：同名 update 覆盖、不留谱系
    expect(section).toContain('no lineage copy is kept')
  })
})

// ── 4. 执行器 wiring 负扫 ──────────────────────────────────────────────

describe('execMemoryTool 源码钉：守卫结构在场', () => {
  const src = read('src/renderer/src/agent/executors/domain-tools.ts')
  it('撞名回落经 resolvePageByRef + isLivePage 查 holder 类型；枚举白名单无 experience', () => {
    expect(src).toContain('resolvePageByRef')
    expect(src).toContain('isLivePage')
    expect(src).toContain("holder?.type === 'experience'")
    expect(src).toContain("['fact', 'decision', 'preference'].includes")
    expect(src).not.toContain(`['fact', 'decision', 'preference', 'experience'].includes`)
  })
})
