import { describe, expect, it } from 'vitest'
import {
  buildExpertChatSystemPrompt,
  buildExpertChatTurnText,
  generateExpertId,
  isDraftEmpty,
  parseExpertChatReply,
  pickDraftFields,
} from '../src/renderer/src/agent/one-shot-agent/expert-form'

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

    const r = parseExpertChatReply(reply)
    expect(r.text).toBe('我把人设和方法论填好了，还需要你确认输出格式。')
    expect(r.draft).toEqual({ basePrompt: '资深代码审查工程师', methodology: '先正确性后风格' })
  })

  it('tolerates a bare ``` fence and surrounding whitespace', () => {
    const r = parseExpertChatReply('好的。\n```\n{"name":"翻译专家"}\n```\n')
    expect(r.draft.name).toBe('翻译专家')
    expect(r.text).toBe('好的。')
  })

  it('ignores unknown keys, empty strings and non-string values', () => {
    const r = parseExpertChatReply(
      '```json\n{"name":"  ","bogus":1,"basePrompt":12,"description":"一句话"}\n```'
    )
    expect(r.draft).toEqual({ description: '一句话' })
  })

  it('ignores capability keys the assistant is not allowed to fill', () => {
    const r = parseExpertChatReply('```json\n{"name":"甲","skillNames":["code-review"]}\n```')
    expect(r.draft).toEqual({ name: '甲' })
  })

  it('falls back to the last balanced object when there is no fence', () => {
    const r = parseExpertChatReply('先这样 {"name":"甲"} 然后 {"name":"乙"}')
    expect(r.draft.name).toBe('乙')
    expect(r.text).toBe('先这样 {"name":"甲"} 然后')
  })

  it('returns the whole reply as text when no JSON is present', () => {
    const r = parseExpertChatReply('你想让这个专家主要处理什么类型的任务？')
    expect(r.draft).toEqual({})
    expect(r.text).toBe('你想让这个专家主要处理什么类型的任务？')
  })

  it('does not treat a JSON array or malformed JSON as a patch', () => {
    expect(parseExpertChatReply('```json\n[1,2,3]\n```').draft).toEqual({})
    expect(parseExpertChatReply('```json\n{ "name": }\n```').text).toBe('```json\n{ "name": }\n```')
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

  it('does not offer the capability fields to the assistant', () => {
    // 可用能力要精确命中目录里的名字，交给表单多选；模型不该在对话里编造。
    expect(buildExpertChatSystemPrompt('zh')).not.toContain('skillNames')
    expect(buildExpertChatSystemPrompt('en')).not.toContain('mcpServerIds')
  })

  it('switches language with the locale but keeps the English key names', () => {
    const en = buildExpertChatSystemPrompt('en')
    expect(en).toContain('expert-config assistant')
    expect(en).toContain('basePrompt')
  })
})

describe('buildExpertChatTurnText', () => {
  it('carries the live form and the user message', () => {
    const text = buildExpertChatTurnText(
      { name: '写作专家', basePrompt: '资深写作顾问' },
      '帮我把它改成面向技术的写作专家',
      'zh'
    )
    expect(text).toContain('写作专家')
    expect(text).toContain('资深写作顾问')
    expect(text).toContain('帮我把它改成面向技术的写作专家')
  })
})

// ── small helpers ──

describe('pickDraftFields', () => {
  it('copies only non-empty string fields', () => {
    expect(pickDraftFields({ name: '甲', description: '', basePrompt: '人设' })).toEqual({
      name: '甲',
      basePrompt: '人设',
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
