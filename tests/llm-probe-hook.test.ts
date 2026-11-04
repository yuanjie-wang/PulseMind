// ── 设置页「测试连接」跑 llm-request hook（2026-11-02 用户裁定，翻转此前
// 「探测不该被 hook 改写」的设计）──
// 真驱动：`testLlmConnection` 打到本地目标服务器，hook 是写进测试 HOME 下
// `~/.pulsemind/hooks/llm-request.js` 的**真实脚本**，由生产的 llm-hook.ts
// 加载器（mtime 缓存 + require）加载——不 mock hook 层，证明的是线路上的字节。
// SSRF 对 127.0.0.1 的放行沿用 proxy-setting 的 fixture：activeProfile 的
// baseURL 指向本地目标，validateRequestUrl 按「同主机」放行。
//
// 四条 hook 钉子：
//   1. hook 改写的头/体真的到达线路，requestId 带 `probe-` 前缀（hook 脚本
//      据此区分探测与真实请求、自行跳过副作用）；
//   2. hook 改写 url（同主机换路径）→ 请求打到新路径；改到别的内网主机 →
//      SSRF 重校验拒绝、零请求发出（首轮校验的是改写前的地址，重校验是硬要求）；
//   3. 没有 hook 文件 → 线路字节与 buildProbeBody 逐字相同，没有 hook 头；
//   4. hook 抛错 → 原样发出、探测照常成功（hook 失败永不阻塞请求，与 api-proxy
//      同契约）。
// 再加探测本体的分支（此前没有任何测试驱动过 llm-probe.ts）：profileId 对已存
// 配置的解析与内联覆盖、provider 缺省 anthropic、配置不完整、${ENV} 未解析、
// HTTP 失败翻译、连接拒绝翻译。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { testLlmConnection } from '../src/main/services/llm-probe'
import { buildProbeBody } from '../src/shared/llm/probe'

const HOME = process.env.HOME as string
const PM_DIR = join(HOME, '.pulsemind')
const SETTINGS_PATH = join(PM_DIR, 'settings.json')
const HOOK_PATH = join(PM_DIR, 'hooks', 'llm-request.js')

// settings-store 与 llm-hook 都按 mtime 缓存——每次写完拨动 mtime，下一次
// 读取才认新内容（同一秒内连写两份会撞同一个 mtime）。
let clockTick = 0
function bumpMtime(path: string): void {
  const stamp = new Date(Date.now() + ++clockTick * 1000)
  utimesSync(path, stamp, stamp)
}

// 已存配置：apiKey 住在供应商层，模型条目 id = profileId。
function writeSettings(targetBase: string): void {
  mkdirSync(PM_DIR, { recursive: true })
  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      providers: [
        {
          id: 'prov_x',
          name: 'P',
          apiFormat: 'openai',
          baseURL: targetBase,
          apiKey: 'sk-saved',
          models: [{ id: 'model_x', model: 'saved-model' }],
        },
      ],
      activeProfileId: 'model_x',
    }),
    'utf-8',
  )
  bumpMtime(SETTINGS_PATH)
}

function writeHook(source: string): void {
  mkdirSync(join(PM_DIR, 'hooks'), { recursive: true })
  writeFileSync(HOOK_PATH, source, 'utf-8')
  bumpMtime(HOOK_PATH)
}

interface SeenRequest {
  url: string
  headers: IncomingMessage['headers']
  body: string
}

const seen: SeenRequest[] = []
let responses: Array<{ status: number; body?: string }> = []
let targetBase = ''
let server: Server

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8')
    })
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body })
      const r = responses.shift() ?? { status: 200, body: '{"ok":true}' }
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(r.body ?? '')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  targetBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  writeSettings(targetBase)
})

