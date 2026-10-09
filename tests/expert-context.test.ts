import { describe, expect, it } from 'vitest'
import {
  composeExpertInstructions,
  expertLabel,
  formatSummonForPrompt,
  normalizeSummonedExperts,
  parseExpertMention,
  parseExpertMentions,
} from '../src/shared/expert-context'
import type { ExpertProfile } from '../src/shared/types/expert'

// ── Test doubles ──

const expert = (patch: Partial<ExpertProfile> = {}): ExpertProfile => ({
  id: 'expert-writing',
  name: '写作专家',
  basePrompt: '资深写作顾问',
  ...patch,
})

// ── composeExpertInstructions ──

describe('composeExpertInstructions', () => {
  it('renders the identity header with precedence statement', () => {
    const out = composeExpertInstructions({ name: '写作专家', basePrompt: 'x' })
    expect(out).toContain('# Expert Mode: 写作专家')
    expect(out).toContain('**写作专家**')
    expect(out).toContain('take precedence')
  })

  it('includes every non-empty section under its own heading', () => {
    const out = composeExpertInstructions({
      name: 'E',
      basePrompt: 'persona body',
      methodology: 'step 1',
      outputSpec: 'markdown only',
      constraints: 'never fabricate',
    })
    expect(out).toContain('## Role & Persona\npersona body')
    expect(out).toContain('## Methodology\nstep 1')
    expect(out).toContain('## Output Specification\nmarkdown only')
    expect(out).toContain('## Constraints\nnever fabricate')
  })

  it('skips empty and whitespace-only sections', () => {
    const out = composeExpertInstructions({
      name: 'E',
      basePrompt: 'persona',
      methodology: '   ',
      outputSpec: undefined,
      constraints: '',
    })
    expect(out).not.toContain('## Methodology')
    expect(out).not.toContain('## Output Specification')
    expect(out).not.toContain('## Constraints')
  })
})

// ── 可用能力（技能 / 连接器）：白名单，会话侧同步收敛工具集合 ──

describe('composeExpertInstructions allowed capability', () => {
  const catalogs = {
    skills: [
      { id: 'code-review', name: 'code-review', summary: '按严重度分级审查代码' },
      { id: 'writing', name: 'writing', summary: '长文写作' },
    ],
    connectors: [{ id: 'mcp-github', name: 'GitHub', summary: '仓库与 PR' }],
  }

  it('lists the allowed skills and connectors with their catalog description', () => {
    const out = composeExpertInstructions(
      { name: 'E', basePrompt: 'p', skillNames: ['code-review'], mcpServerIds: ['mcp-github'] },
      catalogs
    )
    expect(out).toContain('## Allowed Skills')
    expect(out).toContain('- code-review — 按严重度分级审查代码')
    expect(out).toContain('## Allowed Connectors')
    expect(out).toContain('- GitHub — 仓库与 PR')
    // 措辞必须点明「只有这些」——写成倾向提示会与运行时收敛矛盾。
    expect(out).toContain('the ONLY skills available')
    expect(out).toContain('the ONLY connectors')
  })

  it('omits a referenced skill that is no longer in the catalog', () => {
    const out = composeExpertInstructions(
      { name: 'E', basePrompt: 'p', skillNames: ['code-review', 'uninstalled'] },
      catalogs
    )
    expect(out).toContain('code-review')
    expect(out).not.toContain('uninstalled')
  })

  it('falls back to the raw names when the catalog could not be read', () => {
    const out = composeExpertInstructions({ name: 'E', basePrompt: 'p', skillNames: ['code-review'] })
    expect(out).toContain('- code-review')
  })

  it('states outright that nothing is available for empty whitelists', () => {
    // 空白名单 = 一个都不许用（不是「不限制」），必须说清楚，否则模型会
    // 以为只是没列出来而去调用 pick_skill / pick_tool。
    const out = composeExpertInstructions({ name: 'E', basePrompt: 'p', skillNames: [], mcpServerIds: [] }, catalogs)
    expect(out).toContain('## Allowed Skills')
    expect(out).toContain('No skills are available')
    expect(out).toContain('## Allowed Connectors')
    expect(out).toContain('No connectors (MCP servers) are available')
  })

  it('renders no capability section for an expert whose whitelists are absent', () => {
    const out = composeExpertInstructions({ name: 'E', basePrompt: 'p' }, catalogs)
    expect(out).not.toContain('## Allowed Skills')
    expect(out).not.toContain('## Allowed Connectors')
  })
})

