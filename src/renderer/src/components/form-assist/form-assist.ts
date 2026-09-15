// ── Conversational form-filling protocol (shared) ──
// The routine editor and the expert editor host the same kind of assistant
// column: a main-process agent session (via useFormAssistSession) that helps
// fill the form beside it. The contract is textual and identical for both:
//   · every ask carries the form's live state as a trailing [当前表单] JSON
//     annotation — the system prompt itself stays byte-stable (cache
//     contract: no clock, no form values, no per-entity bytes);
//   · a reply that proposes form content ends with a ```form-patch fenced
//     JSON block containing ONLY the fields it adds or changes;
//   · nothing writes into the form until the user applies the proposal.
// A domain supplies a FormAssistSpec (field dictionary, 口径 rules, patch
// sanitizer, conversation prefix); this module owns the mechanics. Pure logic
// — no React, no DOM, no IPC — so tests can drive it directly.

import { extractJson } from '../../agent/one-shot-agent/json-utils'

/** The one proposal fence both editors speak. */
export const FORM_PATCH_FENCE = 'form-patch'

/** One fillable field in the system prompt's dictionary. */
export interface FormAssistField {
  key: string
  /** 中文说明行。 */
  label: string
  /** English line; when any field lacks one the prompt stays zh-only. */
  labelEn?: string
}

export interface FormAssistSpec<P extends object> {
  /** Conversation-id prefix: `<conversationPrefix>_assist_*` maps to a
   *  dedicated type in conversation.db.ts's deriveConvType, keeping the
   *  transcripts out of every 'normal'-filtered surface (sidebar list,
  *  title/message search, memory pipeline). */
  conversationPrefix: string
  /** agentSessionCreate clientId tag, e.g. 'routine-assist'. */
  clientId: string
  /** 领域名（zh），如「日常任务」「专家」。 */
  domain: string
  /** English domain noun for the en prompt, e.g. 'expert-config'. */
  domainEn: string
  /** Fields the assistant may propose, in prompt order. */
  fields: FormAssistField[]
  /** 领域口径（zh）；locale-aware specs pair them with rulesEn. */
  rules: string[]
  rulesEn?: string[]
  /** Legacy fence alias — replies persisted under the old protocol still
   *  parse into proposals (routine's ```routine-draft). */
  legacyFence?: string
  /** Validate + normalize a parsed JSON object into a patch; null = the
   *  proposal is unusable (empty, wrong-typed, or nothing survives). */
  sanitizePatch: (raw: Record<string, unknown> | null) => P | null
}

/** Stable conversation id for an entity's assistant thread. A null entityId
 *  buckets every unsaved create-new flow into one shared draft conversation
 *  (the just-had context survives the first save — callers keep binding to
 *  the draft bucket until the user switches entities). */
export function formAssistConversationId(conversationPrefix: string, entityId: string | null): string {
  return `${conversationPrefix}_assist_${entityId ?? 'draft'}`
}

/** Trailing context appended to each ask so the assistant always argues from
 *  the form's live state (the system prompt tells it not to echo this). */
export function buildFormAnnotation(payload: Record<string, unknown>): string {
  return `\n\n[当前表单]\n${JSON.stringify(payload)}`
}

/** System prompt pinning a hosted session to the form-assistant role. Static
 *  per (spec, locale) — the field dictionary and rules describe the domain,
 *  never a concrete form. */
export function buildFormAssistSystemPrompt(spec: FormAssistSpec<object>, locale = 'zh'): string {
  const bilingual = locale === 'en' && spec.rulesEn && spec.fields.every((f) => f.labelEn)
  if (bilingual) {
    return [
      `You are PulseMind's ${spec.domainEn} form assistant. The user describes in prose what they want; you design the content and fill the form beside the chat by proposing form patches.`,
      '',
      'Form fields:',
      ...spec.fields.map((f) => `- ${f.key}: ${f.labelEn}`),
      '',
      'Rules:',
      ...spec.rulesEn!.map((r) => `- ${r}`),
      '',
      'Output protocol:',
      `- When you produce (or update based on the current form) form content, end your reply with a \`\`\`${FORM_PATCH_FENCE} fenced code block containing a JSON object with ONLY the fields you are adding or changing this turn — not the whole form, and never a field you are leaving alone:`,
      '```' + FORM_PATCH_FENCE,
      '{"field": "value"}',
      '```',
      '- Emit no block when there is nothing new; keep ordinary discussion, follow-up questions and suggestions to one to three short sentences.',
      '- The user message may end with a [当前表单] JSON block — that is the form\'s live state, for your reference as the base you are patching; never echo it back.',
    ].join('\n')
  }
  return [
    `你是「${spec.domain}」编辑器的表单助手。用户会用自然语言描述想要的内容，你帮他设计并填写表单。`,
    '',
    '表单字段：',
    ...spec.fields.map((f) => `- ${f.key}：${f.label}`),
    '',
    '口径：',
    ...spec.rules.map((r) => `- ${r}`),
    '',
    '输出协议：',
    `- 当你产出了（或基于当前表单更新了）表单内容时，在回复的最末尾原样追加一个 ${FORM_PATCH_FENCE} 围栏代码块，块内是一个 JSON 对象，只包含本次要新增或修改的字段（不是完整表单，也不要重复未改动的字段）：`,
    '```' + FORM_PATCH_FENCE,
    '{"字段名": "值"}',
    '```',
    '- 没有新的表单内容就不要输出该块；普通讨论、追问、给建议都用简短的中文说明。',
    '- 用户消息末尾可能带有 [当前表单] JSON，那是表单的实时状态，供你参考增量，不要在回复里复述它。',
  ].join('\n')
}

function lastFenceBody(text: string, fence: string): string | null {
  const re = new RegExp('```' + fence + '[ \\t]*\\r?\\n?([\\s\\S]*?)```', 'g')
  let last: RegExpExecArray | null = null
  for (let m = re.exec(text); m; m = re.exec(text)) last = m
  return last ? last[1] : null
}

/** Pull the last ```form-patch proposal out of an assistant reply and run it
 *  through the spec's sanitizer. Falls back to the spec's legacy fence so
 *  replies persisted under the old protocol still propose. Returns null when
 *  the reply carries no usable patch. */
export function parseFormPatch<P extends object>(text: string, spec: FormAssistSpec<P>): P | null {
  const body = lastFenceBody(text, FORM_PATCH_FENCE)
    ?? (spec.legacyFence ? lastFenceBody(text, spec.legacyFence) : null)
  if (body == null) return null
  return spec.sanitizePatch(extractJson<Record<string, unknown>>(body))
}

/** Remove proposal fences from bubble text — the proposal surfaces in the
 *  form's review banner, not as raw JSON in the transcript. Falls back to the
 *  original text when nothing survives, so a fence-only reply never renders
 *  as an empty bubble. */
export function stripProposalFences(text: string, legacyFences: string[] = []): string {
  let stripped = text
  for (const fence of [FORM_PATCH_FENCE, ...legacyFences]) {
    stripped = stripped.replace(new RegExp('```' + fence + '[ \\t]*\\r?\\n?[\\s\\S]*?```', 'g'), '')
  }
  const cleaned = stripped.replace(/\n{3,}/g, '\n\n').trim()
  return cleaned || text
}
