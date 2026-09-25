// experience_save — the conversation-side write path into the experience pool.
//
// The pool lives in ~/.pulsemind, a path-jail DENY ROOT: `read` reaches it
// (the shell path is not jail-checked for reads) while `edit`/`write` answer
// "Path is protected". That asymmetry is why the tool exists — the model in
// conv_20260925230016 had a finished checklist and no sanctioned door, and the
// assistant explicitly refused to shell around the guard. This file pins the
// door itself: `execExperienceTool` is a free function whose only dependency
// for this name is `opts.experienceManager`, so the behaviour is testable
// here without a host, an engine or a database — plus the dispatch/registry
// wiring, asserted as source the way office-tool-dispatch does it (node-env:
// the engine cannot be mounted).

import { describe, expect, it } from 'vitest'
import { execExperienceTool } from '../src/renderer/src/agent/executors/domain-tools'
import type { ToolExecContext } from '../src/renderer/src/agent/executors/context'
import type { ToolUseBlock } from '../src/shared/types/agent'
import type { ExperienceDraft, ExperienceRecord } from '../src/shared/types/experience-types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const EXISTING: ExperienceRecord = {
  id: 'exp_1',
  name: 'webmail-send',
  title: '网页邮箱发送不落库',
  description: '点了发送但没发出去',
  category: 'code',
  createdAt: '2026-09-25 10:00:00',
  useCount: 3,
  triggers: ['网页邮箱'],
}

function harness(
  records: ExperienceRecord[] = [],
  opts: {
    save?: (draft: ExperienceDraft) => Promise<{ record: ExperienceRecord; evicted?: ExperienceRecord; rejectedFiles?: string[] }>
    apiKey?: string | null
  } = {},
) {
  const saved: ExperienceDraft[] = []
  const ensure: Array<{ name: string; force: boolean; apiKey: unknown }> = []
  const results: Array<{ text: string; isError: boolean }> = []
  const em = {
    list: async () => records,
    save: async (draft: ExperienceDraft) => {
      saved.push(draft)
      if (opts.save) return opts.save(draft)
      return {
        record: {
          id: 'exp_new', name: 'made', title: draft.title, description: draft.description,
          category: draft.category, triggers: draft.triggers ?? [], createdAt: '2026-09-25 11:00:00', useCount: 0,
        } as ExperienceRecord,
      }
    },
    ensureTriggers: async (name: string, llm: { apiKey?: unknown }, force: boolean) => {
      ensure.push({ name, force, apiKey: llm?.apiKey })
    },
  }
  const ex = {
    opts: {
      experienceManager: em,
      conversationId: 'conv_test',
      apiKey: opts.apiKey === undefined ? 'sk-test' : opts.apiKey,
      baseURL: 'https://api.example.com',
      model: 'test-model',
      adapter: 'anthropic',
    },
    addToolResult: (_id: string, text: string, isError: boolean) => { results.push({ text, isError }) },
    notify: () => {},
    formatExecResult: () => '',
  } as unknown as ToolExecContext
  const block = (input: Record<string, unknown>): ToolUseBlock =>
    ({ type: 'tool_use', id: 'tu_1', name: 'experience_save', input, status: 'running' })
  return { ex, saved, ensure, results, block }
}

