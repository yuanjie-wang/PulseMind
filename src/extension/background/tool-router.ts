/**
 * `tool.call` → the tab's content script (PLAN-browser-extension M2.3).
 *
 * The service worker never touches the page itself: it resolves which tab owns
 * the session, forwards the call with `chrome.tabs.sendMessage`, and turns the
 * answer into a `tool.result`. Three failure modes are settled here rather than
 * left to the service's timeout:
 *   - no tab bound to the session (closed / never bound) → immediate refusal
 *   - the tab is navigated or discarded so no content script answers
 *   - `page_execute_js` refused by the page's CSP → retried over CDP
 */
import { PAGE_TOOL_NAMES, type ToolCallParams, type ToolCallResultParams } from '../../shared/agent-protocol'
import { PAGE_TOOL_MESSAGE_TYPE, type PageToolOutcome } from '../bridge'
import { getTabForSession } from './state'
import { isCspStrict, runViaDebugger, shouldUseDebugger } from './cdp'

export interface ToolRouterDeps {
  /** Send the result back to the service. */
  sendResult: (params: ToolCallResultParams) => void
  /** Chrome tabs API, injectable for tests. */
  tabs?: Pick<typeof chrome.tabs, 'sendMessage' | 'get'>
}

const PAGE_TOOL_SET: ReadonlySet<string> = new Set(PAGE_TOOL_NAMES)

/** Resolve one `tool.call` from the desktop service. Never throws. */
export async function routeToolCall(params: ToolCallParams, deps: ToolRouterDeps): Promise<void> {
  const reply = (result: Omit<ToolCallResultParams, 'callId'>): void =>
    deps.sendResult({ callId: params.callId, ...result })

  if (!PAGE_TOOL_SET.has(params.tool)) {
    reply({ ok: false, error: `未知页面工具: ${params.tool}` })
    return
  }

  const tabId = await getTabForSession(params.sessionId).catch(() => null)
  if (tabId === null) {
    reply({ ok: false, error: '标签页已关闭或未绑定——该会话没有可操作的页面，请重新打开面板' })
    return
  }

  // A tab that already refused eval goes straight to CDP (the content script
  // cannot run the script at all), so the second call is not slower than the
  // first. The verdict is dropped on navigation — the new document may differ.
  const evalTool = params.tool === 'page_execute_js'
  const outcome =
    evalTool && shouldUseDebugger() && isCspStrict(tabId)
      ? { ok: false as const, error: 'csp', cspEvalBlocked: true }
      : await sendToTab(tabId, params, deps)

  if (outcome.ok) {
    reply({ ok: true, result: outcome.result })
    return
  }

  // A CSP that forbids eval blocks the content-script path only; CDP evaluates
  // in the page's main world and is not subject to it (Playwright's mechanism).
  if (evalTool && outcome.cspEvalBlocked && shouldUseDebugger()) {
    const fallback = await runViaDebugger(tabId, params)
    reply(fallback.ok ? { ok: true, result: fallback.result } : { ok: false, error: fallback.error })
    return
  }

  reply({ ok: false, error: outcome.error ?? '页面工具执行失败' })
}

async function sendToTab(
  tabId: number,
  params: ToolCallParams,
  deps: ToolRouterDeps,
): Promise<PageToolOutcome> {
  const tabs = deps.tabs ?? chrome.tabs
  try {
    const res = (await tabs.sendMessage(tabId, {
      type: PAGE_TOOL_MESSAGE_TYPE,
      tool: params.tool,
      args: params.args ?? {},
    })) as PageToolOutcome | undefined
    if (!res) return { ok: false, error: '页面无响应（内容脚本未注入或页面正在导航）' }
    return res
  } catch (err) {
    return {
      ok: false,
      error: `无法连接页面内容脚本：${err instanceof Error ? err.message : String(err)}（刷新页面后重试）`,
    }
  }
}
