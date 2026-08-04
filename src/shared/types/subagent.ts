export interface SubAgentProfile {
  id: string
  name: string
  basePrompt: string
  allowedTools: string[]
  allowedMcpServers: string[]
  allowedSkills: string[]
  profileId?: string
  maxTokens?: number
  maxLoopIterations?: number
  isBuiltIn?: boolean
  enabled?: boolean
}
