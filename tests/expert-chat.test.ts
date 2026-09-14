import { describe, expect, it } from 'vitest'
import {
  buildExpertChatSystemPrompt,
  buildExpertChatTurnText,
  generateExpertId,
  isDraftEmpty,
  parseExpertChatReply,
  pickDraftFields,
} from '../src/renderer/src/agent/one-shot-agent/expert-form'

const knowledge = [
  { id: 'k1', title: '风格指南' },
  { id: 'k2', title: '样文集' },
]

// ── parseExpertChatReply ──

describe('parseExpertChatReply', () => {
  it('splits the prose from a fenced JSON patch and keeps the changed fields', () => {
    const reply = [
      '我把人设和方法论填好了，还需要你确认输出格式。',
      '',
      '```json',
      '{ "basePrompt": "资深代码审查工程师", "methodology": "先正确性后风格" }',
      '```',
    ].join('\n')

    const r = parseExpertChatReply(reply, knowledge)
    expect(r.text).toBe('我把人设和方法论填好了，还需要你确认输出格式。')
    expect(r.draft).toEqual({ basePrompt: '资深代码审查工程师', methodology: '先正确性后风格' })
  })

  it('tolerates a bare ``` fence and surrounding whitespace', () => {
    const r = parseExpertChatReply('好的。\n```\n{"name":"翻译专家"}\n```\n', knowledge)
    expect(r.draft.name).toBe('翻译专家')
    expect(r.text).toBe('好的。')
  })

  it('maps knowledge titles back to ids and drops unknown titles', () => {
    const reply = '已绑定两个文件。\n```json\n{"knowledgeFiles":["风格指南","不存在的文件"]}\n```'
    const r = parseExpertChatReply(reply, knowledge)
    expect(r.draft.knowledgeFileIds).toEqual(['k1'])
  })

  it('matches knowledge titles case-insensitively and trims them', () => {
    const files = [{ id: 'k9', title: 'Style Guide' }]
    const r = parseExpertChatReply('```json\n{"knowledgeFiles":["  style guide "]}\n```', files)
    expect(r.draft.knowledgeFileIds).toEqual(['k9'])
  })

  it('ignores unknown keys, empty strings and non-string values', () => {
    const r = parseExpertChatReply(
      '```json\n{"name":"  ","bogus":1,"basePrompt":12,"description":"一句话"}\n```',
      knowledge
    )
    expect(r.draft).toEqual({ description: '一句话' })
  })

  it('falls back to the last balanced object when there is no fence', () => {
    const r = parseExpertChatReply('先这样 {"name":"甲"} 然后 {"name":"乙"}', knowledge)
    expect(r.draft.name).toBe('乙')
    expect(r.text).toBe('先这样 {"name":"甲"} 然后')
  })

  it('returns the whole reply as text when no JSON is present', () => {
    const r = parseExpertChatReply('你想让这个专家主要处理什么类型的任务？', knowledge)
    expect(r.draft).toEqual({})
    expect(r.text).toBe('你想让这个专家主要处理什么类型的任务？')
  })

  it('does not treat a JSON array or malformed JSON as a patch', () => {
    expect(parseExpertChatReply('```json\n[1,2,3]\n```').draft).toEqual({})
    expect(parseExpertChatReply('```json\n{ "name": }\n```').text).toBe('```json\n{ "name": }\n```')
  })

  it('keeps an empty knowledgeFiles array as an explicit unbind', () => {
    const r = parseExpertChatReply('```json\n{"knowledgeFiles":[]}\n```', knowledge)
    expect(r.draft.knowledgeFileIds).toEqual([])
  })
})

// ── prompt building ──

describe('buildExpertChatSystemPrompt', () => {
  it('lists every fillable field and the JSON contract', () => {
    const zh = buildExpertChatSystemPrompt('zh')
    for (const key of ['name', 'description', 'basePrompt', 'methodology', 'outputSpec', 'constraints']) {
      expect(zh).toContain(key)
    }
    expect(zh).toContain('json')
  })

  it('switches language with the locale but keeps the English key names', () => {
    const en = buildExpertChatSystemPrompt('en')
    expect(en).toContain('expert-config assistant')
    expect(en).toContain('basePrompt')
  })
})

describe('buildExpertChatTurnText', () => {
  it('carries the live form, the bound titles and the pickable titles', () => {
    const text = buildExpertChatTurnText(
      { name: '写作专家', basePrompt: '资深写作顾问', knowledgeFileIds: ['k1'] },
      knowledge,
      '帮我把它改成面向技术的写作专家',
      'zh'
    )
    expect(text).toContain('写作专家')
    expect(text).toContain('风格指南')
    expect(text).toContain('样文集')
    expect(text).toContain('帮我把它改成面向技术的写作专家')
    // knowledgeFileIds is an internal join key — the model only sees titles.
    expect(text).not.toContain('k1')
  })

  it('marks an empty knowledge base explicitly', () => {
    const text = buildExpertChatTurnText({}, [], '随便聊聊', 'zh')
    expect(text).toContain('知识库为空')
    expect(text).toContain('（无）')
  })
})

// ── small helpers ──

describe('pickDraftFields', () => {
  it('copies only non-empty strings plus the knowledge ids', () => {
    expect(pickDraftFields({ name: '甲', description: '', knowledgeFileIds: ['k1'] })).toEqual({
      name: '甲',
      knowledgeFileIds: ['k1'],
    })
  })

  it('returns an empty draft for a brand-new expert', () => {
    expect(pickDraftFields(null)).toEqual({})
  })
})

describe('isDraftEmpty', () => {
  it('detects whether anything changed', () => {
    expect(isDraftEmpty({})).toBe(true)
    expect(isDraftEmpty({ name: '甲' })).toBe(false)
  })
})

describe('generateExpertId', () => {
  it('slugifies latin names and keeps CJK', () => {
    expect(generateExpertId('Code Review Expert')).toBe('code-review-expert')
    expect(generateExpertId('翻译专家')).toBe('翻译专家')
  })

  it('falls back to a timestamped id for symbol-only names', () => {
    expect(generateExpertId('!!!')).toMatch(/^expert-\d+$/)
  })
})
