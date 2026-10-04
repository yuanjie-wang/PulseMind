/**
 * The one-line description of a tool call. It is the tool block's collapsed
 * header and each row of the approval area (`ApprovalArea`), so what a user approves
 * is word-for-word what the header said — the same string from one place, not two
 * that drift.
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
  'memory_search', 'memory_save', 'conversation_search', 'tool_result_search',
  'pick_skill', 'pick_tool', 'knowledge_search', 'knowledge_read', 'experience_read', 'experience_save',
  'spawn_agent', 'create_plan', 'advance_plan', 'office_edit', 'office_read', 'export_document',
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
    case 'docx_edit':
    case 'xlsx_edit':
    case 'pptx_edit':
      return (input.file_path as string) || ''
    case 'write':
      return `${input.file_path || ''} (${((input.content as string) || '').length > 0 ? `${((input.content as string).length / 1024).toFixed(1)} KB` : '0 KB'})`
    case 'export_document': {
      const target = (input.file_path as string) || ''
      const deckSlides = (input.deck as { slides?: unknown[] } | undefined)?.slides
      const fmt = `${input.format || ''}${Array.isArray(deckSlides) && deckSlides.length > 0 ? `(${deckSlides.length}页)` : ''}`
      return target ? `${fmt} · ${target}` : fmt
    }
    case 'list_dir': return (input.dir_path as string) || ''
    case 'search':
    case 'find':
    case 'memory_search':
    case 'conversation_search':
    case 'tool_result_search':
    case 'knowledge_search':
      return firstLine((input.query as string) || (input.pattern as string) || '', 60)
    case 'webfetch': {
      try { return new URL(input.url as string).host } catch { return (input.url as string) || '' }
    }
    case 'git_commit': return firstLine(input.message, 60)
    case 'create_plan': return firstLine(input.objective, 60)
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

export function toolBlockSummary(block: ToolUseBlock, t?: ToolTranslator): string {
  const label = toolDisplayName(block.name, t)
  const object = toolObjectSummary(block)
  if (!object) {
    // Unknown family (MCP / user tools, spawn_agent, git_status, …): the
    // historical `k=v` of the first input entry, description excluded — it is
    // the model's own intent, shown on the expanded card, not the object.
    const input = block.input
    if (!input) return label
    const entries = Object.entries(input).filter(([k]) => k !== 'description')
    if (entries.length === 0) return label
    const [k, v] = entries[0]
    const val = typeof v === 'string' ? (v.length > 40 ? v.slice(0, 37) + '...' : v) : JSON.stringify(v).slice(0, 40)
    return `${label} · ${k}=${val}`
  }
  return `${label} · ${object}`
}
