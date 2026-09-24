// ── Browser facade (L2, A-M1) ──
// The complete surface area of browser capability as an object graph the model
// drives from inside the vm kernel: agent.browsers → Browser → Tabs → Tab,
// plus the playwright locator sugar. Every method is a thin wrapper over one
// BrowserCommand — 协议即边界: the facade never touches Playwright; tests
// inject a mock execute().

import {
  assertAllowedUrl,
  type BackendDescriptor,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserTabInfo,
} from './protocol'
import { playwrightSugar, type LocatorSugar } from './playwright-sugar'
import { pmRefSelector } from './pm-refs'
import { matchTabForUrl } from './selection'
import { documentationText, getDocument, listDocuments } from './documentation'
import { AGENT_PLAYWRIGHT_HINT, PLAYWRIGHT_SURFACE_HINT, guardCallable, guardMembers } from './member-guard'

export interface FacadeImage {
  mime: string
  base64: string
}

export interface BrowserFacadeDeps {
  execute: (cmd: BrowserCommand) => Promise<BrowserCommandResult>
  /** Screenshot channel: bytes go out-of-band, never as return values. */
  emitImage: (image: FacadeImage) => void
}

export interface TabApi {
  id: string
  url: () => Promise<string>
  title: () => Promise<string>
  navigate: (url: string) => Promise<void>
  back: () => Promise<void>
  forward: () => Promise<void>
  reload: () => Promise<void>
  close: () => Promise<void>
  /** Numbered interactive elements ([N] refs) first, then the AI/ARIA tree —
   *  the default and primary observation (协议 §5.4); refs address what it saw. */
  domSnapshot: (options?: { full?: boolean }) => Promise<string>
  /** Always emits through emitImage in the same call (协议 §5.6). */
  screenshot: (options?: { fullPage?: boolean; selector?: string | LocatorSugar }) => Promise<{ emitted: true; mime: string }>
  evaluate: (expression: string) => Promise<unknown>
  /** The one selector-engine entry: (sugar|string|ref-number, op, arg?). A
   *  bare number N addresses the [N] element from the latest domSnapshot(). */
  playwright: (selector: number | string | LocatorSugar, op: string, arg?: string, options?: { timeoutMs?: number }) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
}

/** A handle from open()/tabs.new(): what it did, said out loud. Reuse is the
 *  surprising half — repeating open(url) navigates the SAME tab, so a model
 *  that reads the bare handle as "a retry" repeats a call that already landed
 *  (measured: three repeats in conv_20260917151236). */
export interface TabOpenApi extends TabApi {
  opened: 'new' | 'reused'
  note: string
}

export interface BrowserApi {
  descriptor: () => Promise<BackendDescriptor>
  /** Switch this conversation's backend (managed | app-view). One choice per task (协议 §5.1). */
  setActiveBackend: (backend: 'managed' | 'app-view') => Promise<BackendDescriptor>
  /** Preferred entry: same-site tab reuse + in-place navigation (协议 §5.3). */
  open: (url: string) => Promise<TabOpenApi>
  tabs: {
    list: () => Promise<BrowserTabInfo[]>
    get: (id: string) => Promise<TabApi>
    new: (options?: { url?: string }) => Promise<TabOpenApi>
  }
  /** Tabs visible in the app pane (app-view backend only). */
  user: {
    openTabs: () => Promise<BrowserTabInfo[]>
    claimTab: (id: string) => Promise<TabApi>
  }
  /** Files saved by page downloads in this conversation's workspace. */
  downloads: () => Promise<Array<{ name: string; path: string; size: number; savedAt: string }>>
  /** Callable readout (docs §…) that also carries `.list()` / `.get(name)` —
   *  one object, so `agent.documentation.get(...)` (the path the workflow doc
   *  promises) and the legacy `documentation()/documentationList/Get` shapes
   *  cannot drift apart. Also reachable as `agent.documentation`. */
  documentation: DocumentationApi
}

