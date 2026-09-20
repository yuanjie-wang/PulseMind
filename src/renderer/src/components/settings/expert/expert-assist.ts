// ── Expert editor's form-assist spec ──
// The domain half of the shared form-assist protocol
// (components/form-assist): the identity fields the assistant may propose,
// the 口径 it must follow, and how a parsed patch is sanitized. Session
// mechanics live in useFormAssistSession; the form column in ExpertEditor.
//
// 可用能力（技能名 / 连接器 id）与知识库不在可对话填充的字段里：它们要求精确
// 命中目录里的名字，交给表单里的多选更可靠。id 在白名单里（用户报告
// 2026-09-20：「专家创建助手无法填写表单中的ID栏位」）：新建专家时必填，而
// 补丁经 setFieldsValue 写入不会触发名称输入框的 onChange，id 不会像手输那样
// 自动推导 —— 所以放行 id，并用 nextDerivedExpertId 把同一条「id 跟随名称」
// 规则接到补丁路径上。编辑已有专家时表单没有 id 栏（字段未注册，
// getFieldsValue() 也不返回它），补丁里的 id 既不上屏也进不了保存路径。

import type { ExpertProfile } from '../../../../../shared/types/expert'
import type { FormAssistSpec } from '../../form-assist/form-assist'

/** Identity fields the assistant may fill by conversation. Capability is not
 *  here on purpose (experts share the global toolset) and neither are the
 *  runtime knobs (bound LLM profile / token & loop caps) — those stay manual. */
export const EXPERT_CHAT_FIELDS = ['name', 'id', 'description', 'basePrompt', 'methodology', 'outputSpec', 'constraints'] as const

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
      key: 'id',
      label: '专家 ID——唯一标识（例如 code-review-agent），从名称推导；仅新建专家时需要',
      labelEn: 'expert id — a unique identifier (e.g. code-review-agent) derived from the name; only needed for a new expert',
    },
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
    '新建专家的 ID 会随名称自动推导并填入；只有用户明确指定了 ID 时才在补丁里给出 id 字段，编辑已有专家时不要给 id。',
    '每次回复用一到三句话说明你填了什么，或还需要用户补充什么。',
    '可用能力（技能 / 连接器）与知识库由用户在表单里配置，不归你填。',
    '需要用户在明确的选项之间做选择时，用 ask_user 工具给出可点选的选项，不要在正文里罗列。',
  ],
  rulesEn: [
    'Understand the intent first. When key information is missing, ask at most two short questions instead of inventing content.',
    "A new expert's id is derived from its name and filled in automatically; include id in a patch only when the user names one explicitly, and never when editing an existing expert.",
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
  constraints: '可用能力（技能 / 连接器）与知识库由用户在表单里配置，不归你填；信息不足先问（最多两个简短问题），不替用户拍板领域细节；你的结论会直接填入表单（用户可以撤销），所以只写用户要的内容，不要一次塞满所有字段。',
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

/** All chat-fillable fields as plain strings, empties included — the undo
 *  bar's PRE-apply snapshot. Unlike pickDraftFields it must NOT drop empty
 *  fields: a field that was blank before the assistant filled it has to go
 *  back to blank on 撤销, and setFieldsValue only touches keys it receives. */
export function captureExpertFormValues(values: Partial<ExpertProfile> | null): ExpertFormDraft {
  const draft: Record<string, unknown> = {}
  for (const key of EXPERT_CHAT_FIELDS) {
    draft[key] = typeof values?.[key] === 'string' ? values[key] : ''
  }
  return draft as ExpertFormDraft
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

/** The name→id derive rule, one implementation for its two writers: typing in
 *  the name field (ExpertFormFields' onChange) and an assistant patch that
 *  names the expert (ExpertEditor's onPatch — setFieldsValue is silent, so the
 *  input's onChange never fires for it). The id follows the name while the
 *  field still holds the value one of the two derived; a hand-typed id takes
 *  over for good. Returns the id to write, or null to leave the field alone —
 *  a blank name included, so clearing the name never mints a timestamped id. */
export function nextDerivedExpertId(currentId: unknown, lastDerivedId: string, name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return null
  const current = typeof currentId === 'string' ? currentId : ''
  if (current && current !== lastDerivedId) return null
  return generateExpertId(name)
}
