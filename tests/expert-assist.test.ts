import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildFormAssistSystemPrompt, parseFormPatch } from '../src/renderer/src/components/form-assist/form-assist'
import {
  EXPERT_ASSIST_SPEC,
  generateExpertId,
  nextDerivedExpertId,
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

  it('accepts the id field (用户报告 2026-09-20：专家创建助手无法填写 ID 栏位)', () => {
    expect(sanitizeExpertPatch({ id: ' review-agent ', name: '审查专家' })).toEqual({ id: 'review-agent', name: '审查专家' })
    // Uniform treatment: a blank id is dropped like any other blank field.
    expect(sanitizeExpertPatch({ id: '  ' })).toBeNull()
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
    for (const key of ['name', 'id', 'description', 'basePrompt', 'methodology', 'outputSpec', 'constraints']) {
      expect(buildFormAssistSystemPrompt(EXPERT_ASSIST_SPEC, 'zh')).toContain(key)
      expect(buildFormAssistSystemPrompt(EXPERT_ASSIST_SPEC, 'en')).toContain(key)
    }
  })

  it('tells the assistant the id derives from the name and is new-expert only', () => {
    expect(buildFormAssistSystemPrompt(EXPERT_ASSIST_SPEC, 'zh')).toContain('自动推导')
    expect(buildFormAssistSystemPrompt(EXPERT_ASSIST_SPEC, 'en')).toContain('derived from its name')
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
    expect(pickDraftFields({ id: '甲-expert', name: '甲', description: '', basePrompt: '人设' })).toEqual({
      id: '甲-expert',
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

describe('nextDerivedExpertId', () => {
  it('derives from the name while the field is empty or still derived', () => {
    expect(nextDerivedExpertId('', '', 'Code Review Expert')).toBe('code-review-expert')
    // A rename re-derives as long as the field still holds the derived value.
    expect(nextDerivedExpertId('code-review', 'code-review', '翻译专家')).toBe('翻译专家')
  })

  it('leaves a hand-typed id alone (it takes over for good)', () => {
    expect(nextDerivedExpertId('my-own-id', 'code-review', 'New Name')).toBeNull()
    expect(nextDerivedExpertId('my-own-id', '', 'New Name')).toBeNull()
  })

  it('never mints an id from an empty or blank name', () => {
    expect(nextDerivedExpertId('', '', '')).toBeNull()
    expect(nextDerivedExpertId('code-review', 'code-review', '  ')).toBeNull()
  })

  it('treats a non-string current id as empty', () => {
    expect(nextDerivedExpertId(undefined, '', '翻译专家')).toBe('翻译专家')
  })
})

// ── id derive wiring (source scan) ──
// vitest here is node-env — the editor cannot be mounted — but the report
// (「专家创建助手无法填写表单中的ID栏位」) was about exactly this wiring: a
// patch lands via form.setFieldsValue, which is silent, so unless onPatch
// runs the derive rule itself the required id field stays empty even though
// the assistant filled the name. The anchors below fail if either path stops
// going through nextDerivedExpertId, or if the undo frame is captured after
// the derive (撤销 would restore the derived id, not the pre-apply one).

describe('id derive wiring (source scan)', () => {
  const editorSrc = readFileSync(
    join(process.cwd(), 'src', 'renderer', 'src', 'components', 'settings', 'expert', 'ExpertEditor.tsx'),
    'utf-8',
  )
  const fieldsSrc = readFileSync(
    join(process.cwd(), 'src', 'renderer', 'src', 'components', 'settings', 'expert', 'ExpertFormFields.tsx'),
    'utf-8',
  )

  it('onPatch derives the id after applying the patch, before the undo frame is captured', () => {
    const capture = editorSrc.indexOf('captureExpertFormValues(form.getFieldsValue())')
    const apply = editorSrc.indexOf('form.setFieldsValue(patch)')
    const derive = editorSrc.indexOf('nextDerivedExpertId(form.getFieldValue(\'id\')')
    expect(capture).toBeGreaterThan(-1)
    expect(apply).toBeGreaterThan(capture)
    expect(derive).toBeGreaterThan(apply)
    expect(editorSrc).toContain('form.setFieldsValue({ id: derived })')
  })

  it('derives only while creating — an existing expert keeps its id', () => {
    // The guard must read the live `editing` (null = new expert), not isNew-at-mount.
    expect(editorSrc).toMatch(/if \(!editing && patch\.name\)/)
  })

  it('both writers share one derived mark', () => {
    expect(fieldsSrc).toContain('derivedIdRef: React.MutableRefObject<string>')
    expect(editorSrc).toContain('derivedIdRef={derivedIdRef}')
    // Per form load: an existing expert's id is its own, a fresh form starts over.
    expect(editorSrc).toContain('derivedIdRef.current = editing ? editing.id : \'\'')
    expect(fieldsSrc).toContain('nextDerivedExpertId(form.getFieldValue(\'id\'), derivedIdRef.current, name)')
  })
})