export interface DocumentationApi {
  (): Promise<string>
  /** Lookup documents (screenshots/app-view/recording/…), when available. */
  list: () => Promise<Array<{ name: string; mode: string; title: string }>>
  get: (name: string) => Promise<string>
}

function unwrap(value: BrowserCommandResult): unknown {
  if (!value.ok) throw new Error(`[${value.error.code}] ${value.error.message}`)
  return value.value
}

export interface BrowserFacade {
  agent: { browsers: BrowserApi; playwright: typeof playwrightSugar; documentation: DocumentationApi }
  emitImage: (image: FacadeImage) => void
}

export function createBrowserFacade(deps: BrowserFacadeDeps): BrowserFacade {
  const invoke = async (cmd: BrowserCommand): Promise<unknown> => unwrap(await deps.execute(cmd))
  const descriptor = async (): Promise<BackendDescriptor> => (await invoke({ method: 'getDescriptor' })) as BackendDescriptor

  // The docs surface, as ONE object: call it for the full readout, reach into
  // it for a lookup document. `agent.documentation.get(…)` is written in the
  // workflow text itself, so it must exist exactly there.
  const documentation = Object.assign(
    async () => documentationText(await descriptor()),
    {
      list: async () => listDocuments(await descriptor()),
      get: async (name: string) => {
        const body = getDocument(name, await descriptor())
        if (!body) throw new Error(`文档不存在或当前后端不可用：${name}（用 documentation.list() 查看）`)
        return body
      },
    },
  )

  const makeTab = (id: string): TabApi =>
    guardMembers(
      {
        id,
        url: async () => {
          const state = (await invoke({ method: 'getState', tabId: id })) as { url: string; title: string }
          return state.url
        },
        title: async () => {
          const state = (await invoke({ method: 'getState', tabId: id })) as { url: string; title: string }
          return state.title
        },
        navigate: async (url: string) => { await invoke({ method: 'navigate', tabId: id, url: assertAllowedUrl(url) }) },
        back: async () => { await invoke({ method: 'back', tabId: id }) },
        forward: async () => { await invoke({ method: 'forward', tabId: id }) },
        reload: async () => { await invoke({ method: 'reload', tabId: id }) },
        close: async () => { await invoke({ method: 'close', tabId: id }) },
        domSnapshot: async (options) => (await invoke({ method: 'snapshot', tabId: id, full: options?.full })) as string,
        screenshot: async (options) => {
          const shot = (await invoke({
            method: 'screenshot', tabId: id,
            fullPage: options?.fullPage,
            selector: options?.selector ? (typeof options.selector === 'string' ? options.selector : options.selector.selector) : undefined,
          })) as { mime: string; base64: string }
          deps.emitImage({ mime: shot.mime, base64: shot.base64 })
          return { emitted: true, mime: shot.mime }
        },
        evaluate: async (expression: string) => invoke({ method: 'evaluate', tabId: id, expression }),
        // A method, not a locator factory — this is the exact spot the model
        // wrote `tab.playwright.getByRole` (the factory lives on agent.playwright).
        playwright: guardCallable(
          async (selector, op, arg, options) =>
            invoke({
              method: 'playwright', tabId: id,
              selector: typeof selector === 'number' ? pmRefSelector(selector) : typeof selector === 'string' ? selector : selector.selector,
              op, arg, timeoutMs: options?.timeoutMs,
            }),
          `tab.playwright`,
          PLAYWRIGHT_SURFACE_HINT,
        ),
        waitForTimeout: async (ms: number) => { await invoke({ method: 'playwrightWaitForTimeout', tabId: id, ms }) },
      },
      'tab',
      `（打开新页面：await agent.browsers.open(url)；重绑定：await agent.browsers.tabs.list() 再 .get(id)。）`,
    )

  const openedTab = (id: string, opened: 'new' | 'reused', note: string): TabOpenApi =>
    Object.assign(makeTab(id) as TabOpenApi, { opened, note })

  // ONE guarded object at both paths — same identity, same menu, so a typo on
  // either name reads the same and the two can never drift.
  const documentationGuarded = guardMembers(documentation, 'agent.documentation', `（另：agent.browsers.documentation 是同一对象。）`)

  const agent = guardMembers(
    {
      playwright: guardMembers(playwrightSugar, 'agent.playwright', AGENT_PLAYWRIGHT_HINT),
      documentation: documentationGuarded,
      browsers: guardMembers(
        {
          descriptor,
          setActiveBackend: async (backend: 'managed' | 'app-view') => {
            const d = (await invoke({ method: 'setActiveBackend', backend })) as BackendDescriptor
            return d
          },
          user: guardMembers(
            {
              openTabs: () => invoke({ method: 'userOpenTabs' }) as Promise<BrowserTabInfo[]>,
              claimTab: async (id: string) => {
                await invoke({ method: 'claimTab', tabId: id })
                return makeTab(id)
              },
            },
            'agent.browsers.user',
            `（仅应用内浏览器面板的后端有此对象。）`,
          ),
          downloads: () => invoke({ method: 'listDownloads' }) as Promise<Array<{ name: string; path: string; size: number; savedAt: string }>>,
          documentation: documentationGuarded,
          open: async (url: string) => {
            const normalized = assertAllowedUrl(url)
            const tabs = (await invoke({ method: 'listTabs' })) as BrowserTabInfo[]
            const match = matchTabForUrl(tabs, normalized)
            if (match) {
              await invoke({ method: 'navigate', tabId: match.id, url: normalized })
              // Reuse is stated, and so is the consequence the model got wrong:
              // calling open() again never grows the tab set.
              const atSame = match.rank === 3
              return openedTab(
                match.id,
                'reused',
                atSame
                  ? `已复用 ${match.id}（地址本就是 ${normalized}，已重新加载）——没有新开标签页；再次 open() 仍是这个标签页。`
                  : `已复用 ${match.id}（同站，原地址 ${match.url}）并导航到 ${normalized}——没有新开标签页；再次 open() 仍是这个标签页。`,
              )
            }
            const created = (await invoke({ method: 'newTab', url: normalized })) as BrowserTabInfo
            return openedTab(created.id, 'new', `已新建 ${created.id} 并导航到 ${normalized}。`)
          },
          tabs: guardMembers(
            {
              list: () => invoke({ method: 'listTabs' }) as Promise<BrowserTabInfo[]>,
              get: async (id: string) => {
                // 批前重绑定 (协议 §5.2): get() verifies the tab still exists so a
                // stale id from memory fails loudly instead of acting on the wrong tab.
                const tabs = (await invoke({ method: 'listTabs' })) as BrowserTabInfo[]
                if (!tabs.some((t) => t.id === id)) throw new Error(`Tab 不存在（可能已关闭）：${id} — 用 tabs.list() 重新核对`)
                return makeTab(id)
              },
              new: async (options?: { url?: string }) => {
                const created = (await invoke({ method: 'newTab', url: options?.url ? assertAllowedUrl(options.url) : undefined })) as BrowserTabInfo
                return openedTab(created.id, 'new', options?.url ? `已新建 ${created.id} 并导航到 ${options.url}。` : `已新建 ${created.id}（空白页 about:blank）。`)
              },
            },
            'agent.browsers.tabs',
            `（open(url) 会复用同站标签页；new() 总是新建。）`,
          ),
        },
        'agent.browsers',
        `（打开 URL：await agent.browsers.open(url)；已有标签页：await agent.browsers.tabs.list()。）`,
      ),
    },
    'agent',
    `（入口：agent.browsers / agent.playwright / agent.documentation。）`,
  )

  const facade: BrowserFacade = {
    agent: agent as unknown as BrowserFacade['agent'],
    emitImage: (image) => deps.emitImage(image),
  }
  return facade
}
