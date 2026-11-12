import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionReviewAgent } from '../src/renderer/src/agent/one-shot-agent/SessionReviewAgent'
import { MEMORY_ENTRY_MAX_CHARS } from '../src/shared/memory/limits'
import { escapeLikePattern } from '../src/shared/memory/like-pattern'

/**
 * 记忆纪律钉子（PLAN-memory-wiki M4 后形态）：常驻区渲染已退役（记忆/经验
 * 全部转 JIT 检索），本文件钉 100 字短句纪律在提取协议与 memory_save 执行器
 * 两侧的结构执法。原「常驻记忆区瘦身（user 2026-10-10 三条裁定：单条 ≤100 字、内容用短句、
 * memory_search 作取回通道）。
 *
 * 背景（llm-requests api_1791639104031 实测）：26 条记忆全量注入 system
 * prompt ≈11.8K token，占单请求 36%。改造后：
 *   写端 —— 三条路径的提示词都要短句 + 100 字帽，主提取与打捞有结构兜底
 *   （超限不入库；合并产物例外——它的删除账按产物哈希记，跳过会丢内容）；
 *   读端 —— 常驻区只渲染 ≤100 字的最新 20 条 + 省略指针行，长文留在库里
 *   由 memory_search 取回（该工具同日放开 gated、检索改 LIKE 全表扫——
 *   memories_fts 的 unicode61 分词对中文子串查询几乎必然 miss）。
 */

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

describe('主提取路径的结构兜底：超限条目不入库', () => {
  it('preference/fact 超 100 字整条丢弃，帽内的照存（v2：帽在 agent.parseResponse，结构兜底不再依赖 store 复检）', () => {
    const agent = new SessionReviewAgent()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parse = (raw: string) => (agent as any).parseResponse(raw, {
      sessionSummary: '(Conversation statistics: 2 tool call(s), 0 tool error(s))',
      catalogText: '(no pages yet)', catalogMode: 'full', pageIndex: [], revisableTitles: [],
    })
    const out = parse(JSON.stringify({
      pages: [
        { action: 'create', title: '短偏好', type: 'preference', content: '短'.repeat(MEMORY_ENTRY_MAX_CHARS) },
        { action: 'create', title: '长偏好', type: 'preference', content: '长'.repeat(MEMORY_ENTRY_MAX_CHARS + 50) },
        { action: 'create', title: '长决策', type: 'decision', content: '长'.repeat(500) },
      ],
    }))
    expect(out.pages.map((p: { title: string }) => p.title)).toEqual(['短偏好', '长决策'])
  })
})

describe('wiring 扫描：三条写路径的短句规则 + 检索通道', () => {
  it('SessionReviewAgent 的提取规则带 100 字帽与短句要求（v2：帽只压 preference/fact）', () => {
    const src = read('src/renderer/src/agent/one-shot-agent/SessionReviewAgent.ts')
    expect(src).toContain('HARD CAP 100 chars')
    expect(src).toContain('ONE short sentence')
    expect(src).toContain("body.length > 100")  // 结构兜底（normalizeOp）
  })

  it('MemoryPageCompileAgent 的整理纪律：retire 永久删除、supersede 保留取代链（M6；retire 硬删 2026-11-12 用户裁定）', () => {
    const src = read('src/renderer/src/agent/one-shot-agent/MemoryPageCompileAgent.ts')
    expect(src).toContain('NEVER create a new topic')
    expect(src).toContain('deletes it permanently')
    expect(src).toContain('the old pages are KEPT as lineage')
    expect(src).toContain('never truncate')
    expect(src).toContain('supersede')
  })

  it('打捞路径已退役：memory-extraction 不再有 prompt 与保存循环（user 2026-11-12）', () => {
    const src = read('src/renderer/src/agent/engine/memory-extraction.ts')
    // 短句规则与结构兜底随 salvage 一起删除——本文件只剩工具结果落库
    expect(src).not.toContain('at most 100 characters')
    expect(src).not.toContain('MEMORY_ENTRY_MAX_CHARS')
    expect(src).not.toContain('slice(0, 2000)')
    expect(src).not.toContain('ONLY durable ENVIRONMENT and TOOL facts')
    // 落库函数必须还在：本条同时守住「别为删 salvage 连带删掉它」
    expect(src).toContain('persistUnsavedToolResults')
  })

  it('searchMemories 走 LIKE 全表扫，FTS MATCH 通路已摘除', () => {
    const src = read('src/main/storage/memory.db.ts')
    expect(src).toContain("LIKE ? ESCAPE '\\\\'") // 文件字节即 `ESCAPE '\\'`（模板字面量产出单反斜杠的 SQL 串）
    expect(src).toContain('escapeLikePattern')
    expect(src).not.toContain('memories_fts MATCH')
    expect(src).not.toContain('sanitizeFtsQuery')
  })

  it('merge 产物不受长度兜底——跳过会让其输入行被误删（丢内容）', () => {
    const src = read('src/renderer/src/memory/MemoryManager.ts')
    const mergeBody = src.slice(src.indexOf('async ensureMemoryMerged'), src.indexOf('// Experience compression removed'))
    expect(mergeBody).not.toContain('MEMORY_ENTRY_MAX_CHARS')
  })
})

describe('escapeLikePattern（LIKE 通配符转义）', () => {
  it('普通中文原样通过', () => {
    expect(escapeLikePattern('字体')).toBe('字体')
    expect(escapeLikePattern('PPT 字体')).toBe('PPT 字体')
  })

  it('% _ \\ 三个 LIKE 活字被转义', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%')
    expect(escapeLikePattern('a_b')).toBe('a\\_b')
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b')
    expect(escapeLikePattern('%_\\')).toBe('\\%\\_\\\\')
  })
})
