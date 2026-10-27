import { describe, expect, it } from 'vitest'
import { SessionReviewAgent } from '../src/renderer/src/agent/one-shot-agent/SessionReviewAgent'
import type { SessionReviewInput } from '../src/renderer/src/agent/one-shot-agent/SessionReviewAgent'
import {
  buildExtractionCatalog,
  CATALOG_BODY_EXCERPT,
  CATALOG_TRUNCATION_MARK,
  type CatalogPage,
} from '../src/shared/memory-pages'

/** SessionReviewAgent v3（PLAN-memory-wiki → PLAN-experience-sop，2026-10-26）：
 *  pages 协议的钉子。v3：脚本协议整体退出（一阶段产不出经验证的脚本，固化是
 *  二阶段 SOP 代理的职责）；经验洞见命中既有页由「跳过」改「reinforce」（重现
 *  是二阶段固化的资格信号）；资格门与结构纪律原文继承。 */

const agent = new SessionReviewAgent()
// OneShotAgent 的 parseResponse 是 protected——钉子直捣协议层
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = (raw: string, input: SessionReviewInput) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (agent as any).parseResponse(raw, input) as { pages: any[]; summary?: string; keywords?: string[] }
const prompt = (agent as any).buildSystemPrompt() as string

const page = (id: string, title: string, type: CatalogPage['type'] = 'fact', aliases: string[] = [], body = '') => ({ id, title, type, aliases, body })
const input = (idx: Array<ReturnType<typeof page>>, revisable: string[], mode: 'full' | 'bucketed' = 'full'): SessionReviewInput => ({
  sessionSummary: '(Conversation statistics: 6 tool call(s), 2 tool error(s))\n[user]: hi',
  catalogText: 'x',
  catalogMode: mode,
  pageIndex: idx.map(({ id, title, type, aliases }) => ({ id, title, type, aliases })),
  revisableTitles: revisable,
})

describe('资格门与协议抵达 LIVE prompt（v1 原文继承）', () => {
  it('四种情形原文在场且锚定统计行', () => {
    expect(prompt).toContain('5+ tool calls')
    expect(prompt).toContain('hit a wall and eventually found a viable path')
    expect(prompt).toContain('corrected the agent')
    expect(prompt).toContain('non-trivial reusable workflow')
    expect(prompt).toContain('NO experience page this round')
  })
  it('脚本协议离场（v3 裁定：一阶段不产脚本；钉子随刀反转）', () => {
    expect(prompt).not.toContain('### File: scripts/<name>.mjs')
    expect(prompt).not.toContain('Node 20 built-ins only')
    expect(prompt).not.toContain('≤3 files per page')
  })
  it('reinforce 在场：重现不沉默，且只对经验页成立', () => {
    expect(prompt).toContain('reinforce')
    expect(prompt).toContain('Repetition is the strongest signal')
    expect(prompt).toContain('ONLY for experience pages')
  })
  it('五动作协议与 update 的全文可见约束在场', () => {
    expect(prompt).toContain('"action":"create|update|alias|supersede|reinforce"')
    expect(prompt).toContain(CATALOG_TRUNCATION_MARK)
    expect(prompt).toContain('supersede')
  })
})

describe('buildExtractionCatalog：目录形态决定 update 可用性', () => {
  it('经验页全文 ≤ 帽 → 进 revisable；超帽 → 截断且不可修订', () => {
    const short = page('1', '短经验', 'experience', [], '## 背景\n短正文')
    const long = page('2', '长经验', 'experience', [], '很'.repeat(CATALOG_BODY_EXCERPT + 1))
    const cat = buildExtractionCatalog([short, long, page('3', '偏好页', 'preference', ['称呼'], '短句')])
    expect(cat.mode).toBe('full')
    expect(cat.revisableTitles).toEqual(['短经验'])
    expect(cat.text).toContain(CATALOG_TRUNCATION_MARK)
    expect(cat.text).toContain('短经验')
  })
  it('超页数预算 → 分桶且 revisable 为空（update 本轮不可用）', () => {
    const many: CatalogPage[] = Array.from({ length: 401 }, (_, i) => page(`p${i}`, `页${i}`))
    const cat = buildExtractionCatalog(many)
    expect(cat.mode).toBe('bucketed')
    expect(cat.revisableTitles).toEqual([])
    expect(cat.text).toContain('update is unavailable this round')
  })
})

