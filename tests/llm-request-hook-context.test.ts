// ── llm-request hook 的会话身份三元组（2026-11-20，user 定义）──
// requestId 标志一次 LLM 请求（HTTP 层重试不变，引擎级重发换新——已由现行
// 铸点保证）；sessionId 标志整个会话；taskId（promptId）标志一轮问答任务，
// 轮内一切重试不变；turnIndex 是会话内从 0 递增的轮序号。
//
// 四层钉子：
//   1. llm-hook 单元：opts 带三元组 → hook context 逐字带到；opts 不带 →
//      三个键**缺席**（不是 undefined，`'k' in ctx` 为 false）——探针/标题/
//      记忆整理这类无会话旁路调用因此诚实缺失；
//   2. 真漏斗：performLlmStream 的 LlmStreamOptions → applyLlmRequestHook
//      → 真 hook 脚本（临时 HOME，生产的加载器）——身份只进 context，
//      **不进 headers/body**（前缀缓存字节敏感，红线）；
//   3. 引擎铸点纯函数：countUserTurns（真实用户输入才算一轮，tool_result
//      载体不算）与 mintTurnId 形状；
//   4. 接线扫描：prepareTurn 是唯一铸点（retryLastTurn/steer 刻意绕开
//      prepareTurn ⇒ 同轮重试天然保 taskId 不变）；stream-runner 把
//      opts.conversationId + currentTurnId/Index 随 apiFetchStream 交出；
//      代理把 options 三元组透传给 hook。

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyLlmRequestHook } from '../src/main/llm-hook'
import { performLlmStream } from '../src/main/ipc/api-proxy.handler'
import { mintTurnId, countUserTurns } from '../src/renderer/src/agent/engine/turn-identity'
import type { AgentMessage } from '../src/renderer/src/types/agent'

const HOME = process.env.HOME as string
const PM_DIR = join(HOME, '.pulsemind')
const HOOK_PATH = join(PM_DIR, 'hooks', 'llm-request.js')

// llm-hook 按 mtimeMs 缓存脚本——同一毫秒连写两份会撞缓存，逐次拨动。
let clockTick = 0
function bumpMtime(path: string): void {
  const stamp = new Date(Date.now() + ++clockTick * 1000)
  utimesSync(path, stamp, stamp)
}

function writeHook(source: string): void {
  mkdirSync(join(PM_DIR, 'hooks'), { recursive: true })
  writeFileSync(HOOK_PATH, source, 'utf-8')
  bumpMtime(HOOK_PATH)
}

// hook 脚本把收到的 context 记到全局——require 与测试同进程，全局可达。
const HOOK_OBSERVER = `
module.exports = async (ctx) => {
  const ctxs = (globalThis.__hookCtxs = globalThis.__hookCtxs || [])
  ctxs.push(ctx)
}
`

beforeAll(() => {
  // 清掉上一个测试文件可能留下的观察记录
  delete (globalThis as { __hookCtxs?: unknown[] }).__hookCtxs
})

afterAll(() => {
  rmSync(HOOK_PATH, { force: true })
})

function hookCtxs(): Array<Record<string, unknown>> {
  return ((globalThis as { __hookCtxs?: Array<Record<string, unknown>> }).__hookCtxs ?? [])
}

// ── 1. llm-hook 单元：三元组进 context，缺席时键不在 ──────────────────

