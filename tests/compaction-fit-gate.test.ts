// nano 步长的候选纪律（PLAN-compaction-epoch，2026-11-21）。
//
// nano 从「独立门」变成「切割的第 2 步」：60% 触发线、50% 目标、4K 可回收下限
// 与归档账本全部退役（门的唯一判据在 `directCut`，见 tests/compaction-epoch）。
// 仍然承重的是**候选纪律**，它决定「切到哪一段」而不是「要不要切」：
//   1. 定向咬合：target 是唯一预算，最老优先，落点 ≤ target；
//   2. 同一源 + 同一 target ⇒ 逐字节同一物化（占位符 id 来自源块，不重铸）；
//   3. 占位符副本回喂 ⇒ 引用恒等（已归档的字节不再回填）；
//   4. tier 配额降为**上限**：一次 pass 永不吃掉每 tier 最新一批；
//   5. tier3（ask_user/create_plan/advance_plan）与既有占位符一条不碰；
//   6. 纯文本副本无候选（那种深度归 light/hard）；
//   7. 环投影按占位符常数 45 定价：必须 over-read 出征副本，绝不 under-read；
//   8. `lastNanoArchive` 记录的是刚跑的那一次（used/target/archived/reclaimed）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ContextCompactor,
  NANO_PLACEHOLDER_COST,
  estimateAfterNanoTokens,
} from '../src/renderer/src/agent/engine/context-compactor'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const ARCHIVED_PREFIX = '⟨archived: '
const WINDOW = 100_000
const AT = '2026-11-21T00:00:00.000Z'
let seq = 0

function newCompactor(): ContextCompactor {
  return new ContextCompactor({ runHistorySummary: async () => '摘要', getMessages: () => [] })
}

/** One tool round: assistant tool_use + the user message carrying its result.
 *  '果'.repeat(n) prices at exactly n tokens (CJK ≈ 1 token/char).
 *  `tool_result_id` is pre-stamped the way the DB roundtrip delivers it, so a
 *  materialization reuses that id instead of minting a uuid — which is what
 *  makes "same source + same target ⇒ same bytes" testable. */
function round(toolName: string, chars: number): AgentMessage[] {
  const n = ++seq
  const id = `tu${n}`
  return [
    {
      id: `a${n}`, role: 'assistant', createdAt: AT,
      contentBlocks: [{ type: 'tool_use', id, name: toolName, input: {} }] as ContentBlock[],
    },
    {
      id: `u${n}`, role: 'user', createdAt: AT,
      contentBlocks: [
        { type: 'tool_result', tool_use_id: id, tool_result_id: `tr${n}`, content: '果'.repeat(chars) },
      ] as ContentBlock[],
    },
  ]
}

function rounds(count: number, toolName: string, chars: number): AgentMessage[] {
  const out: AgentMessage[] = []
  for (let i = 0; i < count; i++) out.push(...round(toolName, chars))
  return out
}

function archivedIds(messages: AgentMessage[]): string[] {
  const ids: string[] = []
  for (const msg of messages) {
    for (const block of msg.contentBlocks) {
      if (block.type !== 'tool_result') continue
      if ((block.content || '').startsWith(ARCHIVED_PREFIX)) ids.push(block.tool_use_id)
    }
  }
  return ids
}

/** Candidate order (oldest first) as nanoCompact sees it. */
function candidateOrder(messages: AgentMessage[]): string[] {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => (m.contentBlocks[0] as { tool_use_id: string }).tool_use_id)
}

