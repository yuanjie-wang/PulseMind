// ── 网络代理（抓包调试，settings.proxyUrl / proxyStrictSSL，2026-10-27）──
// 四层钉子，与功能的四段管线一一对应：
//   1. shared/proxy.parseProxyUrl —— 解析矩阵（空白=直连、裸 host:port 补
//      http://、socks 拒收、话术自带示例）
//   2. settings-store —— get() 逐字段重建必须带上 proxyUrl/proxyStrictSSL
//      （H1/H2 病的反面钉子：漏了就是写进去读不出来 + 下次整存抹掉），
//      且整存往返不丢
//   3. 端到端 —— 本地 CONNECT 隧道代理 + 本地目标服务器直驱真传输层（retry-
//      status-codes 先例）：undici ProxyAgent 对所有目标先发 CONNECT（实测，
//      纯 http 也不豁免），请求真的穿过隧道到达目标（npm undici 6 与 Node
//      内置 undici 6 的跨实例兼容在这一步被证明）；没配代理时代理零接触；
//      坏配置快速失败且不进 20 次重试退避
//   4. 接线扫描 —— 六个 fetch 站点 + ManagedBrowser + 面板 + i18n +
//      settings-store 重建行，每个扫描写明删掉它守的行会怎么红

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import net, { AddressInfo } from 'node:net'
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PROXY_URL_EXAMPLE, ProxyConfigError, parseProxyUrl } from '../src/shared/proxy'
import { fetchWithAttemptTimeout, performLlmStream } from '../src/main/ipc/api-proxy.handler'
import { resetProxyDispatcherCache } from '../src/main/utils/proxy'

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf-8')

// ── 1. 解析矩阵 ──

describe('parseProxyUrl', () => {
  it('空白 = 直连（null，不是错误）', () => {
    expect(parseProxyUrl(undefined)).toBeNull()
    expect(parseProxyUrl('')).toBeNull()
    expect(parseProxyUrl('   ')).toBeNull()
  })

  it('http/https 直通并规范化（trim + 补尾斜杠）', () => {
    expect(parseProxyUrl('http://127.0.0.1:8888')).toBe('http://127.0.0.1:8888/')
    expect(parseProxyUrl('  https://proxy.corp.lan:3128  ')).toBe('https://proxy.corp.lan:3128/')
  })

  it('裸 host:port 补 http:// —— Fiddler 默认 127.0.0.1:8888 的裸写法不能死在协议上', () => {
    expect(parseProxyUrl('127.0.0.1:8888')).toBe('http://127.0.0.1:8888/')
    expect(parseProxyUrl('localhost:8888')).toBe('http://localhost:8888/')
  })

  it('无法解析 / 非 http(s) 协议 → ProxyConfigError，话术自带示例', () => {
    for (const bad of ['not a proxy at all', 'socks5://127.0.0.1:1080', 'ftp://x/y']) {
      expect(() => parseProxyUrl(bad), bad).toThrow(ProxyConfigError)
      expect(() => parseProxyUrl(bad), bad).toThrow(PROXY_URL_EXAMPLE)
    }
  })

  it('错误是具名类 —— fetchWithRetry 的不重试门与 webhook 的放弃分支靠 instanceof 认它', () => {
    try {
      parseProxyUrl('socks5://x:1')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ProxyConfigError)
      expect(e.name).toBe('ProxyConfigError')
    }
  })
})

// ── 2. settings-store 归一化 ──

const HOME = process.env.HOME as string
const SETTINGS_PATH = join(HOME, '.pulsemind', 'settings.json')

async function freshStore() {
  const mod = await import('../src/main/storage/settings-store')
  return mod.settingsStore
}

function writeRaw(raw: Record<string, unknown>): void {
  mkdirSync(join(HOME, '.pulsemind'), { recursive: true })
  writeFileSync(SETTINGS_PATH, JSON.stringify(raw), 'utf-8')
}

