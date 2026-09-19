import { describe, expect, it } from 'vitest'
import {
  FORM_PATCH_FENCE,
  buildFormAnnotation,
  buildFormAssistSystemPrompt,
  formAssistConversationId,
  parseFormPatch,
  stripFormAnnotation,
  stripProposalFences,
  stripStreamingFences,
} from '../src/renderer/src/components/form-assist/form-assist'
import type { FormAssistSpec } from '../src/renderer/src/components/form-assist/form-assist'
import { filterRoutinePatch, summarizeRoutinePatch } from '../src/renderer/src/components/routine/routine-assist'
import { filterExpertPatch, summarizeExpertPatch } from '../src/renderer/src/components/settings/expert/expert-assist'
import { EMPTY_DRAFT } from '../src/renderer/src/components/routine/routine-form-model'
import type { RoutineDraftState } from '../src/renderer/src/components/routine/routine-form-model'

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
    const reply = ['第一版：', '```form-patch\n{"word":"旧"}\n```', '再改：', '```form-patch\n{"word":"新"}\n```'].join('\n')
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
    const reply = ['```old-draft\n{"word":"旧"}\n```', '改成：', '```form-patch\n{"word":"新"}\n```'].join('\n')
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

  it('fence-only reply → the localized placeholder, never the raw JSON (D7 翻案)', () => {
    // The old contract ("falls back to the original, never an empty bubble")
    // leaked exactly the JSON the strip exists to hide — the placeholder is
    // the replacement, and the original text must NOT resurface.
    const text = '```form-patch\n{"word":"x"}\n```'
    expect(stripProposalFences(text, [], '（已生成表单草稿）')).toBe('（已生成表单草稿）')
    expect(stripProposalFences(text, ['old-draft'], '占位')).toBe('占位')
    // 不传占位（防御路径）保持旧行为，避免其他调用点突然空泡。
    expect(stripProposalFences(text)).toBe(text)
  })

  it('prose plus fences still renders the prose (placeholder not forced)', () => {
    const text = '说明。\n```form-patch\n{"word":"x"}\n```'
    expect(stripProposalFences(text, [], '占位')).toBe('说明。')
  })
})

describe('stripFormAnnotation (D1)', () => {
  it('cuts from the last [当前表单] marker to the end', () => {
    const text = '帮我做个任务' + buildFormAnnotation({ name: 'x' })
    expect(stripFormAnnotation(text)).toBe('帮我做个任务')
  })

  it('leaves messages without the marker untouched', () => {
    expect(stripFormAnnotation('普通消息')).toBe('普通消息')
  })

  it('a user quoting an earlier marker keeps everything before their own', () => {
    const quoted = '上一条里见过 [当前表单] 这个词'
    const text = quoted + buildFormAnnotation({ word: 'v' })
    expect(stripFormAnnotation(text)).toBe(quoted)
  })
})

describe('stripStreamingFences (D2)', () => {
  it('cuts from the fence-start marker while streaming (the fence is incomplete)', () => {
    const partial = '帮你填好了。\n```form-patch\n{"word":"x'
    expect(stripStreamingFences(partial)).toBe('帮你填好了。')
  })

  it('plain streaming text passes through untouched', () => {
    expect(stripStreamingFences('还在打字……')).toBe('还在打字……')
  })

  it('an opened json fence is NOT a form-patch fence and survives', () => {
    const partial = '看这个例子：\n```json\n{"a":1'
    expect(stripStreamingFences(partial)).toBe(partial)
  })

  it('legacy fence markers cut too, and the EARLIEST marker wins', () => {
    const partial = '先给旧版：\n```old-draft\n{"a":1}\n```\n再给新版：\n```form-patch\n{"b":2'
    expect(stripStreamingFences(partial, ['old-draft'])).toBe('先给旧版：')
  })
})

describe('summarizeRoutinePatch (D3)', () => {
  const current: RoutineDraftState = {
    ...EMPTY_DRAFT,
    name: '旧名称',
    prompt: '旧提示词',
    params: [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
    ],
  }

  it('rows only for keys the patch carries; before from the live draft', () => {
    const rows = summarizeRoutinePatch({ name: '新名称', prompt: '新提示词' }, current)
    expect(rows.map((r) => r.key)).toEqual(['name', 'prompt'])
    expect(rows[0]).toEqual({ key: 'name', label: '任务名称', before: '旧名称', after: '新名称' })
  })

  it('params row collapses to the 「N 个参数（keys）」 summary', () => {
    const rows = summarizeRoutinePatch(
      {
        params: [
          { key: 'x', label: '' },
          { key: 'y', label: '' },
          { key: 'z', label: '' },
        ],
      },
      current,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe('params')
    expect(rows[0].before).toBe('2 个参数（a, b）')
    expect(rows[0].after).toBe('3 个参数（x, y, z）')
    expect(summarizeRoutinePatch({ params: [] as never[] }, { ...current, params: [] }).length).toBe(0)
  })

  it('invalid cron reads as-is through describeCron (deterministic)', () => {
    const rows = summarizeRoutinePatch({ cron: 'not-a-cron' }, { ...current, scheduleEnabled: false })
    expect(rows[0].label).toBe('定时执行')
    expect(rows[0].before).toBe('手动执行')
    expect(rows[0].after).toContain('无效表达式')
  })
})

describe('filterRoutinePatch (D4)', () => {
  it('keeps only the checked keys; unchecked fields drop out entirely', () => {
    const patch = { name: '新', prompt: '新提示词', cron: '0 9 * * *' }
    expect(filterRoutinePatch(patch, ['name'])).toEqual({ name: '新' })
    expect(filterRoutinePatch(patch, ['prompt', 'cron'])).toEqual({ prompt: '新提示词', cron: '0 9 * * *' })
    expect(filterRoutinePatch(patch, [])).toEqual({})
  })
})

describe('summarizeExpertPatch / filterExpertPatch (D3/D4)', () => {
  it('rows for carried keys only, before from the live form, empty before = ""', () => {
    const rows = summarizeExpertPatch({ name: '代码审查专家', constraints: '不改代码' }, { name: '旧专家' })
    expect(rows).toEqual([
      { key: 'name', label: '名称', before: '旧专家', after: '代码审查专家' },
      { key: 'constraints', label: '边界约束', before: '', after: '不改代码' },
    ])
  })

  it('filter keeps whitelisted checked keys only', () => {
    const patch = { name: '新名', basePrompt: '人设', methodology: '方法论' }
    expect(filterExpertPatch(patch, ['basePrompt'])).toEqual({ basePrompt: '人设' })
  })
})
