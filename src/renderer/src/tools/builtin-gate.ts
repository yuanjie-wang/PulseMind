/**
 * Gate metadata for gated built-in tools (git / memory / knowledge).
 *
 * Mirrors the per-server granularity of MCP tools: each built-in category is a
 * pseudo-server (serverId `builtin:<category>`) with a compact static summary,
 * so pick_tool's intent mode treats built-ins exactly like MCP servers.
 */

export const BUILTIN_CATEGORY_SUMMARIES: Record<string, string> = {
  git: 'Git operations: status, diff, log, commit, restore — branch/commit/merge workflows',
  memory: 'Long-term memory: search/save memories, search past conversations and tool results',
  knowledge: 'Knowledge base: search and read compiled wiki documents',
}

export const builtinCategoryServerId = (category: string): string => `builtin:${category}`

export const isBuiltinServerId = (serverId: string): boolean => serverId.startsWith('builtin:')
