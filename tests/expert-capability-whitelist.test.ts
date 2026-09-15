import { describe, expect, it, beforeEach } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { AgentEngine } from '../src/renderer/src/agent/AgentEngine'
import { collectEnabledTools } from '../src/renderer/src/agent/engine/tool-collection'
import { ToolManager } from '../src/renderer/src/tools/ToolManager'
import { SkillManager } from '../src/renderer/src/skills/SkillManager'
import type { SkillDefinition } from '../src/shared/types/skill-types'

/**
 * 可用能力白名单的三态语义（专家 / 子代理）在工具集合上的落地：
 *   - undefined（无专家包）→ 不限制，pick_skill 照常列出全部技能
 *   - 非空数组           → 只列出勾选的技能
 *   - 空数组             → 一个技能都不列（不是「不限制」）
 * 运行时拦截（execPickSkill / pick_tool）读的是同一份 opts。
 */

function makeMockHost(): PulseHost {
  const noop = () => Promise.resolve([] as unknown[])
  const keys = [
    'onApiStreamChunk', 'onApiStreamError', 'onApiStreamDone', 'onApiStreamRetry',
    'onTerminalOutput', 'onTerminalExit', 'onTerminalError', 'onMcpServersChanged',
    'onSkillsChanged', 'mcpListServers', 'expertList', 'getSkillPreferences',
    'apiAbortStream', 'apiFetch', 'apiFetchStream', 'execCommandSync', 'executeCommand',
    'killCommand', 'readFile', 'writeFile', 'editFile', 'patchFile', 'getFileStat',
    'saveBase64Image', 'gitInvoke', 'mcpStartServer', 'mcpRegisterServer',
    'mcpUpdateServerSummary', 'mcpCallTool', 'setSkillPreferences', 'readSkillRaw',
    'installSkill', 'readExperienceRecord', 'touchExperienceRecord', 'saveMemory',
  ]
  return {
    ...Object.fromEntries(keys.map((k) => [k, noop])),
    getSettings: () => Promise.resolve({ locale: 'zh' }),
  } as unknown as PulseHost
}

const skill = (name: string): SkillDefinition => ({
  name,
  description: `${name} 的用途`,
  category: 'user',
  systemPrompt: 'body',
})

function makeEngine(opts: { allowedSkills?: string[] }): { engine: AgentEngine; toolManager: ToolManager } {
  const toolManager = new ToolManager()
  // A bare ToolManager starts with nothing enabled (the app's settings store
  // supplies the persisted list) — pick_skill must be on for these assertions.
  toolManager.applyPreferences({ enabledTools: ['pick_skill'] })
  const skillManager = new SkillManager()
  skillManager.registerSkill(skill('code-review'))
  skillManager.registerSkill(skill('longform-writing'))
  const engine = new AgentEngine({
    apiKey: 'test-key',
    baseURL: 'https://example.invalid',
    model: 'm',
    maxTokens: 1024,
    myName: '',
    soul: '',
    yourName: '',
    adapter: {} as never,
    toolManager,
    skillManager,
    conversationId: 'conv_whitelist',
    ...opts,
  })
  return { engine, toolManager }
}

const pickSkillDescription = async (engine: AgentEngine, toolManager: ToolManager): Promise<string> => {
  const tools = await collectEnabledTools(engine, toolManager)
  return tools.find((t) => t.name === 'pick_skill')?.description ?? ''
}

describe('可用技能白名单 → pick_skill 描述', () => {
  beforeEach(() => setHost(makeMockHost()))

  it('lists every enabled skill when the session has no whitelist', async () => {
    const { engine, toolManager } = makeEngine({})
    const desc = await pickSkillDescription(engine, toolManager)
    expect(desc).toContain('code-review')
    expect(desc).toContain('longform-writing')
  })

  it('lists only the allowed skills for a non-empty whitelist', async () => {
    const { engine, toolManager } = makeEngine({ allowedSkills: ['code-review'] })
    const desc = await pickSkillDescription(engine, toolManager)
    expect(desc).toContain('code-review')
    expect(desc).not.toContain('longform-writing')
  })

  it('lists no skill at all for an empty whitelist', async () => {
    const { engine, toolManager } = makeEngine({ allowedSkills: [] })
    const desc = await pickSkillDescription(engine, toolManager)
    expect(desc).not.toContain('code-review')
    expect(desc).not.toContain('longform-writing')
    expect(desc).not.toContain('Available skills')
  })
})

describe('applyExpertContext 的白名单透传', () => {
  beforeEach(() => setHost(makeMockHost()))

  const pack = (skills: string[]) => ({
    id: 'expert-x',
    name: '无能力专家',
    instructions: '# Expert Mode: 无能力专家',
    allowedSkills: skills,
    allowedMcpServers: [],
  })

  it('keeps an empty whitelist as a restriction rather than collapsing it to undefined', async () => {
    const { engine, toolManager } = makeEngine({})
    engine.applyExpertContext(pack([]))
    expect(engine.opts.allowedSkills).toEqual([])
    expect(engine.opts.allowedMcpServers).toEqual([])
    expect(engine.allowedMcpServersSet?.size).toBe(0)
    const desc = await pickSkillDescription(engine, toolManager)
    expect(desc).not.toContain('code-review')
  })

  it('restores the unrestricted session when the expert pack is unbound', () => {
    const { engine } = makeEngine({})
    engine.applyExpertContext(pack([]))
    engine.applyExpertContext(null)
    expect(engine.opts.allowedSkills).toBeUndefined()
    expect(engine.opts.allowedMcpServers).toBeUndefined()
    expect(engine.allowedMcpServersSet).toBeUndefined()
  })

  it('never widens a whitelist that came from construction (spawn sub-agent)', () => {
    // A spawned engine receives its whitelists via options with no expert pack,
    // so applyExpertContext(null) is a no-op for it — clearing here would
    // silently hand a restricted sub-agent the full toolset.
    const { engine } = makeEngine({ allowedSkills: [] })
    engine.applyExpertContext(null)
    expect(engine.opts.allowedSkills).toEqual([])
  })
})
