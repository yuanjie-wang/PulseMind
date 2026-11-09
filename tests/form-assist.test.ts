import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  FORM_PATCH_FENCE,
  buildFormAnnotation,
  buildFormAssistSystemPrompt,
  formAssistConversationId,
  parseFormPatch,
  planAutoApply,
  stripFormAnnotation,
  stripProposalFences,
  stripStreamingFences,
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
    // 2026-09-20 裁定：结论直接填入，不需要确认步骤——合同句要说清这一点。
    expect(prompt).toContain('直接填入表单')
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
    expect(stripProposalFences(text, [], '（已生成表单内容）')).toBe('（已生成表单内容）')
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

// ── 自动填入 trigger (user ruling 2026-09-20: no draft mode — the patch
// lands in the form directly, with an undo). planAutoApply is the fire-once
// ledger behind it; the real-browser behaviors live in probe-form-assist.mjs.

describe('planAutoApply', () => {
  const REPLY = '帮你填。\n```form-patch\n{"word":"新"}\n```'

  it('records hydrated history WITHOUT firing (no replay into the form)', () => {
    // A freshly mounted / rehydrated conversation must not pour its old
    // conclusions back over a form that was just loaded from the entity.
    const d = planAutoApply(null, 'demo_assist_e1', 'a1', REPLY, SPEC)
    expect(d.patch).toBeNull()
    expect(d.record).toEqual({ convId: 'demo_assist_e1', messageId: 'a1', text: REPLY })
  })

  it('records a conversation switch without firing', () => {
    const prev = { convId: 'demo_assist_e1', messageId: 'a1', text: REPLY }
    const d = planAutoApply(prev, 'demo_assist_e2', 'a1', REPLY, SPEC)
    expect(d.patch).toBeNull()
    expect(d.record?.convId).toBe('demo_assist_e2')
  })

  it('fires once for a NEW message; the same message+text never re-fires', () => {
    const first = planAutoApply({ convId: 'demo_assist_e1', messageId: 'a1', text: '旧回复' }, 'demo_assist_e1', 'a2', REPLY, SPEC)
    expect(first.patch).toEqual({ word: '新' })
    // A later message_stats / messages_update re-runs the decision with the
    // same inputs — the ledger answers "already handed over".
    const again = planAutoApply(first.record!, 'demo_assist_e1', 'a2', REPLY, SPEC)
    expect(again.patch).toBeNull()
    expect(again.record).toBe(first.record)
  })

  it('a same-message TEXT GROWTH re-decides (partial append → completed fence)', () => {
    const prev = { convId: 'c', messageId: 'a1', text: '帮你填。\n```form-patch\n{"word":"新' }
    const d = planAutoApply(prev, 'c', 'a1', REPLY, SPEC)
    expect(d.patch).toEqual({ word: '新' })
  })

  it('a plain prose reply still advances the ledger (stops re-parsing)', () => {
    const d = planAutoApply({ convId: 'c', messageId: 'a1', text: REPLY }, 'c', 'a2', '只是说明，没有补丁。', SPEC)
    expect(d.patch).toBeNull()
    expect(d.record).toEqual({ convId: 'c', messageId: 'a2', text: '只是说明，没有补丁。' })
  })

  it('the empty-bubble window (no assistant message yet) is inert and keeps the ledger', () => {
    // Between the optimistic user bubble and the engine's reply the list
    // carries no assistant message; this must not clear the record (which
    // would make the arriving reply look like a fresh mount... it would not,
    // but it must not re-fire either) and must not fire.
    const prev = { convId: 'c', messageId: 'a1', text: REPLY }
    const d = planAutoApply(prev, 'c', null, '', SPEC)
    expect(d.patch).toBeNull()
    expect(d.record).toBe(prev)
  })
})

// ── Host wiring (vitest here is node-env: the React hosts cannot mount, so
// the load-bearing ordering is pinned as source, the pending-approval /
// teardown-lifecycle pattern).

const ROOT = join(import.meta.dirname, '..', 'src', 'renderer', 'src')
const readSrc = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')

describe('auto-apply wiring (source scans)', () => {
  it('the hook drives the trigger through planAutoApply and only fires on a decision patch', () => {
    const hook = readSrc('components', 'form-assist', 'useFormAssistSession.ts')
    expect(hook).toContain('planAutoApply(')
    expect(hook).toContain('if (decision.patch) {')
    expect(hook).toContain('onPatch(decision.patch)')
    // The undo bar's data source and its manual clear exist.
    expect(hook).toContain('clearAppliedPatch')
    expect(hook).not.toContain('proposedPatch')
  })

  it('the routine host captures the PRE-patch frame BEFORE writing the patch', () => {
    const page = readSrc('components', 'routine', 'TaskWizardPage.tsx')
    const push = page.indexOf('setUndoStack')
    const apply = page.indexOf('applyAssistantPatch(patch, draft)')
    expect(push).toBeGreaterThan(-1)
    expect(apply).toBeGreaterThan(push)
    // The frame carries the dirty flag too — 撤销 restores the 未保存 marker's honesty.
    // 帧带 kind 标签（2026-11-08）：撤销栈由 routine/workflow 两臂共用，标签是
    // 复原时选对 setter 的唯一依据。
    expect(page).toContain("{ kind: 'routine', draft, dirty }")
    expect(page).toContain("{ kind: 'workflow', def, dirty }")
  })

  it('the expert host captures all six fields (empties included) BEFORE writing the patch', () => {
    const editor = readSrc('components', 'settings', 'expert', 'ExpertEditor.tsx')
    const push = editor.indexOf('setUndoStack')
    const apply = editor.indexOf('form.setFieldsValue(patch)')
    expect(push).toBeGreaterThan(-1)
    expect(apply).toBeGreaterThan(push)
    expect(editor).toContain('captureExpertFormValues(form.getFieldsValue())')
  })

  it('both forms render the undo bar; the review card is gone everywhere', () => {
    expect(readSrc('components', 'routine', 'RoutineForm.tsx')).toContain('AppliedPatchBar')
    expect(readSrc('components', 'settings', 'expert', 'ExpertEditor.tsx')).toContain('AppliedPatchBar')
    expect(existsSync(join(ROOT, 'components', 'form-assist', 'ProposalReviewCard.tsx'))).toBe(false)
  })

  it('captureExpertFormValues keeps empty fields (the undo of a fill-into-blank must blank it back)', () => {
    const assist = readSrc('components', 'settings', 'expert', 'expert-assist.ts')
    expect(assist).toContain('empties included')
    expect(assist).toContain('draft[key] = typeof values?.[key]')
  })
})
