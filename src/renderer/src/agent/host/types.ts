import type { ElectronAPI } from '../../types/electron'

/**
 * The slice of the ElectronAPI surface that the agent graph actually touches
 * (engine, tool executors, prompt builder, caches, one-shot agents, adapter
 * non-stream fetch). Declaring it as an explicit seam lets the same agent code
 * run against:
 *   - the renderer bridge today  → createRendererHost(window.electronAPI)
 *   - the main-process host (M1.4, Node natives + direct fetch)
 *   - a mock host in tests
 * Keep keys in sync with actual usage; tsc fails loudly when a key drifts.
 */
export const HOST_METHOD_KEYS = [
  // LLM transport
  'apiFetchStream',
  'apiAbortStream',
  'apiFetch',
  'onApiStreamChunk',
  'onApiStreamError',
  'onApiStreamDone',
  'onApiStreamRetry',
  // terminal
  'executeCommand',
  'execCommandSync',
  'killCommand',
  // background process mode (PLAN-coding-contract P0-3) + session exec
  // allowlist (P0-2) — main-host-only in practice, see main-host.ts
  'executeBackground',
  'execLogs',
  'execKill',
  'getExecAllowlist',
  'addExecAllowlist',
  'onTerminalOutput',
  'onTerminalExit',
  'onTerminalError',
  // filesystem
  'readFile',
  'writeFile',
  'editFile',
  'patchFile',
  'getFileStat',
  'convertFileToMarkdown',
  'copyFileToTmp',
  'saveBase64Image',
  // git
  'gitInvoke',
  // mcp
  'mcpListServers',
  'mcpStartServer',
  'mcpRegisterServer',
  'mcpUpdateServerSummary',
  'mcpCallTool',
  'onMcpServersChanged',
  // browser (A-M1)
  'browserRunCode',
  // hosted page tools (browser extension reverse RPC, PLAN-browser-extension M0.2)
  'hostedToolCall',
  'onSkillsChanged',
  // skills / experience / experts
  'getSkillPreferences',
  'setSkillPreferences',
  'updateSkillPreferences',
  'readSkillRaw',
  'installSkill',
  'writeSkillSource',
  'expertList',
  'listExperiences',
  'saveExperienceRecord',
  'deleteExperienceRecord',
  'readExperienceRecord',
  'readExperienceFile',
  'touchExperienceRecord',
  // memory / knowledge / conversation store
  'saveMemory',
  'searchConversationsByKeyword',
  'getToolResult',
  'getConversation',
  // persistence
  'saveConversation',
  'appendConversationMessages',
  'persistToolResults',
  'saveConversationPlan',
  'getConversationPlan',
  // misc
  'getSettings',
  // knowledge (KnowledgeManager + engine knowledge tools)
  'knowledgeAddFile',
  'knowledgeAddFolder',
  'knowledgeAddUrl',
  'knowledgeApplyWikiChanges',
  'knowledgeClearAll',
  'knowledgeDelete',
  'knowledgeGetFile',
  'knowledgeGetRaw',
  'knowledgeGetRawPath',
  'knowledgeGetStats',
  'knowledgeListAdvanced',
  'knowledgeListFiles',
  'knowledgePrepareImport',
  'knowledgeReadWiki',
  'knowledgeRebuildIndex',
  'knowledgeScanFolder',
  'knowledgeSearchContent',
  'knowledgeSearchWiki',
  'knowledgeGetSchema',
  'knowledgeGetWikiDir',
  'knowledgeRebuildWiki',
  'knowledgeListBases',
  'knowledgeCreateBase',
  'knowledgeRenameBase',
  'knowledgeDeleteBase',
  'knowledgeSetFileBase',
  'knowledgeSetFilesBase',
  'knowledgeReextract',
  'editDocx',
  'editPptx',
  'editXlsx',
  'inspectOffice',
  'readOffice',
  'exportDocument',
  'knowledgeWriteExperience',
  // memory store + conversation summary counters (MemoryManager)
  'countMemories',
  'deleteMemory',
  'getMemoryMd',
  'saveMemoryMd',
  'listMemories',
  'searchMemories',
  'updateMemory',
  'listConversationsForMemory',
  'getConversationExperienceExtractedCount',
  'getConversationExtractedMsgCount',
  'updateConversationExperienceExtractedCount',
  'updateConversationExtractedMsgCount',
  'updateConversationKeywords',
  'updateConversationSummary',
] as const

export type HostMethodKey = (typeof HOST_METHOD_KEYS)[number]

export type PulseHost = Pick<ElectronAPI, HostMethodKey>
