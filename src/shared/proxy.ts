/**
 * 用户级 HTTP 代理设置的共享解析（抓包调试，Fiddler / Charles / mitmproxy）。
 *
 * 纯逻辑、双进程可用：主进程的 dispatcher 缓存（src/main/utils/proxy.ts）在
 * 每次请求前调 parseProxyUrl 归一化配置，渲染端的高级设置面板在 blur 提交时
 * 调它做即时校验——两侧同一份规则，不会出现「UI 放行、主进程拒绝」的分裂。
 */

/** 代理配置无效的确定性错误。fetch 链路里它**不重试**（fetchWithRetry 对它
 *  立即失败）——同一个拼写错误重试 20 次只会放大成几分钟的停顿。 */
export class ProxyConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProxyConfigError'
  }
}

/** 无协议的 host:port（Fiddler 默认 127.0.0.1:8888 的裸写法）——补 http://。
 *  抓包工具的本地代理全部说 HTTP 代理协议，这个补全是安全默认。 */
const BARE_HOST_PORT = /^[\w.-]+:\d{2,5}$/

export const PROXY_URL_EXAMPLE = 'http://127.0.0.1:8888'

/**
 * 归一化代理配置：空白 = null（直连）；合法 http/https URL = 规范化 href；
 * 裸 host:port 补 http:// 前缀；其余（无法解析的串、非 http/https 协议如
 * socks5://——undici ProxyAgent 不支持）抛 ProxyConfigError，话术自带示例。
 */
export function parseProxyUrl(raw: string | undefined | null): string | null {
  const value = (raw ?? '').trim()
  if (!value) return null
  const candidate = BARE_HOST_PORT.test(value) ? `http://${value}` : value
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new ProxyConfigError(`代理地址无效: ${value}（示例 ${PROXY_URL_EXAMPLE}）`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProxyConfigError(`代理协议仅支持 http/https: ${value}（示例 ${PROXY_URL_EXAMPLE}）`)
  }
  return parsed.href
}
