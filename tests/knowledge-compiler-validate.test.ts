// PLAN-knowledge-base K1: compilation output validation — an untrustworthy
// LLM response produces NO pages, the source stays raw, and bad actions are
// refused rather than sanitized. Plus the K3 orphan rule and the K5 chunker
// (the three pure halves of the knowledge plan).

import { describe, expect, it } from 'vitest'
import {
  KnowledgeCompilerAgent,
  validateWikiAction,
  isValidWikiPath,
  hasRequiredFrontmatter,
  WikiPlanAgent,
} from '../src/renderer/src/agent/one-shot-agent/KnowledgeCompilerAgent'
import { wikiPageIsOrphan, wikiPageSources } from '../src/shared/knowledge/wiki'
import { chunkText, CHUNK_SIZE, CHUNK_OVERLAP } from '../src/shared/knowledge/chunk'

function parse(raw: string): { actions: unknown[]; failed?: boolean; logEntry: string } {
  const agent = new KnowledgeCompilerAgent()
  const out = (agent as unknown as { parseResponse: (raw: string) => { actions: unknown[]; failed?: boolean; logEntry: string } })
    .parseResponse(raw)
  return out
}

const GOOD_PAGE = '---\ntitle: Cache\ntype: concept\nsources:\n  - a.md\nupdated: 2026-09-18\n---\n\nBody text.'

describe('K1: parseResponse refuses untrustworthy output', () => {
  it('an unparseable response yields NO actions (the old code wrote it to sources/compilation-*.md)', () => {
    const out = parse('这是一个半截的 JSON {"actions": ["write')
    expect(out.actions).toHaveLength(0)
    expect(out.failed).toBe(true)
    // The non-vacuity probe: revert parseResponse to the fallback that wrapped
    // raw output as a write_source action and this exact assertion goes red.
  })

  it('a valid JSON with valid actions passes through, wiki/ prefix stripped', () => {
    const out = parse(JSON.stringify({ actions: [{ type: 'write_entity', filePath: 'wiki/entities/cache.md', content: GOOD_PAGE }], logEntry: 'ok' }))
    expect(out.failed).toBeUndefined()
    expect(out.actions).toHaveLength(1)
    expect((out.actions[0] as { filePath: string }).filePath).toBe('entities/cache.md')
  })

  it('rejects paths outside the four page directories, index/log, and traversal', () => {
    for (const bad of ['index.md', 'log.md', 'sources/index.md', 'sources/../secret.md', 'evil/x.md', 'sources/name.jpeg', '/etc/passwd', '']) {
      const verdict = validateWikiAction({ type: 'write_source', filePath: bad, content: GOOD_PAGE })
      expect(verdict.ok).toBe(false)
    }
  })

  it('rejects actions without title/type frontmatter or empty content', () => {
    expect(validateWikiAction({ type: 'write_source', filePath: 'sources/a.md', content: 'no frontmatter here' }).ok).toBe(false)
    expect(validateWikiAction({ type: 'write_source', filePath: 'sources/a.md', content: '---\ntitle: x\n---\nbody' }).ok).toBe(false)
    expect(validateWikiAction({ type: 'write_source', filePath: 'sources/a.md', content: '  ' }).ok).toBe(false)
    expect(validateWikiAction({ type: 'nonsense', filePath: 'sources/a.md', content: GOOD_PAGE }).ok).toBe(false)
  })
})

