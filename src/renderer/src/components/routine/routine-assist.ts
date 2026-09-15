// ── Routine assistant protocol ──
// The routine editor page's right column hosts a main-process agent session
// that helps fill the middle form. The contract is textual: every ask carries
// the current form state as a trailing [当前表单] JSON block, and the
// assistant ends any reply that proposes form content with a ```routine-draft
// fenced JSON block. The renderer parses the fence and waits for the user's
// explicit apply — nothing writes into the form without a click.

import { extractJson } from '../../agent/one-shot-agent/json-utils'
import type { RoutineParam } from '../../../../shared/types/routine'

/** What the assistant may propose — mirrors the form fields it can fill. */
export interface RoutineAssistantDraft {
  name?: string
  description?: string
  prompt?: string
  /** 5-field cron expression; '' / absent = leave the schedule untouched. */
  cron?: string
  params?: RoutineParam[]
}

/** Structural snapshot of the form carried by each ask. Kept structural so
 *  this protocol module does not import the form component. */
export interface RoutineFormSnapshot {
  name: string
  description: string
  prompt: string
  scheduleEnabled: boolean
  /** Resolved 5-field cron ('' when scheduleEnabled is false). */
  cron: string
  catchUp: 'once' | 'skip'
  enabled: boolean
  params: Array<{ key: string; label: string; required?: boolean; default?: string }>
}

/** Stable conversation id for the editor's assistant session. `routine_`
 *  prefixes derive the 'routine' conversation type (conversation.db.ts), so
 *  these transcripts never surface in the chat list or search. */
export function assistConversationId(routineId: string | null): string {
  return `routine_assist_${routineId ?? 'draft'}`
}

/** Trailing context appended to each ask so the assistant always argues from
 *  the form's live state (the system prompt tells it not to echo this). */
export function buildFormAnnotation(form: RoutineFormSnapshot): string {
  const payload = {
    name: form.name,
    description: form.description,
    prompt: form.prompt,
    cron: form.cron,
    catchUp: form.catchUp,
    enabled: form.enabled,
    params: form.params,
  }
  return `\n\n[当前表单]\n${JSON.stringify(payload)}`
}

/** System prompt pinning the hosted session to the form-assistant role. */
export function buildAssistSystemPrompt(): string {
  return [
    '你是「日常任务」编辑器的表单助手。用户会用自然语言描述一个想反复执行或定时执行的工作，你帮他设计并填写任务表单（任务名称、描述、提示词、参数、定时）。',
    '',
    '表单口径：',
    '- prompt 必须是独立可执行的指令（脱离当前对话也能运行），保留关键上下文与步骤；用 {{参数名}} 引用参数。',
    '- params 是可选的参数列表，每项为 {"key","label","required","default"}；key 用英文标识符，label 是界面显示名，default 是默认值。',
    '- cron 是 5 字段标准 crontab 表达式（本地时间），例如每天九点是 "0 9 * * *"；不需要定时就给空字符串。',
    '- name、description、prompt 默认用中文书写。',
    '',
    '输出协议：',
    '- 当你产出了（或基于当前表单更新了）完整的表单内容时，在回复的最末尾原样追加一个 routine-draft 围栏代码块，块内是一个 JSON 对象（完整表单，不是增量）：',
    '```routine-draft',
    '{"name":"...","description":"...","prompt":"...","cron":"...","params":[]}',
    '```',
    '- 没有新的表单内容就不要输出该块；普通讨论、追问、给建议都用简短的中文说明。',
    '- 用户消息末尾可能带有 [当前表单] JSON，那是表单的实时状态，供你参考增量，不要在回复里复述它。',
  ].join('\n')
}

/** Pull the last ```routine-draft fence out of an assistant reply. Returns a
 *  sanitized draft, or null when the reply has no usable block. */
export function parseRoutineDraftBlock(text: string): RoutineAssistantDraft | null {
  const fence = /```routine-draft[ \t]*\r?\n?([\s\S]*?)```/g
  let last: RegExpExecArray | null = null
  for (let m = fence.exec(text); m; m = fence.exec(text)) last = m
  if (!last) return null
  return sanitizeAssistantDraft(extractJson<Partial<RoutineAssistantDraft>>(last[1]))
}

function sanitizeAssistantDraft(parsed: Partial<RoutineAssistantDraft> | null): RoutineAssistantDraft | null {
  if (!parsed || typeof parsed !== 'object') return null
  const name = asString(parsed.name)
  const description = asString(parsed.description)
  const prompt = asString(parsed.prompt)
  const cron = asString(parsed.cron)
  const params = Array.isArray(parsed.params)
    ? parsed.params
        .filter((p) => !!p && typeof p === 'object')
        .map((p) => {
          const rec = p as unknown as Record<string, unknown>
          return {
            key: asString(rec.key),
            label: asString(rec.label),
            ...(typeof rec.required === 'boolean' ? { required: rec.required } : {}),
            ...(rec.default != null ? { default: asString(rec.default) } : {}),
          }
        })
        .filter((p) => p.key !== '')
    : []
  if (!name && !description && !prompt && !cron && params.length === 0) return null
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    ...(cron ? { cron } : {}),
    ...(params.length > 0 ? { params } : {}),
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