// ── parseExpertMention ──

describe('parseExpertMention', () => {
  const experts = [
    expert(),
    expert({ id: 'expert-code', name: '代码审查专家', enabled: false }),
  ]

  it('resolves an enabled expert by name, and the @ token rides the text', () => {
    // 用户 2026-10-09: the mention's words are message content too — the parse
    // resolves the roster, never rewrites what the user typed.
    const r = parseExpertMention('@写作专家 帮我写一篇周报', experts)
    expect(r.expert?.id).toBe('expert-writing')
    expect(r.text).toBe('@写作专家 帮我写一篇周报')
  })

  it('never resolves a disabled expert, leaving the text untouched', () => {
    expect(parseExpertMention('@代码审查专家 审一下', experts).expert).toBeNull()
    expect(parseExpertMention('@代码审查专家 审一下', experts).text).toBe('@代码审查专家 审一下')
  })

  it('treats a profile with no enabled flag as enabled', () => {
    const noFlag = [expert({ id: 'expert-plain', name: '普通专家', enabled: undefined })]
    expect(parseExpertMention('@普通专家 你好', noFlag).expert?.id).toBe('expert-plain')
  })

  it('matches longest names first so overlapping names resolve to the specific expert', () => {
    const overlapping = [expert({ id: 'a', name: '翻译' }), expert({ id: 'b', name: '翻译专家' })]
    expect(parseExpertMention('@翻译专家 你好', overlapping).expert?.id).toBe('b')
  })

  it('leaves a mid-sentence mention in the text verbatim', () => {
    const r = parseExpertMention('先让 @写作专家 看看这段', experts)
    expect(r.expert?.id).toBe('expert-writing')
    expect(r.text).toBe('先让 @写作专家 看看这段')
  })

  it('returns the text untouched without a match', () => {
    const r = parseExpertMention('邮箱是 a@b.com', experts)
    expect(r.expert).toBeNull()
    expect(r.text).toBe('邮箱是 a@b.com')
  })
})

// ── parseExpertMentions（多专家 @召唤 → 计划模式） ──

describe('parseExpertMentions', () => {
  const experts = [
    expert({ id: 'expert-writing', name: '写作专家' }),
    expert({ id: 'expert-code', name: '代码审查专家' }),
    expert({ id: 'expert-data', name: '数据分析专家' }),
    expert({ id: 'expert-off', name: '离职专家', enabled: false }),
  ]

  it('collects every mentioned expert in match order; the tokens stay in the text and task is the remainder', () => {
    const r = parseExpertMentions('@写作专家 @数据分析专家 一起把这个方案做出来', experts)
    expect(r.experts.map((e) => e.id)).toEqual(['expert-writing', 'expert-data'])
    expect(r.text).toBe('@写作专家 @数据分析专家 一起把这个方案做出来')
    expect(r.task).toBe('一起把这个方案做出来')
  })

  it('counts a name mentioned twice once', () => {
    const r = parseExpertMentions('@写作专家 先写，写完后 @写作专家 再改', experts)
    expect(r.experts.map((e) => e.id)).toEqual(['expert-writing'])
    expect(r.text).toBe('@写作专家 先写，写完后 @写作专家 再改')
    expect(r.task).toBe('先写，写完后 再改')
  })

  it('resolves an overlapping pair to the specific expert, not both', () => {
    // The generic "翻译" is a prefix of the summoned "翻译专家": longest-first
    // matching is what keeps ONE roster entry instead of a stray one.
    const overlapping = [expert({ id: 'a', name: '翻译' }), expert({ id: 'b', name: '翻译专家' })]
    const r = parseExpertMentions('@翻译专家 你好', overlapping)
    expect(r.experts.map((e) => e.id)).toEqual(['b'])
  })

  it('never resolves a disabled expert and returns the raw text when nothing matches', () => {
    const disabled = parseExpertMentions('@离职专家 帮我看看', experts)
    expect(disabled.experts).toEqual([])
    expect(disabled.text).toBe('@离职专家 帮我看看')
    expect(disabled.spans).toEqual([])

    const none = parseExpertMentions('邮箱是 a@b.com', experts)
    expect(none.experts).toEqual([])
    expect(none.text).toBe('邮箱是 a@b.com')
  })

  it('is the same answer the single-expert wrapper gives', () => {
    // The wrapper exists so the two paths cannot disagree about what a mention
    // is; a roster of one must look exactly like the old single-mention result.
    const singular = parseExpertMention('@写作专家 帮我写一篇周报', experts)
    const plural = parseExpertMentions('@写作专家 帮我写一篇周报', experts)
    expect(singular.expert?.id).toBe(plural.experts[0]?.id)
    expect(singular.text).toBe(plural.text)
  })
})

