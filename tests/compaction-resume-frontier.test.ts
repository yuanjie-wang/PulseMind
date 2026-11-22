// 压缩恢复：只持久化 frontier 时，covered 账本的位置重建（2026-11-22）。
//
// 取证（scripts/probe-compaction-replay.mjs --resume-audit）：
//   conv_20261117170141  warm 0 次摘要 / cold 3 次，两臂切割数、全灭请求、
//   头部改写完全相同 ⇒ 重启多付的是纯 LLM 成本，对缓存命中零收益。
//   conv_20261120152212  warm 4 / cold 4 ⇒ 差异不是普遍成立，取决于会话形态。
//
// 机制：historySummary.covered 不落库（context-compactor.ts:1022-1023），重启后
// cacheCovered() 按 `region.findIndex(frontier)` 位置重建。DB 只存最新 frontier，
// 而新窗口的 dropped region 是另一段消息 —— findIndex 落空 ⇒ slice(0,0) ⇒ 空集
// ⇒ uncovered = 整个 region ⇒ 越过 12K 累积线 ⇒ 一次摘要（还可能触发 20K roll）。
// seedWarm()（探针里）把 frontier 重锚到本窗口 drop boundary 才补上这一半；
// 生产侧没有对应处理。review_20261103.md:171 待核实 5 / D11「用一次全价换账本」。
//
// 前三例钉机制：frontier 落空 → 额外摘要；frontier 重锚 → 复用缓存；区域中段
// frontier → 位置重建过度声明覆盖。后两例钉 2026-11-22 的修法：重建基准换成
// 全量转录（frontier 不在本刀 region 里也能定位）+ 瞬时 regroup id 的时间兜底。
// 末两例钉同一轮的第二半（同一类「重启多付」的另一半）：位置重建只产出 DB 里的
// id，而副本里的工具批早被 regroupToolResults 换成 `regroup_<run head>` 收集
// 消息 —— DB 不存在的 id 空间，位置重建永远认不出（conv_20261118223922: 副本里
// 247 个收集消息，位置重建 167 vs 真实账本 234）。
import { describe, expect, it } from 'vitest'
import {
  ContextCompactor,
  isSyntheticMessage,
} from '../src/renderer/src/agent/engine/context-compactor'
import { regroupToolResults } from '../src/renderer/src/llm/regroup-tool-results'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const AT = '2026-11-22T00:00:00.000Z'
const SEED_TEXT = '【历史对话摘要】上一会话已压缩区间的总结文本'
/** 1_500 CJK chars ≈ 1_500 tokens；编号让摘要输入里的来源可辨认。 */
function pair(i: number, chars = 1_500): AgentMessage[] {
  return [
    {
      id: `u${i}`, role: 'user', createdAt: AT,
      contentBlocks: [{ type: 'text', text: `需求${i}：` + '需'.repeat(chars) }] as ContentBlock[],
    },
    {
      id: `a${i}`, role: 'assistant', createdAt: AT,
      contentBlocks: [{ type: 'text', text: '已阅' }] as ContentBlock[],
    },
  ]
}
function transcript(n: number): AgentMessage[] {
  return Array.from({ length: n }, (_, i) => pair(i)).flat()
}

function harness(msgs: AgentMessage[], frontier: string) {
  const calls: string[] = []
  const compactor = new ContextCompactor({
    runHistorySummary: async (text: string) => { calls.push(text); return `摘要#${calls.length}` },
    getMessages: () => msgs,
  })
  compactor.seedHistorySummary(SEED_TEXT, frontier)
  return { compactor, calls }
}

/** A tight target drives hardTruncate to the MIN_KEEP floor and leaves the
 *  replay reserve at 0, so the cut's compensation block carries no replay
 *  shells reusing old message ids — `kept` is exactly the surviving tail. */
const TARGET = 5_000

async function droppedIds(msgs: AgentMessage[]): Promise<string[]> {
  const { compactor } = harness(msgs, 'foreign-frontier')
  const result = await compactor.directCut(TARGET, { record: false, copy: msgs })
  expect(result.cut).toBe(true)
  const kept = new Set(result.messages.filter((m) => !isSyntheticMessage(m)).map((m) => m.id))
  const dropped = msgs.filter((m) => !kept.has(m.id)).map((m) => m.id)
  expect(dropped.length).toBeGreaterThan(10)
  return dropped
}

