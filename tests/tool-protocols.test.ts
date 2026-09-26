import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const { BUILT_IN_TOOLS } = await import('../src/renderer/src/tools/built-in-tools')
const { buildToolProtocols } = await import('../src/renderer/src/agent/engine/tool-collection')
const { buildSystemPrompt } = await import('../src/renderer/src/agent/system-prompt-builder')
import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'

/**
 * 内建工具的 `instructions` 使用手册（tool-instructions.ts，36 篇，每篇自带
 * `## <tool>` 标题）曾经只被赋值、从未被注入任何请求——模型只看得到两三句的
 * description。实测后果（2026-09-16 猪的位置查询会话）：mimo-v2.5 在收到
 * completed 的 spawn_agent 结果后连续重新委派同一任务 5 次，因为没有任何
 * 文本告诉它「结果就是交付物，汇报后继续，不要重复委派」。
 *
 * 修复 = 把启用工具集的 protocols 注入 system prompt（Tool Protocols 节），
 * 并给 spawn_agent 的手册补上「一次任务一次委派」的红线。这里钉住三件事：
 * 协议节的内容、它在 prompt 里的位置（工具约定区，Session State 通知之前）、
 * 以及 prepareLoopRequest 确实从最终工具集接线（源码扫描——引擎挂载太重，
 * vitest 是 node 环境跑不了完整请求构建）。
 */
describe('tool protocols: enabled tools carry their manuals into the system prompt', () => {
  it('builds one section per NON-gated instruction, from the real built-in defs', () => {
    const protocols = buildToolProtocols(BUILT_IN_TOOLS)

    expect(protocols).toContain('# Tool Protocols')
    expect(protocols).toContain('## spawn_agent')
    // The loop fix itself: the no-re-dispatch red line ships with the manual.
    expect(protocols).toContain('One delegation per task')
    expect(protocols).toContain('## read')

    // Exactly one section per NON-gated def that HAS instructions — gated
    // manuals are excluded (2026-09-26): they ride the pick_tool activation
    // result instead, so the system prompt is byte-identical across
    // conversations with different activation states (the shared trunk).
    const withInstructions = BUILT_IN_TOOLS.filter((t) => (t.instructions || '').trim().length > 0 && t.availability !== 'gated')
    const sections = protocols.match(/^## /gm) || []
    expect(sections.length).toBe(withInstructions.length)
    expect(protocols).not.toContain('undefined')
    // A gated manual's distinctive content must stay out of the trunk.
    expect(protocols).not.toContain('python-pptx')
  })

  it('returns empty for an empty toolset and tolerates undefined instructions', () => {
    expect(buildToolProtocols([])).toBe('')
    expect(buildToolProtocols([{ instructions: undefined }, { instructions: '' }])).toBe('')
    const out = buildToolProtocols([{ instructions: undefined }, { instructions: '## a\nbody' }])
    expect(out).toContain('## a')
    expect(out).not.toContain('undefined')
  })

  it('lands in the system prompt before the Session State notice', async () => {
    const protocols = buildToolProtocols(BUILT_IN_TOOLS)
    const opts = {
      myName: 'tester', soul: '', yourName: 'user',
    } as unknown as AgentEngineOptions
    const { systemPrompt } = await buildSystemPrompt({ opts, messages: [], plan: null, toolProtocols: protocols })

    expect(systemPrompt).toContain('## spawn_agent')
    const at = systemPrompt.indexOf('# Tool Protocols')
    expect(at).toBeGreaterThan(-1)
    // Tool conventions live together: protocols come before the per-turn
    // state notice and the wire-format block that follow them in parts order.
    expect(at).toBeLessThan(systemPrompt.indexOf('## Session State'))
  })

  it('is ignored on the spawned-sub-agent path (a spawn prompt owns its system message)', async () => {
    const opts = { myName: 'tester', soul: '', yourName: 'user' } as unknown as AgentEngineOptions
    const { systemPrompt } = await buildSystemPrompt({
      opts, messages: [], plan: null,
      spawnSystemPrompt: 'OWN PROMPT',
      toolProtocols: '# Tool Protocols\n\nshould not appear',
    })
    expect(systemPrompt).toBe('OWN PROMPT')
  })

  it('prepareLoopRequest builds protocols from the final toolset before building the prompt (source-scanned)', () => {
    const src = readFileSync('src/renderer/src/agent/AgentEngine.ts', 'utf8')
    // Non-vacuity: the wiring exists, exactly once, in the right order.
    expect(src.match(/collectEnabledTools\(this, toolManager\)/g)?.length).toBe(1)
    const collect = src.indexOf('const enabledTools = await collectEnabledTools(this, toolManager)')
    const build = src.indexOf('const toolProtocols = buildToolProtocols(enabledTools)')
    const pass = src.indexOf('toolProtocols,')
    expect(collect).toBeGreaterThan(-1)
    expect(build).toBeGreaterThan(collect)
    expect(pass).toBeGreaterThan(build)
  })
})

// PLAN-pptx-export follow-up: the user report 「模型总想用 python-pptx 生成 PPT」
// was a tool-SELECTION failure. The export manual's decision tree must still
// reach the model — but since 2026-09-26 export_document is gate-activated and
// its manual deliberately does NOT ride the shared system prompt (gated
// manuals would fragment the cross-conversation trunk); it rides the pick_tool
// activation result instead. Both halves are pinned: absent from protocols,
// present in the activation result's construction (source-scanned).
describe('export_document manual reaches the model without entering the shared trunk', () => {
  it('gated manuals stay out of buildToolProtocols even for an all-gated toolset', async () => {
    const protocols = buildToolProtocols(BUILT_IN_TOOLS.filter((t) => allEnabled.has(t.name)))
    expect(protocols).toBe('') // export_document + pptx_edit 都是 gated —— 手册一个都不进主干
  })

  it('the manual rides the pick_tool activation result instead (source-scanned)', () => {
    const src = readFileSync('src/renderer/src/agent/executors/pick-tool.ts', 'utf8')
    expect(src).toContain('instructions: def.instructions') // 候选带上手册
    expect(src).toContain('### Usage Protocols') // 激活结果携带手册节
  })
})

const allEnabled = new Set(['export_document', 'pptx_edit'])