describe('experience_save — the draft it hands the store', () => {
  it('creates with every default filled and reports the record it made', async () => {
    const { ex, saved, ensure, results, block } = harness([])
    const t = block({ content: '# Webmail 写信\n\n点了发送但收件箱里没有，最后是在草稿箱点的「发送到服务器」。' })
    expect(await execExperienceTool(ex, t)).toBe(true)

    expect(results).toHaveLength(1)
    expect(results[0]!.isError).toBe(false)
    expect(t.exitCode).toBe(0)
    expect(saved).toHaveLength(1)
    const d = saved[0]!
    expect(d.title).toBe('Webmail 写信') // first line, heading marker stripped
    expect(d.content).toContain('草稿箱')
    expect(d.description.length).toBeGreaterThan(0)
    expect(d.description.length).toBeLessThanOrEqual(120)
    expect(d.description).not.toContain('\n') // a one-line index summary
    expect(d.category).toBe('general')
    expect(d.sourceConversationId).toBe('conv_test')
    expect(d.targetName).toBeUndefined() // a create never aims at a record

    expect(results[0]!.text).toContain('已保存经验')
    expect(results[0]!.text).toContain('name: `made`')
    expect(results[0]!.text).toContain('触发词：稍后自动提取')
    // no triggers given → the automatic path runs, with force OFF (this is not
    // a revision, so a record that already has keywords would keep them)
    expect(ensure).toEqual([{ name: 'made', force: false, apiKey: 'sk-test' }])
  })

  it('revises in place: the body is replaced, the identity is kept, triggers re-extract with force', async () => {
    const { ex, saved, ensure, results, block } = harness([EXISTING])
    const t = block({ content: '修订后的正文：在草稿箱右上角还有一个「发送」。', targetName: 'webmail-send' })
    expect(await execExperienceTool(ex, t)).toBe(true)

    const d = saved[0]!
    expect(d.targetName).toBe('webmail-send')
    expect(d.content).toContain('右上角') // no partial patch — the whole body
    expect(d.title).toBe(EXISTING.title) // omitted → keeps its own
    expect(d.category).toBe(EXISTING.category)
    expect(results[0]!.text).toContain('已修订经验')
    // a revision's old keywords may no longer describe the new body
    expect(ensure).toEqual([{ name: 'made', force: true, apiKey: 'sk-test' }])
  })

  it('refuses a targetName that matches nothing instead of forking a look-alike', async () => {
    const { ex, saved, ensure, results, block } = harness([EXISTING])
    const t = block({ content: '正文', targetName: 'no-such-record' })
    expect(await execExperienceTool(ex, t)).toBe(true)

    expect(results[0]!.isError).toBe(true)
    expect(t.exitCode).toBe(1)
    expect(results[0]!.text).toContain('不存在')
    expect(results[0]!.text).toContain('webmail-send') // names the real candidates
    expect(saved).toHaveLength(0) // the store's create-fallback is NOT reachable from here
    expect(ensure).toHaveLength(0)
  })

  it('rejects empty content before the store is touched', async () => {
    const { ex, saved, results, block } = harness([EXISTING])
    const t = block({ content: '   \n  ' })
    expect(await execExperienceTool(ex, t)).toBe(true)
    expect(results[0]!.isError).toBe(true)
    expect(saved).toHaveLength(0)
  })

  it('says out loud when the 20-cap evicted a record or a script file was rejected', async () => {
    const { ex, results, block } = harness([EXISTING], {
      save: async (draft) => ({
        record: { ...EXISTING, title: draft.title } as ExperienceRecord,
        evicted: { ...EXISTING, name: 'oldest-one', title: '最久未用的经验' },
        rejectedFiles: ['scripts/bad-syntax.mjs'],
      }),
    })
    const t = block({ content: '正文', targetName: 'webmail-send' })
    await execExperienceTool(ex, t)

    // the body IS saved — a rejected file or an eviction is not a failure
    expect(results[0]!.isError).toBe(false)
    expect(results[0]!.text).toContain('被挤出')
    expect(results[0]!.text).toContain('最久未用的经验')
    expect(results[0]!.text).toContain('scripts/bad-syntax.mjs')
    expect(results[0]!.text).toContain('经验正文已照常保存')
  })

  it('explicit triggers are taken verbatim and skip the extraction call entirely', async () => {
    const { ex, saved, ensure, block } = harness([EXISTING])
    await execExperienceTool(ex, block({ content: '正文', triggers: ['网页邮箱', ' 草稿箱 ', '', 'x'.repeat(60)] }))
    expect(saved[0]!.triggers).toEqual(['网页邮箱', '草稿箱']) // trimmed, bounded, junk dropped
    expect(ensure).toHaveLength(0)
  })

  it('an invented category falls back (to the existing one when revising)', async () => {
    const { ex, saved, block } = harness([EXISTING])
    await execExperienceTool(ex, block({ content: '正文', category: 'vibes', targetName: 'webmail-send' }))
    expect(saved[0]!.category).toBe(EXISTING.category)
    const fresh = harness([])
    await execExperienceTool(fresh.ex, fresh.block({ content: '正文', category: 'vibes' }))
    expect(fresh.saved[0]!.category).toBe('general')
  })

  it('no API key → no extraction call, and the save still succeeds', async () => {
    const { ex, ensure, results, block } = harness([], { apiKey: null })
    await execExperienceTool(ex, block({ content: '正文' }))
    expect(results[0]!.isError).toBe(false)
    expect(ensure).toHaveLength(0)
  })

  it('a save with no experience manager fails loudly rather than falling through to the shell', async () => {
    const results: Array<{ text: string; isError: boolean }> = []
    const ex = {
      opts: {} as never,
      addToolResult: (_id: string, text: string, isError: boolean) => { results.push({ text, isError }) },
      notify: () => {},
      formatExecResult: () => '',
    } as unknown as ToolExecContext
    const t: ToolUseBlock = { type: 'tool_use', id: 'tu_2', name: 'experience_save', input: { content: 'x' } }
    expect(await execExperienceTool(ex, t)).toBe(true) // handled, NOT handed to buildCommandFromSkillInput
    expect(results[0]!.isError).toBe(true)
  })
})