const BASE_PROVIDER = {
  id: 'prov_x',
  name: 'P',
  apiFormat: 'openai',
  baseURL: 'https://api.example.com',
  models: [{ id: 'model_x', model: 'm' }],
}

describe('settings-store 归一化（proxyUrl / proxyStrictSSL）', () => {
  it('proxyUrl 原样读回（归一化在消费点）；proxyStrictSSL 缺省开、只有显式 false 才关', async () => {
    writeRaw({ providers: [BASE_PROVIDER], activeProfileId: 'model_x', proxyUrl: 'http://127.0.0.1:8888' })
    const s = await (await freshStore()).get()
    expect(s.proxyUrl).toBe('http://127.0.0.1:8888')
    expect(s.proxyStrictSSL).toBe(true)

    writeRaw({ providers: [BASE_PROVIDER], activeProfileId: 'model_x', proxyUrl: 'http://127.0.0.1:8888', proxyStrictSSL: false })
    expect((await (await freshStore()).get()).proxyStrictSSL).toBe(false)

    writeRaw({ providers: [BASE_PROVIDER], activeProfileId: 'model_x' })
    const s3 = await (await freshStore()).get()
    expect(s3.proxyUrl).toBe('')
    expect(s3.proxyStrictSSL).toBe(true)
  })

  it('整存往返不丢（H1/H2 的反面钉子：get() 重建漏字段 = 下次整存抹掉）', async () => {
    writeRaw({ providers: [BASE_PROVIDER], activeProfileId: 'model_x', proxyUrl: 'http://127.0.0.1:8888', proxyStrictSSL: false })
    const store = await freshStore()
    const settings = await store.get()
    await store.set(settings)
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as Record<string, unknown>
    expect(raw.proxyUrl).toBe('http://127.0.0.1:8888')
    expect(raw.proxyStrictSSL).toBe(false)
  })
})

// ── 3. 端到端：真传输层穿过本地转发代理 ──

const proxySeen: Array<{ url: string; method: string }> = []
const targetSeen: string[] = []
let targetBase = ''
let proxyOrigin = ''
let responses: Array<{ status: number; body?: string }> = []
const servers: Server[] = []
let clockTick = 0

function writeFixture(extra: Record<string, unknown> = {}): void {
  writeRaw({ providers: [{ ...BASE_PROVIDER, baseURL: targetBase }], activeProfileId: 'model_x', ...extra })
  // store 按 mtime 缓存——每次写完拨动 mtime，下一次请求才能读到新值
  const stamp = new Date(Date.now() + ++clockTick * 1000)
  utimesSync(SETTINGS_PATH, stamp, stamp)
}

