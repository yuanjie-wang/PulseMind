import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MemoryPageCompileAgent } from '../src/renderer/src/agent/one-shot-agent/MemoryPageCompileAgent'
import type { MemoryPageCompileInput } from '../src/renderer/src/agent/one-shot-agent/MemoryPageCompileAgent'
import type { PageIndexEntry } from '../src/shared/memory-pages'

/** MemoryPageCompileAgent 的解析矩阵（PLAN-memory-wiki M6）：整理纪律的
 *  结构执法——create 一律丢弃（整理不生产）、幻觉 target 丢弃、分桶模式
 *  只放行 alias、supersede 必须带 type + 完整正文、单轮 ≤12 op。 */

const agent = new MemoryPageCompileAgent()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = (raw: string, mode: 'full' | 'bucketed' = 'full') =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (agent as any).parseResponse(raw, input(mode)) as { pages: any[] }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prompt = (agent as any).buildSystemPrompt() as string

const idx: PageIndexEntry[] = [
  { id: '1', title: '天气核对源A', type: 'fact', aliases: ['NWS'] },
  { id: '2', title: '天气核对源B', type: 'fact', aliases: [] },
  { id: '3', title: '称呼偏好', type: 'preference', aliases: ['老大'] },
]
const input = (mode: 'full' | 'bucketed'): MemoryPageCompileInput => ({
  pagesText: 'x', mode, pageIndex: idx,
})

describe('整理纪律抵达 LIVE prompt', () => {
  it('retire 是永久删除、supersede 保留谱系的红线原文在场', () => {
    expect(prompt).toContain('NEVER create a new topic')
    expect(prompt).toContain('never truncate')
    expect(prompt).toContain('lineage is preserved')
    expect(prompt).toContain('there is no undo')
  })
  it('经验页按 SKILL 标准保持手册结构；旧叙事页的手册化重构就是 fix structure（2026-10-26 用户裁定）', () => {
    expect(prompt).toContain('DRAFT SKILLS')
    expect(prompt).toContain('## 适用场景')
    expect(prompt).toContain('KEEPS this structure')
    expect(prompt).toContain('## 背景 / ## 过程 / ## 问题 / ## 优化')
    expect(prompt).toContain('skill-standard description')
  })
  it('retire 是 last resort：带理由、禁「老/短/少用」判据、优先 merge（2026-11-12 改硬删除）', () => {
    expect(prompt).toContain('**retire**')
    expect(prompt).toContain('LAST resort')
    expect(prompt).toContain('NEVER retire a page merely for being old, short, or rarely used')
    expect(prompt).toContain('"reason"')
    expect(prompt).toContain('rotating slices') // 分区语义进 prompt（只见切片，别假设全量）
  })
})

describe('parseResponse 校验矩阵', () => {
  it('合法 supersede（merge）存活；target 经 alias 命中解析为宿主 title', () => {
    const out = parse(JSON.stringify({
      pages: [
        { action: 'supersede', target: '天气核对源A', title: '天气核对源', type: 'fact', content: 'A+B 合并全文' },
        { action: 'supersede', target: 'NWS', title: '天气核对源', type: 'fact', content: 'A+B 合并全文' },
      ],
    }))
    expect(out.pages).toHaveLength(2)
    expect(out.pages[0]).toMatchObject({ action: 'supersede', target: '天气核对源A', title: '天气核对源', type: 'fact' })
    expect(out.pages[1]).toMatchObject({ target: '天气核对源A' }) // alias → 宿主 title
  })

  it('create 一律丢弃（整理不生产新主题）；幻觉 target 丢弃', () => {
    const out = parse(JSON.stringify({
      pages: [
        { action: 'create', title: '新页', type: 'fact', content: 'x' },
        { action: 'supersede', target: '不存在的页', title: '规范', type: 'fact', content: 'x' },
        { action: 'alias', target: '幻影', aliases: ['a'] },
      ],
    }))
    expect(out.pages).toEqual([])
  })

  it('supersede 缺 type / 缺 content / 非法 type → 丢弃', () => {
    const out = parse(JSON.stringify({
      pages: [
        { action: 'supersede', target: '称呼偏好', title: 'x', content: 'y' }, // 无 type
        { action: 'supersede', target: '称呼偏好', title: 'x', type: 'bogus', content: 'y' },
        { action: 'supersede', target: '称呼偏好', title: 'x', type: 'fact' }, // 无 content
      ],
    }))
    expect(out.pages).toEqual([])
  })

  it('分桶模式只放行 alias（supersede/update/retire 禁）', () => {
    const out = parse(JSON.stringify({
      pages: [
        { action: 'alias', target: '老大', aliases: ['称呼我'] },
        { action: 'supersede', target: '天气核对源A', title: '合并', type: 'fact', content: '全文' },
        { action: 'update', target: '称呼偏好', content: '修订' },
        { action: 'retire', target: '称呼偏好', reason: '过时' },
      ],
    }), 'bucketed')
    expect(out.pages).toHaveLength(1)
    expect(out.pages[0]).toMatchObject({ action: 'alias', target: '称呼偏好', aliases: ['称呼我'] })
  })

  it('retire：带理由存活；无理由/空理由丢弃；titles-only 视图禁用（判「过时」需全文）', () => {
    const out = parse(JSON.stringify({
      pages: [
        { action: 'retire', target: '天气核对源A', reason: '该源已停止服务' },
        { action: 'retire', target: '天气核对源B' }, // 无 reason
        { action: 'retire', target: '天气核对源B', reason: '   ' }, // 空白 reason
        { action: 'retire', target: '幻影', reason: 'x' }, // 幻觉 target
      ],
    }))
    expect(out.pages).toHaveLength(1)
    expect(out.pages[0]).toMatchObject({ action: 'retire', target: '天气核对源A', reason: '该源已停止服务' })
    expect(parse(JSON.stringify({ pages: [{ action: 'retire', target: '天气核对源A', reason: 'x' }] }), 'bucketed').pages).toEqual([])
  })

  it('单轮 ≤12 op（防御帽，挡失控输出）', () => {
    const ops = Array.from({ length: 20 }, (_, i) => ({ action: 'alias', target: '称呼偏好', aliases: [`别名${i}`] }))
    const out = parse(JSON.stringify({ pages: ops }))
    expect(out.pages).toHaveLength(12)
  })

  it('非 JSON / 缺 pages → 空产出（不抛）', () => {
    expect(parse('not json').pages).toEqual([])
    expect(parse('{}').pages).toEqual([])
  })
})