describe('post-restart frontier-only summary cache', () => {
  it('a frontier outside the new drop region rebuilds an EMPTY ledger and pays for a full re-summary', async () => {
    const msgs = transcript(30)
    // DB 里真实存在的前沿形状：regroup 生成的可变 id（conv_20261120152212），
    // 形状翻转后在新窗口的 dropped region 里必然落空。
    const { compactor, calls } = harness(msgs, 'regroup_msg_1795162492388_u7ym2ck')
    const result = await compactor.directCut(TARGET, { record: false, copy: msgs })

    expect(result.cut).toBe(true)
    expect(result.droppedMessages).toBeGreaterThan(0)
    expect(calls).toHaveLength(1)                       // ← 重启多付的那次
    expect(calls[0]).toContain('需求0：')              // 整个 region 从头重摘要
    expect(calls[0].length).toBeGreaterThan(12_000)    // 越过 SUMMARY_EXTEND_MIN_CHARS
    // 前沿被推进到本刀最新 drop，旧 frontier 永久作废。
    expect(compactor.getHistorySummary()?.firstKeptId).not.toBe('regroup_msg_1795162492388_u7ym2ck')
  })

  it('re-anchoring the frontier to this window’s drop boundary reuses the cached text with zero LLM calls', async () => {
    const msgs = transcript(30)
    const dropped = await droppedIds(msgs)
    const { compactor, calls } = harness(msgs, dropped[dropped.length - 1])
    const result = await compactor.directCut(TARGET, { record: false, copy: msgs })

    expect(result.cut).toBe(true)
    expect(calls).toHaveLength(0)
    expect(compactor.getHistorySummary()?.text).toBe(SEED_TEXT)
    expect(compactor.getHistorySummary()?.firstKeptId).toBe(dropped[dropped.length - 1])
  })

  it('a mid-region frontier positionally over-claims coverage: older drops never reach the summarizer', async () => {
    const msgs = transcript(30)
    const dropped = await droppedIds(msgs)
    const mid = dropped[Math.floor(dropped.length / 2)]
    const { compactor, calls } = harness(msgs, mid)
    await compactor.directCut(TARGET, { record: false, copy: msgs })

    // 位置切片把 mid 之前的全部消息标成 covered（无论 seed 文本是否真见过它们）：
    // 要么一次调用都不发生，要么摘要输入里不含最老那批消息。
    if (calls.length > 0) expect(calls[0]).not.toContain('需求0：')
    expect(compactor.getHistorySummary()?.text).not.toBe('摘要#1')
  })

  it('FIX: a frontier that lives in the transcript but OUTSIDE this cut’s drop region no longer pays a re-summary', async () => {
    const msgs = transcript(30)
    const dropped = await droppedIds(msgs)
    const droppedSet = new Set(dropped)
    // 生产重启的真实形状：持久化 frontier 是上一会话最后一刀覆盖到的消息，
    // 重启后 epoch base 不存在、副本从全量转录重建，本刀丢的是最老的一段。
    // 该 id 在 live 里、但不在 region 里 —— 旧实现 findIndex = -1 → 空账本。
    const keptFrontier = msgs.find((m) => !droppedSet.has(m.id))!.id
    expect(msgs.some((m) => m.id === keptFrontier)).toBe(true)
    expect(dropped).not.toContain(keptFrontier)

    const { compactor, calls } = harness(msgs, keptFrontier)
    const result = await compactor.directCut(TARGET, { record: false, copy: msgs })
    expect(result.cut).toBe(true)
    expect(calls).toHaveLength(0)                       // ← 修前是 1 次全量重摘要
    expect(compactor.getHistorySummary()?.text).toBe(SEED_TEXT)
  })

  it('FIX: a transient regroup frontier resolves by its embedded epoch, guarded by the transcript span', async () => {
    const base = Date.parse(AT)
    const timed = transcript(30).map((m, i) => ({ ...m, createdAt: new Date(base + i * 1000).toISOString() }))
    const dropped = await droppedIds(timed)
    const lastDroppedAt = Date.parse(timed.find((m) => m.id === dropped[dropped.length - 1])!.createdAt)
    // 与 conv_20261120152212 的持久化 frontier 同形：regroup 铸造的 id 从不落库。
    const transient = `regroup_msg_${lastDroppedAt}_u7ym2ck`
    expect(timed.some((m) => m.id === transient)).toBe(false)

    const inSpan = harness(timed, transient)
    const result = await inSpan.compactor.directCut(TARGET, { record: false, copy: timed })
    expect(result.cut).toBe(true)
    expect(inSpan.calls).toHaveLength(0)                // 时间兜底把旧区间认回 covered

    // 越出转录时间跨度的 epoch 不能凭空声明覆盖：仍走保守空账本 + 重摘要。
    const outOfSpan = harness(timed, `regroup_msg_${base - 60_000}_ahead`)
    await outOfSpan.compactor.directCut(TARGET, { record: false, copy: timed })
    expect(outOfSpan.calls).toHaveLength(1)
    expect(outOfSpan.calls[0]).toContain('需求0：')
  })
})

// ── regroup id 空间：位置重建认不出副本里的收集消息（2026-11-22） ──────────
//
// conv_20261118223922 的实测：副本 552 条里有 247 条 id 是 `regroup_*`，全部
// 不在 DB 转录里；重启后位置重建给出 167 条覆盖，真实账本 234 条 —— 少认的
// 67 批工具结果会被重新送给摘要器。修法不是在判定处打补丁，而是让位置重建
// 把「覆盖到的那条消息」同时写成它的收集消息 id（positionalLedger）。

