/**
 * 专家配置包（ExpertProfile）：一组可复用的专业能力 —— 身份（人设/方法论/输出规范/约束）
 * 与绑定知识。它回答"以什么身份、带着什么私有知识跑"，宿主（session-manager 托管的主对话 /
 * SpawnManager 托管的子代理）回答"在哪跑、怎么跑"。
 * 同一个包可以被 @ 召唤进主对话，也可以被 spawn_agent 委托为子代理。
 *
 * 能力（工具 / 连接器 / 技能）与运行参数（模型 / token / 循环上限）都不在这里收敛：
 * 专家与全局保持一致，宿主用哪套能力、哪个模型、多少预算，专家就用同一套 —— 配置包只描述
 * "是谁、带什么知识、常和哪些技能/连接器一起用"。
 */
export interface ExpertProfile {
  id: string
  name: string

  // ── 身份与知识（能力包本体）──
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
  /** 绑定的私有知识库文件（knowledge_files.id），两种运行时下都收敛知识检索范围。 */
  knowledgeFileIds?: string[]

  // ── 引用关系（注入指令，不是权限白名单）──
  /** 常用技能（SkillDefinition.name）：指令里点名，让专家优先调用这些技能。 */
  skillNames?: string[]
  /** 常用连接器（MCP 服务 id）：同上，名字与用途随指令注入。 */
  mcpServerIds?: string[]

  // ── 状态 ──
  enabled?: boolean
}

/** 会话绑定的专家运行时上下文：session-manager 每次 ask 前从 DB 解析组装，
 *  经 AgentEngineOptions.expert 注入 system prompt 与知识收敛。 */
export interface ExpertRuntimeContext {
  id: string
  name: string
  /** composeExpertInstructions 的产出（人设/方法论/输出规范/约束）。 */
  instructions: string
  /** 绑定的知识库文件（含 wiki 产出页），驱动 Bound Knowledge 段与检索范围。 */
  knowledgeFiles: Array<{ id: string; title: string; filePath: string; wikiPages: string[] }>
}
