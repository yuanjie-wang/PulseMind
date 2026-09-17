// PLAN-knowledge-base K6: knowledge_read — wiki default (docs and code finally
// agree), cross-directory fallback with the actual source noted, and in-base
// line paging. Drives the REAL executor over a stubbed KnowledgeManager.

import { describe, expect, it } from 'vitest'
import { execKnowledgeTool } from '../src/renderer/src/agent/executors/domain-tools'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

function makeEx(km: unknown) {
  const results: Array<{ id: string; content: string; isError: boolean }> = []
  return {
    ex: {
      opts: { knowledgeManager: km },
      addToolResult: (id: string, content: string, isError: boolean) => {
        results.push({ id, content, isError })
      },
      notify: () => {},
    } as never,
    results,
  }
}

function makeTool(input: Record<string, unknown>): ToolUseBlock {
  return { id: 't1', name: 'knowledge_read', input, status: 'pending' } as unknown as ToolUseBlock
}

const KM = {
  readWiki: async (path: string) => ({ content: path === 'index.md' ? 'WIKI-INDEX-BODY' : null, files: [] }),
  readRawContent: async (path: string) => {
    if (path === 'raw-a.md') return 'RAW-BODY-A'
    throw new Error('not found')
  },
}

describe('knowledge_read (K6)', () => {
  it('defaults to wiki when type is omitted (the old code read raw, against its own docs)', async () => {
    const { ex, results } = makeEx(KM)
    const t = makeTool({ path: 'index.md' })
    await execKnowledgeTool(ex, t)
    expect(results[0].content).toContain('WIKI-INDEX-BODY')
    expect(results[0].content).toContain('[type=wiki]')
  })

  it('falls back to the other directory and NOTES the actual source', async () => {
    const { ex, results } = makeEx(KM)
    const t = makeTool({ path: 'raw-a.md' })
    await execKnowledgeTool(ex, t)
    expect(results[0].content).toContain('RAW-BODY-A')
    expect(results[0].content).toContain('fallback from wiki')
    expect(results[0].content).toContain('[type=raw')
  })

  it('explicit raw reads raw without a fallback note', async () => {
    const { ex, results } = makeEx(KM)
    const t = makeTool({ path: 'raw-a.md', type: 'raw' })
    await execKnowledgeTool(ex, t)
    expect(results[0].content).toContain('RAW-BODY-A')
    expect(results[0].content).not.toContain('fallback')
  })

  it('pages by offset/lines inside the base and reports the next offset', async () => {
    const km = {
      readWiki: async () => ({ content: null, files: [] }),
      readRawContent: async () => 'l1\nl2\nl3\nl4\nl5',
    }
    const { ex, results } = makeEx(km)
    await execKnowledgeTool(ex, makeTool({ path: 'big.md', type: 'raw', offset: 2, lines: 2 }))
    expect(results[0].content).toContain('l2\nl3')
    expect(results[0].content).toContain('offset=4')
    expect(results[0].content).not.toContain('l1\n')
  })

  it('a miss in both directories reports not-found', async () => {
    const { ex, results } = makeEx(KM)
    const t = makeTool({ path: 'nope.md' })
    await execKnowledgeTool(ex, t)
    expect(results[0].content).toContain('not found in knowledge base')
  })
})
