// recall 零命中修复（2026-10-28，复核报告 A1 的落地钉）。四条根因两条修两条废：
//   ① conversation 源整串 LIKE（等价短语匹配，比 AND 更严）→ 切词 OR + 命中数粗排
//     （conversation.db.ts，needle 与 memory 源同一匹配栈）；
//   ② memory 源 LIKE 兜底同分一锅端 → title/aliases 命中中位、body-only 恒后。
//     报告原建议「FTS 阈值 3→2」作废：三个 FTS 全是 trigram（物理下限 3 字符），
//     二字词的正确通道就是兜底加权，不是把不可能命中的词塞进 MATCH；
//   ③ 报告建议的「零命中单 token 重跑给候选」结构性作废，不实现：四源全部词级
//     OR 之后，全 query 零命中 ⟹ 任何单词探测也零命中（探测集 ⊆ 全词集），
//     重跑只会烧 4× 调用打印四个 0。线索改由 ①（假零命中消失）与 ④承担；
//   ④ 四源 .catch(() => []) 吞异常 → swallowSource 按名记账，零命中与部分命中
//     两条出口都区分「源异常」与「无数据」。
// Node 环境的 vitest 开不了 better-sqlite3（Electron-ABI），DB 层行为由
// scripts/probe-recall-zero-hit.mjs 在真库上钉；本文件钉匹配栈事实与三处 wiring。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSearchNeedles } from '../src/shared/memory-pages'

const src = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

describe('匹配栈事实（报告 ② 的阈值三读数，复核结论以此为准）', () => {
  const needles = buildSearchNeedles('Muse 体验 评测 功能')
  it('≥3 字词进 FTS：表达式只剩 "Muse"', () => {
    expect(needles.ftsExpr).toBe('"Muse"')
  })
  it('二字中文词没有被丢弃——走 LIKE 兜底（纠正报告「几乎不具备检索能力」）', () => {
    for (const w of ['muse', '体验', '评测', '功能']) expect(needles.likeNeedles).toContain(w)
  })
  it('trigram 下限不许回潮：FTS 阈值仍是 3（降阈值进 MATCH 匹配不到任何行）', () => {
    expect(src('src/shared/memory-pages.ts')).toContain('token.length >= 3')
  })
})

describe('① conversation 源：整串 LIKE → 切词 OR + 命中数粗排', () => {
  const db = src('src/main/storage/conversation.db.ts')
  it('needle 来自与 memory 源同一匹配栈，LIKE 逐个转义', () => {
    expect(db).toContain("import { buildSearchNeedles } from '../../shared/memory-pages'")
    expect(db).toContain("import { escapeLikePattern } from '../../shared/memory/like-pattern'")
    expect(db).toContain('buildSearchNeedles(query).likeNeedles')
    expect(db).toContain("%${escapeLikePattern(n)}%")
  })
  it('旧整串形态退场：%${query}% 单模式三连不再出现', () => {
    expect(db).not.toContain('const pattern = `%${query}%`')
    expect(db).not.toContain('[pattern, pattern, pattern]')
  })
  it('matchScore 粗排在位：多词齐中的行排前，空 needle 短路', () => {
    expect(db).toContain('ORDER BY matchScore DESC, updatedAt DESC')
    expect(db).toContain('if (needles.length === 0) return []')
  })
  it('NULL 毒化护栏：可空列上的 LIKE 逐项 COALESCE 成 0/1（探针实测，缺它则含 NULL summary 的行整体沉底）', () => {
    expect(db).toContain("COALESCE(title LIKE ? ESCAPE '\\\\' OR summary LIKE ? ESCAPE '\\\\' OR keywords LIKE ? ESCAPE '\\\\', 0)")
  })
  it('参数逐 term 连排：占位符文本序绑定，pat×3 flatMap（spread pats 会把不同词塞进同一 term 的三个字段位，单词行被抬成多词分）', () => {
    expect(db).toContain('pats.flatMap((p) => [p, p, p])')
    expect(db).not.toContain('[...pats, ...pats')
  })
})

describe('② memory 源：兜底内部 head 命中加权', () => {
  const store = src('src/main/storage/memory-pages-store.ts')
  it('headHit 子查询区分 title/aliases 命中与 body-only 命中', () => {
    expect(store).toContain("SELECT id, (title LIKE ? ESCAPE '\\\\' OR aliases LIKE ? ESCAPE '\\\\') AS headHit")
    expect(store).toContain('r.headHit ? LIKE_HEAD_SCORE : LIKE_FALLBACK_SCORE')
  })
  it('分工不变：FTS bm25（负分）仍压过一切兜底分', () => {
    expect(store).toContain('const LIKE_HEAD_SCORE = 50')
    expect(store).toContain('const LIKE_FALLBACK_SCORE = 100')
  })
})

describe('④ recall 失败源记账：异常与无数据分家', () => {
  const exec = src('src/renderer/src/agent/executors/domain-tools.ts')
  const fn = exec.slice(
    exec.indexOf('export async function execRecallTool'),
    exec.indexOf('export async function execMemoryTool')
  )
  it('四个源都走 swallowSource 按名记账（阴性对照：废掉任一处即红）', () => {
    expect(fn).toContain("swallowSource('memory')")
    expect(fn).toContain("swallowSource('conversations')")
    expect(fn).toContain("swallowSource('knowledge (raw)')")
    expect(fn).toContain("swallowSource('knowledge (wiki)')")
    expect(fn).not.toContain('.catch(() => [])')
  })
  it('零命中出口：失败源点名，区分检索失败与空库', () => {
    expect(fn).toContain('zero hits may be a search failure rather than an empty corpus')
  })
  it('部分命中出口：源挂了不得假装结果完整', () => {
    expect(fn).toContain('results may be incomplete')
  })
  it('③ 作废钉：零命中路径没有单 token 重跑循环', () => {
    expect(fn).not.toContain('for (const probe of')
    expect(fn).not.toMatch(/Single-keyword probes/i)
  })
})
