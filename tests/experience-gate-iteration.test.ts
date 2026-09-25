import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SessionReviewAgent, poolNamesOf } from '../src/renderer/src/agent/one-shot-agent/SessionReviewAgent'

// PLAN-experience-iteration, Part A (gate) + Part B (three-way iteration).
// Style B: instantiate the REAL agent and assert what actually reaches the
// model — the four-situation gate used to live only in the dead ExperienceAgent,
// so a prompt assertion is the only thing that can catch its absence again.

const read = (p: string): string => readFileSync(new URL('../' + p, import.meta.url), 'utf-8')

const agent = new SessionReviewAgent()
// protected members — the same pattern the other prompt tests use
const prompt = (agent as any).buildSystemPrompt() as string
const userMsg = (input: Record<string, unknown>) => (agent as any).buildUserMessages(input) as Array<{ role: string; content: string }>

describe('the qualification gate reaches the LIVE prompt', () => {
  it('carries all four situations verbatim', () => {
    expect(prompt).toContain('QUALIFICATION GATE')
    expect(prompt).toContain('1. A complex task completed successfully (the statistics show 5+ tool calls)')
    expect(prompt).toContain('2. The agent hit a wall')
    expect(prompt).toContain('the struggle itself is the lesson')
    expect(prompt).toContain('3. The user corrected the agent')
    expect(prompt).toContain('4. A non-trivial workflow was discovered')
  })

  it('carries the negative list and the stats-driven null rule', () => {
    expect(prompt).toContain('A casual chat, a simple question answered in one exchange, a one-off decision')
    expect(prompt).toContain('does NOT qualify')
    // the gate's input: the (Conversation statistics: …) line in the summary
    expect(prompt).toContain('(Conversation statistics: N tool call(s), M tool error(s))')
    expect(prompt).toContain('few tool calls, zero tool errors')
    expect(prompt).toContain('set "experience" to null')
  })

  it('keeps the two experience types and the four-section body structure', () => {
    expect(prompt).toContain('**Optimizations:**')
    expect(prompt).toContain('**User pain points:**')
    expect(prompt).toContain('## 背景 (Background)')
    expect(prompt).toContain('## 过程 (Process)')
    expect(prompt).toContain('## 问题 (Problems)')
    expect(prompt).toContain('## 优化 (Optimization)')
  })

  it('keeps the script hard constraints (regression: experience-script-wiring)', () => {
    expect(prompt).toContain('### File: scripts/<name>.mjs')
    expect(prompt).toContain('ONLY built-in modules')
    expect(prompt).toContain('NO npm')
    expect(prompt).toContain('process.argv')
    expect(prompt).toContain('## 脚本 (Script)')
  })
})

describe('the three-way iteration protocol', () => {
  it('names DUPLICATES / EXTENDS / NEW and their three actions', () => {
    expect(prompt).toContain('DUPLICATES / EXTENDS / NEW')
    expect(prompt).toContain('set "experience" to null') // DUPLICATES
    expect(prompt).toContain('"action": "update"')
    expect(prompt).toContain('"target"')
    expect(prompt).toContain('"action": "create"')
  })

  it('an update must be the FULL revised document, never a fragment', () => {
    expect(prompt).toContain('FULL revised document')
    expect(prompt).toContain('do NOT truncate')
    expect(prompt).toContain('a partial fragment would destroy the entry')
  })

  it('script changes ride same-path fences; untouched scripts are not re-emitted', () => {
    expect(prompt).toContain('SAME path')
    expect(prompt).toContain('must NOT be re-emitted')
    expect(prompt).toContain('left untouched on disk')
  })

  it('the output format carries the optional action/target fields', () => {
    expect(prompt).toContain('"action": "create|update", "target": "<existing name, only when action=update>"')
  })

  it('the user message hands over the live pool with its line format', () => {
    const msgs = userMsg({ sessionSummary: 'x', existingExperiencesText: '- 聚合导出 | code | 每周聚合\nbody here' })
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toContain('EXISTING EXPERIENCES (the live experience pool')
    expect(msgs[0].content).toContain('"- name | category | description"')
    expect(msgs[0].content).toContain('- 聚合导出 | code | 每周聚合')
    // with no pool the section is absent, not an empty header
    const bare = userMsg({ sessionSummary: 'x' })
    expect(bare[0].content).not.toContain('EXISTING EXPERIENCES')
  })
})

