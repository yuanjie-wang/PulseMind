// PLAN-workflow-engine：workflow-assistant 钉子——校验门、回喂重试一次、
// schema/few-shot/objective 规范在 prompt 中（wiring 扫描 + mock adapter）。

import { describe, expect, it, vi, beforeEach } from 'vitest'

const calls: Array<{ system: string; user: string }> = []
const replies: Array<string | Error> = []

vi.mock('../src/main/storage/settings-store', () => ({
  settingsStore: {
    get: async () => ({
      activeProfileId: 'p1',
      profiles: [{ id: 'p1', name: 'GPT', provider: 'openai', apiKey: 'sk-test', baseURL: 'https://api.test/v1', model: 'gpt-test', maxTokens: 4096 }],
    }),
  },
}))
vi.mock('../src/renderer/src/llm/OpenAIAdapter', () => ({
  openaiAdapter: {
    callNonStreaming: async (_key: string, _url: string, _model: string, system: string, messages: Array<{ content: string }>): Promise<string> => {
      calls.push({ system, user: messages[0]?.content ?? '' })
      const next = replies.shift()
      if (next instanceof Error) throw next
      return next ?? ''
    },
  },
}))
vi.mock('../src/renderer/src/llm/AnthropicAdapter', () => ({ anthropicAdapter: {} }))

import { assistWorkflow } from '../src/main/pipeline/workflow-assistant'

const validJson = JSON.stringify({
  id: 'assist-flow',
  name: '助手产物',
  entry: 'a',
  nodes: [{ id: 'a', title: 'A', prompt: '做 {{objective}}，结尾输出 PIPELINE_RESULT: {...}', verdicts: ['pass', 'fail'] }],
  edges: [{ from: 'a', when: 'pass', to: 'DONE' }],
})

describe('assistWorkflow', () => {
  beforeEach(() => {
    calls.length = 0
    replies.length = 0
  })

  it('校验通过的输出直达：ok + workflow；system prompt 携 schema/规范/few-shot 模板', async () => {
    replies.push(`\`\`\`json\n${validJson}\n\`\`\``)
    const res = await assistWorkflow('做一个单步流水线', '')
    expect(res.ok).toBe(true)
    expect(res.workflow?.id).toBe('assist-flow')
    expect(calls).toHaveLength(1)
    expect(calls[0].system).toContain('PIPELINE_RESULT')
    expect(calls[0].system).toContain('DONE')
    expect(calls[0].system).toContain('coding-pipeline') // few-shot 内置模板
    expect(calls[0].user).toContain('做一个单步流水线')
  })

  it('校验失败回喂重试一次：第二次调用带错误清单；两次都失败则透出错误', async () => {
    replies.push(
      JSON.stringify({
        id: 'bad',
        name: '坏',
        entry: 'a',
        nodes: [{ id: 'a', title: 'A', prompt: 'p', verdicts: ['pass'] }],
        edges: [{ from: 'a', when: 'SKIP', to: 'DONE' }],
      }),
      validJson,
    )
    const res = await assistWorkflow('改一下', '')
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[1].user).toContain('上次输出未过校验')
    expect(calls[1].user).toContain('verdicts')

    replies.push('{bad', '{bad')
    const failed = await assistWorkflow('再改', '')
    expect(failed.ok).toBe(false)
    expect(failed.errors?.length).toBeGreaterThan(0)
  })

  it('围栏缺省也解析（最外层花括号提取）；模型异常透出', async () => {
    replies.push(`前言 ${validJson} 后记`)
    const res = await assistWorkflow('x', '')
    expect(res.ok).toBe(true)
    replies.push(new Error('网络挂了'))
    const err = await assistWorkflow('x', '')
    expect(err.ok).toBe(false)
    expect(err.errors?.[0]).toContain('网络挂了')
  })


})
