import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { LruCandidate } from '../src/shared/experience/lru'
import { MAX_EXPERIENCE_PAGES, compareExperienceLRU } from '../src/shared/experience/lru'

/** 经验池 30 条上限（2026-11-12 用户裁定）：超出按 LRU 淘汰，软退役可反悔。
 *
 *  排序是纯逻辑，已抽到 `src/shared/experience/lru.ts`，这里**真断言**；
 *  接线在 `memory-pages-store.ts`（顶部拉 better-sqlite3，Node 侧加载不了），
 *  只能按项目惯例钉源码文本。 */

const store = readFileSync(new URL('../src/main/storage/memory-pages-store.ts', import.meta.url), 'utf8')

const c = (id: string, useCount: number, lastUsedAt: string | null, updatedAt = '2026-01-01T00:00:00.000Z'): LruCandidate => ({
  id,
  useCount,
  lastUsedAt,
  updatedAt,
})
const order = (xs: LruCandidate[]): string[] => [...xs].sort(compareExperienceLRU).map((x) => x.id)

describe('上限常量', () => {
  it('30 条，且 store 复用它而不是另写一个魔数', () => {
    expect(MAX_EXPERIENCE_PAGES).toBe(30)
    expect(store).toContain("from '../../shared/experience/lru'")
    expect(store).toContain('live.length - MAX_EXPERIENCE_PAGES')
  })
})

describe('淘汰次序', () => {
  it('use_count 升序：用得最少的先走', () => {
    expect(order([c('b', 5, '2026-01-01T00:00:00.000Z'), c('a', 0, '2026-01-01T00:00:00.000Z'), c('c', 2, '2026-01-01T00:00:00.000Z')])).toEqual([
      'a',
      'c',
      'b',
    ])
  })

  it('同 use_count 时 last_used_at 早的先走——这一级才是 LRU 的本体', () => {
    expect(order([c('new', 3, '2026-11-12T00:00:00.000Z'), c('old', 3, '2026-03-01T00:00:00.000Z')])).toEqual(['old', 'new'])
  })

  it('last_used_at 为 null 视为从未用过，比任何时间戳都先淘汰', () => {
    expect(order([c('used', 2, '2026-01-01T00:00:00.000Z'), c('never', 2, null)])).toEqual(['never', 'used'])
  })

  it('全平局按 updated_at、再按 id 定序：同一份数据每次算出的名单必须一致', () => {
    expect(order([c('z', 1, null, '2026-01-02T00:00:00.000Z'), c('y', 1, null, '2026-01-01T00:00:00.000Z')])).toEqual(['y', 'z'])
    expect(order([c('b', 1, null), c('a', 1, null)])).toEqual(['a', 'b'])
  })
})

describe('接线', () => {
  it('只有活页参与淘汰：退役与被取代的都排除', () => {
    expect(store).toContain('return !rec.retiredAt && !rec.supersededBy')
  })

  it('未超上限时一条都不动', () => {
    expect(store).toContain('if (overflow <= 0) return []')
  })

  it('淘汰是硬删除：磁盘目录与流水一起物理删除，不软退役（2026-11-12 用户裁定）', () => {
    expect(store).toContain('experienceStore.removeSync(v.id)')
    expect(store).toContain('deleteExperienceUses(v.id)')
    expect(store).not.toContain('setExperienceRetired')
  })

  it('create 与 supersede 之后都压池，且刚写入的那条不参与本轮淘汰', () => {
    expect(store).toContain('enforceExperienceCap(id)')
    expect(store).toContain('enforceExperienceCap(newId)')
    expect(store).toContain('const candidates = live.filter((r) => r.id !== keepId)')
  })
})

describe('停用不被复活（review 2026-11-12 实锤后修复）：ensure 的 ON CONFLICT 不覆写 enabled', () => {
  const uses = readFileSync(new URL('../src/main/storage/experience-uses.ts', import.meta.url), 'utf8')

  it('ensureExperienceUses 的冲突分支只认显式传入（COALESCE 兜底既有行）', () => {
    expect(uses).toContain('enabled                = COALESCE(?, experience_uses.enabled),')
    // 传参位：INSERT 的 enabled 缺省 1（新行默认启用），conflict 参数按 opts 显式与否传 NULL/0/1
    expect(uses).toContain('opts.enabled === undefined ? null : opts.enabled ? 1 : 0')
  })

  it('记忆页写路径所有 ensure 调用方都不传 enabled（缺省值不得参与冲突覆写）', () => {
    const calls = [...store.matchAll(/ensureExperienceUses\(([^)]*)\)/g)].map((m) => m[1])
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) expect(args).not.toMatch(/enabled\s*:/)
  })
})
