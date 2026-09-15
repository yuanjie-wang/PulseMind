// ── Expert editor's form-assist spec ──
// The domain half of the shared form-assist protocol
// (components/form-assist): the identity fields the assistant may propose,
// the 口径 it must follow, and how a parsed patch is sanitized. Session
// mechanics live in useFormAssistSession; the form column in ExpertEditor.
//
// 可用能力（技能名 / 连接器 id）与知识库不在可对话填充的字段里：它们要求精确
// 命中目录里的名字，交给表单里的多选更可靠 —— 所以白名单就是下面这六个。

import type { ExpertProfile } from '../../../../../shared/types/expert'
import type { FormAssistSpec } from '../../form-assist/form-assist'

/** Identity fields the assistant may fill by conversation. Capability is not
 *  here on purpose (experts share the global toolset) and neither are the
 *  runtime knobs (bound LLM profile / token & loop caps) — those stay manual. */
export const EXPERT_CHAT_FIELDS = [
  'name',
  'description',
  'basePrompt',
  'methodology',
  'outputSpec',
  'constraints',
] as const

export type ExpertChatField = (typeof EXPERT_CHAT_FIELDS)[number]

/** The subset of ExpertProfile the assistant can propose values for. */
export type ExpertFormDraft = Partial<Pick<ExpertProfile, ExpertChatField>>

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Sanitize a parsed proposal: whitelist keys only, non-empty trimmed strings
 *  only, and a proposal with nothing usable is null. */
export function sanitizeExpertPatch(parsed: Record<string, unknown> | null): ExpertFormDraft | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const draft: Record<string, unknown> = {}
  for (const key of EXPERT_CHAT_FIELDS) {
    const value = asString(parsed[key])
    if (value) draft[key] = value
  }
  return Object.keys(draft).length > 0 ? (draft as ExpertFormDraft) : null
}

export const EXPERT_ASSIST_SPEC: FormAssistSpec<ExpertFormDraft> = {
  conversationPrefix: 'expert',
  clientId: 'expert-assist',
  domain: '专家',
  domainEn: 'expert-config',
  fields: [
    { key: 'name', label: '专家名称（简短，如「代码审查专家」）', labelEn: 'expert name (short, e.g. "Code Review Expert")' },
    { key: 'description', label: '一句话简介（不超过 80 字，展示在专家卡片与召唤列表）', labelEn: 'one-line summary (max 80 chars, shown on the card and in the summon list)' },
    { key: 'basePrompt', label: '角色人设——专家是谁、以什么身份工作', labelEn: 'role persona — who this expert is and the identity it works under' },
    { key: 'methodology', label: '领域方法论——工作范式与流程', labelEn: 'domain methodology — ways of working and workflow' },
    { key: 'outputSpec', label: '输出规范——交付物的结构与格式要求', labelEn: 'output specification — structure and format of deliverables' },
    { key: 'constraints', label: '边界约束——不可越过的行为边界', labelEn: 'constraints — behavioral boundaries that must not be crossed' },
  ],
  rules: [
    '先理解意图；关键信息不足时最多问两个简短问题，不要凭空编造。',
    '每次回复用一到三句话说明你填了什么，或还需要用户补充什么。',
    '可用能力（技能 / 连接器）与知识库由用户在表单里配置，不归你填。',
  ],
  rulesEn: [
    'Understand the intent first. When key information is missing, ask at most two short questions instead of inventing content.',
    'Answer in one to three sentences: what you filled in, or what you still need.',
    'Availability (skills / connectors) and the knowledge base are configured in the form, not by you.',
  ],
  sanitizePatch: sanitizeExpertPatch,
}

/** Current form values, limited to the fields the assistant can see — the
 *  annotation payload sent with every ask. */
export function pickDraftFields(profile: Partial<ExpertProfile> | null): ExpertFormDraft {
  const draft: Record<string, unknown> = {}
  for (const key of EXPERT_CHAT_FIELDS) {
    const value = profile?.[key]
    if (typeof value === 'string' && value) draft[key] = value
  }
  return draft as ExpertFormDraft
}

/** Derive an id from a name (kept stable on edit — only new experts use it). */
export function generateExpertId(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9一-鿿぀-ゟ゠-ヿ-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'expert-' + Date.now()
}