describe('K2: the prompt carries the schema and the sources requirement', () => {
  it('buildSystemPrompt embeds the real schema text (K2: it never reached the prompt before)', () => {
    const agent = new KnowledgeCompilerAgent()
    const prompt = (agent as unknown as { buildSystemPrompt: (i: unknown) => string }).buildSystemPrompt({
      schema: 'THE-REAL-SCHEMA-MARKER',
      existingIndex: '',
      rawFiles: [],
    })
    expect(prompt).toContain('THE-REAL-SCHEMA-MARKER')
    expect(prompt).toContain('sources:')
    expect(prompt).toContain('updated:')
  })

  it('merge context (existing pages) rides the prompt when provided (K8)', () => {
    const agent = new KnowledgeCompilerAgent()
    const prompt = (agent as unknown as { buildSystemPrompt: (i: unknown) => string }).buildSystemPrompt({
      schema: 's',
      existingIndex: '',
      rawFiles: [],
      existingPages: [{ filePath: 'entities/cache.md', content: '---\ntitle: Cache\n---\nOld body' }],
    })
    expect(prompt).toContain('existing entities/cache.md')
    expect(prompt).toContain('Old body')
  })

  it('WikiPlanAgent only accepts valid page paths', () => {
    const agent = new WikiPlanAgent()
    const out = (agent as unknown as { parseResponse: (raw: string) => { pages: Array<{ filePath: string }> } })
      .parseResponse(JSON.stringify({ pages: [{ filePath: 'entities/ok.md' }, { filePath: 'index.md' }, { filePath: 'nope/x.md' }] }))
    expect(out.pages).toEqual([{ filePath: 'entities/ok.md' }])
  })
})

describe('K3: the orphan rule for wiki page deletion', () => {
  const page = '---\ntitle: Cache\ntype: concept\nsources:\n  - a.md\n  - b.md\n---\n\nBody'

  it('a page with other sources survives the deletion of one source', () => {
    expect(wikiPageIsOrphan(page, 'entities/cache.md', 'a.md', [], ['b.md'])).toBe(false)
  })

  it('a page listed by another knowledge file survives', () => {
    const onlyA = '---\ntitle: Cache\ntype: concept\nsources:\n  - a.md\n---\nBody'
    expect(wikiPageIsOrphan(onlyA, 'entities/cache.md', 'a.md', [['entities/cache.md']], ['b.md'])).toBe(false)
    expect(wikiPageIsOrphan(onlyA, 'entities/cache.md', 'a.md', [['entities/other.md']], ['b.md'])).toBe(true)
  })

  it('a source that was already deleted cannot hold the page back', () => {
    const both = '---\ntitle: Cache\ntype: concept\nsources:\n  - a.md\n  - b.md\n---\nBody'
    // b.md still has a row → held back; b.md was deleted earlier → deletable.
    expect(wikiPageIsOrphan(both, 'entities/cache.md', 'a.md', [], ['b.md'])).toBe(false)
    expect(wikiPageIsOrphan(both, 'entities/cache.md', 'a.md', [], [])).toBe(true)
  })

  it('a truly orphaned page (single source, no other referers) is deletable', () => {
    const onlyA = '---\ntitle: Cache\ntype: concept\nsources:\n  - a.md\n---\nBody'
    expect(wikiPageIsOrphan(onlyA, 'entities/cache.md', 'a.md', [], ['b.md'])).toBe(true)
  })

  it('inline sources lists parse too', () => {
    expect(wikiPageSources('---\ntitle: x\ntype: concept\nsources: [a.md, "b.md"]\n---\n')).toEqual(['a.md', 'b.md'])
  })
})

describe('K5: chunking', () => {
  it('short content stays one chunk', () => {
    expect(chunkText('short')).toEqual(['short'])
    expect(chunkText('')).toEqual([])
  })

  it('long content splits near CHUNK_SIZE with overlap, never losing text', () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `第${i}段。${'内容'.repeat(40)}`).join('\n\n')
    const chunks = chunkText(paragraphs)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(CHUNK_SIZE + 1)
    // Consecutive chunks overlap so a match spanning the cut survives whole.
    for (let i = 1; i < chunks.length; i++) {
      const tail = chunks[i - 1].slice(-CHUNK_OVERLAP)
      expect(chunks[i].startsWith(tail) || chunks[i - 1].length < CHUNK_OVERLAP).toBe(true)
    }
    // Coverage: every original character appears in some chunk.
    const joined = chunks.join('\u0000')
    for (const p of paragraphs.split('\n\n')) expect(joined).toContain(p)
  })

  it('prefers paragraph boundaries over mid-sentence cuts', () => {
    const content = 'a'.repeat(CHUNK_SIZE - 10) + '\n\n' + 'b'.repeat(50)
    const chunks = chunkText(content)
    expect(chunks[0].endsWith('a') || chunks[0].length < CHUNK_SIZE).toBe(true)
  })
})
