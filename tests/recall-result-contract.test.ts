import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { interleaveRecallHits } from '../src/shared/recall'

/** E7 recall 输出纯数据化 + 说明文档化（PLAN-recall-result-contract）：
 *  description = 结构文档（When/Parameters/Returns/Follow-ups），result = 纯数据
 *  （信封零教学句、零信息命中降级单行、长页纯指针）。 */

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

describe('manual = 结构文档（四段式）', () => {
  const src = read('src/renderer/src/tools/tool-instructions.ts')
  const i = src.indexOf('recall: `## recall')
  const manual = src.slice(i, src.indexOf('`,', i))

  it('四段在位：When/Parameters/Returns/Follow-ups', () => {
    expect(manual).toContain('When to use')
    expect(manual).toContain('Returns')
    expect(manual).toContain('Follow-ups')
  })
  it('Returns 逐源形状：memory 三类/conversation/knowledge 绝对路径', () => {
    expect(manual).toContain('[memory]')
    expect(manual).toContain('[conversation]')
    expect(manual).toContain('[knowledge]')
    expect(manual).toContain('absolute md path')
    expect(manual).not.toContain('knowledge_read')
  })
  it('信封零教学词式（retry/use/should 不出现在 executor 输出串）', () => {
    const exec = read('src/renderer/src/agent/executors/domain-tools.ts')
    const fn = exec.slice(exec.indexOf('export async function execRecallTool'), exec.indexOf('export async function execMemoryTool'))
    expect(fn).not.toMatch(/Retry once/)
    expect(fn).not.toContain('ask by title')
    expect(fn).not.toContain('knowledge_read(')
  })
})

describe('信封数据形态', () => {
  it('长页纯指针 (page: <id>, N chars)', () => {
    const exec = read('src/renderer/src/agent/executors/domain-tools.ts')
    expect(exec).toContain('(page: ${r.id}, ${r.body.length} chars)')
  })
  it('零信息命中降级：title 为 body 头部切片时单行渲染', () => {
    const exec = read('src/renderer/src/agent/executors/domain-tools.ts')
    expect(exec).toContain('isTitleEcho')
    expect(exec).toContain('singleLine')
  })
  it('memory 收窄：recall 列表排除 experience（彻底隔离，E6 双向断言半边）', () => {
    const exec = read('src/renderer/src/agent/executors/domain-tools.ts')
    expect(exec).toContain("r.type !== 'experience'")
  })
  it('[knowledge] meta 携带绝对路径字段 path（不再是 read 语法串）', () => {
    const exec = read('src/renderer/src/agent/executors/domain-tools.ts')
    expect(exec).toContain("meta: { path: r.wikiPath, kind: 'wiki' }")
    expect(exec).toContain("meta: { path: r.filePath, kind: 'raw' }")
    expect(exec).not.toContain('meta: { read:')
  })
})

describe('交错合并仍为输出骨架（回归锚）', () => {
  it('interleaveRecallHits 在 executor 中消费', () => {
    const exec = read('src/renderer/src/agent/executors/domain-tools.ts')
    expect(exec).toContain('interleaveRecallHits(hits, limit)')
  })
})
