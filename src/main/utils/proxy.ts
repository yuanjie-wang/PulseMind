// ── 用户级 HTTP 代理（抓包调试，2026-10-27）────────────────────────────────
// settings.proxyUrl 设置后，主进程的全部对外 HTTP 都挂 undici ProxyAgent：
// LLM 流/一次性调用与简单 fetch（api-proxy 的唯一 fetch 点）、连接探针、
// webfetch（ipc 与 tool-runtime 两路）、MCP HTTP transport、例行 webhook，
// 外加托管浏览器的启动参数（ManagedBackend 的 Playwright proxy）。
//
// 两个纪律：
//  • 读取走 mtime 缓存的 settingsStore，dispatcher 按 (proxyUrl, strictSSL)
//    缓存复用——改完设置对下一次请求生效，无需重启（与 debugLlmRequests /
//    llmRetryStatusCodes 同款语义）；换配置时旧连接池 close 排空。
//  • undici 必须钉在 v6：Electron 33 = Node 20.18，全局 fetch 是 Node 内置
//    undici 6.x，npm undici 6 的 ProxyAgent 与之同大版本兼容；v7 改了
//    handler 回调面，跨实例混用没有兼容承诺。

import { ProxyAgent, type Dispatcher } from 'undici'
import { settingsStore } from '../storage/settings-store'
import { parseProxyUrl } from '../../shared/proxy'

export { ProxyConfigError, parseProxyUrl } from '../../shared/proxy'

interface CachedDispatcher {
  proxyUrl: string
  strictSSL: boolean
  dispatcher: ProxyAgent
}

let cached: CachedDispatcher | null = null

/** 测试复位钩子（resetPageToolState 同款惯例）。 */
export function resetProxyDispatcherCache(): void {
  cached = null
}

export function buildProxyAgent(proxyUrl: string, strictSSL: boolean): ProxyAgent {
  return new ProxyAgent({
    uri: proxyUrl,
    // 抓包工具解密 HTTPS 时用自签根证书重签目标站点的证书，而 undici 走
    // Node 内置 CA（不读系统钥匙串）——strictSSL 关掉即两侧都跳过校验：
    // requestTls 管目标连接，proxyTls 管代理自身是 https 的罕见形态。
    requestTls: strictSSL ? undefined : { rejectUnauthorized: false },
    proxyTls: strictSSL ? undefined : { rejectUnauthorized: false },
  })
}

/** 配置 → 缓存的 dispatcher。无配置 = undefined（直连）；配置非法抛
 *  ProxyConfigError（调用方各自收进自己的错误通道，fetch 链不重试它）。 */
export async function resolveProxyDispatcher(): Promise<Dispatcher | undefined> {
  const settings = await settingsStore.get()
  const proxyUrl = parseProxyUrl(settings.proxyUrl)
  if (!proxyUrl) return undefined
  const strictSSL = settings.proxyStrictSSL !== false
  if (cached && cached.proxyUrl === proxyUrl && cached.strictSSL === strictSSL) return cached.dispatcher
  const previous = cached
  cached = { proxyUrl, strictSSL, dispatcher: buildProxyAgent(proxyUrl, strictSSL) }
  if (previous)
    void previous.dispatcher.close().catch(() => {
      /* pool already gone */
    })
  return cached.dispatcher
}

/** fetch init 增强：设置了代理就带上 dispatcher，否则原样返回。每个 fetch
 *  站点一行 `await withProxyDispatcher({ … })`，fetch 调用本身不动。 */
export async function withProxyDispatcher(init: RequestInit = {}): Promise<RequestInit> {
  const dispatcher = await resolveProxyDispatcher()
  if (!dispatcher) return init
  // dispatcher 是 undici 的非标准 RequestInit 扩展，运行时由全局 fetch 认领；
  // DOM 的 RequestInit 类型没有它，在这里一次性收口。
  return { ...init, dispatcher } as RequestInit
}
