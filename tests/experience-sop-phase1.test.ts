import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SessionReviewAgent } from '../src/renderer/src/agent/one-shot-agent/SessionReviewAgent'
import type { SessionReviewInput } from '../src/renderer/src/agent/one-shot-agent/SessionReviewAgent'
import type { PageIndexEntry } from '../src/shared/memory-pages'

/** SessionReviewAgent v3（PLAN-experience-sop 刀一）：脚本协议整体退出 +
 *  reinforce（经验重现记账）的解析矩阵。结构性纪律（≤3/≤1/100 字帽）不变。 */

const agent = new SessionReviewAgent()
const prompt = (agent as any).buildSystemPrompt() as string
const parse = (raw: string, revisable: string[] = ['部署脚本']) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (agent as any).parseResponse(raw, input(revisable)) as { pages: any[] }

const idx: PageIndexEntry[] = [
  { id: '1', title: '部署脚本', type: 'experience', aliases: ['deploy', '发布流程'] },
  { id: '2', title: '称呼偏好', type: 'preference', aliases: ['老大'] },
]
const input = (revisable: string[]): SessionReviewInput => ({
  sessionSummary: 'x',
  catalogText: 'x',
  catalogMode: 'full',
  pageIndex: idx,
  revisableTitles: revisable,
})

describe('一阶段瘦身：脚本协议退出 prompt', () => {
  it('脚本教学特征串全部离场（实测 27 页 0 脚本的死重量）', () => {
    expect(prompt).not.toContain('### File:')
    expect(prompt).not.toContain('Node 20 built-ins')
    expect(prompt).not.toContain('idempotent')
    expect(prompt.toLowerCase()).not.toContain('## scripts')
  })
  it('资格门与结构纪律原样在场（不是整节误删）', () => {
    expect(prompt).toContain('QUALIFICATION GATE')
    expect(prompt).toContain('HARD CAP 100 chars')
    expect(prompt).toContain('supersede')
  })
  it('经验正文按 SKILL 标准写成手册（2026-10-26 用户裁定：技能候选池的候选要按技能规范长）', () => {
    expect(prompt).toContain('DRAFT SKILL')
    expect(prompt).toContain('## 适用场景')
    expect(prompt).toContain('## 步骤')
    expect(prompt).toContain('## 注意事项')
    // 叙事报告结构退场——手册写给未来会话，不是这次的案例记录
    expect(prompt).not.toContain('## 背景')
    expect(prompt).not.toContain('## 过程')
    // summary = 技能式 description（候选表展示的就是这一行）
    expect(prompt).toContain('skill-standard DESCRIPTION')
    expect(prompt).toContain('INSTRUCTIONS, never narration')
  })
})

describe('reinforce 解析矩阵', () => {
  it('合法 reinforce 存活；target 经 alias 命中解析为宿主 title', () => {
    const out = parse(JSON.stringify({
      pages: [
        { action: 'reinforce', target: 'deploy', note: '发布流程这次又手动走了 8 步' },
        { action: 'reinforce', target: '部署脚本', note: '同类撞墙重现' },
      ],
    }))
    expect(out.pages).toHaveLength(2)
    expect(out.pages[0]).toMatchObject({ action: 'reinforce', target: '部署脚本', note: '发布流程这次又手动走了 8 步' })
    expect(out.pages[1]).toMatchObject({ action: 'reinforce', target: '部署脚本' })
  })

  it('幻觉 target 静默丢弃（记账宁缺毋滥，不降级 create）', () => {
    const out = parse(JSON.stringify({ pages: [{ action: 'reinforce', target: '不存在的页', note: 'x' }] }))
    expect(out.pages).toEqual([])
  })

  it('缺 note / 空 note 丢弃', () => {
    const out = parse(JSON.stringify({
      pages: [
        { action: 'reinforce', target: '部署脚本' },
        { action: 'reinforce', target: '部署脚本', note: '   ' },
      ],
    }))
    expect(out.pages).toEqual([])
  })

  it('reinforce ≤3（独立小帽）', () => {
    const ops = Array.from({ length: 6 }, (_, i) => ({ action: 'reinforce', target: '部署脚本', note: `重现 ${i}` }))
    expect(parse(JSON.stringify({ pages: ops })).pages).toHaveLength(3)
  })

  it('reinforce 不占经验页 ≤1 帽——同一轮可 1 新经验页 + 3 reinforce', () => {
    const out = parse(JSON.stringify({
      pages: [
        { action: 'create', title: '新经验', type: 'experience', content: '## 背景\nx' },
        { action: 'reinforce', target: '部署脚本', note: 'a' },
        { action: 'reinforce', target: '部署脚本', note: 'b' },
        { action: 'reinforce', target: '部署脚本', note: 'c' },
      ],
    }))
    expect(out.pages).toHaveLength(4)
    expect(out.pages.filter((p) => p.action === 'create')).toHaveLength(1)
    expect(out.pages.filter((p) => p.action === 'reinforce')).toHaveLength(3)
  })

  it('reinforce 不进记忆页 ≤3 帽的计数池', () => {
    const out = parse(JSON.stringify({
      pages: [
        { action: 'create', title: '事实一', type: 'fact', content: '一句结论一' },
        { action: 'create', title: '事实二', type: 'fact', content: '一句结论二' },
        { action: 'create', title: '事实三', type: 'fact', content: '一句结论三' },
        { action: 'create', title: '事实四', type: 'fact', content: '一句结论四' },
        { action: 'reinforce', target: '部署脚本', note: 'x' },
      ],
    }))
    expect(out.pages.filter((p) => p.type === 'fact')).toHaveLength(3)
    expect(out.pages.filter((p) => p.action === 'reinforce')).toHaveLength(1)
  })
})

describe('接线', () => {
  const read = (p: string) => readFileSync(p, 'utf-8')
  it('extractAndSaveAll 的开关过滤把 reinforce 归经验开关', () => {
    const src = read('src/renderer/src/memory/MemoryManager.ts')
    expect(src).toContain("op.action === 'reinforce'")
  })
  it('存储层 reinforce 分支与脚本保全护栏在场（DB 行为由 probe-memory-pages-sop.mjs 驱动真库验证）', () => {
    const src = read('src/main/storage/memory-pages-store.ts')
    expect(src).toContain("op.action === 'reinforce'")
    expect(src).toContain('脚本保全')
    expect(src).toContain('touchMemoryPage')
  })
})