describe('定向咬合：target 是唯一预算，最老优先', () => {
  it('bites down to the target and stops there', () => {
    // 60 tier-2 results × 1.5K = 90K 副本；+5K overhead 后按 60K 目标咬。
    const messages = rounds(60, 'read', 1_500)
    const compactor = newCompactor()
    const out = compactor.nanoCompact(messages, 60_000, 5_000)

    const ids = archivedIds(out)
    expect(ids.length).toBeGreaterThanOrEqual(20)
    expect(compactor.copyTokens(out, 5_000)).toBeLessThanOrEqual(60_000)

    // 最老优先：归档集合是候选序的前缀（缓存断点落在最深处）。
    expect(ids).toEqual(candidateOrder(messages).slice(0, ids.length))
    // 保护窗（最新 4 条 tool_result）整段保留。
    for (const id of candidateOrder(messages).slice(-4)) expect(ids).not.toContain(id)
    // 只重写内容、不合并/删除消息。
    expect(out.length).toBe(messages.length)
  })

  it('the same source with the same target materializes the same bytes', () => {
    // 生产形态：源转录从不被改写，每次请求都从同一份源重新物化。占位符 id
    // 来自源块（DB 往返带来的 tool_result_id），所以两次物化必须逐字节相同
    // ——这是「同一 epoch 内不改头」的前提。
    const messages = rounds(40, 'read', 1_500)
    const first = newCompactor().nanoCompact(messages, 60_000, 5_000)
    const second = newCompactor().nanoCompact(messages, 60_000, 5_000)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(archivedIds(second)).toEqual(archivedIds(first))
  })

  it('feeding the shipped copy back is identity — placeholders never refill', () => {
    const messages = rounds(40, 'read', 1_500)
    const compactor = newCompactor()
    const shipped = compactor.nanoCompact(messages, 60_000, 5_000)
    expect(archivedIds(shipped).length).toBeGreaterThan(0)
    expect(compactor.nanoCompact(shipped, 60_000, 5_000)).toBe(shipped)
  })
})

describe('tier 配额只剩上限语义', () => {
  it('one pass never eats the newest batch, however far over the target', () => {
    // 预算远超副本（target 0 + 巨大 overhead）：只有配额拦着它归档一切。
    const messages = rounds(40, 'read', 1_500)
    const compactor = newCompactor()
    const ids = archivedIds(compactor.nanoCompact(messages, 0, WINDOW * 2))
    // tier2 size 20, count 40 ⇒ 一次至多 count − size = 20。
    expect(ids.length).toBe(20)
    const candidates = candidateOrder(messages).slice(0, -4)
    expect(ids).toEqual(candidates.slice(0, 20))
  })

  it('tier3 results and existing placeholders are never touched', () => {
    const messages: AgentMessage[] = [
      ...rounds(12, 'read', 1_500),
      ...rounds(3, 'ask_user', 1_500),
    ]
    // 在可归档区中间种一个既有占位符。
    const plantAt = messages.findIndex((m) => m.role === 'user')
    ;(messages[plantAt].contentBlocks[0] as { content: string }).content = '⟨archived: old-id⟩'
    const planted = messages[plantAt].contentBlocks[0] as { content: string; tool_use_id: string }

    const out = newCompactor().nanoCompact(messages, 0, WINDOW * 2)
    // 已归档的块按原样幸存：计划跳过占位符，绝不重铸它的 id。
    expect(planted.content).toBe(`${ARCHIVED_PREFIX}old-id⟩`)
    const ids = archivedIds(out)
    const tier3Ids = messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.contentBlocks)
      .filter((b): b is { type: 'tool_use'; id: string; name: string } => b.type === 'tool_use' && b.name === 'ask_user')
      .map((b) => b.id)
    expect(tier3Ids.length).toBe(3)
    for (const id of tier3Ids) expect(ids).not.toContain(id)
  })

  it('a pure-text copy has nothing to archive — that depth belongs to light/hard', () => {
    const messages: AgentMessage[] = []
    for (let i = 0; i < 30; i++) {
      messages.push({ id: `t${i}`, role: 'user', createdAt: AT, contentBlocks: [{ type: 'text', text: '果'.repeat(2_000) }] })
      messages.push({ id: `s${i}`, role: 'assistant', createdAt: AT, contentBlocks: [{ type: 'text', text: '果'.repeat(1_000) }] })
    }
    expect(newCompactor().nanoCompact(messages, 0, WINDOW * 2)).toBe(messages)
  })
})