describe('parseResponse 校验/降级矩阵', () => {
  const idx = [page('1', '天气播报经验', 'experience', [], '正文'), page('2', '称呼偏好', 'preference', ['老大'], '短句')]
  const rev = ['天气播报经验']

  it('catalog 内 target 的 update 存活', () => {
    const out = parse('{"pages":[{"action":"update","target":"天气播报经验","content":"完整修订稿"}]}', input(idx, rev))
    expect(out.pages).toEqual([{ action: 'update', target: '天气播报经验', content: '完整修订稿', aliases: [], links: [] }])
  })
  it('target 用 alias 命中 → 解析为宿主页 title', () => {
    const out = parse('{"pages":[{"action":"alias","target":"老大","aliases":["称呼我"]}]}', input(idx, rev))
    expect(out.pages[0]).toMatchObject({ action: 'alias', target: '称呼偏好', aliases: ['称呼我'] })
  })
  it('幻觉 target 的 supersede 降级 create（洞见不丢）', () => {
    const out = parse('{"pages":[{"action":"supersede","target":"不存在的页","title":"新拍板","type":"decision","content":"新正文内容足够"}]}', input(idx, rev))
    expect(out.pages[0]).toMatchObject({ action: 'create', title: '新拍板', type: 'decision' })
  })
  it('update 对不可修订页（全文未展示）降级 create', () => {
    const out = parse('{"pages":[{"action":"update","target":"称呼偏好","content":"完整修订稿"}]}', input(idx, rev))
    // 称呼偏好是 preference：目录从未展示其正文 → 不可修订 → 降级
    expect(out.pages[0]).toMatchObject({ action: 'create', title: '称呼偏好' })
  })
  it('update 无 target / alias 幻觉 target → 丢弃该 op', () => {
    expect(parse('{"pages":[{"action":"update","content":"x"}]}', input(idx, rev)).pages).toEqual([])
    expect(parse('{"pages":[{"action":"alias","target":"幻影","aliases":["a"]}]}', input(idx, rev)).pages).toEqual([])
  })
  it('省略 action 读作 create；非法 type 回落 fact', () => {
    const out = parse('{"pages":[{"title":"新事实","type":"bogus","content":"环境事实一句话"}]}', input(idx, rev))
    expect(out.pages[0]).toMatchObject({ action: 'create', type: 'fact' })
  })
  it('结构性纪律：非经验页 ≤3、经验页 ≤1、preference/fact 超 100 字整条丢弃', () => {
    const many = JSON.stringify({
      pages: [
        { action: 'create', title: '一', type: 'fact', content: '事实一' },
        { action: 'create', title: '二', type: 'fact', content: '事实二' },
        { action: 'create', title: '三', type: 'fact', content: '事实三' },
        { action: 'create', title: '四', type: 'fact', content: '事实四' },
        { action: 'create', title: '经验A', type: 'experience', content: '长正文' },
        { action: 'create', title: '经验B', type: 'experience', content: '长正文' },
        { action: 'create', title: '超长', type: 'preference', content: '很'.repeat(101) },
      ],
    })
    const out = parse(many, input(idx, rev))
    const nonExp = out.pages.filter((p) => p.type !== 'experience')
    const exp = out.pages.filter((p) => p.type === 'experience')
    expect(nonExp).toHaveLength(3)
    expect(exp).toHaveLength(1)
    expect(out.pages.some((p) => p.title === '超长')).toBe(false)
  })
  it('经验页脚本围栏拆出 files（regression: script-fence）', () => {
    const raw = JSON.stringify({
      pages: [{ action: 'create', title: '带脚本的页', type: 'experience', content: '## 背景\n正文\n\n### File: scripts/run.mjs\n```js\nconsole.log(1)\n```' }],
    })
    const out = parse(raw, input(idx, rev))
    const op = out.pages[0]
    expect(op.files).toEqual([{ path: 'scripts/run.mjs', content: 'console.log(1)' }])
    expect(op.content).not.toContain('### File:')
  })
  it('空池：一切 update 降级/丢弃，create 照常', () => {
    const out = parse('{"pages":[{"action":"create","title":"新页","type":"fact","content":"事实一句"},{"action":"update","target":"任何","content":"x"}]}', input([], []))
    expect(out.pages).toHaveLength(1)
    expect(out.pages[0]).toMatchObject({ action: 'create' })
  })
})