describe('applyLlmRequestHook session identity', () => {
  it('carries sessionId/taskId/turnIndex into the hook context when provided', async () => {
    writeHook(HOOK_OBSERVER)
    await applyLlmRequestHook('https://api.example.com/v1/messages', { 'x-a': '1' }, '{"model":"m"}', {
      requestId: 'api_t1',
      profileId: 'model_x',
      sessionId: 'conv_abc',
      taskId: 'turn_123_abc',
      turnIndex: 3,
    })
    const ctx = hookCtxs().at(-1) as { requestId?: string; sessionId?: string; taskId?: string; turnIndex?: number }
    expect(ctx.requestId).toBe('api_t1')
    expect(ctx.sessionId).toBe('conv_abc')
    expect(ctx.taskId).toBe('turn_123_abc')
    expect(ctx.turnIndex).toBe(3)
    expect('sessionId' in ctx && 'taskId' in ctx && 'turnIndex' in ctx).toBe(true)
  })

  it('omits the keys entirely (absent, not undefined) when the caller has no session', async () => {
    writeHook(HOOK_OBSERVER)
    // 无会话旁路调用：探针/标题/记忆整理只带 requestId（profileId 也可缺席）
    await applyLlmRequestHook('https://api.example.com/v1/messages', {}, '{}', { requestId: 'probe_t2' })
    const ctx = hookCtxs().at(-1) as Record<string, unknown>
    expect('sessionId' in ctx).toBe(false)
    expect('taskId' in ctx).toBe(false)
    expect('turnIndex' in ctx).toBe(false)
    expect(ctx.requestId).toBe('probe_t2')
  })
})

// ── 2. 真漏斗：LlmStreamOptions → hook context，且不碰 headers/body ────

describe('performLlmStream forwards identity to the hook only', () => {
  interface SeenRequest { path: string; headers: IncomingMessage['headers']; body: string }
  const seen: SeenRequest[] = []
  let server: Server | null = null
  let localBase = ''

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf-8') })
      req.on('end', () => {
        seen.push({ path: req.url ?? '', headers: req.headers, body })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    localBase = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
    // SSRF 门：私网地址只放行「与 activeProfile baseURL 同主机」——把配置
    // 指到本地服务器（与 oneshot-proxy-funnel 同款 fixture 形状）。
    mkdirSync(PM_DIR, { recursive: true })
    const settingsPath = join(PM_DIR, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      activeProfileId: 'model_x',
      providers: [{
        id: 'prov_x', name: 'P', apiFormat: 'openai', baseURL: localBase, apiKey: 'sk-x',
        models: [{ id: 'model_x', model: 'm' }],
      }],
    }), 'utf-8')
    bumpMtime(settingsPath)
    writeHook(HOOK_OBSERVER)
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
  })

  it('hook receives the triple; the wire request carries none of it', async () => {
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    const headers = { 'content-type': 'application/json', 'x-api-key': 'sk-x' }
    const done = new Promise<void>((resolve) => {
      void performLlmStream(
        'api_t3', `${localBase}/v1/messages`,
        { method: 'POST', headers, body, profileId: 'model_x', sessionId: 'conv_e2e', taskId: 'turn_e2e_1', turnIndex: 0 },
        {
          onError: () => {}, onRetry: () => {}, onChunk: () => {},
          onDone: () => resolve(),
        },
        new AbortController(),
      )
    })
    await done
    const ctx = hookCtxs().at(-1) as Record<string, unknown>
    expect(ctx.sessionId).toBe('conv_e2e')
    expect(ctx.taskId).toBe('turn_e2e_1')
    expect(ctx.turnIndex).toBe(0)
    // 红线：身份只进 context——线上字节（头与体）不得携带任何一项
    const wire = seen.at(-1)
    expect(wire?.body).toBe(body)
    expect(JSON.stringify(wire?.headers ?? {})).not.toContain('conv_e2e')
    expect(JSON.stringify(wire?.headers ?? {})).not.toContain('turn_e2e_1')
    expect(wire?.body).not.toContain('conv_e2e')
    expect(wire?.body).not.toContain('turn_e2e_1')
  })
})

// ── 3. 铸点纯函数 ──────────────────────────────────────────────────────

function msg(role: 'user' | 'assistant', blocks: Array<Record<string, unknown>>): AgentMessage {
  return { id: `m_${Math.random().toString(36).slice(2, 7)}`, role, contentBlocks: blocks as AgentMessage['contentBlocks'], createdAt: new Date().toISOString() }
}

