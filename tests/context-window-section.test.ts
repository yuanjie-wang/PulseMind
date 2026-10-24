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
 * 节。
 *
 * 口径（2026-10-24 二次修正）：分子 = 本请求管线后规模——prepareLoopRequest
 * 先以哨兵占位（管线的 overhead 估算需要 state block 字节长度，先有鸡先有
 * 蛋），管线跑完 finalMessages 已知后单次替换为
 * contextTokensOf(finalMessages, fixedOverhead)。2026-10-20 的 requestTokensOf
 * 口径（wire 锚点 + 原始尾段）是「下一请求压缩前会有多大」，恒高估恰好管线
 * 会压掉的份额：工具密集回合把刻度钉在 79–96% 而 wire 实载 ~60%，模型当真
 * 开始克扣工作（conv_20261021155951「上下文只剩不到 4%，我必须小批量并一次
 * 成功」）。守卫 ③ 仍读转写压力（触发侧的正确单位），拒绝信封自打百分比，
 * 55% 阈值不再对着一发不同单位的数字念。
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

  it('口径教学在场：管线后规模 + 不为省上下文克扣工作 + compact 阶段边界', () => {
    const s = buildContextWindowSection({ tokens: 10_000, window: 128_000 })
    expect(s).toContain('~8% used')
    // 2026-10-24 口径：数字是本请求管线后的规模；旧「refused below 55%」
    // 引用的是转写压力单位（守卫 ③ 的口径），对着另一个单位的数字念阈值
    // 就是新谎——拒绝信封自己打印诚实的压力百分比。
    expect(s).toContain('after automatic compaction')
    expect(s).toContain('do not rush to finish or ration detail')
    expect(s).toContain('context_compact at a phase boundary')
    expect(s).not.toContain('55%')
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

  it('buildStateBlock 在 Turn Continuation 之前推入 Context Window 节（哨兵或成品皆然）', () => {
    const src = read(BUILDER)
    const push = src.indexOf('if (contextUsage) {')
    const nudge = src.indexOf('if (continuationNudge) sections.push(TURN_CONTINUATION_NUDGE)')
    expect(push).toBeGreaterThan(-1)
    expect(nudge).toBeGreaterThan(push) // 钟最后、nudge 次之的既有契约不破
  })

  it('引擎传哨兵（tokens: null）并在管线后换真数——刻度是本请求管线后规模', () => {
    const src = read(ENGINE)
    // pass 1：管线还没跑，state block 只能带哨兵（管线的 overhead 估算又
    // 需要 state block 的字节长度——先有鸡先有蛋，哨兵解环）。
    expect(src).toContain('contextUsage: { tokens: null, window: this.opts.contextLength || 128_000 }')
    // 管线后：finalMessages 已知，哨兵一次性替换为 contextTokensOf(final)
    // 的真实刻度节。旧口径（requestTokensOf：wire 锚点 + 原始尾段）恒高估
    // 恰好管线会压掉的份额——工具密集回合钉在 79–96% 而 wire 实载 ~60%，
    // 模型当真开始克扣工作（conv_20261021155951）。
    // 2026-10-24 harness review: the swap targets the LAST occurrence — user
    // content rendered before the gauge must not eat it (first-match replace
    // silently dropped the gauge when a literal sentinel rode user bytes).
    expect(src).toContain('stateBlockText.lastIndexOf(CONTEXT_GAUGE_SENTINEL)')
    expect(src).toContain('buildContextWindowSection({ tokens: contextTokensOf(finalMessages, fixedOverhead), window: this.opts.contextLength || 128_000 })')
  })

  it('contextUsage 缺席不出节（派生会话/测试的零负担面）', () => {
    const src = read(BUILDER)
    expect(src).toContain('if (contextUsage) {')
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

  it('哨兵模式（tokens: null）→ state block 带且仅带一次哨兵，替换后节序不变', async () => {
    const { buildSystemPrompt, CONTEXT_GAUGE_SENTINEL, buildContextWindowSection } = await import('../src/renderer/src/agent/system-prompt-builder')
    const { stateBlock } = await buildSystemPrompt({
      opts: {},
      messages: [],
      plan: null,
      contextUsage: { tokens: null, window: 100_000 },
    })
    // 恰好一次出现（用户内容 git/AGENTS.md 理论上可撞字符串——单次替换
    // 换的是第一个出现，节位又在块尾，撞不上）。
    expect(stateBlock.split(CONTEXT_GAUGE_SENTINEL).length - 1).toBe(1)
    expect(stateBlock).not.toContain('## Context Window')
    // prepareLoopRequest 的替换形状：单次 replace 换入完整节。
    const swapped = stateBlock.replace(CONTEXT_GAUGE_SENTINEL, buildContextWindowSection({ tokens: 60_000, window: 100_000 }))
    expect(swapped).toContain('## Context Window')
    expect(swapped).toContain('~60% used (~60K / 100K tokens)')
    // 节序契约在替换后保持：gauge 在钟之前、钟恒最后。
    expect(swapped.indexOf('## Context Window')).toBeLessThan(swapped.indexOf('## Current Date'))
    expect(swapped.trimEnd().endsWith('</session-state>')).toBe(true)
  })
})
