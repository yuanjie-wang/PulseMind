/** Display formatting shared by the panel transcript — the panel's copies of
 *  three helpers the desktop chat keeps private inside
 *  `components/chat/MessageGroup.tsx` (`toolBlockSummary`, `formatDuration`,
 *  `formatTokenCount`).
 *
 * They are copied rather than imported on purpose: MessageGroup imports antd,
 * `@ant-design/icons` and the renderer stores, and the panel runs as a content
 * script in the page's isolated world — importing that module would pull the
 * whole widget layer (and its DOM-injecting cssinjs runtime) into every page
 * load. If the chat's wording changes, change it here too. */

import type { ToolUseBlock } from '../../renderer/src/types/agent'

/** One-line summary of a tool call, by tool name — mirrors the chat's header
 *  summary so the same call reads the same on both surfaces. */
export function toolBlockSummary(block: ToolUseBlock): string {
  const input = block.input
  if (!input) return block.name
  switch (block.name) {
    case 'exec':
      return ((input.command as string) || '').slice(0, 80)
    case 'read':
      return (input.file_path as string) || ''
    case 'write':
      return `${input.file_path || ''} (${
        ((input.content as string) || '').length > 0
          ? `${(((input.content as string) || '').length / 1024).toFixed(1)} KB`
          : '0 KB'
      })`
    case 'edit':
      return (input.file_path as string) || ''
    case 'search':
      return (input.query as string) || ''
    case 'list_dir':
      return (input.dir_path as string) || ''
    case 'ask_user':
      return ((input.prompt as string) || '').slice(0, 80)
    default: {
      const entries = Object.entries(input).filter(([k]) => k !== 'description')
      if (entries.length === 0) return block.name
      const [k, v] = entries[0]
      const val = typeof v === 'string' ? (v.length > 40 ? `${v.slice(0, 37)}...` : v) : JSON.stringify(v).slice(0, 40)
      return `${k}=${val}`
    }
  }
}

/** `950ms` / `1.4s` — the chat's duration format for the action row. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** `1,234` / `12.3k` — the chat's token format. */
export function formatTokenCount(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  return n.toLocaleString()
}

/** Thinking-block preview line: the first line (truncated) plus a line count —
 *  the chat's ThinkingBlockView heuristic, so a collapsed block reads the same. */
export function thinkingPreview(thinking: string): string {
  const lines = thinking.split('\n')
  if (lines.length > 1) return `${lines[0].slice(0, 80)}… (${lines.length} lines)`
  return thinking.slice(0, 80) + (thinking.length > 80 ? '…' : '')
}
