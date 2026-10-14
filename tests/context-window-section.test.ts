import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildContextWindowSection } from '../src/renderer/src/agent/system-prompt-builder'

/**
 * 上下文窗口仪表上送（user 2026-10-10）。
 *
 * 背景：context_compact 的守卫 ③ 以 `contextTokens() < contextLength × 0.55`
 * 拒绝调用，但这个数此前从不上送——模型对窗口占用全盲，「判断阶段边界」
 * 只能靠读感，试探性调用浪费一轮。修复：state block 加 `## Context Window`
 * 节，数字 = 引擎自己的估算（与守卫同一个 contextTokens()，不是 UI 环的
 * wire 锚点），模型看到的数就是裁决它的数。
 *
 * 载体纪律：state block 是逐回合易变值的钦点载体，且是请求最后一条消息
 * ——它变了只重计自己；钟每请求都变，尾部重计费本来就在付。节放在
 * Turn Continuation 之前，续跑指令的 last-but-clock 契约不动。
 */

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

describe('buildContextWindowSection 的算术', () => {
  it('百分比取整、K 格式化', () => {
    const s = buildContextWindowSection({ tokens: 86_800, window: 140_000 })
    expect(s).toContain('## Context Window')
    expect(s).toContain('~62% used (~87K / 140K tokens)')
  })

  it('拒绝线 55% 与阶段边界教学在场（模型要能预判拒绝）', () => {
    const s = buildContextWindowSection({ tokens: 10_000, window: 128_000 })
    expect(s).toContain('~8% used')
    expect(s).toContain('refused below 55%')
  })

  it('越过窗口钳到 100%（估算器可能高估）', () => {
    const s = buildContextWindowSection({ tokens: 150_000, window: 140_000 })
    expect(s).toContain('~100% used')
    expect(s).not.toContain('107%')
  })
})

describe('wiring 扫描：引擎传数、节在钟前、续跑指令契约不动', () => {
  const BUILDER = 'src/renderer/src/agent/system-prompt-builder.ts'
  const ENGINE = 'src/renderer/src/agent/AgentEngine.ts'

  it('buildStateBlock 在 Turn Continuation 之前推入 Context Window 节', () => {
    const src = read(BUILDER)
    const push = src.indexOf('if (contextUsage) sections.push(buildContextWindowSection(contextUsage))')
    const nudge = src.indexOf('if (continuationNudge) sections.push(TURN_CONTINUATION_NUDGE)')
    expect(push).toBeGreaterThan(-1)
    expect(nudge).toBeGreaterThan(push) // 钟最后、nudge 次之的既有契约不破
  })

  it('引擎用 compactor.contextTokens() 传表——与守卫 ③ 同一估算器', () => {
    const src = read(ENGINE)
    expect(src).toContain('contextUsage: { tokens: this.compactor.contextTokens(), window: this.opts.contextLength || 128_000 }')
  })

  it('contextUsage 缺席不出节（派生会话/测试的零负担面）', () => {
    const src = read(BUILDER)
    expect(src).toContain('if (contextUsage) sections.push')
  })
})

// 端到端真调用（review_20261011 高4 的漏网原因正是「三个 wiring 断言全是
// readFileSync 源码扫描、没有任何用例执行 buildSystemPrompt」——生产端在
// 传、消费端在等，顶层解构与 buildStateBlock 转发两跳漏写，类型 optional
// 无声，源码扫描全绿而功能落库即死）。
describe('buildSystemPrompt 端到端：contextUsage 真转发到 state block', () => {
  it('传入 contextUsage → state block 含 ## Context Window 节，且在钟之前', async () => {
    const { buildSystemPrompt } = await import('../src/renderer/src/agent/system-prompt-builder')
    const { systemPrompt, stateBlock } = await buildSystemPrompt({
      opts: {},
      messages: [],
      plan: null,
      contextUsage: { tokens: 86_800, window: 140_000 },
    })
    expect(systemPrompt.length).toBeGreaterThan(0)
    expect(stateBlock).toContain('## Context Window')
    expect(stateBlock).toContain('~62% used (~87K / 140K tokens)')
    // 节序契约：Context Window 在 Current Date（钟，恒最后）之前
    expect(stateBlock.indexOf('## Context Window')).toBeLessThan(stateBlock.indexOf('## Current Date'))
    expect(stateBlock.trimEnd().endsWith('</session-state>')).toBe(true)
  })

  it('缺省负控：不传 contextUsage → 不出节（真调用，非扫描）', async () => {
    const { buildSystemPrompt } = await import('../src/renderer/src/agent/system-prompt-builder')
    const { stateBlock } = await buildSystemPrompt({ opts: {}, messages: [], plan: null })
    expect(stateBlock).not.toContain('## Context Window')
    expect(stateBlock).toContain('## Current Date')
  })
})
