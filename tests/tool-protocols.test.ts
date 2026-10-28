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
    expect(protocols).toBe('') // export_document + office_edit 都是 gated —— 手册一个都不进主干
  })

  it('the manual rides the pick_tool activation result instead (source-scanned)', () => {
    const src = readFileSync('src/renderer/src/agent/executors/pick-tool.ts', 'utf8')
    expect(src).toContain('instructions: def.instructions') // 候选带上手册
    expect(src).toContain('### Usage Protocols') // 激活结果携带手册节
  })
})

const allEnabled = new Set(['export_document', 'office_edit'])

// 2026-10-26 (user ruling, 系统提示词瘦身): the browser tool's 5.4K manual —
// the single largest non-office protocol — left the trunk for the `browser`
// built-in skill (skills/built-in/browser.ts), loaded on demand via
// pick_skill. This supersedes the half-applied 2026-10-25 "gate the tool"
// sketch: the tool stays ALWAYS-ON (its schema is ~0.7K), its instructions are
// a slim pointer, and the full protocol text lives on the skill side. Pin both
// halves so neither half of the move can silently regress.
describe('browser manual lives in the built-in skill, not the shared trunk', () => {
  const browserDef = BUILT_IN_TOOLS.find((t) => t.name === 'browser')!

  it('the tool stays always-on with a slim instructions pointer (no triggers)', () => {
    // availability 未设即 'always' —— 门控是那版被推翻的 A 方案，钉住别复活。
    expect(browserDef.availability).not.toBe('gated')
    // 工具侧 triggers 只喂门控扫描，常驻工具上就是死配置。
    expect(browserDef.triggers).toBeUndefined()
    const manual = (browserDef.instructions || '').trim()
    expect(manual.startsWith('## browser')).toBe(true)
    expect(manual.length).toBeLessThan(600)
    expect(manual).toContain("pick_skill(name='browser')")
  })

  it('the full manual text is out of the trunk and present in the skill body', async () => {
    const { BUILT_IN_SKILLS } = await import('../src/renderer/src/skills/built-in-skills')
    const protocols = buildToolProtocols(BUILT_IN_TOOLS)
    const skill = BUILT_IN_SKILLS.find((s) => s.name === 'browser')!

    // 手册特征串：trunk 里绝不出现，技能正文里必须在。
    for (const distinctive of ['FRAME-PREFIXED', '### Calling convention', 'Sandbox & kernel notes']) {
      expect(protocols).not.toContain(distinctive)
      expect(skill.systemPrompt).toContain(distinctive)
    }
    // 触发词播种进 state block 的 matchSkills（沿 A 方案拟定的关键词集）。
    expect(skill.triggers).toEqual(['浏览器', '网页', '网址', '网站', 'browser'])
    expect(skill.builtIn).toBe(true)
  })
})

// ── edit 手册的 diff 形态教学（2026-10-29，计算器会话实测事故：deepseek-
// v4.1-flash 的首个 diff 用裸 `@@` 当 hunk 头被整单拒收）。上游教学此前只有
// 「纯插入 = @@ -start,0 +start,count @@」一个括号提过完整头形状，hunk 头语法
// 全靠失败时教。现在 Rules 里补：完整语法 + 计数口径 + 裸 @@ 的后果 + 三行示例
// （static per toolset，一次性 re-bill，当场消除格式猜测）。
describe('edit manual teaches the hunk-header contract', () => {
  // 钉运行时手册（BUILT_IN_TOOLS 携带的 instructions，即模型实际收到的字节），
  // 不钉 tool-instructions.ts 源码——源码里模板字符串的反引号是转义形态，
  // 扫源码既绕又测不到真实注入值。
  const editManual = (BUILT_IN_TOOLS.find((t) => t.name === 'edit')!.instructions || '').trim()

  it('states the full header grammar with the count arithmetic', () => {
    expect(editManual).toContain('@@ -start,count +start,count @@')
    expect(editManual).toContain('old = context + removed, new = context + added')
    expect(editManual).toContain('`start` is the file line number read printed')
  })

  it('names the bare-@@ failure and its consequence', () => {
    expect(editManual).toContain('a bare `@@` parses as nothing and rejects the whole call')
  })

  it('carries a 3-line example whose header counts equal its own body sums', () => {
    // 示例头 -12,2 +12,2 配 1 上下文 + 1 删 + 1 增：applyPatch 的 splice 按
    // 头的 oldCount 吃区间，虚高的计数会静默吞掉 hunk 后一行——示例的算术
    // 必须自洽，否则教给最爱照抄的那批模型的是吃行形状。
    expect(editManual).toContain(
      [
        '```',
        '  @@ -12,2 +12,2 @@',
        '   unchanged context line',
        '  -removed line',
        '  +new line',
        '  ```',
      ].join('\n'),
    )
  })
})
