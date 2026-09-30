// ── ask_user parks on hosted sessions, refuses only on spawned sub-agents ──
// The 任务创建助手 reported 「ask_user is not available in sub-agent mode」:
// the ask_user park gate in handleToolUseResponse keyed on `spawnSystemPrompt`,
// which the assistants' pinned override ALSO occupies (AgentEngine stores
// systemPromptOverride there) — so a form assistant was mistaken for a spawned
// agent, which is the one runtime with no user channel and the only one where
// refusing ask_user is correct. The fix is the explicit `isSpawnedSubAgent`
// flag; this file pins BOTH sides with the real engine:
//
//   · assistant (spawnSystemPrompt set, not spawned) → parks
//     awaiting_user_input, block stays running, no tool_result — the chips can
//     answer it via respondToTool;
//   · spawned sub-agent → settles an error tool_result and the loop drains.
//
// Non-vacuity: reverting the guard to `spawnSystemPrompt` fails the assistant
// park test (measured), because that is exactly the pre-fix shape.

import { describe, expect, it, beforeEach } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { AgentEngine } from '../src/renderer/src/agent/AgentEngine'
import { ToolManager } from '../src/renderer/src/tools/ToolManager'
import { SkillManager } from '../src/renderer/src/skills/SkillManager'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

function makeMockHost(): PulseHost {
  const record = () => () => Promise.resolve([] as unknown[])
  return {
    onApiStreamChunk: record(),
    onApiStreamError: record(),
    onApiStreamDone: record(),
    onApiStreamRetry: record(),
    onTerminalOutput: record(),
    onTerminalExit: record(),
    onTerminalError: record(),
    onMcpServersChanged: record(),
    onSkillsChanged: record(),
    mcpListServers: record(),
    expertList: record(),
    getSkillPreferences: record(),
    getSettings: () => Promise.resolve({ locale: 'zh' }),
    ...Object.fromEntries(
      [
        'apiAbortStream', 'apiFetch', 'apiFetchStream', 'execCommandSync', 'executeCommand',
        'killCommand', 'readFile', 'writeFile', 'editFile', 'patchFile', 'getFileStat',
        'convertFileToMarkdown', 'copyFileToTmp', 'saveBase64Image', 'gitInvoke',
        'mcpStartServer', 'mcpRegisterServer', 'mcpUpdateServerSummary', 'mcpCallTool',
        'setSkillPreferences', 'readSkillRaw', 'installSkill', 'readExperienceRecord',
        'touchExperienceRecord', 'saveMemory', 'searchConversationsByKeyword', 'getToolResult',
        'getConversation', 'saveConversation', 'appendConversationMessages',
        'persistToolResults', 'saveConversationPlan', 'getConversationPlan',
      ].map(k => [k, record(k)]),
    ),
  } as unknown as PulseHost
}

/** 助手形状：pinned override 占着 spawnSystemPrompt（AgentEngine:348 的既有
 *  映射）——这正是修复前被误判成子代理的那个形状。空 apiKey 让批末
 *  continueLoop 落在 no-key 守卫上，可断言、无 LLM 调用。 */
function makeAssistantEngine(): AgentEngine {
  return new AgentEngine({
    apiKey: '',
    baseURL: 'https://example.invalid',
    model: 'test-model',
    maxTokens: 512,
    myName: '',
    soul: '',
    yourName: '',
    adapter: {} as never,
    toolManager: new ToolManager(),
    skillManager: new SkillManager(),
    conversationId: 'routine_assist_demo',
    systemPromptOverride: '你是「日常任务」编辑器的表单助手。',
  })
}

const makeAskUser = (id: string): ToolUseBlock =>
  ({
    type: 'tool_use',
    id,
    name: 'ask_user',
    input: { prompt: '定时用 cron 还是自然语言？', choices: ['cron 表达式', '自然语言描述'] },
    status: 'pending',
  }) as ToolUseBlock