describe('turn-identity pure functions', () => {
  it('countUserTurns counts real user text inputs only', () => {
    const messages = [
      msg('user', [{ type: 'text', text: '第一轮' }]),
      msg('assistant', [{ type: 'text', text: '回答' }]),
      // tool_result 载体：user 角色但无文本块——不算一轮
      msg('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ls 输出' }]),
      msg('assistant', [{ type: 'text', text: '又答' }]),
      // 空白文本不算（空 text 的 user 载体）
      msg('user', [{ type: 'text', text: '   ' }]),
    ]
    expect(countUserTurns(messages)).toBe(1)
    expect(countUserTurns([])).toBe(0)
  })

  it('a steer text appended mid-turn counts in the NEXT turn index', () => {
    const afterSteer = [
      msg('user', [{ type: 'text', text: '第一轮' }]),
      msg('user', [{ type: 'text', text: '转向：改成中文' }]),
    ]
    expect(countUserTurns(afterSteer)).toBe(2)
  })

  it('mintTurnId keeps the minted-id shape and uniqueness', () => {
    const a = mintTurnId()
    const b = mintTurnId()
    expect(a).toMatch(/^turn_\d+_[0-9a-z]+$/)
    expect(a).not.toBe(b)
  })
})

// ── 4. 接线扫描 ────────────────────────────────────────────────────────

const engineSrc = readFileSync(join(__dirname, '../src/renderer/src/agent/AgentEngine.ts'), 'utf-8')
const runnerSrc = readFileSync(join(__dirname, '../src/renderer/src/agent/engine/stream-runner.ts'), 'utf-8')
const proxySrc = readFileSync(join(__dirname, '../src/main/ipc/api-proxy.handler.ts'), 'utf-8')
const hookSrc = readFileSync(join(__dirname, '../src/main/llm-hook.ts'), 'utf-8')

describe('wiring scans', () => {
  it('prepareTurn is the ONLY mint site — in-turn re-issues keep the taskId', () => {
    // `this.currentTurnId =` 恰好一处：prepareTurn。retryLastTurn / steer /
    // continueLoop 刻意绕开 prepareTurn，所以它们保持原值（同轮重试不变）。
    const assignments = engineSrc.match(/this\.currentTurnId\s*=\s*/g) ?? []
    expect(assignments.length).toBe(1)
    // 铸点落在 prepareTurn 体内（与 loopCount 归零同段）
    expect(engineSrc).toMatch(/this\.currentTurnId = mintTurnId\(\)\s*\n\s*this\.currentTurnIndex = countUserTurns\(this\.messages\)/)
  })

  it('stream-runner forwards conversationId + turn identity into apiFetchStream', () => {
    expect(runnerSrc).toMatch(/const hookIdentity = \{/)
    expect(runnerSrc).toMatch(/sessionId: opts\.conversationId/)
    expect(runnerSrc).toMatch(/taskId: this\.engine\.currentTurnId \?\? undefined/)
    expect(runnerSrc).toMatch(/turnIndex: this\.engine\.currentTurnIndex \?\? undefined/)
    expect(runnerSrc).toMatch(/profileId: this\.engine\.opts\.profileId, \.\.\.hookIdentity/)
  })

  it('proxy passes LlmStreamOptions identity into the hook options', () => {
    expect(proxySrc).toMatch(/sessionId: options\.sessionId/)
    expect(proxySrc).toMatch(/taskId: options\.taskId/)
    expect(proxySrc).toMatch(/turnIndex: options\.turnIndex/)
  })

  it('llm-hook keeps absent keys absent (conditional arms, not unconditional assignment)', () => {
    expect(hookSrc).toMatch(/if \(opts\.sessionId !== undefined\) context\.sessionId = opts\.sessionId/)
    expect(hookSrc).toMatch(/if \(opts\.taskId !== undefined\) context\.taskId = opts\.taskId/)
    expect(hookSrc).toMatch(/if \(opts\.turnIndex !== undefined\) context\.turnIndex = opts\.turnIndex/)
  })
})
