// ── Conversational form-filling protocol (shared) ──
// The routine editor and the expert editor host the same kind of assistant
// column: a main-process agent session (via useFormAssistSession) that helps
// fill the form beside it. The contract is textual and identical for both:
//   · every ask carries the form's live state as a trailing [当前表单] JSON
//     annotation — the system prompt itself stays byte-stable (cache
//     contract: no clock, no form values, no per-entity bytes);
//   · a reply that carries form content ends with a ```form-patch fenced JSON
//     block containing ONLY the fields it adds or changes;
//   · the parsed patch is written into the form the moment the reply lands —
//     no review card (user ruling 2026-09-20: 「不要草稿模式」) — and the form
//     exposes an undo for it.
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
 *  the form's live state (the system prompt tells it not to echo this). The
 *  marker constant is shared with stripFormAnnotation — one definition, so the
 *  wire format and the render-side strip can never drift. */
export const FORM_ANNOTATION_MARK = '\n\n[当前表单]\n'

export function buildFormAnnotation(payload: Record<string, unknown>): string {
  return `${FORM_ANNOTATION_MARK}${JSON.stringify(payload)}`
}

/** User-bubble copy with the trailing [当前表单] annotation removed (D1: the
 *  annotation still rides the wire and persists — only the RENDER drops it).
 *  Cuts from the LAST marker to the end, so a user quoting an earlier
 *  assistant mention of the marker keeps everything before their real one. */
export function stripFormAnnotation(text: string): string {
  const idx = text.lastIndexOf(FORM_ANNOTATION_MARK)
  return idx === -1 ? text : text.slice(0, idx)
}

/** System prompt pinning a hosted session to the form-assistant role. Static
 *  per (spec, locale) — the field dictionary and rules describe the domain,
 *  never a concrete form. */
export function buildFormAssistSystemPrompt(spec: FormAssistSpec<object>, locale = 'zh'): string {
  const bilingual = locale === 'en' && spec.rulesEn && spec.fields.every((f) => f.labelEn)
  if (bilingual) {
    return [
      `You are PulseMind's ${spec.domainEn} form assistant. The user describes in prose what they want; you design the content and it fills the form beside the chat directly — the user can undo, so no confirmation step is needed.`,
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
      "- The user message may end with a [当前表单] JSON block — that is the form's live state, for your reference as the base you are patching; never echo it back.",
    ].join('\n')
  }
  return [
    `你是「${spec.domain}」编辑器的表单助手。用户会用自然语言描述想要的内容，你帮他设计并把结论直接填入表单（填入后用户可以撤销，无需先征求确认）。`,
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
  const body = lastFenceBody(text, FORM_PATCH_FENCE) ?? (spec.legacyFence ? lastFenceBody(text, spec.legacyFence) : null)
  if (body == null) return null
  return spec.sanitizePatch(extractJson<Record<string, unknown>>(body))
}

/** Remove proposal fences from bubble text — the proposal already landed in
 *  the form, so raw JSON must not also paint in the transcript. `emptyPlaceholder`
 *  (D7) is returned when the whole reply was fences: a pure-proposal reply
 *  renders as a localized hint line instead of an empty bubble (the old
 *  fall-back-to-original leaked the JSON it was meant to hide). */
export function stripProposalFences(text: string, legacyFences: string[] = [], emptyPlaceholder?: string): string {
  let stripped = text
  for (const fence of [FORM_PATCH_FENCE, ...legacyFences]) {
    stripped = stripped.replace(new RegExp('```' + fence + '[ \\t]*\\r?\\n?[\\s\\S]*?```', 'g'), '')
  }
  const cleaned = stripped.replace(/\n{3,}/g, '\n\n').trim()
  return cleaned || emptyPlaceholder || text
}

/** Streaming-cut counterpart of stripProposalFences (D2). While the reply is
 *  still streaming, a fence is BY CONSTRUCTION incomplete — the complete-fence
 *  regex above never matches — so the raw JSON would run bare in the bubble.
 *  Cut from the earliest fence-start marker to the end instead. (The earliest,
 *  not the last: with both a legacy and a form-patch marker present, cutting
 *  at the last would leave the first one's JSON on screen.) */
export function stripStreamingFences(text: string, legacyFences: string[] = []): string {
  let cut = -1
  for (const fence of [FORM_PATCH_FENCE, ...legacyFences]) {
    const idx = text.lastIndexOf('```' + fence)
    if (idx !== -1 && (cut === -1 || idx < cut)) cut = idx
  }
  return cut === -1 ? text : text.slice(0, cut).trimEnd()
}

/** What the latest assistant reply's patch landed as (user ruling 2026-09-20:
 *  「不要草稿模式，生成结论后直接填入表单，给撤销按钮」 — there is no review
 *  card; the host writes every parsed patch straight into the form and exposes
 *  an undo). The record is the fire-once bookkeeping: which assistant message,
 *  under which conversation, with which raw text, has already been handed to
 *  the host. Kept in the hook's state, reset per conversation. */
export interface AutoApplyRecord {
  convId: string
  /** null when the conversation carried no assistant message at all. */
  messageId: string | null
  /** The RAW text (fences intact) the decision was made from — a later
   *  message_stats / messages_update on the same message must not re-fire. */
  text: string
}

export interface AutoApplyDecision<P extends object> {
  /** Non-null = hand it to the host's apply now (exactly once per change). */
  patch: P | null
  record: AutoApplyRecord | null
}

/** Decide whether the latest assistant message's patch should fill the form
 *  now. Pure so the trigger is unit-testable; the hook calls it whenever the
 *  message list changes and applies the returned decision. Rules, each
 *  load-bearing:
 *  - A conversation freshly mounted or switched to (record null, or convId
 *    changed) RECORDS WITHOUT FIRING — hydrated history must not re-land in
 *    the form: the form was just (re)loaded from the entity, and the
 *    assistant's older conclusions predate it. Record the message, wait for
 *    the next genuinely new reply.
 *  - Same message id AND same raw text = already handled, no re-fire — this is
 *    what keeps a late message_stats/messages_update on the same message from
 *    re-applying. Text in the record is also why a message whose text GROWS
 *    re-decides: partial-append → completed fence fires when it completes.
 *  - A message with no usable patch still updates the record, so a plain
 *    prose reply stops being re-parsed on every later render. */
export function planAutoApply<P extends object>(
  prev: AutoApplyRecord | null,
  convId: string,
  messageId: string | null,
  rawText: string,
  spec: FormAssistSpec<P>,
): AutoApplyDecision<P> {
  if (!prev || prev.convId !== convId) {
    return { patch: null, record: { convId, messageId, text: rawText } }
  }
  if (messageId === null || (messageId === prev.messageId && rawText === prev.text)) {
    return { patch: null, record: prev }
  }
  return { patch: parseFormPatch(rawText, spec), record: { convId, messageId, text: rawText } }
}
