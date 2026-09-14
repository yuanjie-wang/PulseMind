import { describe, expect, it } from 'vitest'
import { composeExpertInstructions, parseExpertMention } from '../src/shared/expert-context'
import { getExpertKnowledgeScope } from '../src/renderer/src/agent/executors/domain-tools'
import type { ToolExecContext } from '../src/renderer/src/agent/executors/context'
import type { ExpertProfile } from '../src/shared/types/expert'

// ── Test doubles ──

const expert = (patch: Partial<ExpertProfile> = {}): ExpertProfile => ({
  id: 'expert-writing',
  name: '写作专家',
  basePrompt: '资深写作顾问',
  ...patch,
})

const knowledge = [
  { id: 'k1', title: '风格指南', filePath: 'raw/style-guide.md' },
  { id: 'k2', title: '样文集', filePath: 'raw/samples.md' },
]

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

  it('appends the bound knowledge index when files are present', () => {
    const out = composeExpertInstructions({ name: 'E', basePrompt: 'p' }, knowledge)
    expect(out).toContain('## Bound Knowledge')
    expect(out).toContain('- 风格指南 (raw/style-guide.md)')
    expect(out).toContain('- 样文集 (raw/samples.md)')
    expect(out).toContain('knowledge_search')
  })

  it('omits the knowledge section without files', () => {
    expect(composeExpertInstructions({ name: 'E', basePrompt: 'p' })).not.toContain('## Bound Knowledge')
  })
})

// ── 引用关系（常用技能 / 连接器）：注入指令的倾向提示，不是权限白名单 ──

describe('composeExpertInstructions references', () => {
  const catalogs = {
    skills: [
      { id: 'code-review', name: 'code-review', summary: '按严重度分级审查代码' },
      { id: 'writing', name: 'writing', summary: '长文写作' },
    ],
    connectors: [{ id: 'mcp-github', name: 'GitHub', summary: '仓库与 PR' }],
  }

  it('lists preferred skills and connectors with their catalog description', () => {
    const out = composeExpertInstructions(
      { name: 'E', basePrompt: 'p', skillNames: ['code-review'], mcpServerIds: ['mcp-github'] },
      [],
      catalogs
    )
    expect(out).toContain('## Preferred Skills')
    expect(out).toContain('- code-review — 按严重度分级审查代码')
    expect(out).toContain('## Preferred Connectors')
    expect(out).toContain('- GitHub — 仓库与 PR')
    // 措辞必须点明「只是倾向」，否则会被读成权限白名单。
    expect(out).toContain('preference, not a restriction')
  })

  it('omits a referenced skill that is no longer in the catalog', () => {
    const out = composeExpertInstructions(
      { name: 'E', basePrompt: 'p', skillNames: ['code-review', 'uninstalled'] },
      [],
      catalogs
    )
    expect(out).toContain('code-review')
    expect(out).not.toContain('uninstalled')
  })

  it('falls back to the raw names when the catalog could not be read', () => {
    const out = composeExpertInstructions({ name: 'E', basePrompt: 'p', skillNames: ['code-review'] })
    expect(out).toContain('- code-review')
  })

  it('renders no reference section for an expert that references nothing', () => {
    const out = composeExpertInstructions({ name: 'E', basePrompt: 'p' }, [], catalogs)
    expect(out).not.toContain('## Preferred Skills')
    expect(out).not.toContain('## Preferred Connectors')
  })
})

// ── parseExpertMention ──

describe('parseExpertMention', () => {
  const experts = [
    expert(),
    expert({ id: 'expert-code', name: '代码审查专家', enabled: false }),
  ]

  it('resolves an enabled expert by name and strips the token', () => {
    const r = parseExpertMention('@写作专家 帮我写一篇周报', experts)
    expect(r.expert?.id).toBe('expert-writing')
    expect(r.text).toBe('帮我写一篇周报')
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

  it('strips the mention inside a sentence, collapsing extra whitespace', () => {
    const r = parseExpertMention('先让 @写作专家 看看这段', experts)
    expect(r.expert?.id).toBe('expert-writing')
    expect(r.text).toBe('先让 看看这段')
  })

  it('returns the text untouched without a match', () => {
    const r = parseExpertMention('邮箱是 a@b.com', experts)
    expect(r.expert).toBeNull()
    expect(r.text).toBe('邮箱是 a@b.com')
  })
})

// ── getExpertKnowledgeScope（委托运行时的知识收敛与召唤运行时对齐）──

describe('getExpertKnowledgeScope', () => {
  const files = [
    { id: 'k1', title: '风格指南', filePath: 'raw/style-guide.md', wikiPages: ['wiki/style.md'] },
  ]
  const ctx = (opts: Record<string, unknown>): ToolExecContext => ({ opts } as unknown as ToolExecContext)

  it('confines to the @-summoned expert pack when one is bound', () => {
    const scope = getExpertKnowledgeScope(ctx({ expert: { knowledgeFiles: files } }))
    expect(scope?.ids).toEqual(new Set(['k1']))
    expect(scope?.rawPaths).toEqual(new Set(['raw/style-guide.md']))
    expect(scope?.wikiPaths).toEqual(new Set(['wiki/style.md']))
  })

  it('falls back to the delegated knowledgeScope so spawn_agent enforces the same convergence', () => {
    const scope = getExpertKnowledgeScope(ctx({ knowledgeScope: files }))
    expect(scope?.ids).toEqual(new Set(['k1']))
    expect(scope?.wikiPaths).toEqual(new Set(['wiki/style.md']))
  })

  it('prefers the summoned pack when both are present', () => {
    const scope = getExpertKnowledgeScope(ctx({
      expert: { knowledgeFiles: files },
      knowledgeScope: [{ id: 'other', title: 'x', filePath: 'raw/other.md', wikiPages: [] }],
    }))
    expect(scope?.ids).toEqual(new Set(['k1']))
  })

  it('returns null without any bound files', () => {
    expect(getExpertKnowledgeScope(ctx({}))).toBeNull()
    expect(getExpertKnowledgeScope(ctx({ knowledgeScope: [] }))).toBeNull()
  })
})
