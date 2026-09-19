/**
 * Tool name → approval tier (PLAN-browser-extension §3.4.2.1).
 *
 * Before this file, the engine's *dispatch grouping* and its *approval tier*
 * were the same thing: `READ_TIER_TOOLS` / `WRITE_TIER_TOOLS` decided both
 * which executor a call went to and whether the ladder held it. That works
 * only while every tool belongs to one of the file/shell families — the page
 * tools belong to neither (they drive a browser tab), so classifying them by
 * the old sets would route `page_click` into the file-write path.
 *
 * `tierOfTool` answers the approval question alone. `READ_TIER_TOOLS` /
 * `WRITE_TIER_TOOLS` stay as the dispatch classification; the page family is
 * dispatched by `isPageTool` instead. The two must not be conflated again.
 */
import type { SandboxToolTier } from '../../../../shared/sandbox/policy'
import { PAGE_READ_TOOL_NAMES, isPageTool } from '../../../../shared/agent-protocol/page-tools'

/** Built-in tools that only look — the file-read family. */
export const READ_TIER_TOOLS = new Set(['read', 'list_dir', 'find', 'search', 'git_status', 'git_diff', 'git_log', 'office_inspect'])
/** Built-in tools that change the workspace on disk. */
export const WRITE_TIER_TOOLS = new Set(['write', 'edit', 'git_commit', 'git_restore', 'docx_edit', 'xlsx_edit', 'pptx_edit', 'export_document'])

/** Tier of a page tool, or null when the name is not one. `page_execute_js`
 *  runs arbitrary code in the page, so it sits on the exec rung (held from
 *  'outside-ask' up); the rest are ordinary page writes. */
export function pageToolTier(name: string): SandboxToolTier | null {
  if (!isPageTool(name)) return null
  if (PAGE_READ_TOOL_NAMES.has(name)) return 'read'
  return name === 'page_execute_js' ? 'exec' : 'write'
}

/** The approval rung a tool sits on.
 *
 *  Deliberately NOT the whole story for the desktop groups: the system/memory/
 *  knowledge tools answer 'exec' here yet are never held, because they are
 *  dispatched as trusted groups rather than through the ladder (a pre-existing
 *  exemption — `browser` is one of them, see execution-flow's heldTools). Use
 *  this for page tools, which have no such exemption, and for display. */
export function tierOfTool(name: string): SandboxToolTier {
  const page = pageToolTier(name)
  if (page) return page
  if (READ_TIER_TOOLS.has(name)) return 'read'
  if (WRITE_TIER_TOOLS.has(name)) return 'write'
  return 'exec'
}
