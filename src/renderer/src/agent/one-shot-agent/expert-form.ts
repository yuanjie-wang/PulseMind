// ── Expert form chat (能力中心 → 专家 → 编辑模式对话区) ──
// Pure logic behind the conversational form filler: build the assistant's
// prompt from the current form + the chat history, and turn the assistant's
// reply back into a form patch. No DOM and no IPC — ExpertFormAgent wires it
// to the LLM and the panel stays a thin view over both.

import type { ExpertProfile } from '../../../../shared/types/expert'

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

/** The subset of ExpertProfile the assistant can propose values for.
 *  可用能力（技能名 / 连接器 id）不在可对话填充的字段里：它们要求精确命中目录
 *  里的名字，交给表单里的多选更可靠。 */
export type ExpertFormDraft = Partial<Pick<ExpertProfile, ExpertChatField>>

export interface ExpertChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ExpertChatParseResult {
  /** Assistant prose with the JSON patch block stripped — what the bubble shows. */
  text: string
  /** Fields to merge into the form. Empty when the reply carried no usable patch. */
  draft: ExpertFormDraft
}

const FIELD_LABELS_ZH: Record<string, string> = {
  name: '专家名称（简短，如「代码审查专家」）',
  description: '一句话简介（不超过 80 字，展示在专家卡片与召唤列表）',
  basePrompt: '角色人设——专家是谁、以什么身份工作',
  methodology: '领域方法论——工作范式与流程',
  outputSpec: '输出规范——交付物的结构与格式要求',
  constraints: '边界约束——不可越过的行为边界',
}

const FIELD_EN: Record<string, string> = {
  name: 'expert name (short, e.g. "Code Review Expert")',
  description: 'one-line summary (max 80 chars, shown on the card and in the summon list)',
  basePrompt: 'role persona — who this expert is and the identity it works under',
  methodology: 'domain methodology — ways of working and workflow',
  outputSpec: 'output specification — structure and format of deliverables',
  constraints: 'constraints — behavioral boundaries that must not be crossed',
}

/** The assistant's standing instructions. Locale-aware because the reply is
 *  read by the user as-is; the JSON keys stay English either way. */
export function buildExpertChatSystemPrompt(locale: string): string {
  const zh = locale !== 'en'
  const fieldLines = EXPERT_CHAT_FIELDS.map((f) =>
    zh ? `- ${f}：${FIELD_LABELS_ZH[f]}` : `- ${f}: ${FIELD_EN[f]}`
  ).join('\n')

  if (!zh) {
    return `You are PulseMind's expert-config assistant. You help the user turn an idea into a structured expert profile by conversation, and you keep the form beside this chat in sync.

An expert profile has these fields:
${fieldLines}

Rules:
1. Understand the intent first. When key information is missing, ask at most two short questions instead of inventing content.
2. Answer in one to three sentences: what you filled in, or what you still need.
3. End every reply with a \`\`\`json code block containing ONLY the fields you are adding or changing this turn — not the whole form, and never a field you are leaving alone.
4. Use the exact English key names above, and never add keys that are not in the list. Availability (skills / connectors) and the knowledge base are configured in the form, not by you.`
  }

  return `你是 PulseMind 的「专家配置助手」。你通过对话帮用户把想法变成一份结构化的专家配置，并同步更新旁边的表单。

专家配置包含以下字段：
${fieldLines}

规则：
1. 先理解意图；关键信息不足时最多问两个简短问题，不要凭空编造。
2. 每次回复用一到三句话说明你填了什么，或还需要用户补充什么。
3. 回复末尾给出一个 \`\`\`json 代码块，里面**只包含本次要新增或修改的字段**（不要给完整表单，也不要重复未改动的字段）。
4. 字段名必须用上面的英文键名，也不要新增列表以外的键。可用能力（技能 / 连接器）与知识库由用户在表单里配置，不归你填。`
}

/** Current form values, limited to the fields the assistant can see. */
export function pickDraftFields(profile: Partial<ExpertProfile> | null): ExpertFormDraft {
  const draft: Record<string, unknown> = {}
  for (const key of EXPERT_CHAT_FIELDS) {
    const value = profile?.[key]
    if (typeof value === 'string' && value) draft[key] = value
  }
  return draft as ExpertFormDraft
}

/** One user turn: the live form snapshot (so manual edits are visible to the
 *  model too) and the user's message. */
export function buildExpertChatTurnText(current: ExpertFormDraft, message: string, locale: string): string {
  const zh = locale !== 'en'
  return [
    zh ? '【当前表单】' : '[Current form]',
    JSON.stringify(current, null, 2),
    '',
    zh ? `【用户】${message}` : `[User] ${message}`,
  ].join('\n')
}

/** Extract the last fenced block (```json … ```) or, failing that, the last
 *  balanced {...} object in the text. Returns null when there is none. */
function extractJsonBlock(text: string): { json: string; raw: string } | null {
  const fence = /```(?:json|JSON)?\s*\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  let found: { json: string; raw: string } | null = null
  while ((match = fence.exec(text)) !== null) {
    found = { json: match[1], raw: match[0] }
  }
  if (found) return found

  // No fence: take the last balanced brace object that parses.
  for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    let depth = 0
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) {
          const candidate = text.slice(start, i + 1)
          if (isParsableObject(candidate)) return { json: candidate, raw: candidate }
          break
        }
      }
    }
  }
  return null
}

function isParsableObject(candidate: string): boolean {
  try {
    const parsed = JSON.parse(candidate)
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

/** Turn an assistant reply into a form patch + the prose to display. */
export function parseExpertChatReply(reply: string): ExpertChatParseResult {
  const block = extractJsonBlock(reply)
  if (!block) return { text: reply.trim(), draft: {} }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(block.json)
  } catch {
    return { text: reply.trim(), draft: {} }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { text: reply.trim(), draft: {} }
  }

  const draft: Record<string, unknown> = {}
  for (const key of EXPERT_CHAT_FIELDS) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim()) draft[key] = value.trim()
  }

  // The JSON block is machine payload, not chat: strip it from the bubble text.
  const text = reply.replace(block.raw, '').trim()
  return { text, draft: draft as ExpertFormDraft }
}

/** Whether a parsed draft actually changes anything in the form. */
export function isDraftEmpty(draft: ExpertFormDraft): boolean {
  return Object.keys(draft).length === 0
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