// ── spans（token 留在消息里后的位置标记，2026-10-09）──

describe('parseExpertMentions spans', () => {
  const experts = [expert({ id: 'expert-writing', name: '写作专家' })]

  it('marks every consumed token at its offsets in the text it stays in', () => {
    const r = parseExpertMentions('先让 @写作专家 看看 @写作专家', experts)
    expect(r.spans).toEqual([{ start: 3, end: 8 }, { start: 12, end: 17 }])
  })

  it('a mention at the very start, with punctuation glued on, still cuts cleanly from task', () => {
    const r = parseExpertMentions('@写作专家，帮我看看', experts)
    expect(r.spans).toEqual([{ start: 0, end: 5 }])
    expect(r.task).toBe('，帮我看看')
    expect(r.text).toBe('@写作专家，帮我看看')
  })
})

// ── SummonedExpert 名单与回合简报（state block，多专家计划模式） ──

describe('normalizeSummonedExperts', () => {
  it('drops blanks, dedupes by id and keeps the first name seen', () => {
    const roster = normalizeSummonedExperts([
      { id: ' a ', name: ' 甲 ' },
      { id: 'a', name: '重复' },
      { id: '', name: '无 id' },
      { id: 'b', name: '' },
    ] as never)
    expect(roster).toEqual([{ id: 'a', name: '甲' }, { id: 'b', name: 'b' }])
  })

  it('tolerates nothing at all', () => {
    expect(normalizeSummonedExperts(undefined)).toEqual([])
  })
})

describe('formatSummonForPrompt', () => {
  const summon = {
    experts: [{ id: 'expert-writing', name: '写作专家' }, { id: 'expert-code', name: '代码审查专家' }],
    nudged: false,
    engaged: false,
  }

  it('names every summoned expert with the id the plan assigns', () => {
    const out = formatSummonForPrompt(summon)!
    expect(out).toContain('**写作专家** (id: `expert-writing`)')
    expect(out).toContain('**代码审查专家** (id: `expert-code`)')
    // The protocol the turn is graded on, step by step.
    expect(out).toContain('`create_plan` first')
    expect(out).toContain('planNode')
    expect(out).toContain('advance_plan')
  })

  it('adds the corrective paragraph only after a nudged turn', () => {
    expect(formatSummonForPrompt(summon)).not.toContain('ended the previous turn')
    const nudged = formatSummonForPrompt({ ...summon, nudged: true })!
    expect(nudged).toContain('ended the previous turn')
  })

  it('renders nothing without a summons', () => {
    expect(formatSummonForPrompt(null)).toBeNull()
    expect(formatSummonForPrompt({ experts: [], nudged: false, engaged: false })).toBeNull()
  })
})

// ── expertLabel ──
// The plan stores the expert ID; every surface that shows a 负责人 resolves it
// here. The fallback matters as much as the hit: experts get deleted, and plans
// outlive them.

describe('expertLabel', () => {
  const list = [expert(), expert({ id: 'expert-code', name: '代码审查专家' })]

  it('resolves an id to the display name', () => {
    expect(expertLabel(list, 'expert-writing')).toBe('写作专家')
  })

  it('falls back to the id when the expert is gone', () => {
    expect(expertLabel(list, 'expert-deleted')).toBe('expert-deleted')
  })

  it('falls back to the id when the name is blank, and tolerates no list at all', () => {
    expect(expertLabel([expert({ id: 'e1', name: '   ' })], 'e1')).toBe('e1')
    expect(expertLabel(undefined, 'e2')).toBe('e2')
    expect(expertLabel([], 'e3')).toBe('e3')
  })

  it('picks the matching profile, not the first one', () => {
    const list = [expert({ id: 'a', name: '甲' }), expert({ id: 'b', name: '乙' })]
    expect(expertLabel(list, 'b')).toBe('乙')
  })
})
