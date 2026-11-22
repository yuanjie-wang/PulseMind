// 生产侧 copyCalibration 配对日志（任务 4）。
//
// review_20261122.md §0：逐请求 `lastBuildCopyEstimate ↔ usage.inputTokens`
// 的配对在事后取不到，因为 renderer console 不进 main.log、DB 不存 API copy、
// llm-requests 转储被修剪。这里用真 AgentEngine 驱动 noteCopyCalibration，
// 钉住「同一行里同时有 raw / wire / 钳前比 / 钳后因子 / 是否触钳」，以及
// 这行确实走了宿主诊断通道（打包版能落盘），而不只是 console.log。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { AgentEngine } from '../src/renderer/src/agent/AgentEngine'
import { ToolManager } from '../src/renderer/src/tools/ToolManager'
import { SkillManager } from '../src/renderer/src/skills/SkillManager'

const lines: Array<{ source: string; message: string }> = []

function host(): PulseHost {
  return {
    logDiagnostic: (source: string, message: string) => { lines.push({ source, message }) },
    getSettings: () => Promise.resolve({ locale: 'zh' }),
    onApiStreamChunk: () => () => {},
    onApiStreamError: () => () => {},
    onApiStreamDone: () => () => {},
    onApiStreamRetry: () => () => {},
    onTerminalOutput: () => () => {},
    onTerminalExit: () => () => {},
    onTerminalError: () => () => {},
    onMcpServersChanged: () => () => {},
    onSkillsChanged: () => () => {},
    mcpListServers: async () => [],
    expertList: async () => [],
    getSkillPreferences: async () => null,
  } as unknown as PulseHost
}

function engine(): AgentEngine {
  return new AgentEngine({
    apiKey: 'test-key',
    baseURL: 'https://example.invalid',
    model: 'test-model',
    maxTokens: 1024,
    myName: 'tester',
    soul: '',
    yourName: 'user',
    adapter: {} as never,
    toolManager: new ToolManager(),
    skillManager: new SkillManager(),
    conversationId: 'conv_calibration_log',
  })
}

beforeEach(() => {
  lines.length = 0
  setHost(host())
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe('noteCopyCalibration — durable raw/wire pair', () => {
  it('logs both sides of the pair plus the clamp verdict, through the host sink', () => {
    const e = engine()
    e.lastBuildCopyEstimate = 100_000
    e.noteCopyCalibration(32_500)          // wanted 0.325 — inside [0.2, 2.5]

    expect(lines).toHaveLength(1)
    const { source, message } = lines[0]
    expect(source).toBe('ContextCalibration')
    expect(message).toContain('raw=100000')
    expect(message).toContain('wire=32500')
    expect(message).toContain('want=0.3250')
    expect(message).toContain('applied=0.3250')
    expect(message).toContain('clamp=no')
    expect(message).toContain('conv=conv_calibration_log')
  })

  it('flags a clamped outlier without losing the measured wire', () => {
    const e = engine()
    e.lastBuildCopyEstimate = 100_000
    e.noteCopyCalibration(1_000)           // wanted 0.01 → floor

    expect(lines).toHaveLength(1)
    expect(lines[0].message).toContain('wire=1000')
    expect(lines[0].message).toContain('want=0.0100')
    expect(lines[0].message).toContain('applied=0.2000')
    expect(lines[0].message).toContain('clamp=hit')
  })

  it('is a no-op without a report or a prior build', () => {
    const e = engine()
    e.noteCopyCalibration(0)
    e.noteCopyCalibration(Number.NaN)
    e.lastBuildCopyEstimate = 0
    e.noteCopyCalibration(50_000)
    expect(lines).toHaveLength(0)
  })

  it('never lets a missing host break the request', () => {
    setHost(null as unknown as PulseHost)
    const e = engine()
    e.lastBuildCopyEstimate = 10_000
    expect(() => e.noteCopyCalibration(5_000)).not.toThrow()
  })
})
