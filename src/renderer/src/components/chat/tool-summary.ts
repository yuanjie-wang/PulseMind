/**
 * The one-line description of a tool call, in two halves: the human label
 * (`toolDisplayName`) and the detail (`toolDetailSummary`). The tool block's
 * collapsed header and each row of the approval area (`ApprovalArea`) paint the
 * label in bold and the detail beside it, so what a user approves is word-for-word
 * what the header said — the same two strings from one place, not two that drift.
 * `toolBlockSummary` joins the halves (`label · detail`) for surfaces with no
 * bold label slot of their own — the execution segment's collapsed narration.
 *
 * PLAN-tool-ux T1 (裁定 D1=C): the label is human ("运行命令"), the OBJECT stays
 * verbatim (paths, commands, queries — never translated or paraphrased, the
 * approval red line); exec's object remains the raw command including the
 * 80-char truncation, so `probe-chat-approval`'s "the row carries the command
 * text" assertion keeps holding without modification.
 */
import type { ToolUseBlock } from '../../types/agent'
import { lookupToolDescription } from './tool-descriptions'

/** Minimal shape of the i18n translator — keeps this module importable from
 *  tests and mirrors without pulling the i18n runtime in. */
export type ToolTranslator = (key: string) => string

/** Every known tool → its i18n label key under `toolLabel.*`. Tools absent
 *  from the map (new built-ins, MCP, user tools) fall to the schema
 *  description's first sentence, then to the raw name. */
const LABEL_KEYS: ReadonlySet<string> = new Set([
  'read', 'write', 'edit', 'list_dir', 'search', 'find', 'exec', 'install', 'webfetch',
  'recall', 'memory_save', 'tool_result_search',
  'pick_skill', 'pick_tool', 'experience_read', 'experience_save',
  'exec_logs', 'exec_list', 'exec_kill',
  'spawn_agent', 'create_plan', 'advance_plan', 'todo_write', 'office_edit', 'office_read', 'office_search',
  'office_export',
  'export_document', // retired name (→ office_export, 2026-11-08) — stays for hydrated transcripts' old cards
  // Retired office tool names (merged into office_edit, 2026-10-04) — they
  // stay so hydrated transcripts' old cards keep their human labels.
  'docx_edit', 'xlsx_edit', 'pptx_edit',
  'git_status', 'git_diff', 'git_log', 'git_commit', 'git_restore',
  'page_get_content', 'page_scroll', 'page_wait', 'page_click', 'page_input', 'page_select', 'page_back', 'page_execute_js',
  'browser', 'ask_user',
])

/** The human verb for one tool call, by the fallback chain: i18n label →
 *  schema description's first sentence → raw name. Unknown tools (MCP / user
 *  tools) resolve through the description registry fed by collectEnabledTools. */
export function toolDisplayName(name: string, t?: ToolTranslator): string {
  if (LABEL_KEYS.has(name)) {
    const key = `toolLabel.${name}`
    const label = t?.(key)
    // A translator that returns the key itself means the locale has no entry
    // (or no translator at all) — fall through rather than printing the key.
    if (label && label !== key) return label
  }
  const description = lookupToolDescription(name)
  if (description) {
    const firstSentence = description.split(/[.\n。;；]/, 1)[0]?.trim()
    if (firstSentence) return firstSentence.length > 40 ? firstSentence.slice(0, 37) + '...' : firstSentence
  }
  return name
}

function firstLine(value: unknown, cap = 80): string {
  const text = String(value ?? '').split('\n', 1)[0]?.trim() ?? ''
  return text.length > cap ? text.slice(0, cap) : text
}

/** The object half, verbatim by family (paths / commands / queries).
 *  Exported for the expanded card's 对象行 (T3: replaces the JSON dump). */
export function toolObjectSummary(block: ToolUseBlock): string {
  const input = block.input
  if (!input) return ''
  switch (block.name) {
    case 'exec': return ((input.command as string) || '').slice(0, 80)
    // docx_edit/xlsx_edit/pptx_edit: retired names still riding persisted
    // transcripts — the object row keeps resolving for hydrated history.
    case 'read':
    case 'edit':
    case 'office_edit':
    case 'office_read':
    case 'office_search':
    case 'docx_edit':
    case 'xlsx_edit':
    case 'pptx_edit':
      return (input.file_path as string) || ''
    case 'write':
      return `${input.file_path || ''} (${((input.content as string) || '').length > 0 ? `${((input.content as string).length / 1024).toFixed(1)} KB` : '0 KB'})`
    case 'office_export':
    case 'export_document': {
      const target = (input.file_path as string) || ''
      const fmt = `${input.format || ''}`
      return target ? `${fmt} · ${target}` : fmt
    }
    case 'list_dir': return (input.dir_path as string) || ''
    case 'search':
    case 'find':
    case 'recall':
    case 'tool_result_search':
      return firstLine((input.query as string) || (input.pattern as string) || '', 60)
    case 'webfetch': {
      try { return new URL(input.url as string).host } catch { return (input.url as string) || '' }
    }
    case 'git_commit': return firstLine(input.message, 60)
    case 'create_plan': return firstLine(input.objective, 60)
    case 'todo_write': {
      const items = Array.isArray(input.items) ? input.items : []
      return firstLine(input.objective, 40) || `${items.length} 项`
    }
    case 'ask_user': return ((input.prompt as string) || '').slice(0, 80)
    default: return ''
  }
}

/** Header title for the sub-agent session view a spawn card opens. Not
 *  `toolBlockSummary` — that string is the collapsed header the user just
 *  clicked, and a spawn falls to the unknown-family fallback (`subAgentId=…`),
 *  which is not what a header over a whole transcript should say. Here it is the
 *  expert when one was named, plus the task's first line. */
export function subAgentSessionTitle(block: ToolUseBlock, fallback = '子代理会话'): string {
  const expert = typeof block.input?.subAgentId === 'string' ? block.input.subAgentId.trim() : ''
  const task = firstLine(block.input?.task, 60)
  if (expert && task) return `${expert} · ${task}`
  return expert || task || fallback
}

/** The half after the label: the object when the family has one, else the
 *  unknown family's (MCP / user tools, spawn_agent, git_status, …) historical
 *  `k=v` of the first input entry, description excluded — it is the model's
 *  own intent, shown on the expanded card, not the object. Empty when the call
 *  carries nothing to show. This is what a header that already paints the
 *  label in bold renders beside it — `toolBlockSummary` there repeated the
 *  label (「运行命令  运行命令 · npm test」, user 2026-10-28). */
export function toolDetailSummary(block: ToolUseBlock): string {
  const object = toolObjectSummary(block)
  if (object) return object
  const input = block.input
  if (!input) return ''
  const entries = Object.entries(input).filter(([k]) => k !== 'description')
  if (entries.length === 0) return ''
  const [k, v] = entries[0]
  const val = typeof v === 'string' ? (v.length > 40 ? v.slice(0, 37) + '...' : v) : JSON.stringify(v).slice(0, 40)
  return `${k}=${val}`
}

export function toolBlockSummary(block: ToolUseBlock, t?: ToolTranslator): string {
  const label = toolDisplayName(block.name, t)
  const detail = toolDetailSummary(block)
  return detail ? `${label} · ${detail}` : label
}
