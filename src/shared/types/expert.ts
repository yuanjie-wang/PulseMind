/**
 * 专家配置包（ExpertProfile）：一组可复用的专业能力 —— 身份（人设/方法论/输出规范/约束）
 * 与可用能力（技能 / 连接器）。它回答"以什么身份、带着哪几样能力跑"，宿主
 * （session-manager 托管的主对话 / SpawnManager 托管的子代理）回答"在哪跑、怎么跑"。
 * 同一个包可以被 @ 召唤进主对话，也可以被 spawn_agent 委托为子代理。
 *
 * 可用技能 / 连接器是白名单，且「没配」与「配了空的」不是一回事：
 *   - 勾了几项  → 只允许这几项
 *   - 一项没勾  → 这类能力一个都不许用
 *   - 字段缺省  → 只有非专家会话会出现，表示不限制（专家包一律给出数组）
 * 工具集合与运行参数（模型 / token / 循环上限）不在这里收敛：宿主用哪套，专家就用同一套。
 */
export interface ExpertProfile {
  id: string
  name: string

  // ── 身份（能力包本体）──
  /** 角色人设：专家是谁、以什么身份工作（原 basePrompt，语义升级）。 */
  basePrompt: string
  /** 一句话简介：能力中心卡片与 spawn_agent 工具清单展示用。 */
  description?: string
  /** 领域方法论：工作范式/流程。 */
  methodology?: string
  /** 输出规范：交付物的结构与格式要求。 */
  outputSpec?: string
  /** 边界约束：不可越过的行为边界。 */
  constraints?: string

  // ── 可用能力（白名单；缺省 = 不限制，空数组 = 一个都不许用）──
  /** 可用技能（SkillDefinition.name）：专家只被允许使用这些技能。 */
  skillNames?: string[]
  /** 可用连接器（MCP 服务 id）：专家只被允许使用这些连接器。 */
  mcpServerIds?: string[]

  // ── 状态 ──
  enabled?: boolean
}

/** 会话绑定的专家运行时上下文：session-manager 每次 ask 前从 DB 解析组装，
 *  经 AgentEngineOptions.expert 注入 system prompt 并收敛可用能力。 */
export interface ExpertRuntimeContext {
  id: string
  name: string
  /** composeExpertInstructions 的产出（人设 / 方法论 / 输出规范 / 约束 / 可用能力）。 */
  instructions: string
  /** 可用技能白名单（SkillDefinition.name）：空数组 = 一个都不许用。 */
  allowedSkills: string[]
  /** 可用连接器白名单（MCP 服务 id）：空数组 = 一个都不许用。 */
  allowedMcpServers: string[]
}
