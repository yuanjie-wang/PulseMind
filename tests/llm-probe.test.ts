// 连通性测试的纯逻辑（shared/llm/probe.ts）：URL 构造与两个 LLM adapter 的
// buildRequest 同构（ trailing slash 规整 + provider 路径），HTTP 状态码与
// 网络错误翻成人话并给出下一步动作。

import { describe, expect, it } from 'vitest'
import {
  buildProbeUrl,
  buildProbeHeaders,
  buildProbeBody,
  probeMissingFields,
  describeHttpProbeFailure,
  describeNetworkProbeFailure,
} from '../src/shared/llm/probe'

describe('buildProbeUrl — 与 adapter 的 URL 拼法同构', () => {
  it('openai: 去 trailing slash + /chat/completions', () => {
    expect(buildProbeUrl('openai', 'https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/chat/completions')
  })
  it('anthropic: /v1/messages', () => {
    expect(buildProbeUrl('anthropic', 'https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages')
  })
  it('多个 trailing slash 一次去净', () => {
    expect(buildProbeUrl('openai', 'https://x.example.com///')).toBe('https://x.example.com/chat/completions')
  })
})

describe('probe 请求构造', () => {
  it('anthropic 头带 x-api-key + anthropic-version；openai 带 Bearer', () => {
    expect(buildProbeHeaders('anthropic', 'sk-1')).toEqual({
      'Content-Type': 'application/json',
      'x-api-key': 'sk-1',
      'anthropic-version': '2023-06-03',
    })
    expect(buildProbeHeaders('openai', 'sk-2').Authorization).toBe('Bearer sk-2')
  })
  it('探测请求 max_tokens=1、单条 user 消息 —— 最小计费面', () => {
    const body = JSON.parse(buildProbeBody('openai', 'gpt-x'))
    expect(body.max_tokens).toBe(1)
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }])
    expect(body.model).toBe('gpt-x')
  })
})

describe('probeMissingFields —— main 与 renderer 的同一个守卫', () => {
  it('按 Base URL → 模型名 → API Key 的顺序报第一个缺失', () => {
    expect(probeMissingFields({})).toBe('Base URL')
    expect(probeMissingFields({ baseURL: 'https://x' })).toBe('模型名')
    expect(probeMissingFields({ baseURL: 'https://x', model: 'm' })).toBe('API Key')
    expect(probeMissingFields({ baseURL: 'https://x', model: 'm', apiKey: 'k' })).toBeNull()
  })
  it('纯空白视为缺失', () => {
    expect(probeMissingFields({ baseURL: '   ', model: 'm', apiKey: 'k' })).toBe('Base URL')
  })
})

describe('describeHttpProbeFailure —— 状态码 → 人话 + 下一步', () => {
  it('401/403 → Key 无效', () => {
    for (const status of [401, 403]) {
      const r = describeHttpProbeFailure(status, '')
      expect(r.message).toContain('API Key')
      expect(r.hint).toBeTruthy()
    }
  })
  it('404 → 路径不存在，提示 /v1 结尾', () => {
    const r = describeHttpProbeFailure(404, '')
    expect(r.message).toContain('路径不存在')
    expect(r.hint).toContain('/v1')
  })
  it('400 且 body 是模型身份错误 → 模型名问题；否则 Base URL 组合', () => {
    expect(describeHttpProbeFailure(400, '{"error":"model not found"}').message).toContain('模型名')
    const other = describeHttpProbeFailure(400, '{"error":"bad request"}')
    expect(other.message).not.toContain('模型名')
  })
  it('400 且 body 是网关上游故障 → 「上游暂时不可用」而非模型名误报（OpenCode Zen 实测形态）', () => {
    const zen = describeHttpProbeFailure(400, '{"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}')
    expect(zen.message).toContain('上游暂时不可用')
    expect(zen.message).not.toContain('模型名')
    expect(zen.detail).toContain('Upstream request failed')
    // 其他网关措辞
    for (const body of ['upstream error', 'all models at capacity', 'provider is overloaded, try again later']) {
      expect(describeHttpProbeFailure(400, body).message).toContain('上游暂时不可用')
    }
  })
  it('400 且 body 是各家真实的模型身份错误 → 仍报「模型名」', () => {
    // OpenAI 兼容网关（code=model_not_found）
    expect(
      describeHttpProbeFailure(400, '{"error":{"message":"The model `gpt-5-turbo` does not exist or you do not have access to it.","code":"model_not_found"}}')
        .message,
    ).toContain('模型名')
    // DeepSeek
    expect(describeHttpProbeFailure(400, '{"err_msg":"Model Not Exist"}').message).toContain('模型名')
    // Ollama（带引号模型名隔开 not found）
    expect(describeHttpProbeFailure(400, `{"error":"model 'llama3:70b' not found, try pulling it first"}`).message).toContain('模型名')
    // 中文网关
    expect(describeHttpProbeFailure(400, '{"error":{"message":"模型不存在或无权访问"}}').message).toContain('模型名')
    // 模型名分支现在带原始响应体留痕
    expect(describeHttpProbeFailure(400, '{"error":"model not found"}').detail).toContain('model')
  })
  it('429 → 网络是通的，指向额度/频率', () => {
    const r = describeHttpProbeFailure(429, '')
    expect(r.message).toContain('额度不足')
    expect(r.hint).toContain('连接没问题')
  })
  it('5xx → 服务商服务端错误，带响应体留痕', () => {
    const r = describeHttpProbeFailure(503, 'upstream unavailable')
    expect(r.message).toContain('服务端错误')
    expect(r.detail).toContain('upstream')
  })
  it('未知状态 → 带状态号的兜底', () => {
    expect(describeHttpProbeFailure(418, '').message).toContain('418')
  })
})

describe('describeNetworkProbeFailure —— fetch 异常链 → 人话', () => {
  it('ENOTFOUND → 域名无法解析（检查 cause 链）', () => {
    const err = new Error('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.example.com') })
    const r = describeNetworkProbeFailure(err)
    expect(r.message).toContain('域名无法解析')
  })
  it('ECONNREFUSED → 连接被拒绝（本地模型端口提示）', () => {
    const err = new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:11434') })
    const r = describeNetworkProbeFailure(err)
    expect(r.message).toContain('连接被拒绝')
    expect(r.hint).toContain('11434')
  })
  it('证书问题 → 证书校验失败', () => {
    const err = new Error('unable to verify the first certificate')
    expect(describeNetworkProbeFailure(err).message).toContain('证书')
  })
  it('超时 → 连接超时', () => {
    const r = describeNetworkProbeFailure(new Error('Request timed out'))
    expect(r.message).toBe('连接超时')
  })
  it('未知错误 → 兜底且带原始文本留痕', () => {
    const r = describeNetworkProbeFailure(new Error('some weird failure'))
    expect(r.message).toBe('无法连接到服务')
    expect(r.detail).toContain('some weird failure')
  })
})
