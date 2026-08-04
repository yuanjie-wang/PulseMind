export interface HookContext {
  event: string
  dataDir: string
  workspaceDir: string
  skillsDir: string
  knowledgeDir: string
  platform: {
    name: string
    release: string
    arch: string
  }
  env: Record<string, string>
}

export interface HookResult {
  env?: Record<string, string>
}