describe('parseResponse validates action/target', () => {
  const wrap = (experience: unknown) => JSON.stringify({ memories: [], experience })

  it('a target the model was shown survives as update', () => {
    const out = (agent as any).parseResponse(
      wrap({ title: 'T', content: 'body', category: 'code', action: 'update', target: '聚合导出' }),
      { existingExperiencesText: '- 聚合导出 | code | 每周聚合\nold body' },
    )
    expect(out.experience.action).toBe('update')
    expect(out.experience.target).toBe('聚合导出')
  })

  it('a target NOT in the pool degrades to create (never silently dropped)', () => {
    const out = (agent as any).parseResponse(
      wrap({ title: 'T', content: 'body', category: 'code', action: 'update', target: '幻觉出来的名字' }),
      { existingExperiencesText: '- 聚合导出 | code | 每周聚合\nold body' },
    )
    expect(out.experience.action).toBe('create')
    expect(out.experience.target).toBeUndefined()
    expect(out.experience.content).toBe('body') // the insight itself survives
  })

  it('update without a target degrades to create', () => {
    const out = (agent as any).parseResponse(
      wrap({ title: 'T', content: 'body', category: 'code', action: 'update' }),
      { existingExperiencesText: '- 聚合导出 | code | 每周聚合' },
    )
    expect(out.experience.action).toBe('create')
    expect(out.experience.target).toBeUndefined()
  })

  it('an update against an EMPTY pool degrades to create (no names were ever shown)', () => {
    const out = (agent as any).parseResponse(
      wrap({ title: 'T', content: 'body', category: 'code', action: 'update', target: '聚合导出' }),
      { existingExperiencesText: '' },
    )
    expect(out.experience.action).toBe('create')
    expect(out.experience.target).toBeUndefined()
  })

  it('omitting action reads as create (the default)', () => {
    const out = (agent as any).parseResponse(wrap({ title: 'T', content: 'body', category: 'code' }), {})
    expect(out.experience.action).toBe('create')
    expect(out.experience.target).toBeUndefined()
  })

  it('script fences still split out of an update body (regression)', () => {
    const out = (agent as any).parseResponse(
      wrap({
        title: 'T',
        content: '## 背景\nx\n\n### File: scripts/a.mjs\n```js\nconsole.log(1)\n```\n',
        category: 'code',
        action: 'update',
        target: '聚合导出',
      }),
      { existingExperiencesText: '- 聚合导出 | code | d' },
    )
    expect(out.experience.action).toBe('update')
    expect(out.experience.files).toEqual([{ path: 'scripts/a.mjs', content: 'console.log(1)' }])
    expect(out.experience.content).not.toContain('### File:')
  })

  it('poolNamesOf reads the first field of each "- name | " line and ignores prose', () => {
    const names = poolNamesOf('- 聚合导出 | code | d\nbody\n- weekly-report | general | d2\nno pipe here')
    expect([...names]).toEqual(['聚合导出', 'weekly-report'])
    expect(poolNamesOf(undefined).size).toBe(0)
  })
})

describe('the dedup context reads the LIVE pool (data-source scan)', () => {
  const src = read('src/renderer/src/memory/MemoryManager.ts')

  it('reads listExperiences + readExperienceRecord, never the knowledge base', () => {
    expect(src).toContain('listExperiences()')
    expect(src).toContain('readExperienceRecord(rec.name)')
    // The old source: knowledge rows only the 0.3.4 migration ever wrote —
    // content dedup against them was blind to the whole live pool.
    expect(src).not.toContain('knowledgeListFiles')
    expect(src).not.toContain("sourceType === 'experience'")
    expect(src).not.toContain('knowledgeGetRaw')
  })

  it('formats each record as "- name | category | description" + body, with budgets', () => {
    expect(src).toContain('- ${rec.name} | ${rec.category} | ${rec.description}')
    expect(src).toContain('maxBodyLen = 1500')
    expect(src).toContain('maxTotal = 30000')
    // the section header moved to the agent (it used to be emitted twice)
    expect(src).not.toContain('EXISTING EXPERIENCES')
  })

  it('the agent owns the section header', () => {
    expect(read('src/renderer/src/agent/one-shot-agent/SessionReviewAgent.ts')).toContain('EXISTING EXPERIENCES (the live experience pool')
  })

  it('extractAndSaveAll surfaces the target, and the shared frontmatter parser is used', () => {
    expect(src).toContain('experienceTarget?: string')
    expect(src).toContain("parseExperienceMd(raw, rec.title)")
    // hoisted, not a second private copy in ExperienceManager
    const em = read('src/renderer/src/experiences/ExperienceManager.ts')
    expect(em).not.toContain('function parseExperienceMd')
    expect(em).toContain("from '../../../shared/experience/frontmatter'")
    expect(read('src/shared/experience/frontmatter.ts')).toContain('export function parseExperienceMd')
  })
})
