import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildContextWindowSection } from '../src/renderer/src/agent/system-prompt-builder'
import { contextTokensOf, copyTokensOf } from '../src/renderer/src/agent/engine/context-estimate'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

/**
 * 上下文窗口仪表上送（user 2026-10-10）。
 *
 * 背景：context_compact 的守卫 ③ 以 `contextTokens() < contextLength × 0.55`
 * 拒绝调用，但这个数此前从不上送——模型对窗口占用全盲，「判断阶段边界」
 * 只能靠读感，试探性调用浪费一轮。修复：state block 加 `## Context Window`
 * 节。
 *
 * 口径（2026-11-21 三次修正）：分子 = 本请求管线后 copy 的内容价
 * （copyTokensOf(finalMessages, fixedOverhead)）——prepareLoopRequest 先以哨
 * 兵占位（管线的 overhead 估算需要 state block 字节长度，先有鸡先有蛋），管
 * 线跑完 finalMessages 已知后单次替换。两代旧口径都死在同一个坑上：
 * 2026-10-20 的 requestTokensOf（wire 锚点 + 原始尾段）恒高估恰好管线会压掉
 * 的份额——工具密集回合把刻度钉在 79–96% 而 wire 实载 ~60%（
 * conv_20261021155951「上下文只剩不到 4%，我必须小批量并一次成功」）；
 * 2026-10-24 换上的 contextTokensOf（max-guard 全转录）则被「骑在消息上的上
 * 次 wire 报告」毒化——压缩刀一切，报告还标着切割前的 110,535，刻度便钉在
 * ~74% 而 copy 实载 54,005（36%），同一份毒还顺着 CompactionEvent.tokensAfter
 * 传给环的投影通道，环/仪表/模型三方各说各话（conv_20261120152212，2026-11-21
 * 凌晨实锤）。守卫 ③ 仍读转写压力（触发侧的正确单位），拒绝信封自打百分比。
 *
 * 载体纪律：state block 是逐回合易变值的钦点载体，且是请求最后一条消息
 * ——它变了只重计自己；钟每请求都变，尾部重计费本来就在付。节放在
 * Turn Continuation 之前，续跑指令的 last-but-clock 契约不动。
 */

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