describe('target 寻址（2026-11-12 记忆防重）：同名不塌缩，只有 #id 能指认', () => {
  const twins: PageIndexEntry[] = [
    { id: 'p1', title: '天气交付', type: 'fact', aliases: [] },
    { id: 'p2', title: '天气交付', type: 'fact', aliases: [] },
  ]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parseTwins = (raw: string) => (agent as any).parseResponse(raw, { pagesText: 'x', mode: 'full', pageIndex: twins }) as { pages: any[] }

  it('同名裸 target 是歧义 → 丢弃（旧实现 refs 后者覆盖前者，两 op 双双落到同一页）', () => {
    const out = parseTwins(JSON.stringify({ pages: [{ action: 'retire', target: '天气交付', reason: '重复' }] }))
    expect(out.pages).toEqual([])
  })

  it('#id 精确指认：同名两页各自被单独取代，互不塌缩', () => {
    const out = parseTwins(
      JSON.stringify({
        pages: [
          { action: 'retire', target: '#p1', reason: '重复' },
          { action: 'retire', target: '#p2', reason: '重复' },
        ],
      }),
    )
    expect(out.pages.map((p) => p.target)).toEqual(['p1', 'p2'])
  })

  it('唯一名仍解析成 title（apply 层按 title 寻址的老契约不变）', () => {
    const out = parse(JSON.stringify({ pages: [{ action: 'retire', target: '称呼偏好', reason: 'x' }] }))
    expect(out.pages[0].target).toBe('称呼偏好')
  })

  it('prompt 带 Addressing 条，且写明裸同名会被丢弃', () => {
    expect(prompt).toContain('**Addressing**')
    expect(prompt).toContain('[#page_xxx]')
    expect(prompt).toContain('AMBIGUOUS')
  })
})

describe('接线（sweep 宿主 + 分区选页）', () => {
  const read = (p: string) => readFileSync(p, 'utf-8')
  it('MemoryManager 编译输入带 30K 预算、游标分区与维护钟；超 600 字单页标「正文被截断」', () => {
    const src = read('src/renderer/src/memory/MemoryManager.ts')
    expect(src).toContain('COMPILE_BODY_BUDGET')
    expect(src).toContain('「正文被截断」')
    // 分区整理（2026-10-27）：游标轮转 + 7 天维护钟取代「超预算全体降级禁 merge」
    expect(src).toContain('COMPILE_MAINTENANCE_MS')
    expect(src).toContain('lastCursorAt')
    expect(src).toContain('localeCompare(b.createdAt)')
  })
  it('startup 定时器挂 compile sweep（3 分钟位）', () => {
    const sm = read('src/main/agent/session-manager.ts')
    expect(sm).toContain('runMemoryCompileSweep().catch')
    // watermark 持久化带游标（重启后分区位置不丢）
    expect(sm).toContain('lastCursorAt')
  })
})