beforeAll(async () => {
  const target = createServer((_req: IncomingMessage, res: ServerResponse) => {
    targetSeen.push(_req.url ?? '')
    const r = responses.shift() ?? { status: 200, body: 'ok' }
    res.writeHead(r.status, { 'content-type': 'application/json' })
    res.end(r.body ?? '')
  })
  servers.push(target)
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
  targetBase = `http://127.0.0.1:${(target.address() as AddressInfo).port}`

  // 转发代理：undici 的 ProxyAgent 对**所有**目标先发 CONNECT 建隧道（实测，
  // 纯 http 目标也不例外），隧道内再走 origin-form 的真请求。这里按 Fiddler
  // 的非解密形态把隧道双向接到真目标——只记录不转发就证明不了端到端。
  // 注意 Node 的 http 服务器对 CONNECT 触发 connect 事件而不是 request：
  // 不应答 200 Connection Established，undici 会永远等不到隧道（首版测试
  // 就是这么挂死的）。
  const proxy = createServer((_req: IncomingMessage, _res: ServerResponse) => {
    /* CONNECT 不走这里 */
  })
  proxy.on('connect', (req: IncomingMessage, clientSocket: import('node:net').Socket, head: Buffer) => {
    proxySeen.push({ url: req.url ?? '', method: req.method ?? '' })
    const authority = new URL(`http://${req.url}`)
    const upstream = net.connect(Number(authority.port) || 80, authority.hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  servers.push(proxy)
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  proxyOrigin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
})

afterEach(() => {
  proxySeen.length = 0
  targetSeen.length = 0
  responses = []
  resetProxyDispatcherCache()
})

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

interface StreamResult {
  chunks: string[]
  errors: string[]
  retryMessages: string[]
  done: boolean
}

function runStream(requestId: string): Promise<StreamResult> {
  return new Promise((resolve) => {
    const acc: StreamResult = { chunks: [], errors: [], retryMessages: [], done: false }
    const settle = (): void => resolve(acc)
    performLlmStream(
      requestId,
      `${targetBase}/chat/completions`,
      { headers: { authorization: 'Bearer test' } },
      {
        onError: (m) => {
          acc.errors.push(m)
          settle()
        },
        onRetry: (_attempt, _max, _delay, message) => acc.retryMessages.push(message),
        onChunk: (t) => acc.chunks.push(t),
        onDone: () => {
          acc.done = true
          settle()
        },
      },
      new AbortController(),
    )
  })
}

const SSE_OK = 'data: {"ok":true}\n\ndata: [DONE]\n\n'

describe('端到端：请求真的穿过代理', () => {
  it('配了代理时，LLM 流以绝对形式穿过转发代理到达目标并完成', { timeout: 20_000 }, async () => {
    responses = [{ status: 200, body: SSE_OK }]
    writeFixture({ proxyUrl: proxyOrigin })
    const t0 = Date.now()
    const result = await runStream('proxy-e2e')
    expect(result.done).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.chunks.join('')).toContain('[DONE]')
    // CONNECT 隧道 = ProxyAgent 的 wire 形态（对所有目标，纯 http 也不豁免）：
    // 代理看到 authority 形式的 CONNECT，隧道内目标看到 origin-form 真请求。
    expect(proxySeen).toHaveLength(1)
    expect(proxySeen[0].method).toBe('CONNECT')
    expect(proxySeen[0].url).toBe(new URL(targetBase).host)
    expect(targetSeen).toEqual(['/chat/completions'])
    expect(Date.now() - t0).toBeLessThan(15_000)
  })

  it('没配代理时直连，代理一个字节都看不到', { timeout: 20_000 }, async () => {
    responses = [{ status: 200, body: SSE_OK }]
    writeFixture({})
    const result = await runStream('proxy-e2e-direct')
    expect(result.done).toBe(true)
    expect(proxySeen).toHaveLength(0)
    expect(targetSeen).toEqual(['/chat/completions'])
  })

  it('坏代理配置快速失败：错误直出、零次重试退避（20 次退避是几分钟，这里必须毫秒级）', { timeout: 20_000 }, async () => {
    writeFixture({ proxyUrl: 'this is not a proxy' })
    const t0 = Date.now()
    const result = await runStream('proxy-e2e-bad')
    expect(result.done).toBe(false)
    expect(result.retryMessages).toHaveLength(0)
    expect(result.errors[0]).toContain('代理地址无效')
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(proxySeen).toHaveLength(0)
    expect(targetSeen).toHaveLength(0)
  })

  it('fetchWithAttemptTimeout 直驱同样不重试 ProxyConfigError（删掉重试门的短路即红）', async () => {
    writeFixture({ proxyUrl: 'socks5://127.0.0.1:1080' })
    const t0 = Date.now()
    await expect(fetchWithAttemptTimeout(`${targetBase}/x`, { method: 'POST', headers: {}, body: '{}' }, undefined, 5_000)).rejects.toThrow(ProxyConfigError)
    expect(Date.now() - t0).toBeLessThan(5_000)
  })
})

// ── 4. 接线扫描 ──
// 每条扫描写明非空洞性：删掉它守的行，哪一条断。

describe('接线：六个 fetch 站点 + 浏览器 + 面板 + i18n', () => {
  it('api-proxy 的唯一 fetch 点挂了代理，且重试门在 ProxyConfigError 处短路', () => {
    const src = read('src', 'main', 'ipc', 'api-proxy.handler.ts')
    expect(src).toContain('await withProxyDispatcher({')
    // 非空洞：instanceof 检查必须出现在 fetchWithRetry 的 catch 里、retry 日志之前——
    // 删掉短路，同样的坏配置会吃满 20 次 (attempt+5)s 退避（上面的毫秒级用例也红）。
    // catch 分支的 Retry 日志是文件里**最后**一处（try 分支的 HTTP 重试先出现）。
    const gate = src.indexOf('err instanceof ProxyConfigError')
    const retryLog = src.lastIndexOf('[API-Proxy] Retry')
    expect(gate).toBeGreaterThan(-1)
    expect(retryLog).toBeGreaterThan(gate)
  })

  it('探针 / webfetch(tool-runtime) / MCP×2 / webhook 都挂了同一个入口', () => {
    // 非空洞：把任意站点的 withProxyDispatcher 摘掉，它的 toContain 即红——
    // 「为什么抓包里没有 X」就是这么避免的。
    expect(read('src', 'main', 'services', 'llm-probe.ts')).toContain('await withProxyDispatcher({')
    expect(read('src', 'main', 'tool-runtime', 'index.ts')).toContain('await withProxyDispatcher({')
    const mcp = read('src', 'main', 'mcp', 'transport.ts')
    expect(mcp.match(/withProxyDispatcher\(/g)?.length).toBeGreaterThanOrEqual(2)
    const webhook = read('src', 'main', 'routine', 'webhook-out.ts')
    expect(webhook).toContain('await withProxyDispatcher({')
    // webhook 是 fire-and-forget：坏配置断在第一拍，不吃指数退避。
    expect(webhook).toContain('proxy misconfigured, giving up')
  })

  it('托管浏览器把代理带进真实 launch（探测不背它），坏配置响亮失败', () => {
    const src = read('src', 'main', 'browser', 'backends', 'ManagedBackend.ts')
    expect(src).toContain('parseProxyUrl(settings.proxyUrl)')
    expect(src).toContain('.proxy = { server: proxyUrl }')
    expect(src).toContain('err instanceof ProxyConfigError')
    // 非空洞：resolveLaunchOptions（可执行文件探测）里出现 proxy 就是把
    // 「代理不可达」误伤成「找不到浏览器内核」——它必须只长在 start()。
    const resolveIdx = src.indexOf('export async function resolveLaunchOptions')
    expect(src.indexOf('.proxy =', resolveIdx)).toBe(-1)
  })

  it('面板提交走主进程同一解析器就地校验，i18n 两语言都有键', () => {
    const ui = read('src', 'renderer', 'src', 'components', 'settings', 'DataRuntimeSettings.tsx')
    expect(ui).toContain("from '../../../../shared/proxy'")
    expect(ui).toContain('parseProxyUrl(trimmed)')
    expect(ui).toContain('proxyStrictSSL')
    for (const locale of ['zh', 'en']) {
      const table = read('src', 'renderer', 'src', 'i18n', 'locales', `${locale}.ts`)
      expect(table).toContain('proxyUrl:')
      expect(table).toContain('proxyStrictSSL:')
    }
  })

  it('settings-store 的重建行与 FALLBACK 都有这两个字段（写进去读不出来即红）', () => {
    const src = read('src', 'main', 'storage', 'settings-store.ts')
    expect(src).toContain("proxyUrl: typeof parsed.proxyUrl === 'string'")
    expect(src).toContain('proxyStrictSSL: parsed.proxyStrictSSL !== false')
    expect(src).toMatch(/proxyUrl: '',\s*\n\s*proxyStrictSSL: true/)
  })
})