describe('copyTokensOf：copy 自身的诚实价（锚点毒化不可回归）', () => {
  const text = (t: string): ContentBlock => ({ type: 'text', text: t })
  const msg = (over: Partial<AgentMessage> & { role: 'user' | 'assistant' }): AgentMessage => ({
    id: `m${Math.random().toString(36).slice(2, 8)}`,
    contentBlocks: [text('答')],
    createdAt: '2026-11-21T16:24:00.000Z',
    ...over
  })

  it('压缩后的 copy 按 copy 内容计价，不被骑在消息上的旧 wire 报告抬高', () => {
    // conv_20261120152212 的 00:24 形状：上次请求真发 110,535（报告骑在末条
    // assistant 上），随后压缩刀把 160K 字符的工具结果换成占位载体——copy
    // 实载 ~54K，锚点读数却仍 ≥110,535。
    const big = 'x'.repeat(160_000)
    const api = [
      msg({ role: 'user' }),
      msg({ role: 'assistant' }),
      msg({ role: 'user', contentBlocks: [{ type: 'tool_result', tool_use_id: 't1', content: big } as ContentBlock] }),
      msg({ role: 'assistant', inputTokens: 110_535, outputTokens: 2_305 })
    ]
    const final = [
      api[0],
      api[1],
      msg({ role: 'user', contentBlocks: [{ type: 'tool_result', tool_use_id: 't1', content: '⟨archived: t1⟩' } as ContentBlock] }),
      api[3]
    ]
    const OVH = 12_000
    // copy 价读 copy：压缩后 ≈ 内容小头 + overhead，与 54K 同量级。
    const after = copyTokensOf(final, OVH)
    expect(after).toBeLessThan(30_000)
    // 切割前 > 切割后（CompactionEvent 的 before/after 语义成立）。
    expect(copyTokensOf(api, OVH)).toBeGreaterThan(after)
    // overhead 计入（gauge 的窗口分母含系统提示+工具+state block）。
    expect(copyTokensOf([], 5_000)).toBe(5_000)
    // 负向对照：这正是换 reader 的理由——锚点读数被 110,535 的旧报告钉死，
    // 触发链要的就是这个转写压力（契约不动），但刻度/事件绝不能读它。
    expect(contextTokensOf(final, OVH)).toBeGreaterThanOrEqual(110_535)
  })

  it('copyTokens 按上次实测 wire 校准，钳制住离群请求', async () => {
    // conv_20261120152212 的残差形状：启发式报 ~112K，供应商实测 117,168——
    // 一次校准后刻度价落在实测 ±1%，而不是永久差着 2–5% 的 tokenizer 斜差。
    const { ContextCompactor } = await import('../src/renderer/src/agent/engine/context-compactor')
    const compactor = new ContextCompactor({ runHistorySummary: async () => '摘要', getMessages: () => [] })
    // copy 内容 ≈ 100K 估算（400K 非中文字符，无报告的消息按块计价）+ overhead 12K。
    const copy = [msg({ role: 'user', contentBlocks: [text('x'.repeat(400_000))] })]
    const raw = copyTokensOf(copy, 12_000)
    const uncalibrated = compactor.copyTokens(copy, 12_000)
    expect(uncalibrated).toBe(raw) // 校准因子初值 1
    compactor.setCopyCalibration(117_168 / raw)
    const calibrated = compactor.copyTokens(copy, 12_000)
    expect(Math.abs(calibrated - 117_168)).toBeLessThanOrEqual(117_168 * 0.01)
    // 离群请求（一张启发式计 0 的大图把比值顶上天）不得把刻度甩上天。
    compactor.setCopyCalibration(9.7)
    expect(compactor.copyTokens(copy, 12_000)).toBeLessThan(raw * 1.6 + 1)
    // 无效报告（0/负/NaN）不碰已学因子。
    compactor.setCopyCalibration(117_168 / raw)
    const learned = compactor.copyTokens(copy, 12_000)
    compactor.setCopyCalibration(0)
    compactor.setCopyCalibration(Number.NaN)
    expect(compactor.copyTokens(copy, 12_000)).toBe(learned)
  })
})

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

  it('buildStateBlock 在续跑指令之前推入 Context Window 节（哨兵或成品皆然）', () => {
    const src = read(BUILDER)
    const push = src.indexOf('if (contextUsage) {')
    // 2026-11-12 todo 收口门与早停守卫共用这一个推入点（continuationNudgeSection
    // 按值分支选节），last-but-clock 的既有契约不破。
    const nudge = src.indexOf('if (continuationNudge) sections.push(continuationNudgeSection(continuationNudge))')
    expect(push).toBeGreaterThan(-1)
    expect(nudge).toBeGreaterThan(push) // 钟最后、nudge 次之的既有契约不破
  })

  it('引擎传哨兵（tokens: null）并在管线后换真数——刻度是本请求管线后 copy 的内容价', () => {
    const src = read(ENGINE)
    // pass 1：管线还没跑，state block 只能带哨兵（管线的 overhead 估算又
    // 需要 state block 的字节长度——先有鸡先有蛋，哨兵解环）。
    expect(src).toContain('contextUsage: { tokens: null, window: this.opts.contextLength || 128_000 }')
    // 管线后：finalMessages 已知，哨兵一次性替换为 copyTokensOf(final) 的
    // 真实刻度节。两代旧口径各有死法：requestTokensOf（wire 锚点+原始尾段）
    // 恒高估管线会压掉的份额（conv_20261021155951，79–96% vs ~60%）；
    // contextTokensOf 的 max-guard 被「骑在消息上的上次 wire 报告」毒化——
    // 压缩一切，报告还标着切割前规模，刻度钉在切割前（conv_20261120152212，
    // ~74% vs 36%）。
    // 2026-10-24 harness review: the swap targets the LAST occurrence — user
    // content rendered before the gauge must not eat it (first-match replace
    // silently dropped the gauge when a literal sentinel rode user bytes).
    expect(src).toContain('stateBlockText.lastIndexOf(CONTEXT_GAUGE_SENTINEL)')
    expect(src).toContain('buildContextWindowSection({ tokens: this.compactor.copyTokens(finalMessages, fixedOverhead), window: this.opts.contextLength || 128_000 })')
    // 负扫：锚点读数不得回到 gauge/事件的取数位（触发链里 contextTokensOf
    // 住在 compactor.contextTokens，那里才是它的家）。
    expect(src).not.toContain('contextTokensOf(finalMessages')
    expect(src).not.toContain('contextTokensOf(apiMessages')
  })

  it('CompactionEvent 的 before/after 同一口径（校准 copy 价），锚点毒化不可回归', () => {
    const src = read(ENGINE)
    const compactor = read('src/renderer/src/agent/engine/context-compactor.ts')
    // 请求路径两处（refill_breaker + 主事件）与 prewarm 路径一处，before/after
    // 全走校准后的 copy 内容价 + overhead。
    expect(src.match(/tokensBefore: this\.compactor\.copyTokens\(apiMessages, fixedOverhead\)/g)?.length).toBe(2)
    expect(src.match(/tokensAfter: this\.compactor\.copyTokens\(finalMessages, fixedOverhead\)/g)?.length).toBe(2)
    // 2026-11-21 epoch：prewarm 的事件数字直接从 directCut 的 copy 与 priceAfter
    // 取（同一口径；original/final 两个中间量已随四门流水线退役）。
    expect(compactor).toContain('const tokensBefore = this.copyTokens(copy, overhead)')
    expect(compactor).toContain('tokensAfter: result.priceAfter')
    // 事件取数位不得残留锚点读法。
    expect(src).not.toContain('contextTokensOf(apiMessages')
    expect(src).not.toContain('contextTokensOf(finalMessages')
    expect(compactor).not.toMatch(/contextTokensOf\((original|final)\)/)
  })

  it('刻度按上次实测 wire 校准（估算 vs 实测的斜差不可回归）', () => {
    const src = read(ENGINE)
    const runner = read('src/renderer/src/agent/engine/stream-runner.ts')
    const compactor = read('src/renderer/src/agent/engine/context-compactor.ts')
    // 构建时记下 RAW 价（校准分母），刻度发校准后价。
    expect(src).toContain('this.lastBuildCopyEstimate = copyTokensOf(finalMessages, fixedOverhead)')
    expect(src).toContain('this.compactor.copyTokens(finalMessages, fixedOverhead)')
    // usage 落地即喂校准（stream-runner 主回合路径；旁路 one-shot 不经此）。
    expect(runner).toContain('this.engine.noteCopyCalibration(usage.inputTokens)')
    expect(src).toContain('this.compactor.setCopyCalibration(measuredTokens / this.lastBuildCopyEstimate)')
    // 校准器语义在位：钳制与纯函数包装。
    expect(compactor).toContain('private copyCalibration = 1')
    expect(compactor).toContain('Math.min(1.6, Math.max(0.6, ratio))')
    expect(compactor).toContain('copyTokensOf(messages, fixedOverhead) * this.copyCalibration')
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
