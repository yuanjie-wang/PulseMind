import { describe, expect, it } from 'vitest'
import {
  buildPageCatalog,
  buildSearchNeedles,
  findNameCollisions,
  MEMORY_PAGE_CATALOG_BUDGET,
  normalizeTitle,
  resolvePageByRef,
  resolveSupersedeChain,
  type MemoryPageType,
  type PageIndexEntry,
} from '../src/shared/memory-pages'

/** 记忆页共享纯逻辑（PLAN-memory-wiki M1）：取代链解析、名称冲突判定、
 *  提取目录的分桶回落、检索词分解（M0a 定形的匹配栈）。DB 往返由
 *  scripts/probe-memory-pages-db.mjs 在真库上钉。 */

const page = (id: string, title: string, type: MemoryPageType = 'fact', aliases: string[] = []): PageIndexEntry => ({
  id, title, type, aliases,
})

describe('resolveSupersedeChain', () => {
  const chain = new Map([
    ['a', { id: 'a', supersededBy: 'b' }],
    ['b', { id: 'b', supersededBy: 'c' }],
    ['c', { id: 'c', supersededBy: null }],
  ])

  it('走到链尾的活页', () => {
    expect(resolveSupersedeChain(chain, 'a')).toBe('c')
    expect(resolveSupersedeChain(chain, 'b')).toBe('c')
    expect(resolveSupersedeChain(chain, 'c')).toBe('c')
  })

  it('活页自持', () => {
    expect(resolveSupersedeChain(new Map([['x', { id: 'x', supersededBy: null }]]), 'x')).toBe('x')
  })

  it('断链/未知 id 按起点自持（宁可读到旧页也不读不到）', () => {
    const broken = new Map([['y', { id: 'y', supersededBy: 'ghost' }]])
    expect(resolveSupersedeChain(broken, 'y')).toBe('y')
    expect(resolveSupersedeChain(new Map(), 'nobody')).toBe('nobody')
  })

  it('成环不死循环（深度帽 16）', () => {
    const loop = new Map([
      ['p', { id: 'p', supersededBy: 'q' }],
      ['q', { id: 'q', supersededBy: 'p' }],
    ])
    expect(['p', 'q']).toContain(resolveSupersedeChain(loop, 'p'))
  })
})

describe('resolvePageByRef（poolNamesOf 的推广）', () => {
  const pages = [page('1', '楼花合同全译', 'decision', ['术语表']), page('2', '称呼与协作习惯', 'preference', ['老大'])]

  it('title 精确（NOCASE）优先', () => {
    expect(resolvePageByRef(pages, '楼花合同全译')).toBe('1')
    expect(resolvePageByRef(pages, 'FLOWER CONTRACT')).toBeNull()
  })

  it('alias 命中次之', () => {
    expect(resolvePageByRef(pages, '术语表')).toBe('1')
    expect(resolvePageByRef(pages, '老大')).toBe('2')
  })

  it('不命中返回 null（幻觉 target 由调用方降级 create）', () => {
    expect(resolvePageByRef(pages, '不存在的页')).toBeNull()
    expect(resolvePageByRef(pages, '')).toBeNull()
  })
})

describe('findNameCollisions（title 与 alias 共用 NOCASE 命名空间）', () => {
  const pages = [page('1', '数据口径纪律', 'preference', ['信源等级']), page('2', '天气交付格式', 'fact', ['天气播报'])]

  it('新 title 撞既有 title/alias 都算冲突', () => {
    const hits = findNameCollisions(pages, { title: '数据口径纪律' })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ kind: 'title', holderId: '1' })
    expect(findNameCollisions(pages, { title: '信源等级' })).toHaveLength(1)
  })

  it('alias 撞既有页同样冲突；ignoreId 豁免自身（update 场景）', () => {
    expect(findNameCollisions(pages, { aliases: ['天气播报'] })).toHaveLength(1)
    expect(findNameCollisions(pages, { aliases: ['天气播报'], ignoreId: '2' })).toHaveLength(0)
  })

  it('干净名字零冲突；大小写不敏感', () => {
    expect(findNameCollisions(pages, { title: '全新的页', aliases: ['全新别名'] })).toHaveLength(0)
    expect(findNameCollisions(pages, { title: '数据口径纪律' })).toHaveLength(1) // 同串即撞（CJK 无大小写变换）
    expect(findNameCollisions([page('3', 'Node Versions')], { title: 'node versions' })).toHaveLength(1) // ASCII 大小写不敏感
  })
})

