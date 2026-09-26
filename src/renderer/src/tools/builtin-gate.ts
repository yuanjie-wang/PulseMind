/**
 * Gate metadata for gated built-in tools (git / memory / knowledge / office-file).
 *
 * Mirrors the per-server granularity of MCP tools: each built-in category is a
 * pseudo-server (serverId `builtin:<category>`) with a compact static summary,
 * so pick_tool's intent mode treats built-ins exactly like MCP servers.
 *
 * A category needs an entry only when it can appear in pick_tool's activation
 * list — i.e. when it has gated members. `browser` has none (it is always in
 * the tool list), so its summary is here for the category to be readable
 * wherever categories are listed. The extension-only page_* family is not a
 * desktop category at all — it is not in the registry, so pick_tool can neither
 * list nor activate it.
 */

export const BUILTIN_CATEGORY_SUMMARIES: Record<string, string> = {
  git: 'Git operations: status, diff, log, commit, restore — branch/commit/merge workflows',
  memory: 'Long-term memory: search/save memories, search past conversations and tool results',
  knowledge: 'Knowledge base: search and read compiled wiki documents',
  experience: 'Past workflow experiences: read one for its lessons, save or revise one from this conversation',
  // `file` is the one MIXED category: read/write/edit/list_dir/search/find stay
  // always in the tool list; this summary describes only the gated office subset
  // that activating `builtin:file` actually surfaces.
  file: 'Office documents: inspect/edit .docx/.xlsx/.pptx in place, export deliverables (.docx/.xlsx/.csv/.pptx/.pdf)',
  browser: 'Real browser automation: open URLs, AI/ARIA snapshots, click/type via locators, screenshots — one JS-code tool (agent.browsers)',
}

export const builtinCategoryServerId = (category: string): string => `builtin:${category}`

export const isBuiltinServerId = (serverId: string): boolean => serverId.startsWith('builtin:')
