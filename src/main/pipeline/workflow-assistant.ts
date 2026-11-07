// PLAN-workflow-engine：内置工作流助手——一次性 LLM 调用（无工具、无会话）。
//
// system prompt = 工作流 JSON schema + 边/保留字/契约规范 + objective 字段
// 说明 + 两个内置模板作 few-shot；输入 = 用户自然语言需求 + 当前工作流 JSON
// （可为空）。输出 = 完整修订后的 JSON → 先过 validate 门；校验失败带原因
// 回喂模型重试一次，仍失败则把错误透出给用户。
//
// 复用主进程既有 adapter 构建路径（读 activeProfile，与 api-proxy 同源）；
// 未配密钥时助手入口由 UI 置灰（本模块拒绝空密钥调用）。

import { settingsStore } from '../storage/settings-store'
import { openaiAdapter } from '../../renderer/src/llm/OpenAIAdapter'
import { anthropicAdapter } from '../../renderer/src/llm/AnthropicAdapter'
import { validateWorkflow } from '../../shared/workflow/validate'
import { WORKFLOW_TEMPLATES } from '../storage/workflow-store'
import type { WorkflowDefinition } from '../../shared/workflow/types'

const MAX_OUTPUT_TOKENS = 16_000
/** 修订后 JSON 的提取面：剥 ```json 围栏、取最外层花括号体。 */
function extractJson(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  return body.slice(start, end + 1)
}

function buildSystemPrompt(): string {
  const schema = `{
  "id": "kebab-id（字母开头，字母/数字/-/_，≤64字符）",
  "name": "工作流名",
  "objective": "全局目标（一句话；任何节点 prompt 里可用 {{objective}} 引用）",
  "entry": "入口节点 id",
  "params": { "stageTimeoutMinutes": 30, "maxStageContinues": 2, "defaultMaxVisits": 3, "gitCheckpoint": true },
  "nodes": [
    { "id": "node-id", "title": "节点名", "prompt": "节点工作内容（可用占位符 {{objective}} {{planContent}} {{planPath}} {{workspace}} {{prevVerdict}} {{prevSummary}} {{prevArtifacts}} {{visit}}）", "verdicts": ["pass","fail"], "layout": { "x": 120, "y": 80 } }
  ],
  "edges": [ { "from": "node-id", "when": "verdict值", "to": "下一节点 id 或 DONE/FAILED/RETRY" } ]
}`
  return `你是 PulseMind 的工作流设计助手。把用户的自然语言需求整理/修订成一份完整的工作流 JSON（输出修订后的**完整** JSON，不要增量 diff）。

## JSON 形态
${schema}

## 硬规范
1. 边目标只能是节点 id / "DONE"（实例成功）/ "FAILED"（实例失败）/ "RETRY"（重进本节点）。某 verdict 没有出边 = 默认 FAILED（fail-safe）。
2. 节点 id 不得叫 DONE/FAILED/RETRY；id 必须唯一；entry 必须存在；同一 from+when 只能有一条出边。
3. 每个节点的 verdicts 非空，edges 的 when 必须来自 from 节点的 verdicts。
4. 每个节点的 prompt 必须在结尾教模型输出契约行，形态一字不差：
PIPELINE_RESULT: {"verdict":"<verdicts 之一>","summary":"<一句话总结>","artifacts":["<交付物相对路径>"]}
5. artifacts 是工作区相对路径（禁绝对路径、禁 ..）；fix/review 类阶段把发现清单写进 pipeline/*.md 作为交付物传给下一阶段（{{prevArtifacts}} 注入）。
6. 单文件内容帽：{{planContent}} 120k 字符、{{prevArtifacts}} 单文件 20k——超限会被截断标注，prompt 不必自行处理。
7. 节点职责单一：一个节点一件事（编码/测试/评审/修复/翻译/校对……），失败回路靠边表表达。

## 内置模板（few-shot，两份）
${WORKFLOW_TEMPLATES.map((t) => `### ${t.name}\n${JSON.stringify(t, null, 2)}`).join('\n\n')}

只输出修订后的完整 JSON（可以用 json 代码围栏包住），不要输出任何解释。`
}

export interface WorkflowAssistResult {
  ok: boolean
  /** 校验通过的完整工作流（应用前仍须过调用方的同一 validate 门）。 */
  workflow?: WorkflowDefinition
  /** 校验错误（重试一次后仍失败时透出）。 */
  errors?: string[]
  warnings?: string[]
}

/** 一次助手调用（内部含校验失败回喂重试一次）。 */
export async function assistWorkflow(userNeed: string, currentJson: string): Promise<WorkflowAssistResult> {
  const settings = await settingsStore.get()
  const profile = settings.profiles.find((p) => p.id === settings.activeProfileId)
  if (!profile || !profile.apiKey || !profile.baseURL || !profile.model) {
    return { ok: false, errors: ['未配置模型或密钥——先在设置里启用一个模型'] }
  }
  const adapter = profile.provider === 'anthropic' ? anthropicAdapter : openaiAdapter
  const userMessage = `## 用户需求\n${userNeed.trim() || '（无——请基于当前 JSON 给出改进建议）'}\n\n## 当前工作流 JSON（可为空 = 从零起稿）\n${currentJson.trim() || '（空）'}`

  const apiKey = profile.apiKey as string
  const callOnce = async (extraFeedback?: string): Promise<string | null> =>
    adapter.callNonStreaming(
      apiKey,
      profile.baseURL,
      profile.model,
      buildSystemPrompt(),
      [{ role: 'user', content: extraFeedback ? `${userMessage}\n\n## 上次输出未过校验\n${extraFeedback}\n请修正后重新输出完整 JSON。` : userMessage }],
      profile.maxTokens && profile.maxTokens > 0 ? profile.maxTokens : MAX_OUTPUT_TOKENS,
    )

  try {
    let raw = await callOnce()
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!raw) return { ok: false, errors: ['模型返回为空'] }
      const json = extractJson(raw)
      if (!json) return { ok: false, errors: ['模型输出中没有可解析的 JSON 对象'] }
      let parsed: unknown
      try {
        parsed = JSON.parse(json)
      } catch (err) {
        return { ok: false, errors: [`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`] }
      }
      const v = validateWorkflow(parsed)
      if (v.ok) return { ok: true, workflow: parsed as WorkflowDefinition, warnings: v.warnings }
      if (attempt === 0) {
        raw = await callOnce(v.errors.map((e) => `- ${e}`).join('\n'))
        continue
      }
      return { ok: false, errors: v.errors, warnings: v.warnings }
    }
    return { ok: false, errors: ['模型两次输出均未过校验'] }
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] }
  }
}
