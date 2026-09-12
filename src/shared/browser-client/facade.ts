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
import { selectTabForUrl } from './selection'
import { documentationText, getDocument, listDocuments } from './documentation'

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
  /** AI/ARIA tree — the default and primary observation (协议 §5.4). */
  domSnapshot: () => Promise<string>
  /** Always emits through emitImage in the same call (协议 §5.6). */
  screenshot: (options?: { fullPage?: boolean; selector?: string | LocatorSugar }) => Promise<{ emitted: true; mime: string }>
  evaluate: (expression: string) => Promise<unknown>
  /** The one selector-engine escape hatch: (sugar|string, op, arg?). */
  playwright: (selector: string | LocatorSugar, op: string, arg?: string, options?: { timeoutMs?: number }) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
}

export interface BrowserApi {
  descriptor: () => Promise<BackendDescriptor>
  /** Switch this conversation's backend (managed | app-view). One choice per task (协议 §5.1). */
  setActiveBackend: (backend: 'managed' | 'app-view') => Promise<BackendDescriptor>
  /** Preferred entry: same-site tab reuse + in-place navigation (协议 §5.3). */
  open: (url: string) => Promise<TabApi>
  tabs: {
    list: () => Promise<BrowserTabInfo[]>
    get: (id: string) => Promise<TabApi>
    new: (options?: { url?: string }) => Promise<TabApi>
  }
  /** Tabs visible in the app pane (app-view backend only). */
  user: {
    openTabs: () => Promise<BrowserTabInfo[]>
    claimTab: (id: string) => Promise<TabApi>
  }
  /** Files saved by page downloads in this conversation's workspace. */
  downloads: () => Promise<Array<{ name: string; path: string; size: number; savedAt: string }>>
  /** One-shot full readout: backend + effective API + included documents. */
  documentation: () => Promise<string>
  /** Lookup documents (screenshots/app-view/recording/…), when available. */
  documentationList: () => Promise<Array<{ name: string; mode: string; title: string }>>
  documentationGet: (name: string) => Promise<string>
}

function unwrap(value: BrowserCommandResult): unknown {
  if (!value.ok) throw new Error(`[${value.error.code}] ${value.error.message}`)
  return value.value
}

export interface BrowserFacade {
  agent: { browsers: BrowserApi; playwright: typeof playwrightSugar }
  emitImage: (image: FacadeImage) => void
}

export function createBrowserFacade(deps: BrowserFacadeDeps): BrowserFacade {
  const invoke = async (cmd: BrowserCommand): Promise<unknown> => unwrap(await deps.execute(cmd))

  const makeTab = (id: string): TabApi => ({
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
    domSnapshot: async () => (await invoke({ method: 'snapshot', tabId: id })) as string,
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
    playwright: async (selector, op, arg, options) =>
      invoke({ method: 'playwright', tabId: id, selector: typeof selector === 'string' ? selector : selector.selector, op, arg, timeoutMs: options?.timeoutMs }),
    waitForTimeout: async (ms: number) => { await invoke({ method: 'playwrightWaitForTimeout', tabId: id, ms }) },
  })

  const agent = {
    playwright: playwrightSugar,
    browsers: {
      descriptor: () => invoke({ method: 'getDescriptor' }) as Promise<BackendDescriptor>,
      setActiveBackend: async (backend: 'managed' | 'app-view') => {
        const d = (await invoke({ method: 'setActiveBackend', backend })) as BackendDescriptor
        return d
      },
      user: {
        openTabs: () => invoke({ method: 'userOpenTabs' }) as Promise<BrowserTabInfo[]>,
        claimTab: async (id: string) => {
          await invoke({ method: 'claimTab', tabId: id })
          return makeTab(id)
        },
      },
      downloads: () => invoke({ method: 'listDownloads' }) as Promise<Array<{ name: string; path: string; size: number; savedAt: string }>>,
      documentation: async () => documentationText((await invoke({ method: 'getDescriptor' })) as BackendDescriptor),
      documentationList: async () => listDocuments((await invoke({ method: 'getDescriptor' })) as BackendDescriptor),
      documentationGet: async (name: string) => {
        const body = getDocument(name, (await invoke({ method: 'getDescriptor' })) as BackendDescriptor)
        if (!body) throw new Error(`文档不存在或当前后端不可用：${name}（用 documentationList() 查看）`)
        return body
      },
      open: async (url: string) => {
        const normalized = assertAllowedUrl(url)
        const tabs = (await invoke({ method: 'listTabs' })) as BrowserTabInfo[]
        const reuseId = selectTabForUrl(tabs, normalized)
        if (reuseId) {
          await invoke({ method: 'navigate', tabId: reuseId, url: normalized })
          return makeTab(reuseId)
        }
        const created = (await invoke({ method: 'newTab', url: normalized })) as BrowserTabInfo
        return makeTab(created.id)
      },
      tabs: {
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
          return makeTab(created.id)
        },
      },
    },
  }

  const facade: BrowserFacade = {
    agent: agent as unknown as { browsers: BrowserApi; playwright: typeof playwrightSugar },
    emitImage: (image) => deps.emitImage(image),
  }
  return facade
}
