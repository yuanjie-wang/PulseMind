#!/usr/bin/env node
// M0b 采纳率基线（PLAN-memory-wiki，2026-10-25，一次性测量）：JIT 化之前，agent 会话
// 里检索类工具（memory_search / conversation_search / knowledge_search / knowledge_read /
// pick_skill / tool_result_search / experience_read）的实际使用率。
//
// 为什么存在：Sourcegraph 2026 点名的失败模式「retrieval the agent won't use」——注入
// 退役（M4）后检索层是唯一通道，改造前的使用率是基线，M4 后复测不得低于它。
//
// 口径：扫 ~/.pulsemind/logs/llm-requests/*.request.txt（wire 级全量 dump）。
//   - agent 请求 = tools 数组非空（一次性调用 title/greeting/memory 不带 tools）。
//   - 会话分组 = messages[0](system) + messages[1](首条 user) 的 SHA1——system 核心跨会话
//     字节一致，首条 user（任务句/state block）是会话指纹。
//   - 会话采纳 = 该会话任一请求的 messages 里出现 ≥1 个检索类 tool_call。
//   - 回合采纳 = agent 请求中含检索 tool_call 的比例（回合粒度，供参考）。
// 注意：本基线在「记忆尚且注入」的旧形态下测得——模型看得见记忆时较少检索是预期行为，
// 基线的意义是「M4 之后不低于此」，而非绝对水平。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const RETRIEVAL_TOOLS = new Set([
  'recall', 'memory_search', 'conversation_search', 'knowledge_search', 'knowledge_read',
  'pick_skill', 'tool_result_search', 'experience_read',
])

const dir = path.join(os.homedir(), '.pulsemind', 'logs', 'llm-requests')
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.request.txt')).sort()

const convs = new Map() // fingerprint → { requests, retrieved, perTool }
let agentRequests = 0
let agentRequestHits = 0

for (const f of files) {
  let body
  try { body = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { continue }
  const tools = body.tools ?? []
  const msgs = body.messages ?? []
  if (tools.length === 0 || msgs.length < 2) continue // 一次性调用或残缺请求
  agentRequests++

  const retrievalCalls = []
  for (const m of msgs) {
    for (const c of m.tool_calls ?? []) {
      const name = c.function?.name ?? ''
      if (RETRIEVAL_TOOLS.has(name)) retrievalCalls.push(name)
    }
  }
  if (retrievalCalls.length > 0) agentRequestHits++

  const fp = crypto.createHash('sha1')
    .update(JSON.stringify(msgs[0]) + '\u0000' + JSON.stringify(msgs[1]))
    .digest('hex').slice(0, 16)
  const conv = convs.get(fp) ?? { requests: 0, retrieved: false, perTool: new Map() }
  conv.requests++
  if (retrievalCalls.length > 0) {
    conv.retrieved = true
    for (const name of retrievalCalls) conv.perTool.set(name, (conv.perTool.get(name) ?? 0) + 1)
  }
  convs.set(fp, conv)
}

const convList = [...convs.values()]
const adopted = convList.filter((c) => c.retrieved).length
const perTool = new Map()
for (const c of convList) for (const [k, v] of c.perTool) perTool.set(k, (perTool.get(k) ?? 0) + v)

console.log(`请求 dump: ${files.length} 份，其中 agent 请求（带工具）${agentRequests} 份`)
console.log(`会话（指纹分组）: ${convList.length} 场，其中用过任一检索工具: ${adopted} 场`)
console.log(`\n会话级采纳率: ${((adopted / Math.max(convList.length, 1)) * 100).toFixed(0)}%`)
console.log(`回合级采纳率: ${((agentRequestHits / Math.max(agentRequests, 1)) * 100).toFixed(0)}%（${agentRequestHits}/${agentRequests}）`)
console.log('\n检索工具使用分布（tool_call 总次数）:')
for (const [k, v] of [...perTool.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)
if (perTool.size === 0) console.log('  （无）')
console.log('\n← 记录此基线；M4 注入退役后复测，会话级采纳率不得低于此值（PLAN M4 验收）。')
