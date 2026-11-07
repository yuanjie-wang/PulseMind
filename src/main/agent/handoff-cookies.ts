/** session.handoff 的 cookie 面（PLAN-extension-handoff M2）。
 *
 *  纯函数、零 electron 导入——wire 元组（shared/agent-protocol payloads 的
 *  HandoffCookieTuple）与 Electron `cookies.set` details 的映射和清洗都在
 *  这里，单测直接钉；ws-server 只负责真正调 `session.fromPartition(...).cookies.set`。
 *
 *  关键语义：
 *  - 元组里 domain 为空串 = host-only（chrome.cookies 的 hostOnly 语义）——
 *    设了 domain 会把主机 cookie 改写成域 cookie，登录态的边界就变了。
 *  - __Host-/__Secure- 前缀约束（secure、path=/、无 domain）两端一致，原样透传。
 *  - Partitioned (CHIPS) cookie 不携带：chrome.cookies 的 partitionKey 要
 *    Chromium 119+，我们的地板是 108——如实降级（目标站很少有 CHIPS 依赖的登录态）。
 *  - sameSite 跨端枚举不齐（chrome 有 unbounded / strict 变体），映射不出的丢弃。 */

/** Electron `CookiesSetDetails` 的结构投影（不用 electron 类型导入——本模块
 *  必须能进 vitest 与探针）。 */
export interface HandoffCookieDetails {
  url: string
  name: string
  value: string
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  expirationDate?: number
  sameSite?: 'no_restriction' | 'lax' | 'strict' | 'unspecified'
}

/** 一条 cookie 的清洗形态（sanitizeHandoffCookies 的产物）。 */
export interface ParsedHandoffCookie {
  name: string
  value: string
  /** 空 = host-only（不落 domain 字段）。 */
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  /** 秒级 epoch；缺席 = session cookie。 */
  expirationDate?: number
  sameSite?: HandoffCookieDetails['sameSite']
}

const MAX_COOKIES = 100
const SAME_SITE: Record<string, HandoffCookieDetails['sameSite']> = {
  no_restriction: 'no_restriction',
  lax: 'lax',
  strict: 'strict',
  unspecified: 'unspecified',
  // chrome 的 'unbounded' 与 Electron 无对应值 → 丢弃（unspecified 的宽容语义）
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** wire 元组数组 → 清洗形态。越界/畸形条目丢弃，帽 100 条；输入不是数组 → []。 */
export function sanitizeHandoffCookies(raw: unknown): ParsedHandoffCookie[] {
  if (!Array.isArray(raw)) return []
  const out: ParsedHandoffCookie[] = []
  for (const entry of raw.slice(0, MAX_COOKIES)) {
    if (!Array.isArray(entry) || entry.length < 6) continue
    const name = asString(entry[0])
    if (!name) continue
    const expirationDate = typeof entry[6] === 'number' && Number.isFinite(entry[6]) && entry[6] > 0 ? entry[6] : undefined
    const sameSite = typeof entry[7] === 'string' ? SAME_SITE[entry[7]] : undefined
    out.push({
      name,
      value: asString(entry[1]),
      domain: asString(entry[2]),
      path: asString(entry[3]) || '/',
      secure: entry[4] === true,
      httpOnly: entry[5] === true,
      ...(expirationDate !== undefined ? { expirationDate } : {}),
      ...(sameSite !== undefined ? { sameSite } : {}),
    })
  }
  return out
}

/** 清洗形态 → Electron cookies.set details。url 用页面 URL（对 domain 级
 *  cookie 足够——set 以 url 定方向、domain 显式声明作用域）。 */
export function handoffCookieDetails(pageUrl: string, cookie: ParsedHandoffCookie): HandoffCookieDetails {
  return {
    url: pageUrl,
    name: cookie.name,
    value: cookie.value,
    // host-only：绝不带 domain（带了就把主机 cookie 改写成域 cookie）
    ...(cookie.domain ? { domain: cookie.domain } : {}),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.expirationDate !== undefined ? { expirationDate: cookie.expirationDate } : {}),
    ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
  }
}