/** 一段工具批，形状取自真实转写：一轮收尾文本 + 紧接着的派发 assistant
 *  （相邻同角色 ⇒ 历史非法 ⇒ regroupToolResults 整篇重建并铸收集消息），
 *  以及它们的工具结果。live 保留四段原形；副本里塌成「合并后的 assistant
 *  （保留 run 头的 id）+ `regroup_<run head>` 收集消息」。
 *
 *  一批塞 40 个结果，是因为摘要区域的单条工具结果只取 SUMMARY_RESULT_CAP=400
 *  字符 —— 一个收集消息要能单独越过 SUMMARY_EXTEND_MIN_CHARS(12K) 这条线，
 *  才能用「有没有触发摘要调用」区分「认领了哪些批」。 */
function toolBatch(i: number, results: number): AgentMessage[] {
  const uses = Array.from({ length: results }, (_, k) => `toolu_${i}_${k}`)
  return [
    { id: `u${i}`, role: 'user', createdAt: AT, contentBlocks: [{ type: 'text', text: `继续${i}` }] as ContentBlock[] },
    { id: `a${i}`, role: 'assistant', createdAt: AT, contentBlocks: [{ type: 'text', text: `已阅${i}` }] as ContentBlock[] },
    {
      id: `b${i}`, role: 'assistant', createdAt: AT,
      contentBlocks: uses.map((id) => ({ type: 'tool_use', id, name: 'read', input: { path: `/p/${i}` } })) as ContentBlock[],
    },
    {
      id: `r${i}`, role: 'user', createdAt: AT,
      contentBlocks: uses.map((id, k) => ({ type: 'tool_result', tool_use_id: id, content: `结果${i}-${k}：` + '果'.repeat(400) })) as ContentBlock[],
    },
  ]
}

function regrouped(batches: number, results = 40) {
  const live = Array.from({ length: batches }, (_, i) => toolBatch(i, results)).flat()
  const copy = regroupToolResults(live)
  // 守卫：fixture 必须真的落进 regroup id 空间，否则这两条测试会在「合法历史
  // 原样返回」的形态下空转（断言照样绿，但什么都没钉住）。
  expect(copy.map((m) => m.id)).toContain('regroup_a0')
  expect(live.map((m) => m.id)).not.toContain('regroup_a0')
  expect(copy.find((m) => m.id === 'regroup_a0')!.contentBlocks).toHaveLength(results)
  return { live, copy }
}

function collectorHarness(live: AgentMessage[], frontier: string) {
  const calls: string[] = []
  const compactor = new ContextCompactor({
    runHistorySummary: async (text: string) => { calls.push(text); return '摘要#1' },
    getMessages: () => live,
  })
  compactor.seedHistorySummary(SEED_TEXT, frontier)
  return { compactor, calls }
}

/** 覆盖头那一行，用于读「这一刀认为多少条已覆盖」。 */
function coverageHeader(out: AgentMessage[]): string {
  const line = out
    .flatMap((m) => m.contentBlocks)
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .flatMap((b) => b.text.split('\n'))
    .find((l) => l.startsWith('〔覆盖〕'))
  return line ?? ''
}

describe('post-restart coverage rebuild across the regroup id space', () => {
  it('FIX: the rebuild claims the collectors it covers, so a restart stops re-summarizing whole batches', async () => {
    // frontier 落在第 3 批的 tool_result 上 ⇒ 前三批连结果一起覆盖。修前三个收集
    // 消息全部认不出 ⇒ 3 × 16K ≫ 12K ⇒ 一次全量重摘要；修后 uncovered 为空。
    const { live, copy } = regrouped(4)
    const { compactor, calls } = collectorHarness(live, 'r2')
    const out = await compactor.injectHistorySummary(copy, copy.slice(-3))

    expect(calls).toHaveLength(0)
    // 前 9 条（3 批 × 「user + assistant + 收集消息」）全部算已覆盖：收集消息认领
    // 上了，覆盖头才会是 9 而不是 6。
    expect(coverageHeader(out)).toContain('已压缩 9 条消息')
  })

  it('FIX: the frontier run’s own collector stays unclaimed — the prefix cannot vouch for results trailing it', async () => {
    // frontier 落在第 3 批的 tool_use assistant 上：run 头（也就是收集消息的名字）
    // 到此为止，但该批结果在它之后 —— 前缀无权声明。于是只有这一个收集消息落进
    // unexplained 区（一个就够越过 12K 线），摘要输入里应当只剩它。
    const { live, copy } = regrouped(4)
    const { compactor, calls } = collectorHarness(live, 'b2')
    await compactor.injectHistorySummary(copy, copy.slice(-3))

    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toContain('结果0-0：')   // 修前：三批收集消息全部重摘要
    expect(calls[0]).toContain('结果2-0：')       // 边界批仍要补摘要（保守方向）
  })
})
