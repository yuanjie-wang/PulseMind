import { describe, expect, it } from 'vitest'
import { interleaveRecallHits, RECALL_DEFAULT_LIMIT, RECALL_SOURCE_ORDER, type RecallHit } from '../src/shared/recall'

/** recall 联邦检索的合并纯逻辑（PLAN-recall-unification R1）：轮转交错 +
 *  全局 limit；确定性、零命中让位、帽是上限不是配额。 */

const hit = (source: RecallHit['source'], title: string): RecallHit => ({ source, title, body: `${title} 的内容`, meta: {} })

describe('interleaveRecallHits', () => {
  it('轮转交错：固定源序 memory → knowledge → conversation', () => {
    const out = interleaveRecallHits([
      hit('memory', 'm1'), hit('memory', 'm2'),
      hit('knowledge', 'k1'), hit('knowledge', 'k2'),
      hit('conversation', 'c1'), hit('conversation', 'c2'),
    ], 6)
    expect(out.map((h) => `${h.source}:${h.title}`)).toEqual([
      'memory:m1', 'knowledge:k1', 'conversation:c1',
      'memory:m2', 'knowledge:k2', 'conversation:c2',
    ])
  })

  it('零命中源让位，其余源继续填满 limit（帽是上限不是配额）', () => {
    const out = interleaveRecallHits([hit('memory', `m${1}`), ...Array.from({ length: 20 }, (_, i) => hit('memory', `mm${i}`))], 5)
    expect(out).toHaveLength(5)
    expect(out.every((h) => h.source === 'memory')).toBe(true)
  })

  it('不均衡分布：稀缺源轮空后不再占位', () => {
    const out = interleaveRecallHits([
      hit('memory', 'm1'), hit('memory', 'm2'), hit('memory', 'm3'),
      hit('knowledge', 'k1'),
    ], 10)
    expect(out.map((h) => h.title)).toEqual(['m1', 'k1', 'm2', 'm3'])
  })

  it('全局 limit 生效；0 与负数返回空', () => {
    const hits = RECALL_SOURCE_ORDER.flatMap((s) => [hit(s, `${s}1`), hit(s, `${s}2`)])
    expect(interleaveRecallHits(hits, 4)).toHaveLength(4)
    expect(interleaveRecallHits(hits, 0)).toEqual([])
    expect(interleaveRecallHits(hits, -3)).toEqual([])
  })

  it('默认 limit = 10', () => {
    const hits = Array.from({ length: 30 }, (_, i) => hit(i % 2 === 0 ? 'memory' : 'knowledge', `h${i}`))
    expect(interleaveRecallHits(hits)).toHaveLength(RECALL_DEFAULT_LIMIT)
  })

  it('确定性：同输入恒同输出', () => {
    const hits = [hit('conversation', 'c1'), hit('memory', 'm1'), hit('knowledge', 'k1'), hit('memory', 'm2')]
    const a = interleaveRecallHits(hits, 4)
    const b = interleaveRecallHits(hits, 4)
    expect(a.map((h) => h.title)).toEqual(b.map((h) => h.title))
  })

  it('空输入返回空', () => {
    expect(interleaveRecallHits([], 10)).toEqual([])
  })
})
