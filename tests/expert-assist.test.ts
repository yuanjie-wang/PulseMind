import { describe, expect, it } from 'vitest'
import { buildFormAssistSystemPrompt, parseFormPatch } from '../src/renderer/src/components/form-assist/form-assist'
import {
  EXPERT_ASSIST_SPEC,
  generateExpertId,
  pickDraftFields,
  sanitizeExpertPatch,
} from '../src/renderer/src/components/settings/expert/expert-assist'

// ── sanitizeExpertPatch ──

describe('sanitizeExpertPatch', () => {
  it('keeps only whitelist fields as trimmed non-empty strings', () => {
    expect(sanitizeExpertPatch({ name: '  ', bogus: 1, basePrompt: 12, description: ' 一句话 ' })).toEqual({
      description: '一句话',
    })
  })

  it('ignores capability keys the assistant is not allowed to fill', () => {
    // 可用能力要精确命中目录里的名字，交给表单多选；模型不该在对话里编造。
    expect(sanitizeExpertPatch({ name: '甲', skillNames: ['code-review'], mcpServerIds: ['x'] })).toEqual({ name: '甲' })
  })

  it('is null when nothing usable survives', () => {
    expect(sanitizeExpertPatch({})).toBeNull()
    expect(sanitizeExpertPatch(null)).toBeNull()
    expect(sanitizeExpertPatch([1, 2, 3])).toBeNull()
    expect(sanitizeExpertPatch({ name: 42 })).toBeNull()
  })
})

// ── parseFormPatch with the expert spec ──

describe('parseFormPatch with EXPERT_ASSIST_SPEC', () => {
  it('parses the form-patch fence into the changed fields only', () => {
    const reply = [
      '我把人设和方法论填好了，还需要你确认输出格式。',
      '',
      '```form-patch',
      '{ "basePrompt": "资深代码审查工程师", "methodology": "先正确性后风格" }',
      '```',
    ].join('\n')
    expect(parseFormPatch(reply, EXPERT_ASSIST_SPEC)).toEqual({
      basePrompt: '资深代码审查工程师',
      methodology: '先正确性后风格',
    })
  })

  it('rescues a patch embedded in prose inside the fence', () => {
    const reply = '```form-patch\n好的，补丁如下：{"name":"翻译专家"}\n```'
    expect(parseFormPatch(reply, EXPERT_ASSIST_SPEC)).toEqual({ name: '翻译专家' })
  })

  it('is null when the reply is a plain question (no patch)', () => {
    expect(parseFormPatch('你想让这个专家主要处理什么类型的任务？', EXPERT_ASSIST_SPEC)).toBeNull()
  })

  it('is null for malformed or non-object bodies', () => {
    expect(parseFormPatch('```form-patch\n{ "name": }\n```', EXPERT_ASSIST_SPEC)).toBeNull()
    expect(parseFormPatch('```form-patch\n[1,2,3]\n```', EXPERT_ASSIST_SPEC)).toBeNull()
  })
})

// ── prompt building ──

describe('buildFormAssistSystemPrompt(EXPERT_ASSIST_SPEC)', () => {
  it('lists every fillable field in both locales', () => {
    for (const key of ['name', 'description', 'basePrompt', 'methodology', 'outputSpec', 'constraints']) {
      expect(buildFormAssistSystemPrompt(EXPERT_ASSIST_SPEC, 'zh')).toContain(key)
      expect(buildFormAssistSystemPrompt(EXPERT_ASSIST_SPEC, 'en')).toContain(key)
    }
  })

  it('does not offer the capability fields to the assistant', () => {
    expect(buildFormAssistSystemPrompt(EXPERT_ASSIST_SPEC, 'zh')).not.toContain('skillNames')
    expect(buildFormAssistSystemPrompt(EXPERT_ASSIST_SPEC, 'en')).not.toContain('mcpServerIds')
  })

  it('switches language with the locale but keeps the English key names', () => {
    const en = buildFormAssistSystemPrompt(EXPERT_ASSIST_SPEC, 'en')
    expect(en).toContain('expert-config')
    expect(en).toContain('basePrompt')
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

describe('generateExpertId', () => {
  it('slugifies latin names and keeps CJK', () => {
    expect(generateExpertId('Code Review Expert')).toBe('code-review-expert')
    expect(generateExpertId('翻译专家')).toBe('翻译专家')
  })

  it('falls back to a timestamped id for symbol-only names', () => {
    expect(generateExpertId('!!!')).toMatch(/^expert-\d+$/)
  })
})
