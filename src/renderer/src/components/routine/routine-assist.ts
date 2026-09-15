// ── Routine editor's form-assist spec ──
// The domain half of the shared form-assist protocol
// (components/form-assist): which fields the assistant may propose, the 口径
// it must follow, and how a parsed patch is sanitized. Session mechanics live
// in useFormAssistSession, merging in routine-form-model.applyAssistantPatch,
// the views in RoutineForm / RoutineEditorPage.

import type { RoutineParam } from '../../../../shared/types/routine'
import type { FormAssistSpec } from '../form-assist/form-assist'

/** What the assistant may propose — mirrors the form fields it can fill. */
export interface RoutineAssistantPatch {
  name?: string
  description?: string
  prompt?: string
  /** 5-field cron expression; absent = leave the schedule untouched. */
  cron?: string
  params?: RoutineParam[]
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Sanitize a parsed proposal: only known string fields survive, params are
 *  rebuilt item-by-item (a param without a key is dropped), and a proposal
 *  with nothing usable is null. */
export function sanitizeRoutinePatch(parsed: Record<string, unknown> | null): RoutineAssistantPatch | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
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

export const ROUTINE_ASSIST_SPEC: FormAssistSpec<RoutineAssistantPatch> = {
  conversationPrefix: 'routine',
  clientId: 'routine-assist',
  domain: '日常任务',
  domainEn: 'routine',
  fields: [
    { key: 'name', label: '任务名称（简短）' },
    { key: 'description', label: '一句话描述（可选）' },
    { key: 'prompt', label: '提示词——独立可执行的指令，用 {{参数名}} 引用参数' },
    { key: 'cron', label: '定时，5 字段标准 crontab 表达式（本地时间），不需要定时就省略' },
    { key: 'params', label: '可选参数列表，每项为 {"key","label","required","default"}' },
  ],
  rules: [
    'prompt 必须是独立可执行的指令（脱离当前对话也能运行），保留关键上下文与步骤；用 {{参数名}} 引用参数。',
    'params 的 key 用英文标识符，label 是界面显示名，default 是默认值。',
    'cron 是 5 字段标准 crontab 表达式（本地时间），例如每天九点是 "0 9 * * *"。',
    'name、description、prompt 默认用中文书写。',
  ],
  // Transcripts persisted before the shared protocol still propose through
  // their old fence (a full-form draft merges field-level, so it is
  // patch-compatible).
  legacyFence: 'routine-draft',
  sanitizePatch: sanitizeRoutinePatch,
}
