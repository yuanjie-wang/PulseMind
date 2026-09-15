/** The `page_*` tool family (PLAN-browser-extension §3.4): the names, which of
 *  them only look, and the whitelist an extension session runs with.
 *
 *  This lives in the shared protocol package because four very different places
 *  must agree on it and none of them can import the others:
 *    - the tool definitions (`renderer/src/tools/built-in-tools.ts`)
 *    - the approval tier + routing (`renderer/src/agent/engine/tool-tiers.ts`)
 *    - the default-enabled list (`main/storage/tool-preferences-store.ts`)
 *    - the session whitelist (`main/agent/ws-server.ts`)
 *    - the extension's own dispatcher (`extension/content/page-tools.ts`)
 *
 *  Semantics (decision D2): `page_*` operates on the tab the user is looking
 *  at — real login state, real session. It is deliberately NOT the desktop
 *  `browser` tool, which drives a separate Playwright browser. */

export const PAGE_TOOL_NAMES = [
  'page_get_content',
  'page_scroll',
  'page_wait',
  'page_click',
  'page_input',
  'page_select',
  'page_back',
  'page_execute_js',
] as const

export type PageToolName = (typeof PAGE_TOOL_NAMES)[number]

/** Tools that only look at the page. They run in parallel and are never held
 *  for approval — the same treatment the file-read tier gets. */
export const PAGE_READ_TOOL_NAMES: ReadonlySet<string> = new Set(['page_get_content', 'page_scroll', 'page_wait'])

const PAGE_TOOL_NAME_SET: ReadonlySet<string> = new Set(PAGE_TOOL_NAMES)

export function isPageTool(name: string): name is PageToolName {
  return PAGE_TOOL_NAME_SET.has(name)
}

/** What an extension-driven session may call. The desktop toolset (shell, file
 *  writes, Playwright) stays out: that conversation happens *inside a web
 *  page*, and the model must not reach past the tab it was asked about (§3.4.1).
 *  `ask_user` is in so the panel can present choices. */
export const PAGE_SESSION_ALLOWED_TOOLS: readonly string[] = [...PAGE_TOOL_NAMES, 'ask_user']
