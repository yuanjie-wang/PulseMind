// 记忆提取的取向钉子（user 2026-10-10：记忆侧重用户的决策/偏好，不归纳模型
// 产出的结果）。
//
// 实测（库内最近 40 条）：大量 fact 型记忆是「任务产出摘要」——「iPhone 18 调研
// 报告口径」「天气查询实例（10-09 查 10-10）」「用户本轮只是打招呼与玩闹」
// 「《AI-native SDLC playbook》核心论点」——全是模型自己的产出/单回合执行日志，
// 不是关于用户的知识。根因是三份提示词都没有归属约束：
//   1. SessionReviewAgent A 节「Extract important facts…」——fact 排第一，
//      模型把对话讨论过的内容都当事实抄下来；
//   2. 打捞路径（extractMemoriesFromOldToolPairs）的输入只有 assistant 文本 +
//      工具名（pair 的 user 位是纯 tool_result），却要求「decisions, file
//      paths, or user preferences」——结构性只能产出模型产出摘要；
//   3. 合并步骤没有丢弃判据，垃圾存量随合并永久续命。
// 提示词行为 vitest 无法用真 LLM 验证，按 wiring-scan 惯例钉提示词的关键
// 取向字样——字样没了 = 取向被改回去了，直接红。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

describe('主提取路径（SessionReviewAgent A 节）：记忆锚定用户，不是工作复盘', () => {
  const src = read('src/renderer/src/agent/one-shot-agent/SessionReviewAgent.ts')

  it('三条轴全部要求用户归属', () => {
    expect(src).toContain('attributable to the user')
    expect(src).toContain('a choice the USER made or ratified')
    expect(src).toContain('every correction they made')
    expect(src).toContain('the user\'s background: role, organization, ongoing projects')
  })

  it('负面清单点名模型产出/执行日志/寒暄，带「用户认可即 decision」的口子', () => {
    expect(src).toContain('NOT memories')
    expect(src).toContain('The assistant\'s own analysis, frameworks, research findings')
    expect(src).toContain('UNLESS the user explicitly approved or adopted it')
    expect(src).toContain('execution narration is not durable knowledge')
  })

  it('消失判据在场：丢了这条记忆，下次对话会不会变差', () => {
    expect(src).toContain('would the NEXT conversation for this user be visibly worse')
  })

  it('产出门槛：至多 3 条，空数组是合法且常见的结果（user 2026-10-10：低价值不进记忆）', () => {
    expect(src).toContain('At most 3 memories per review')
    expect(src).toContain('Most conversations correctly yield ZERO')
    expect(src).toContain('One high-value memory beats five marginal ones')
  })

  it('既有契约不回退：去重规则与经验资格门照旧', () => {
    expect(src).toContain('QUALIFICATION GATE')
    expect(src).toContain('NOT already covered by them')
    expect(src).toContain('EXISTING EXPERIENCES (the live experience pool')
  })
})

describe('打捞路径（extractMemoriesFromOldToolPairs）：只收环境/工具事实', () => {
  const src = read('src/renderer/src/agent/engine/memory-extraction.ts')

  it('输入无用户文本 → 只收环境与工具事实，禁任务摘要', () => {
    expect(src).toContain('ONLY durable ENVIRONMENT and TOOL facts')
    expect(src).toContain('work-product narration is not a memory')
  })

  it('禁止编造用户信息；文件路径明确出局', () => {
    expect(src).toContain('do NOT invent decisions or user preferences')
    expect(src).toContain('File paths are session-scoped')
  })

  it('旧 prompt 的取向字样已移除（回归守卫）', () => {
    expect(src).not.toContain('Given AI reasoning and tool execution')
    expect(src).not.toContain('file paths, or user preferences')
  })
})

describe('合并步骤（MemoryCompressionAgent）：无用户锚点的叙述条目可丢弃', () => {
  const src = read('src/renderer/src/agent/one-shot-agent/MemoryCompressionAgent.ts')

  it('丢弃判据在场，且 USER-EDITED 优先级仍是第一条', () => {
    expect(src).toContain('merely narrates what happened in one conversation')
    expect(src).toContain('a durable environment fact')
    const rules = src.slice(src.indexOf('buildSystemPrompt'))
    expect(rules.indexOf('USER-EDITED memories are authoritative')).toBeGreaterThan(0)
    expect(rules.indexOf('USER-EDITED memories are authoritative')).toBeLessThan(rules.indexOf('merely narrates'))
  })
})

describe('保存循环（extractAndSaveAll）：每轮收获的兜底帽', () => {
  const src = read('src/renderer/src/memory/MemoryManager.ts')

  it('MAX_EXTRACT_PER_RUN 存在且被 slice 执法——提示词失守时结构兜底', () => {
    expect(src).toContain('MAX_EXTRACT_PER_RUN = 5')
    expect(src).toContain('result.memories.slice(0, MemoryManager.MAX_EXTRACT_PER_RUN)')
  })
})