describe('环投影 over-read，绝不 under-read', () => {
  it('prices planned placeholders at the documented constant, above the shipped copy', () => {
    // 90K 副本 + 5K overhead：投影的整副目标 0.70b = 70K（冷启动 epoch 目标），
    // 而真切割按调用方给的 60K 落——投影必须比真副本贵，比未压副本便宜。
    const messages = rounds(60, 'read', 1_500)
    const compactor = newCompactor()
    const shipped = compactor.nanoCompact(messages, 60_000, 5_000)

    // 投影瞄准冷启动 epoch 目标（0.70b），占位符按 45 定价（实际发货的
    // `⟨archived: trN⟩` 只值个位数）——所以投影必须高于真副本。
    const projected = estimateAfterNanoTokens(messages, WINDOW, 5_000)
    expect(projected).toBeLessThan(compactor.copyTokens(messages, 0))
    expect(projected).toBeGreaterThan(compactor.copyTokens(shipped, 0))
    // 占位符常数就是那条 over-read 的承重项。
    expect(NANO_PLACEHOLDER_COST).toBe(45)
  })
})

describe('lastNanoArchive 记录刚跑的那一次', () => {
  it('used / target / archived / reclaimed all describe this pass', () => {
    const messages = rounds(60, 'read', 1_500)
    const compactor = newCompactor()
    const out = compactor.nanoCompact(messages, 60_000, 5_000)

    const stats = compactor.lastNanoArchive!
    expect(stats.used).toBe(compactor.copyTokens(messages, 5_000))
    expect(stats.target).toBe(60_000)
    expect(stats.archived).toBe(archivedIds(out).length)
    // 每条的回收 = 正文 − 占位符常数（比例 1：副本价高于启发式总量时 scale = 1）。
    expect(stats.reclaimed).toBe(stats.archived * (1_500 - NANO_PLACEHOLDER_COST))
  })

  it('the record follows the pass, not the previous one', () => {
    const compactor = newCompactor()
    compactor.nanoCompact(rounds(40, 'read', 1_500), 60_000, 5_000)
    expect(compactor.lastNanoArchive!.archived).toBeGreaterThan(0)

    const small = rounds(3, 'read', 100)
    compactor.nanoCompact(small, 60_000, 1_000)
    expect(compactor.lastNanoArchive!.archived).toBe(0)
    expect(compactor.lastNanoArchive!.reclaimed).toBe(0)
    expect(compactor.lastNanoArchive!.used).toBe(compactor.copyTokens(small, 1_000))
  })
})

describe('接线：nano 只有一个调用方，且它给的是步长目标', () => {
  const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

  it('directCut calls nanoCompact with the cut step target; the engine never calls it', () => {
    const engine = read('src/renderer/src/agent/AgentEngine.ts')
    const compactor = read('src/renderer/src/agent/engine/context-compactor.ts')
    expect(compactor).toContain('this.nanoCompact(working, stepTarget, overhead)')
    expect(engine).not.toContain('nanoCompact(')
    // 环是投影的唯一消费方（两处：整段与压缩后的 tail）。投影分母是引擎的
    // 输入侧预算，不是总窗口（方案 A 只管环的显示分母），否则环会按一条
    // 压缩链永远不会切到的深度问 nano 要空间。
    const ring = read('src/renderer/src/components/chat/ContextRing.tsx')
    expect(ring).toContain('const projectionWindow = inputBudget ?? contextLength')
    expect(ring).toContain('estimateAfterNanoTokens(messages.slice(i + 1), projectionWindow, t, epochTarget)')
    expect(ring).toContain('estimateAfterNanoTokens(tailMsgs, inputBudget ?? contextLength, compaction.tokensAfter, epochTarget)')
  })
})
