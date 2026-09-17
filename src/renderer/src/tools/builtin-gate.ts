/**
 * Gate metadata for gated built-in tools (git / memory / knowledge).
 *
 * Mirrors the per-server granularity of MCP tools: each built-in category is a
 * pseudo-server (serverId `builtin:<category>`) with a compact static summary,
 * so pick_tool's intent mode treats built-ins exactly like MCP servers.
 *
 * A category needs an entry only when it can appear in pick_tool's activation
 * list — i.e. when it has gated members. `page` and `browser` have none (page's
 * availability is the extension's connection; browser is always in the tool
 * list), so their summaries are here for the category to be readable wherever
 * categories are listed.
 */

export const BUILTIN_CATEGORY_SUMMARIES: Record<string, string> = {
  git: 'Git operations: status, diff, log, commit, restore — branch/commit/merge workflows',
  memory: 'Long-term memory: search/save memories, search past conversations and tool results',
  knowledge: 'Knowledge base: search and read compiled wiki documents',
  browser: 'Real browser automation: open URLs, AI/ARIA snapshots, click/type via locators, screenshots — one JS-code tool (agent.browsers)',
  page: 'The page the user is looking at right now, in their own browser tab: read it as indexed text, scroll, click, type, select — real login state',
}

export const builtinCategoryServerId = (category: string): string => `builtin:${category}`

export const isBuiltinServerId = (serverId: string): boolean => serverId.startsWith('builtin:')
