/**
 * The one-line description of a tool call's input. It is the tool block's collapsed
 * header and each row of the approval area (`ApprovalArea`), so what a user approves
 * is word-for-word what the header said — the same string from one place, not two
 * that drift.
 */
import type { ToolUseBlock } from '../../types/agent'

export function toolBlockSummary(block: ToolUseBlock): string {
  const input = block.input
  if (!input) return block.name
  switch (block.name) {
    case 'exec': return (input.command as string || '').slice(0, 80)
    case 'read': return input.file_path as string || ''
    case 'write': return `${input.file_path || ''} (${((input.content as string) || '').length > 0 ? `${((input.content as string).length / 1024).toFixed(1)} KB` : '0 KB'})`
    case 'edit': return input.file_path as string || ''
    case 'search': return input.query as string || ''
    case 'list_dir': return input.dir_path as string || ''
    case 'ask_user': return (input.prompt as string || '').slice(0, 80)
    default: {
      const entries = Object.entries(input).filter(([k]) => k !== 'description')
      if (entries.length === 0) return block.name
      const [k, v] = entries[0]
      const val = typeof v === 'string' ? (v.length > 40 ? v.slice(0, 37) + '...' : v) : JSON.stringify(v).slice(0, 40)
      return `${k}=${val}`
    }
  }
}
