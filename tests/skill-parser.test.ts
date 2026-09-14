import { describe, it, expect } from 'vitest'
import { parseSkillMarkdown, validateSkillSpec, formatSkillMd } from '../src/main/utils/skill-parser'
import type { SkillDefinition } from '../src/shared/types/skill-types'

function md(frontmatter: string, body = 'Instructions here.'): string {
  return `---\n${frontmatter}\n---\n\n${body}`
}

function skill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: 'test-skill',
    description: 'Does things',
    category: 'imported',
    systemPrompt: 'Body text.',
    ...overrides,
  }
}

describe('parseSkillMarkdown — legacy format (regression)', () => {
  it('parses plain keys and trigger lists', () => {
    const parsed = parseSkillMarkdown(
      md('name: my-skill\ndescription: Does something\ncategory: engineering\ntriggers:\n  - keyword1\n  - keyword2'),
      'SKILL.md',
    )
    expect(parsed.name).toBe('my-skill')
    expect(parsed.description).toBe('Does something')
    expect(parsed.category).toBe('engineering')
    expect(parsed.triggers).toEqual(['keyword1', 'keyword2'])
    expect(parsed.systemPrompt).toBe('Instructions here.')
  })

  it('defaults category and description, tolerates BOM and CRLF', () => {
    const parsed = parseSkillMarkdown('\uFEFF---\r\nname: my-skill\r\n---\r\n\r\nBody.\r\n', 'SKILL.md')
    expect(parsed.name).toBe('my-skill')
    expect(parsed.description).toBe('my-skill')
    expect(parsed.category).toBe('imported')
    expect(parsed.triggers).toEqual([])
  })

  it('throws on missing name / missing body / missing delimiters', () => {
    expect(() => parseSkillMarkdown(md('description: x'), 'a.md')).toThrow(/name/)
    expect(() => parseSkillMarkdown('---\nname: x\n---\n', 'b.md')).toThrow(/empty/)
    expect(() => parseSkillMarkdown('name: x\n', 'c.md')).toThrow(/---/)
  })
})

describe('parseSkillMarkdown — ecosystem YAML constructs', () => {
  it('handles quoted strings containing colons and hashes', () => {
    const parsed = parseSkillMarkdown(md('name: q-skill\ndescription: "Does X: then Y #not-a-comment"\ncategory: \'imported\' # note'), 'SKILL.md')
    expect(parsed.description).toBe('Does X: then Y #not-a-comment')
    expect(parsed.category).toBe('imported')
  })

  it('strips inline comments on plain scalars only after whitespace', () => {
    const parsed = parseSkillMarkdown(md('name: c-skill\ndescription: Plain value # real comment'), 'SKILL.md')
    expect(parsed.description).toBe('Plain value')
  })

  it('parses literal block scalars (|) with clip chomping', () => {
    const parsed = parseSkillMarkdown(md('name: block-skill\ndescription: |\n  Extracts text and tables\n  from PDF files.'), 'SKILL.md')
    expect(parsed.description).toBe('Extracts text and tables\nfrom PDF files.')
  })

  it('parses folded block scalars (>) joining lines', () => {
    const parsed = parseSkillMarkdown(md('name: fold-skill\ndescription: >-\n  one two\n  three'), 'SKILL.md')
    expect(parsed.description).toBe('one two three')
  })

  it('parses nested metadata maps and flow sequences (OpenClaw style)', () => {
    const parsed = parseSkillMarkdown(
      md(
        [
          'name: oc-skill',
          'description: Media conversion',
          'license: Apache-2.0',
          'compatibility: Requires ffmpeg',
          'metadata:',
          '  author: example-org',
          '  version: "1.0"',
          '  openclaw:',
          '    emoji: 🧧',
          '    requires:',
          '      bins: [ffmpeg, ffprobe]',
          '      env:',
          '        - GROQ_API_KEY',
        ].join('\n'),
      ),
      'SKILL.md',
    )
    expect(parsed.license).toBe('Apache-2.0')
    expect(parsed.compatibility).toBe('Requires ffmpeg')
    expect(parsed.allowedTools).toBeUndefined()
    const meta = parsed.metadata!
    expect(meta['author']).toBe('example-org')
    const openclaw = meta['openclaw'] as Record<string, unknown>
    expect(openclaw['emoji']).toBe('🧧')
    const requires = openclaw['requires'] as Record<string, unknown>
    expect(requires['bins']).toEqual(['ffmpeg', 'ffprobe'])
    expect(requires['env']).toEqual(['GROQ_API_KEY'])
  })

  it('parses multi-line flow collections', () => {
    const parsed = parseSkillMarkdown(md('name: flow-skill\ndescription: x\nmetadata:\n  cfg: {\n    a: 1,\n    b: [x, y]\n  }'), 'SKILL.md')
    expect(parsed.metadata!['cfg']).toEqual({ a: '1', b: ['x', 'y'] })
  })

  it('preserves allowed-tools and unknown fields in extra', () => {
    const parsed = parseSkillMarkdown(
      md('name: tools-skill\ndescription: x\nallowed-tools: Bash(git:*) Read\nuser-invocable: false\nhomepage: https://x.y'),
      'SKILL.md',
    )
    expect(parsed.allowedTools).toBe('Bash(git:*) Read')
    expect(parsed.extra).toEqual({ 'user-invocable': 'false', homepage: 'https://x.y' })
  })

  it('folds plain multi-line scalars', () => {
    const parsed = parseSkillMarkdown(md('name: plain-skill\ndescription: Extracts text\n  and tables from PDFs'), 'SKILL.md')
    expect(parsed.description).toBe('Extracts text and tables from PDFs')
  })
})