afterEach(() => {
  seen.length = 0
  responses = []
  rmSync(HOOK_PATH, { force: true })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

// 内联字段（设置抽屉里未保存的编辑）——不带 profileId，走纯内联分支。
function probeInput() {
  return { provider: 'openai' as const, baseURL: targetBase, model: 'probe-model', apiKey: 'sk-test' }
}

describe('测试连接跑 llm-request hook', () => {
  it('hook 改写的头与体到达线路；requestId 带 probe- 前缀；探测自带的头与 max_tokens:1 存活', async () => {
    writeHook(`
      module.exports = async (ctx) => ({
        headers: { 'x-pm-hook': ctx.requestId, 'x-pm-event': ctx.event },
        body: { ...ctx.body, metadata: { hooked: true } },
      })
    `)
    const outcome = await testLlmConnection(probeInput())
    expect(outcome.ok, outcome.message).toBe(true)
    expect(seen).toHaveLength(1)
    const [req] = seen
    expect(req.url).toBe('/chat/completions')
    expect(req.headers['x-pm-hook']).toMatch(/^probe-[0-9a-f]{8}$/)
    expect(req.headers['x-pm-event']).toBe('llm-request')
    // 探测自己的头没被 hook 的 headers 覆盖掉（合并而非替换）
    expect(req.headers.authorization).toBe('Bearer sk-test')
    const body = JSON.parse(req.body) as Record<string, unknown>
    expect(body.model).toBe('probe-model')
    expect(body.max_tokens).toBe(1)
    expect(body.metadata).toEqual({ hooked: true })
  })

  it('hook 以不同大小写覆盖 Authorization（动态 token 场景）→ 线路上只有 hook 的那一份', async () => {
    writeHook(`
      module.exports = () => ({ headers: { authorization: 'Bearer from-hook' } })
    `)
    const outcome = await testLlmConnection(probeInput())
    expect(outcome.ok, outcome.message).toBe(true)
    // Node 把同名头折叠成一个值；若大小写合并失手会出现 "Bearer sk-test, Bearer from-hook"
    expect(seen[0].headers.authorization).toBe('Bearer from-hook')
  })

  it('hook 改写 url 到同主机的新路径 → 请求打到新路径（SSRF 重校验按同主机放行）', async () => {
    writeHook(`
      module.exports = (ctx) => ({ url: ctx.url.replace('/chat/completions', '/hooked/completions') })
    `)
    const outcome = await testLlmConnection(probeInput())
    expect(outcome.ok, outcome.message).toBe(true)
    expect(seen.map((r) => r.url)).toEqual(['/hooked/completions'])
  })

  it('hook 把 url 改到别的内网主机 → SSRF 重校验拒绝，零请求发出', async () => {
    writeHook(`
      module.exports = () => ({ url: 'http://10.255.255.1:9/chat/completions' })
    `)
    const outcome = await testLlmConnection(probeInput())
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('SSRF 拦截')
    expect(outcome.message).toContain('10.255.255.1')
    expect(seen).toHaveLength(0)
  })

  it('没有 hook 文件 → 线路字节就是 buildProbeBody 的原样，没有 hook 头', async () => {
    rmSync(HOOK_PATH, { force: true })
    const outcome = await testLlmConnection(probeInput())
    expect(outcome.ok, outcome.message).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0].body).toBe(buildProbeBody('openai', 'probe-model'))
    expect(seen[0].headers['x-pm-hook']).toBeUndefined()
    expect(seen[0].headers.authorization).toBe('Bearer sk-test')
  })

  it('hook 抛错 → 原样发出、探测照常成功（hook 失败永不阻塞请求）', async () => {
    writeHook(`
      module.exports = () => { throw new Error('boom') }
    `)
    const outcome = await testLlmConnection(probeInput())
    expect(outcome.ok, outcome.message).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0].body).toBe(buildProbeBody('openai', 'probe-model'))
    expect(seen[0].headers['x-pm-hook']).toBeUndefined()
  })

  // review_20261103 中7：applyLlmRequestHook 无时限——hook 挂死 → 设置页
  // spinner 永不收口；hook 慢过探测 15s → fetch 拿到已 abort 的 signal、
  // 失败被误翻译成网络错误。hook 现在有专属（更短的）deadline 与专属文案，
  // 超时即返回、零请求发出；迟到的 hook 结果也不会再补发任何请求。
  it('hook 超过专属 deadline → 专属文案、零请求；迟到结果不再补发', async () => {
    writeHook(`
      module.exports = () => new Promise((resolve) => setTimeout(() => resolve({ headers: { 'x-pm-hook': 'late' } }), 2000))
    `)
    const t0 = Date.now()
    const outcome = await testLlmConnection(probeInput(), { hookDeadlineMs: 200 })
    const elapsed = Date.now() - t0
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('llm-request hook 超时')
    expect(outcome.hint).toContain('llm-request.js')
    expect(elapsed).toBeLessThan(1500) // 旧实现：spinner 挂到 hook 返回（2s+）甚至永不收口
    expect(seen).toHaveLength(0)
    // 迟到的 hook 结果不得再驱动任何请求（返回即终局）
    await new Promise((r) => setTimeout(r, 2200))
    expect(seen).toHaveLength(0)
  })

  it('hook 在 deadline 内返回 → 照常生效（deadline 不误伤慢而未死的脚本）', async () => {
    writeHook(`
      module.exports = () => new Promise((resolve) => setTimeout(() => resolve({ headers: { 'x-pm-hook': 'slow-ok' } }), 80))
    `)
    const outcome = await testLlmConnection(probeInput(), { hookDeadlineMs: 2000 })
    expect(outcome.ok, outcome.message).toBe(true)
    expect(seen[0].headers['x-pm-hook']).toBe('slow-ok')
  })
})