describe('experience_save — registration and dispatch (source scans)', () => {
  const builtins = read('src/renderer/src/tools/built-in-tools.ts')
  const instructions = read('src/renderer/src/tools/tool-instructions.ts')
  const flow = read('src/renderer/src/agent/engine/execution-flow.ts')
  const dispatch = read('src/renderer/src/agent/tool-executors.ts')
  const summary = read('src/renderer/src/components/chat/tool-summary.ts')
  const zh = read('src/renderer/src/i18n/locales/zh.ts')
  const en = read('src/renderer/src/i18n/locales/en.ts')

  it('non-vacuity: the scans read real sources', () => {
    expect(builtins).toContain("name: 'experience_read'")
    expect(instructions).toContain('experience_read: `## experience_read')
    expect(flow).toContain('isExperienceTool')
  })

  it('registered as a gated tool of the experience category, with its own manual', () => {
    const at = builtins.indexOf("name: 'experience_save'")
    const next = builtins.indexOf("name: '", at + 10) // the NEXT tool entry ends this one
    const block = builtins.slice(Math.max(0, at - 200), next > 0 ? next : undefined)
    expect(block).toContain("category: 'experience'")
    expect(block).toContain("instructions: toolInstructions.experience_save")
    expect(block).toContain("availability: 'gated'")
    expect(block).toContain("required: ['content']")
    expect(instructions).toContain('experience_save: `## experience_save')
  })

  it('both dispatch surfaces route it to the experience group (never the shell default)', () => {
    // Two isExperienceTool predicates — dispatchToolExecution's grouping and
    // handleToolUseResponse's held/not-held partition. Both must know the name,
    // or it lands in otherTools and the ladder holds it → an approval release
    // walks every branch into the shell command builder (the H10 shape).
    const matches = flow.match(/isExperienceTool = \(name: string\): boolean => [^\n]+/g) ?? []
    expect(matches).toHaveLength(2)
    for (const m of matches) expect(m).toContain("'experience_save'")
    // the group is dispatched through the catch-all executor …
    expect(dispatch).toMatch(/if \(await execExperienceTool\(this, t\)\) return/)
    // … and the trusted group reaches it: both grouping sites send the group
    // to execOtherTool rather than letting it fall into otherTools (which the
    // ladder holds at 'exec').
    expect(flow.match(/experienceTools\.length > 0\) for \(const t of experienceTools\) await this\.engine\.toolExecutor\.execOtherTool\(t\)/g)).toHaveLength(1)
    expect(flow.match(/!experienceTools\.includes\(t\)/g)).toHaveLength(2) // both otherTools filters
  })

  it('the collapsed header and both locales can name it', () => {
    expect(summary).toContain("'experience_save'")
    expect(zh).toContain("experience_save: '保存经验'")
    expect(en).toContain("experience_save: 'Save experience'")
  })
})