describe('validateSkillSpec', () => {
  it('flags spec-violating names but accepts valid ones', () => {
    expect(validateSkillSpec({ name: 'pdf-processing', description: 'x' })).toEqual([])
    expect(validateSkillSpec({ name: 'PDF-Processing', description: 'x' }).length).toBe(1)
    expect(validateSkillSpec({ name: '-pdf', description: 'x' }).length).toBe(1)
    expect(validateSkillSpec({ name: 'a--b', description: 'x' }).length).toBe(1)
    expect(validateSkillSpec({ name: 'a'.repeat(65), description: 'x' }).length).toBe(1)
  })

  it('flags over-long description/compatibility and dir mismatch', () => {
    expect(validateSkillSpec({ name: 'x', description: 'd'.repeat(1025) }).length).toBe(1)
    expect(validateSkillSpec({ name: 'x', description: 'd', compatibility: 'c'.repeat(501) }).length).toBe(1)
    expect(validateSkillSpec({ name: 'x', description: 'd' }, 'y')).toEqual(['directory "y" doesn\'t match the skill name "x"'])
  })
})

describe('formatSkillMd round-trip', () => {
  it('emits YAML that the parser reads back unchanged — including hostile strings', () => {
    const source = skill({
      name: 'round-trip',
      description: 'Does X: with "quotes" and #hash and: colons',
      category: 'engineering',
      triggers: ['pdf', 'multi word trigger'],
      license: 'Apache-2.0',
      compatibility: 'Requires Python 3.14+',
      allowedTools: 'Bash(git:*) Read',
      metadata: { author: 'org', version: '1.0', openclaw: { emoji: '🧧' } },
      systemPrompt: 'Line one.\n\nLine two.',
    })
    const reparsed = parseSkillMarkdown(formatSkillMd(source), 'SKILL.md')
    expect(reparsed.name).toBe(source.name)
    expect(reparsed.description).toBe(source.description)
    expect(reparsed.category).toBe(source.category)
    expect(reparsed.triggers).toEqual(source.triggers)
    expect(reparsed.license).toBe(source.license)
    expect(reparsed.compatibility).toBe(source.compatibility)
    expect(reparsed.allowedTools).toBe(source.allowedTools)
    expect(reparsed.metadata).toEqual(source.metadata)
    expect(reparsed.systemPrompt).toBe(source.systemPrompt)
  })

  it('the legacy unquoted-description bug no longer corrupts output', () => {
    const text = formatSkillMd(skill({ description: 'Does X: then Y' }))
    expect(text).not.toContain('description: Does X:')
    expect(parseSkillMarkdown(text, 'SKILL.md').description).toBe('Does X: then Y')
  })
})
