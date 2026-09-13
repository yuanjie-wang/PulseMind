export interface SubAgentProfile {
  id: string
  name: string
  /** 角色人设：专家是谁、以什么身份工作（原 basePrompt，语义升级）。 */
  basePrompt: string
  /** 一句话简介：能力中心卡片与 spawn_agent 工具清单展示用。 */
  description?: string
  /** 卡片图标（emoji）。 */
  icon?: string
  /** 领域方法论：工作范式/流程。 */
  methodology?: string
  /** 输出规范：交付物的结构与格式要求。 */
  outputSpec?: string
  /** 边界约束：不可越过的行为边界。 */
  constraints?: string
  /** 绑定的私有知识库文件（knowledge_files.id），主会话召唤时收敛检索范围。 */
  knowledgeFileIds?: string[]
  allowedTools: string[]
  allowedMcpServers: string[]
  allowedSkills: string[]
  profileId?: string
  maxTokens?: number
  maxLoopIterations?: number
  isBuiltIn?: boolean
  enabled?: boolean
}

/** 会话绑定的专家运行时上下文：session-manager 每次 ask 前从 DB 解析组装，
 *  经 AgentEngineOptions.expert 注入 system prompt 与工具收敛。 */
export interface ExpertRuntimeContext {
  id: string
  name: string
  /** composeExpertInstructions 的产出（人设/方法论/输出规范/约束）。 */
  instructions: string
  /** 绑定的知识库文件（含 wiki 产出页），驱动 Bound Knowledge 段与检索范围。 */
  knowledgeFiles: Array<{ id: string; title: string; filePath: string; wikiPages: string[] }>
}
