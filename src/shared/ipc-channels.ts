export const IPC_CHANNELS = {
  // ── API ──
  API_FETCH: 'api:fetch',
  API_FETCH_STREAM: 'api:fetch-stream',
  API_ABORT_STREAM: 'api:abort-stream',
  API_STREAM_CHUNK: 'api:stream-chunk',
  API_STREAM_ERROR: 'api:stream-error',
  API_STREAM_DONE: 'api:stream-done',
  API_STREAM_RETRY: 'api:stream-retry',

  // ── App ──
  APP_GET_PLATFORM_INFO: 'app:get-platform-info',
  APP_GET_DATA_PATHS: 'app:get-data-paths',
  APP_SYSTEM_RESUMED: 'app:system-resumed',
  APP_SYSTEM_RESUMED_ACK: 'app:system-resumed-ack',
  APP_HOOKS_COMPLETED: 'app:hooks-completed',
  // 原生菜单/加速键 → 渲染层动作（菜单点击或 before-input fallback 命中后推送）
  MENU_ACTION: 'app:menu-action',

  // ── LLM ──
  // 设置页「测试连接」：main 侧对 provider 发一次最小非流式请求
  LLM_TEST_CONNECTION: 'llm:test-connection',

  // ── Conversation ──
  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_GET: 'conversation:get',
  CONVERSATION_SAVE: 'conversation:save',
  CONVERSATION_DELETE: 'conversation:delete',
  CONVERSATION_UPDATE_TITLE: 'conversation:updateTitle',
  CONVERSATION_UPDATE_SUMMARY: 'conversation:update-summary',
  CONVERSATION_UPDATE_KEYWORDS: 'conversation:update-keywords',
  CONVERSATION_GET_EXTRACTED_MSG_COUNT: 'conversation:get-extracted-msg-count',
  CONVERSATION_UPDATE_EXTRACTED_MSG_COUNT: 'conversation:update-extracted-msg-count',
  CONVERSATION_GET_EXPERIENCE_EXTRACTED_COUNT: 'conversation:get-experience-extracted-count',
  CONVERSATION_UPDATE_EXPERIENCE_EXTRACTED_COUNT: 'conversation:update-experience-extracted-count',
  CONVERSATION_LIST_FOR_MEMORY: 'conversation:list-for-memory',
  CONVERSATION_TOKEN_STATS: 'conversation:token-stats',
  CONVERSATION_TOGGLE_PIN: 'conversation:toggle-pin',
  CONVERSATION_TOUCH: 'conversation:touch',
  CONVERSATION_SAVE_SYNC: 'conversation:save-sync',
  CONVERSATION_APPEND_MESSAGES: 'conversation:append-messages',
  CONVERSATION_UPDATE_MESSAGE_METADATA: 'conversation:update-message-metadata',
  CONVERSATION_SAVE_PLAN: 'conversation:save-plan',
  CONVERSATION_GET_PLAN: 'conversation:get-plan',
  CONVERSATION_HYDRATE: 'conversation:hydrate',
  CONVERSATION_GET_TOOL_RESULT: 'conversation:get-tool-result',
  CONVERSATION_REPLACE_MESSAGES: 'conversation:replace-messages',
  CONVERSATION_PERSIST_TOOL_RESULTS: 'conversation:persist-tool-results',
  CONVERSATION_SEARCH_KEYWORD: 'conversation:search-keyword',
  CONVERSATION_SEARCH_MESSAGES: 'conversation:search-messages',
  CONVERSATION_LAST_USER_MESSAGE: 'conversation:last-user-message',

  // ── Database ──
  DB_CHECK: 'db:check',

  // ── Dialog ──
  DIALOG_SHOW: 'dialog:show',
  DIALOG_SHOW_OPEN: 'dialog:show-open',
  DIALOG_SHOW_SAVE: 'dialog:show-save',

  // ── MCP ──
  MCP_LIST_SERVERS: 'mcp:list-servers',
  MCP_GET_SERVER: 'mcp:get-server',
  MCP_CALL_TOOL: 'mcp:call-tool',
  MCP_REGISTER_SERVER: 'mcp:register-server',
  MCP_UNREGISTER_SERVER: 'mcp:unregister-server',
  MCP_START_SERVER: 'mcp:start-server',
  MCP_STOP_SERVER: 'mcp:stop-server',
  MCP_RESTART_SERVER: 'mcp:restart-server',
  MCP_UPDATE_SERVER: 'mcp:update-server',
  MCP_RELOAD_SERVERS: 'mcp:reload-servers',
  MCP_SERVERS_CHANGED: 'mcp:servers-changed',
  MCP_UPDATE_SERVER_SUMMARY: 'mcp:update-server-summary',

  // ── Memory ──
  MEMORY_LIST: 'memory:list',
  MEMORY_SAVE: 'memory:save',
  MEMORY_COUNT: 'memory:count',
  MEMORY_UPDATE: 'memory:update',
  MEMORY_DELETE: 'memory:delete',
  MEMORY_SEARCH: 'memory:search',
  MEMORY_GET_MD: 'memory:get-md',
  MEMORY_SAVE_MD: 'memory:save-md',
  MEMORY_APPEND_MD: 'memory:append-md',

  // ── Settings ──
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // ── Shell ──
  SHELL_OPEN_FOLDER: 'shell:open-folder',
  SHELL_OPEN_EXTERNAL: 'shell:open-external',

  // ── Skills ──
  SKILLS_GET_PREFERENCES: 'skills:get-preferences',
  SKILLS_SET_PREFERENCES: 'skills:set-preferences',
  SKILLS_UPDATE_PREFERENCES: 'skills:update-preferences',
  SKILLS_LIST_IMPORTED: 'skills:list-imported',
  SKILLS_DELETE_IMPORTED: 'skills:delete-imported',
  SKILLS_READ_RAW: 'skills:read-raw',
  SKILLS_WRITE: 'skills:write',
  SKILLS_IMPORT: 'skills:import',
  SKILLS_INSTALL: 'skills:install',
  SKILLS_ENSURE_BUILT_IN: 'skills:ensure-built-in',
  SKILLS_CHANGED: 'skills:changed',
  SKILLS_LIST_FILES: 'skills:list-files',
  SKILLS_READ_FILE: 'skills:read-file',

  // ── Experiences ──
  EXPERIENCES_LIST: 'experiences:list',
  EXPERIENCES_SAVE: 'experiences:save',
  EXPERIENCES_DELETE: 'experiences:delete',
  EXPERIENCES_READ: 'experiences:read',
  EXPERIENCES_TOUCH: 'experiences:touch',
  EXPERIENCES_CLEAR: 'experiences:clear',
  EXPERIENCES_CHANGED: 'experiences:changed',

  // ── Terminal ──
  TERMINAL_EXECUTE: 'terminal:execute',
  TERMINAL_EXEC_SYNC: 'terminal:exec-sync',
  TERMINAL_KILL: 'terminal:kill',
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_EXIT: 'terminal:exit',
  TERMINAL_ERROR: 'terminal:error',

  // ── Git ──
  GIT_INVOKE: 'git:invoke',

  // ── Tools ──
  TOOLS_GET_PREFERENCES: 'tools:get-preferences',
  TOOLS_SET_PREFERENCES: 'tools:set-preferences',

  // ── Utilities ──
  UTIL_READ_FILE: 'util:read-file',
  UTIL_READ_FILE_BINARY: 'util:read-file-binary',
  UTIL_LIST_DIR: 'util:list-dir',
  UTIL_DELETE_PATH: 'util:delete-path',
  UTIL_EDIT_FILE: 'util:edit-file',
  UTIL_PATCH_FILE: 'util:patch-file',
  UTIL_WRITE_FILE: 'util:write-file',
  UTIL_EDIT_DOCX: 'util:edit-docx',
  UTIL_EDIT_PPTX: 'util:edit-pptx',
  UTIL_EDIT_XLSX: 'util:edit-xlsx',
  UTIL_INSPECT_OFFICE: 'util:inspect-office',
  UTIL_EXPORT_DOCUMENT: 'util:export-document',
  UTIL_SAVE_BASE64_IMAGE: 'util:save-base64-image',
  UTIL_COPY_FILE_TO_TMP: 'util:copy-file-to-tmp',
  UTIL_COPY_FILE: 'util:copy-file',
  UTIL_CONVERT_TO_MARKDOWN: 'util:convert-to-markdown',
  // Element-edit preview nonce (M10): the per-mount secret travels through a
  // main-process registry, never the frame URL (the edited page can read
  // location.search).
  UTIL_REGISTER_PREVIEW_NONCE: 'util:register-preview-nonce',
  FILE_STAT: 'file:stat',

  // ── Canvas ──
  CANVAS_PREPARE_WORK_DIR: 'canvas:prepare-work-dir',
  CANVAS_EXPORT_HTML: 'canvas:export-html',
  CANVAS_OPEN_IN_BROWSER: 'canvas:open-in-browser',
  // ── Agent sessions (PLAN-0.3.5 M1.4④): engines hosted in main ──
  AGENT_SESSION_CREATE: 'agent-session:create',
  AGENT_SESSION_ASK: 'agent-session:ask',
  AGENT_SESSION_CANCEL: 'agent-session:cancel',
  AGENT_SESSION_HISTORY: 'agent-session:history',
  AGENT_SESSION_EVENT: 'agent-session:event',
  SERVICE_GET_STATUS: 'service:get-status',
  SERVICE_SET_ENABLED: 'service:set-enabled',
  SERVICE_SET_PORT: 'service:set-port',
  SERVICE_RESET_TOKEN: 'service:reset-token',
  /** Zip the built browser extension and hand it to the user as a download. */
  EXTENSION_EXPORT_ZIP: 'extension:export-zip',
  AGENT_SESSION_HYDRATE: 'agent-session:hydrate',
  AGENT_SESSION_SNAPSHOT: 'agent-session:snapshot',
  AGENT_SESSION_ENGINE_CALL: 'agent-session:engine-call',
  AGENT_SESSION_REFRESH_OPTIONS: 'agent-session:refresh-options',
  // ── Hosted (reverse-RPC) page tools (PLAN-browser-extension M0.2) ──
  HOSTED_TOOL_CALL: 'hosted:tool-call',
  CANVAS_EXPORT_IMAGE: 'canvas:export-image',
  CANVAS_CLEANUP_RECT: 'canvas:cleanup-rect',
  CANVAS_CLEAR_ALL: 'canvas:clear-all',

  // ── SubAgent ──
  EXPERT_LIST: 'expert:list',
  EXPERT_CREATE: 'expert:create',
  EXPERT_UPDATE: 'expert:update',
  EXPERT_DELETE: 'expert:delete',
  EXPERT_RESET: 'expert:reset',

  // ── Knowledge Base ──
  KNOWLEDGE_LIST: 'knowledge:list',
  KNOWLEDGE_LIST_ADVANCED: 'knowledge:list-advanced',
  KNOWLEDGE_GET: 'knowledge:get',
  KNOWLEDGE_ADD_FILE: 'knowledge:add-file',
  KNOWLEDGE_PREPARE_IMPORT: 'knowledge:prepare-import',
  KNOWLEDGE_SCAN_FOLDER: 'knowledge:scan-folder',
  KNOWLEDGE_ADD_FOLDER: 'knowledge:add-folder',
  KNOWLEDGE_ADD_URL: 'knowledge:add-url',
  KNOWLEDGE_DELETE: 'knowledge:delete',
  KNOWLEDGE_REEXTRACT: 'knowledge:reextract',
  KNOWLEDGE_GET_RAW: 'knowledge:get-raw',
  KNOWLEDGE_GET_RAW_PATH: 'knowledge:get-raw-path',
  KNOWLEDGE_READ_WIKI: 'knowledge:read-wiki',
  KNOWLEDGE_WRITE_EXPERIENCE: 'knowledge:write-experience',
  KNOWLEDGE_WRITE_FAVORITE: 'knowledge:write-favorite',
  KNOWLEDGE_GET_STATS: 'knowledge:get-stats',
  KNOWLEDGE_APPLY_WIKI_CHANGES: 'knowledge:apply-wiki-changes',
  KNOWLEDGE_UPDATE_STATUS: 'knowledge:update-status',
  KNOWLEDGE_CLEAR_ALL: 'knowledge:clear-all',
  KNOWLEDGE_SEARCH_CONTENT: 'knowledge:search-content',
  KNOWLEDGE_REBUILD_INDEX: 'knowledge:rebuild-index',
  KNOWLEDGE_ABORT_IMPORT: 'knowledge:abort-import',
  KNOWLEDGE_SEARCH_WIKI: 'knowledge:search-wiki',
  KNOWLEDGE_GET_SCHEMA: 'knowledge:get-schema',
  KNOWLEDGE_GET_WIKI_DIR: 'knowledge:get-wiki-dir',
  KNOWLEDGE_REBUILD_WIKI: 'knowledge:rebuild-wiki',
  KNOWLEDGE_BASE_LIST: 'knowledge:base-list',
  KNOWLEDGE_BASE_CREATE: 'knowledge:base-create',
  KNOWLEDGE_BASE_RENAME: 'knowledge:base-rename',
  KNOWLEDGE_BASE_DELETE: 'knowledge:base-delete',
  KNOWLEDGE_SET_FILE_BASE: 'knowledge:set-file-base',
  KNOWLEDGE_SET_FILES_BASE: 'knowledge:set-files-base',

  // ── PLAN-0.4.0 M3: projects, sandbox, audit ──
  PROJECT_LIST: 'project:list',
  PROJECT_GET: 'project:get',
  PROJECT_CREATE: 'project:create',
  PROJECT_UPDATE: 'project:update',
  PROJECT_DELETE: 'project:delete',
  PROJECT_VALIDATE_DIR: 'project:validate-dir',
  PROJECT_REORDER: 'project:reorder',
  CONVERSATION_SET_PROJECT: 'conversation:set-project',
  CONVERSATION_SET_EXPERT: 'conversation:set-expert',
  CONVERSATION_SET_APPROVAL_MODE: 'conversation:set-approval-mode',
  CONVERSATION_SET_PROFILE: 'conversation:set-profile',

  // ── PLAN-0.4.0 M4: routines ──
  ROUTINE_LIST: 'routine:list',
  ROUTINE_GET: 'routine:get',
  ROUTINE_CREATE: 'routine:create',
  ROUTINE_UPDATE: 'routine:update',
  ROUTINE_DELETE: 'routine:delete',
  ROUTINE_TOGGLE: 'routine:toggle',
  ROUTINE_RUN: 'routine:run',
  ROUTINE_RUNS: 'routine:runs',
  /** 手动清理运行历史（运行记录 + 它产生的对话）—— 见 routine-run-history。 */
  ROUTINE_RUN_DELETE: 'routine:run-delete',
  ROUTINE_RUNS_CLEAR: 'routine:runs-clear',
  ROUTINE_RUNS_PRUNE: 'routine:runs-prune',
  // ── PLAN-routine-batch: CSV 批量模式 ──
  ROUTINE_BATCH_RUN: 'routine:batch-run',
  ROUTINE_BATCH_STOP: 'routine:batch-stop',
  ROUTINE_BATCH_ITEMS: 'routine:batch-items',
  ROUTINE_CSV_PREVIEW: 'routine:csv-preview',

  // ── PLAN-0.4.0 M5: user tools (tool studio; presets per M5R) ──
  TOOL_LIST: 'tool:list',
  TOOL_GET: 'tool:get',
  TOOL_CREATE: 'tool:create',
  TOOL_UPDATE: 'tool:update',
  TOOL_DELETE: 'tool:delete',
  TOOL_DUPLICATE: 'tool:duplicate',
  TOOL_READ_HTML: 'tool:read-html',
  TOOL_WRITE_HTML: 'tool:write-html',
  TOOL_DELETED_PRESETS: 'tool:deleted-presets',
  TOOL_RESTORE_PRESETS: 'tool:restore-presets',
  TOOLBRIDGE_INVOKE: 'toolbridge:invoke',

  // ── Browser Use (A-M1): one channel for the whole capability ──
  BROWSER_RUN_CODE: 'browser:run-code',
  // ── Browser pane (A-M5): in-app browser chrome ──
  BROWSER_PANE_STATE: 'browser:pane-state',
  BROWSER_PANE_WIDTH: 'browser:pane-width',
  BROWSER_PANE_ACTION: 'browser:pane-action',
  BROWSER_PANE_UPDATE: 'browser:pane-update',
  // Address-bar history (PLAN-browser-pane-ux T3.3): manual navigation only,
  // globally shared, clearable from the suggestion dropdown's footer.
  BROWSER_HISTORY_QUERY: 'browser:history-query',
  BROWSER_HISTORY_CLEAR: 'browser:history-clear',
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