describe('buildPageCatalog（提取目录）', () => {
  it('空库给出占位', () => {
    const c = buildPageCatalog([])
    expect(c.mode).toBe('full')
    expect(c.liveCount).toBe(0)
    expect(c.text).toContain('no pages')
  })

  it('预算内全量列出（title + type + 别名）', () => {
    const c = buildPageCatalog([page('1', '楼花合同全译', 'decision', ['术语表', '重译'])])
    expect(c.mode).toBe('full')
    expect(c.text).toContain('- 楼花合同全译 (decision) 别名: 术语表, 重译')
  })

  it('超预算回落 type 分桶，且桶内截断必须显式标注（红线：不许静默截断）', () => {
    const many: PageIndexEntry[] = []
    for (let i = 0; i < MEMORY_PAGE_CATALOG_BUDGET + 40; i++) {
      many.push(page(`p${i}`, `页${i}`, (['preference', 'decision', 'fact', 'experience'] as const)[i % 4]))
    }
    const c = buildPageCatalog(many, MEMORY_PAGE_CATALOG_BUDGET)
    expect(c.mode).toBe('bucketed')
    expect(c.liveCount).toBe(MEMORY_PAGE_CATALOG_BUDGET + 40)
    expect(c.text).toContain('catalog over budget')
    // 每个被截断的桶必须有显式的 +N more 行
    const bucketHeaders = c.text.match(/^## (\w+) \((\d+)\)/gm) ?? []
    const moreLines = c.text.match(/… \+\d+ more/g) ?? []
    expect(bucketHeaders.length).toBeGreaterThan(0)
    expect(moreLines.length).toBeGreaterThan(0)
    expect(moreLines.length).toBe(bucketHeaders.length) // 本夹具四类均匀、桶容量同额 → 桶桶都截断
  })
})

describe('buildSearchNeedles（M0a 定形的匹配栈）', () => {
  it('≥3 字符词进 FTS 短语，≥2 字符词进 LIKE needle', () => {
    const n = buildSearchNeedles('客户认知档案')
    expect(n.ftsExpr).toBe('"客户认知档案"')
    expect(n.likeNeedles).toContain('客户认知档案')
  })

  it('混合分隔符拆词：ASCII 词与 CJK 词各走各路', () => {
    const n = buildSearchNeedles('KYC 项目 正式名称')
    // 2 字词够不到 trigram 下限，只走 LIKE 兜底——这是 M0a 栈的既定分工
    expect(n.ftsExpr).toBe('"KYC" OR "正式名称"')
    expect(n.likeNeedles).toEqual(expect.arrayContaining(['kyc', '项目', '正式名称']))
  })

  it('CJK 长串滑窗二元组：「怎么称呼我」里的「称呼」必须够得着（trigram 下限 3 字符）', () => {
    const n = buildSearchNeedles('怎么称呼我')
    expect(n.likeNeedles).toEqual(expect.arrayContaining(['称呼', '怎么', '呼我']))
    expect(n.ftsExpr).toBe('"怎么称呼我"')
  })

  it('needle 去重、截到 16 个；超长 CJK 串不会撑爆 LIKE 路数', () => {
    const long = '一二三四五六七八九十'.repeat(4) // 40 字 → 39 个二元组
    const n = buildSearchNeedles(long)
    expect(n.likeNeedles.length).toBeLessThanOrEqual(16)
    expect(new Set(n.likeNeedles).size).toBe(n.likeNeedles.length)
  })

  it('短查询不产生任何 needle 时两路皆空', () => {
    const n = buildSearchNeedles('a')
    expect(n.ftsExpr).toBe('')
    expect(n.likeNeedles).toEqual([])
  })

  it('引号在分词阶段被剥掉——MATCH 表达式注入在构造上不可能', () => {
    const n = buildSearchNeedles('含"引号"的词')
    expect(n.ftsExpr).not.toContain('"')
    expect(n.likeNeedles.join(' ')).not.toContain('"')
  })
})

describe('normalizeTitle', () => {
  it('去首尾空白、折叠连续空白', () => {
    expect(normalizeTitle('  楼花   合同 ')).toBe('楼花 合同')
  })
})