describe('探测本体：配置解析与失败翻译', () => {
  it('profileId 对已存配置解析：连接字段来自供应商层，hook 看到 profileId；内联字段优先于已存', async () => {
    writeHook(`
      module.exports = (ctx) => ({ headers: { 'x-pm-profile': String(ctx.profileId) } })
    `)
    // 全部来自已存配置
    const saved = await testLlmConnection({ profileId: 'model_x' })
    expect(saved.ok, saved.message).toBe(true)
    expect(saved.message).toContain('saved-model')
    expect(seen[0].headers.authorization).toBe('Bearer sk-saved')
    expect(seen[0].headers['x-pm-profile']).toBe('model_x')
    expect((JSON.parse(seen[0].body) as { model: string }).model).toBe('saved-model')

    // 抽屉里未保存的编辑：内联 model 赢，其余仍从已存配置补齐
    const inline = await testLlmConnection({ profileId: 'model_x', model: 'inline-model' })
    expect(inline.ok, inline.message).toBe(true)
    expect(seen[1].headers.authorization).toBe('Bearer sk-saved')
    expect((JSON.parse(seen[1].body) as { model: string }).model).toBe('inline-model')
  })

  it('provider 缺省 anthropic：路径 /v1/messages、x-api-key 头', async () => {
    const outcome = await testLlmConnection({ baseURL: targetBase, model: 'claude-x', apiKey: 'sk-ant' })
    expect(outcome.ok, outcome.message).toBe(true)
    expect(seen[0].url).toBe('/v1/messages')
    expect(seen[0].headers['x-api-key']).toBe('sk-ant')
    expect(seen[0].headers.authorization).toBeUndefined()
  })

  it('配置不完整 → 不发请求，点名缺的字段', async () => {
    const outcome = await testLlmConnection({ provider: 'openai', baseURL: targetBase, model: 'm' })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('API Key')
    expect(seen).toHaveLength(0)
  })

  it('${ENV} 未设置 → 不发请求，点名变量并指向 app-start.js', async () => {
    const outcome = await testLlmConnection({ ...probeInput(), apiKey: '${PM_PROBE_TEST_UNSET_VAR}' })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toBe('环境变量 PM_PROBE_TEST_UNSET_VAR 未设置')
    expect(outcome.hint).toContain('app-start.js')
    expect(seen).toHaveLength(0)
  })

  it('HTTP 401 → 翻成「Key 无效」，带耗时与响应体片段', async () => {
    responses = [{ status: 401, body: '{"error":"bad key"}' }]
    const outcome = await testLlmConnection(probeInput())
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toBe('API Key 无效或没有访问权限')
    expect(typeof outcome.latencyMs).toBe('number')
    expect(outcome.detail).toContain('bad key')
  })

  it('连接被拒 → 网络失败翻译，零请求到达', async () => {
    // 同主机换一个已关闭的端口：SSRF 按主机放行，连接当场 ECONNREFUSED
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const outcome = await testLlmConnection({ ...probeInput(), baseURL: `http://127.0.0.1:${port}` })
    expect(outcome.ok).toBe(false)
    expect(outcome.message.length).toBeGreaterThan(0)
    expect(outcome.latencyMs).toBeUndefined()
    expect(seen).toHaveLength(0)
  })
})
