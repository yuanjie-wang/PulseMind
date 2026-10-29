// ── 2026-10-29 recall 零命中复核 ──
// A1（recall 零命中无反馈）落地后仍留一个洞：四个源的「检索引擎起不来」和
// 「库里确实没有」共用同一个空数组出口。recall 的 swallowSource 只认 reject，
// 于是永远等不到它——零命中话术因此敢说「任何一个词都没出现过」，而那可能只是
// rg 没跑起来。本文件钉两件事：判定函数本身，以及三条 wiring 不许回潮。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSearchEngineFailure } from '../src/main/utils/ripgrep'

const src = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

describe('isSearchEngineFailure — 「跑不起来」vs「跑完没匹配」', () => {
  it('err 为 null（干净跑完）一律 false，无论有没有命中', () => {
    expect(isSearchEngineFailure(null)).toBe(false)
    expect(isSearchEngineFailure(undefined)).toBe(false)
  })

  it('退出码 1 是 rg/grep 的「没有匹配」，不是失败', () => {
    expect(isSearchEngineFailure({ code: 1 })).toBe(false)
  })

  it('退出码 2+ 是二进制自身报错，算失败', () => {
    expect(isSearchEngineFailure({ code: 2 })).toBe(true)
  })

  it('spawn 失败给的是字符串 code（ENOENT/EACCES/maxBuffer 溢出）', () => {
    expect(isSearchEngineFailure({ code: 'ENOENT' })).toBe(true)
    expect(isSearchEngineFailure({ code: 'EACCES' })).toBe(true)
    expect(isSearchEngineFailure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })).toBe(true)
  })

  it('被 timeout 杀掉（killed）算失败——扫描没跑完', () => {
    expect(isSearchEngineFailure({ code: null, killed: true })).toBe(true)
  })
})

describe('wiring — wiki 源：引擎失败交给上层记账', () => {
  const q = src('src/main/services/knowledge-queries.ts')

  it('导入判定函数（与 buildRgSearchArgs 同一模块，两通道不许再漂移）', () => {
    expect(q).toContain('isSearchEngineFailure')
    expect(q).toContain("from '../utils/ripgrep'")
  })

  it('rg / rg 重试 / grep 三条回调都记账（阴性对照：漏一处即红）', () => {
    const hits = q.match(/if \(isSearchEngineFailure\(err\)\) engineFailure = true/g) ?? []
    expect(hits.length).toBe(3)
  })

  it('零结果且引擎失败才抛——正常扫完没命中仍是干净空数组', () => {
    expect(q).toContain('if (results.length === 0 && engineFailure)')
    expect(q).toContain('is a search failure, not an empty corpus')
  })
})

describe('wiring — raw 源：同款处理', () => {
  const s = src('src/main/storage/knowledge-store.ts')

  it('携带 engineFailure 而不是裸空数组', () => {
    expect(s).toContain('Promise<{ matches: ContentMatch[]; engineFailure: boolean }>')
    expect(s).toContain('engineFailure: isSearchEngineFailure(err)')
  })

  it('FTS 兜底也空且引擎失败时抛（限定单 base 与全 base 两条分支）', () => {
    const hits = s.match(/if \(fts\.length === 0 && engineFailure\)/g) ?? []
    expect(hits.length).toBe(2)
  })
})

describe('零命中话术不再过度声明', () => {
  const d = src('src/renderer/src/agent/executors/domain-tools.ts')

  it('撤回「zero hits means none of them appear in any source」这条未经检验的断言', () => {
    expect(d).not.toContain('so zero hits means none of them appear in any source')
  })

  it('改说 knowledge 源 CJK 无分词、整串匹配（这是零命中推不出缺席的原因）', () => {
    expect(d).toContain('no word segmentation')
    expect(d).toContain('searched as ONE string')
  })

  it('旧钉不许回潮：失败源点名 + 部分命中提示仍在', () => {
    expect(d).toContain('zero hits may be a search failure rather than an empty corpus')
    expect(d).toContain('results may be incomplete')
    expect(d).toContain("swallowSource('knowledge (wiki)')")
    expect(d).toContain("swallowSource('knowledge (raw)')")
  })
})
