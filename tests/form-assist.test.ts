import { describe, expect, it } from 'vitest'
import {
  FORM_PATCH_FENCE,
  buildFormAnnotation,
  buildFormAssistSystemPrompt,
  formAssistConversationId,
  parseFormPatch,
  stripProposalFences,
} from '../src/renderer/src/components/form-assist/form-assist'
import type { FormAssistSpec } from '../src/renderer/src/components/form-assist/form-assist'

// ── The shared form-assist protocol mechanics, driven through a minimal spec.
// Domain specs (routine / expert) have their own files.

interface StringPatch {
  word?: string
}

const SPEC: FormAssistSpec<StringPatch> = {
  conversationPrefix: 'demo',
  clientId: 'demo-assist',
  domain: '演示',
  domainEn: 'demo',
  fields: [{ key: 'word', label: '词语', labelEn: 'word' }],
  rules: ['规则甲。'],
  rulesEn: ['Rule one.'],
  sanitizePatch: (raw) => {
    if (!raw || typeof raw !== 'object') return null
    const word = typeof raw.word === 'string' ? raw.word : ''
    return word ? { word } : null
  },
}

describe('formAssistConversationId', () => {
  it('keys on the entity id and buckets unsaved drafts', () => {
    expect(formAssistConversationId('demo', 'e1')).toBe('demo_assist_e1')
    expect(formAssistConversationId('demo', null)).toBe('demo_assist_draft')
  })
})

describe('buildFormAnnotation', () => {
  it('appends the live form state as a trailing block', () => {
    const annotation = buildFormAnnotation({ word: '你好', n: 1 })
    expect(annotation.startsWith('\n\n')).toBe(true)
    expect(annotation).toContain('[当前表单]')
    expect(annotation).toContain('"word":"你好"')
  })
})

describe('buildFormAssistSystemPrompt', () => {
  it('carries the fence, field dictionary and rules — and no concrete form bytes', () => {
    const prompt = buildFormAssistSystemPrompt(SPEC)
    expect(prompt).toContain(FORM_PATCH_FENCE)
    expect(prompt).toContain('word：词语')
    expect(prompt).toContain('规则甲')
    expect(prompt).toContain('[当前表单]')
    // 缓存契约：提示词里不能出现具体表单值。
    expect(prompt).not.toContain('你好')
  })

  it('switches to English while keeping the English key names and the fence', () => {
    const prompt = buildFormAssistSystemPrompt(SPEC, 'en')
    expect(prompt).toContain('form assistant')
    expect(prompt).toContain('word: word')
    expect(prompt).toContain('Rule one')
    expect(prompt).toContain(FORM_PATCH_FENCE)
  })

  it('stays zh when the spec is not bilingual', () => {
    const zhOnly: FormAssistSpec<StringPatch> = {
      ...SPEC,
      fields: [{ key: 'word', label: '词语' }],
      rulesEn: undefined,
    }
    expect(buildFormAssistSystemPrompt(zhOnly, 'en')).toContain('词语')
    expect(buildFormAssistSystemPrompt(zhOnly, 'en')).not.toContain('form assistant')
  })
})

describe('parseFormPatch', () => {
  it('parses the last form-patch fence through the spec sanitizer', () => {
    const reply = [
      '第一版：',
      '```form-patch\n{"word":"旧"}\n```',
      '再改：',
      '```form-patch\n{"word":"新"}\n```',
    ].join('\n')
    expect(parseFormPatch(reply, SPEC)).toEqual({ word: '新' })
  })

  it('ignores ordinary json fences — only form-patch speaks the protocol', () => {
    expect(parseFormPatch('```json\n{"word":"x"}\n```', SPEC)).toBeNull()
  })

  it('returns null without a fence or with an unusable body', () => {
    expect(parseFormPatch('普通回复，没有提案。', SPEC)).toBeNull()
    expect(parseFormPatch('```form-patch\nnot json\n```', SPEC)).toBeNull()
    expect(parseFormPatch('```form-patch\n{"other":1}\n```', SPEC)).toBeNull()
  })

  it('prefers the new fence when a legacy fence also parsed', () => {
    const spec = { ...SPEC, legacyFence: 'old-draft' }
    const reply = [
      '```old-draft\n{"word":"旧"}\n```',
      '改成：',
      '```form-patch\n{"word":"新"}\n```',
    ].join('\n')
    expect(parseFormPatch(reply, spec)).toEqual({ word: '新' })
  })

  it('falls back to the legacy fence for replies persisted before the shared protocol', () => {
    const spec = { ...SPEC, legacyFence: 'old-draft' }
    expect(parseFormPatch('```old-draft\n{"word":"旧回复"}\n```', spec)).toEqual({ word: '旧回复' })
  })
})

describe('stripProposalFences', () => {
  it('strips the fence and keeps the prose', () => {
    const text = '帮你填好了。\n```form-patch\n{"word":"x"}\n```'
    expect(stripProposalFences(text)).toBe('帮你填好了。')
  })

  it('also strips legacy fences when asked', () => {
    const text = '说明。\n```old-draft\n{"word":"x"}\n```'
    expect(stripProposalFences(text, ['old-draft'])).toBe('说明。')
  })

  it('falls back to the original when nothing survives (never an empty bubble)', () => {
    const text = '```form-patch\n{"word":"x"}\n```'
    expect(stripProposalFences(text)).toBe(text)
  })
})
