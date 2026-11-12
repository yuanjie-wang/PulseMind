import { describe, expect, it, beforeEach } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { AgentEngine } from '../src/renderer/src/agent/AgentEngine'
import { collectEnabledTools } from '../src/renderer/src/agent/engine/tool-collection'
import { ToolManager } from '../src/renderer/src/tools/ToolManager'
import { SkillManager } from '../src/renderer/src/skills/SkillManager'

/**
 * M1.4 derisking probe: proves the whole agent graph (engine + tool executors
 * + prompt builder + caches + managers) constructs and runs under plain Node
 * with a mock host — no DOM, no electronAPI. This is the precondition for
 * hosting the engine in the Electron main process.
 */

let calls: string[] = []

function makeMockHost(): PulseHost {
  const record = (name: string) => (..._args: unknown[]) => {
    calls.push(name)
    return Promise.resolve([] as unknown[])
  }
  return {
    // stream listener registration returns an unsubscribe fn
    onApiStreamChunk: record('onApiStreamChunk'),
    onApiStreamError: record('onApiStreamError'),
    onApiStreamDone: record('onApiStreamDone'),
    onApiStreamRetry: record('onApiStreamRetry'),
    onTerminalOutput: record('onTerminalOutput'),
    onTerminalExit: record('onTerminalExit'),
    onTerminalError: record('onTerminalError'),
    onMcpServersChanged: record('onMcpServersChanged'),
    onSkillsChanged: record('onSkillsChanged'),
    mcpListServers: record('mcpListServers'),
    expertList: record('expertList'),
    getSkillPreferences: record('getSkillPreferences'),
    getSettings: () => Promise.resolve({ locale: 'zh' }),
    // Everything else: generic async no-op recorded for assertions.
    ...Object.fromEntries(
      [
        'apiAbortStream', 'apiFetch', 'apiFetchStream', 'execCommandSync', 'executeCommand',
        'killCommand', 'readFile', 'writeFile', 'editFile', 'patchFile', 'getFileStat',
        'convertFileToMarkdown', 'copyFileToTmp', 'saveBase64Image', 'gitInvoke',
        'mcpStartServer', 'mcpRegisterServer', 'mcpUpdateServerSummary', 'mcpCallTool',
        'setSkillPreferences', 'readSkillRaw', 'installSkill',
        'saveMemory', 'searchConversationsByKeyword', 'getToolResult',
        'getConversation', 'saveConversation', 'appendConversationMessages',
        'persistToolResults', 'saveConversationPlan', 'getConversationPlan',
      ].map(k => [k, record(k)]),
    ),
  } as unknown as PulseHost
}

beforeEach(() => {
  calls = []
  setHost(makeMockHost())
})

describe('agent graph under plain Node (M1.4 precondition)', () => {
  it('constructs a full engine with ToolManager + SkillManager and no DOM, warming caches via the host', async () => {
    // NOTE: this must be the file's first construction — mcp-cache memoizes
    // its init per module registry, so later constructions skip host calls.
    const engine = new AgentEngine({
      apiKey: 'test-key',
      baseURL: 'https://example.invalid',
      model: 'test-model',
      maxTokens: 1024,
      myName: 'tester',
      soul: '',
      yourName: 'user',
      adapter: {} as never, // adapters are host-clean; not exercised at construction
      toolManager: new ToolManager(),
      skillManager: new SkillManager(),
      conversationId: 'conv_test',
    })
    expect(engine.messages).toEqual([])
    expect(engine.agentStatus.status).toBe('idle')
    // ensureCache is fire-and-forget; give the microtask queue a beat.
    await new Promise(r => setTimeout(r, 20))
    expect(calls).toContain('mcpListServers')
  })

  it('collectEnabledTools resolves to an array via ToolManager + host caches', async () => {
    const tm = new ToolManager()
    const engine = new AgentEngine({
      apiKey: 'test-key', baseURL: 'https://example.invalid', model: 'm', maxTokens: 1024,
      myName: '', soul: '', yourName: '', adapter: {} as never,
      toolManager: tm, skillManager: new SkillManager(), conversationId: 'conv_test',
    })
    // collectEnabledTools is now a standalone function over a deps object —
    // the engine instance satisfies ToolCollectionDeps structurally.
    const tools = await collectEnabledTools(engine, tm)
    expect(Array.isArray(tools)).toBe(true)
  })
})
