// ── Expert editor's form-assist spec ──
// The domain half of the shared form-assist protocol
// (components/form-assist): the identity fields the assistant may propose,
// the 口径 it must follow, and how a parsed patch is sanitized. Session
// mechanics live in useFormAssistSession; the form column in ExpertEditor.
//
// 可用能力（技能名 / 连接器 id）与知识库不在可对话填充的字段里：它们要求精确
// 命中目录里的名字，交给表单里的多选更可靠 —— 所以白名单就是下面这六个。

import type { ExpertProfile } from '../../../../../shared/types/expert'
import type { ProposalDiffRow } from '../../form-assist/form-assist'
import type { FormAssistSpec } from '../../form-assist/form-assist'

/** Identity fields the assistant may fill by conversation. Capability is not
 *  here on purpose (experts share the global toolset) and neither are the
 *  runtime knobs (bound LLM profile / token & loop caps) — those stay manual. */
export const EXPERT_CHAT_FIELDS = ['name', 'description', 'basePrompt', 'methodology', 'outputSpec', 'constraints'] as const

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
    {
      key: 'description',
      label: '一句话简介（不超过 80 字，展示在专家卡片与召唤列表）',
      labelEn: 'one-line summary (max 80 chars, shown on the card and in the summon list)',
    },
    { key: 'basePrompt', label: '角色人设——专家是谁、以什么身份工作', labelEn: 'role persona — who this expert is and the identity it works under' },
    { key: 'methodology', label: '领域方法论——工作范式与流程', labelEn: 'domain methodology — ways of working and workflow' },
    { key: 'outputSpec', label: '输出规范——交付物的结构与格式要求', labelEn: 'output specification — structure and format of deliverables' },
    { key: 'constraints', label: '边界约束——不可越过的行为边界', labelEn: 'constraints — behavioral boundaries that must not be crossed' },
  ],
  rules: [
    '先理解意图；关键信息不足时最多问两个简短问题，不要凭空编造。',
    '每次回复用一到三句话说明你填了什么，或还需要用户补充什么。',
    '可用能力（技能 / 连接器）与知识库由用户在表单里配置，不归你填。',
    '需要用户在明确的选项之间做选择时，用 ask_user 工具给出可点选的选项，不要在正文里罗列。',
  ],
  rulesEn: [
    'Understand the intent first. When key information is missing, ask at most two short questions instead of inventing content.',
    'Answer in one to three sentences: what you filled in, or what you still need.',
    'Availability (skills / connectors) and the knowledge base are configured in the form, not by you.',
    'When the user must choose between clear options, present clickable choices with the ask_user tool instead of listing options in prose.',
  ],
  sanitizePatch: sanitizeExpertPatch,
}

// ── 内部专家包（D15/D16）──
// 与 routine 侧同一制度：代码常量、不进 expertStore（构造性不可见）；白名单
// 显式给数组；协议归 spec 层、built-in 工具集归宿主 create options（D17）。

/** Built-in tools the assistant's session may use — ask_user only（钉定即隐含
 *  MCP=0：pick_tool 被滤除，MCP 工具永远无法激活）。 */
export const EXPERT_ASSIST_ALLOWED_TOOLS = ['ask_user']

export const EXPERT_ASSISTANT_PROFILE: ExpertProfile = {
  id: 'internal-expert-assistant',
  name: '专家创建助手',
  basePrompt: '你是专家设计顾问：帮用户把「我想要一个帮我做 X 的专家」变成一份结构化的专家配置——身份人设、领域方法论、输出规范与边界约束。',
  methodology: '从用户的目标反推专家画像：先问清这位专家要解决什么问题、交付什么；人设与方法论要具体到领域，不写「认真负责」这类空话；输出规范写清交付物的结构与格式；约束写死不可越过的边界。',
  outputSpec: '每次只交付要新增或修改的字段；每次回复用一到三句话说明你填了什么、或还需要用户补充什么。',
  constraints: '可用能力（技能 / 连接器）与知识库由用户在表单里配置，不归你填；信息不足先问（最多两个简短问题），不替用户拍板领域细节；用户确认之前，产出只是提案。',
  skillNames: [],
  mcpServerIds: [],
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

/** Short row labels for the review card — the spec's own labels carry prompt
 *  guidance (e.g. 「不超过 80 字」) that would bloat a diff line. */
const EXPERT_ROW_LABELS: Record<ExpertChatField, string> = {
  name: '名称',
  description: '简介',
  basePrompt: '角色人设',
  methodology: '领域方法论',
  outputSpec: '输出规范',
  constraints: '边界约束',
}

/** Field-level before→after rows (D3). `current` is re-read from the live
 *  form by the host on every render, so hand edits since the proposal show
 *  in `before` immediately. Only keys the patch actually carries become rows. */
export function summarizeExpertPatch(patch: ExpertFormDraft, current: ExpertFormDraft): ProposalDiffRow[] {
  const rows: ProposalDiffRow[] = []
  for (const key of EXPERT_CHAT_FIELDS) {
    const after = patch[key]
    if (typeof after !== 'string' || !after) continue
    const before = current[key]
    rows.push({ key, label: EXPERT_ROW_LABELS[key], before: typeof before === 'string' ? before : '', after })
  }
  return rows
}

/** Keep only the checked rows' keys (D4) — the form's setFieldsValue merge is
 *  already per-field, so a filtered patch needs zero changes downstream. */
export function filterExpertPatch(patch: ExpertFormDraft, keys: string[]): ExpertFormDraft {
  const picked = new Set(keys)
  const out: Record<string, unknown> = {}
  for (const key of EXPERT_CHAT_FIELDS) {
    const value = patch[key]
    if (picked.has(key) && typeof value === 'string' && value) out[key] = value
  }
  return out as ExpertFormDraft
}

/** Derive an id from a name (kept stable on edit — only new experts use it). */
export function generateExpertId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9一-鿿぀-ゟ゠-ヿ-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'expert-' + Date.now()
  )
}