const toolResults = (engine: AgentEngine): Array<{ tool_use_id: string; is_error?: boolean; content?: string }> =>
  engine.messages
    .flatMap(m => m.contentBlocks)
    .filter((b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result') as Array<{ tool_use_id: string; is_error?: boolean; content?: string }>

describe('ask_user: hosted sessions park, spawned agents refuse', () => {
  beforeEach(() => setHost(makeMockHost()))

  it('assistant with a pinned override parks awaiting_user_input (the reported bug)', async () => {
    const engine = makeAssistantEngine()
    // The override really did land in spawnSystemPrompt — the very field the
    // old guard used, which is why the assistant was mistaken for a sub-agent.
    expect(engine.spawnSystemPrompt).toBe('你是「日常任务」编辑器的表单助手。')
    expect(engine.isSpawnedSubAgent).toBe(false)

    const ask = makeAskUser('tu_assist')
    await engine.handleToolUseResponse([ask])

    expect(engine.agentStatus).toMatchObject({ status: 'awaiting_user_input' })
    // 'queued' since the 排队中/执行中 split (2026-09-30): nothing dispatches
    // ask_user — it parks accepted-but-waiting until respondToTool settles it.
    // The header glyph is the hourglass either way.
    expect(ask.status).toBe('queued')
    // Nothing settles the call — respondToTool (the chips) owns it from here.
    expect(toolResults(engine)).toHaveLength(0)
  })

  it('spawned sub-agent still refuses: error tool_result, loop drains', async () => {
    const engine = makeAssistantEngine()
    // spawn-manager's exact shape: same pinned prompt field, PLUS the flag.
    engine.spawnSystemPrompt = '专家提示词'
    engine.isSpawnedSubAgent = true

    const ask = makeAskUser('tu_spawn')
    await engine.handleToolUseResponse([ask])

    const results = toolResults(engine)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
    expect(results[0].content).toContain('not available in sub-agent mode')
    // The refusal settles the batch and the loop drains (no-key guard).
    expect(engine.agentStatus).toEqual({ status: 'error', error: 'API key not configured' })
  })

  it('respondToTool on a parked assistant settles the answer and continues', async () => {
    const engine = makeAssistantEngine()
    const ask = makeAskUser('tu_answer')
    await engine.handleToolUseResponse([ask])
    expect(engine.agentStatus).toMatchObject({ status: 'awaiting_user_input' })

    engine.respondToTool('tu_answer', 'cron 表达式')
    const results = toolResults(engine)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(false)
    expect(results[0].content).toBe('cron 表达式')
    expect(engine.agentStatus).toEqual({ status: 'error', error: 'API key not configured' })
  })

  it('answering a RESTORED ask_user card continues the loop (app exited mid-park)', async () => {
    // The reported shape (2026-09-30): the app exits while the turn is parked
    // on ask_user; on re-entry hydrate seeds the parked turn into a fresh
    // engine via loadConversation — which freezes through cancelLoop/
    // stopExecution and used to leave isCancelled raised. The card stayed
    // interactive (the block is whatever the DB kept), but the answer's
    // addToolResult → continueLoop hit the cancelled guard and died silently:
    // the card flipped to 已选择 and the task never continued. Every other
    // re-entry (new message / retry / 继续执行) resets the flag itself; the
    // card-answer entry is the one that does not pass through prepareTurn.
    const engine = makeAssistantEngine()
    engine.loadConversation([
      { id: 'msg_a', role: 'user', contentBlocks: [{ type: 'text', text: '帮我配置定时任务' }], createdAt: new Date().toISOString() },
      { id: 'msg_b', role: 'assistant', contentBlocks: [makeAskUser('tu_restored')], createdAt: new Date().toISOString() },
    ])

    engine.respondToTool('tu_restored', '自然语言描述')
    const results = toolResults(engine)
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('自然语言描述')
    // The loop re-issued and landed on the assertable no-key guard — with the
    // gate still raised this stays `{ status: 'idle' }` (the silent no-op).
    expect(engine.agentStatus).toEqual({ status: 'error', error: 'API key not configured' })
  })
})
