import { describe, expect, it } from 'vitest'
import { composeExpertInstructions, parseExpertMention } from '../src/renderer/src/agent/expert-context'
import type { SubAgentProfile } from '../src/shared/types/subagent'

// ── Test doubles ──

const expert = (patch: Partial<SubAgentProfile> = {}): SubAgentProfile => ({
  id: 'expert-writing',
  name: '写作专家',
  basePrompt: '资深写作顾问',
  allowedTools: [],
  allowedMcpServers: [],
  allowedSkills: [],
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

// ── parseExpertMention ──

describe('parseExpertMention', () => {
  const experts = [
    expert(),
    expert({ id: 'expert-code', name: '代码审查专家', enabled: false }),
    expert({ id: 'subagent-general', name: '通用子代理', isBuiltIn: true }),
  ]

  it('resolves an enabled non-builtin expert by name and strips the token', () => {
    const r = parseExpertMention('@写作专家 帮我写一篇周报', experts)
    expect(r.expert?.id).toBe('expert-writing')
    expect(r.text).toBe('帮我写一篇周报')
  })

  it('never resolves disabled or built-in profiles', () => {
    expect(parseExpertMention('@代码审查专家 审一下', experts).expert).toBeNull()
    expect(parseExpertMention('@通用子代理 干活', experts).expert).toBeNull()
    expect(parseExpertMention('@通用子代理 干活', experts).text).toBe('@通用子代理 干活')
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
