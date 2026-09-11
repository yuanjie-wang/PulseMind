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

  // ── Database ──
  DB_CHECK: 'db:check',

  // ── Dialog ──
  DIALOG_SHOW: 'dialog:show',
  DIALOG_SHOW_OPEN: 'dialog:show-open',
  DIALOG_SHOW_SAVE: 'dialog:show-save',

  // ── Favorites ──
  FAVORITE_LIST: 'favorite:list',
  FAVORITE_ADD: 'favorite:add',
  FAVORITE_REMOVE: 'favorite:remove',

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
  SKILLS_LIST_IMPORTED: 'skills:list-imported',
  SKILLS_DELETE_IMPORTED: 'skills:delete-imported',
  SKILLS_READ_RAW: 'skills:read-raw',
  SKILLS_WRITE: 'skills:write',
  SKILLS_IMPORT: 'skills:import',
  SKILLS_INSTALL: 'skills:install',
  SKILLS_ENSURE_BUILT_IN: 'skills:ensure-built-in',
  SKILLS_CHANGED: 'skills:changed',

  // ── Experiences ──
  EXPERIENCES_LIST: 'experiences:list',
  EXPERIENCES_SAVE: 'experiences:save',
  EXPERIENCES_DELETE: 'experiences:delete',
  EXPERIENCES_READ: 'experiences:read',
  EXPERIENCES_TOUCH: 'experiences:touch',
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
  UTIL_EDIT_FILE: 'util:edit-file',
  UTIL_PATCH_FILE: 'util:patch-file',
  UTIL_WRITE_FILE: 'util:write-file',
  UTIL_SAVE_BASE64_IMAGE: 'util:save-base64-image',
  UTIL_COPY_FILE_TO_TMP: 'util:copy-file-to-tmp',
  UTIL_COPY_FILE: 'util:copy-file',
  UTIL_CONVERT_TO_MARKDOWN: 'util:convert-to-markdown',
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
  AGENT_SESSION_HYDRATE: 'agent-session:hydrate',
  AGENT_SESSION_SNAPSHOT: 'agent-session:snapshot',
  AGENT_SESSION_ENGINE_CALL: 'agent-session:engine-call',
  AGENT_SESSION_REFRESH_OPTIONS: 'agent-session:refresh-options',
  CANVAS_EXPORT_IMAGE: 'canvas:export-image',
  CANVAS_CLEANUP_RECT: 'canvas:cleanup-rect',
  CANVAS_CLEAR_ALL: 'canvas:clear-all',

  // ── SubAgent ──
  SUBAGENT_LIST: 'subagent:list',
  SUBAGENT_CREATE: 'subagent:create',
  SUBAGENT_UPDATE: 'subagent:update',
  SUBAGENT_DELETE: 'subagent:delete',
  SUBAGENT_RESET: 'subagent:reset',

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
  KNOWLEDGE_GET_RAW: 'knowledge:get-raw',
  KNOWLEDGE_GET_RAW_PATH: 'knowledge:get-raw-path',
  KNOWLEDGE_READ_WIKI: 'knowledge:read-wiki',
  KNOWLEDGE_WRITE_EXPERIENCE: 'knowledge:write-experience',
  KNOWLEDGE_GET_STATS: 'knowledge:get-stats',
  KNOWLEDGE_APPLY_WIKI_CHANGES: 'knowledge:apply-wiki-changes',
  KNOWLEDGE_UPDATE_STATUS: 'knowledge:update-status',
  KNOWLEDGE_CLEAR_ALL: 'knowledge:clear-all',
  KNOWLEDGE_SEARCH_CONTENT: 'knowledge:search-content',
  KNOWLEDGE_REBUILD_INDEX: 'knowledge:rebuild-index',
  KNOWLEDGE_ABORT_IMPORT: 'knowledge:abort-import',
  KNOWLEDGE_SEARCH_WIKI: 'knowledge:search-wiki',

  // ── PLAN-0.4.0 M3: projects, sandbox, audit ──
  PROJECT_LIST: 'project:list',
  PROJECT_GET: 'project:get',
  PROJECT_CREATE: 'project:create',
  PROJECT_UPDATE: 'project:update',
  PROJECT_DELETE: 'project:delete',
  AUDIT_LIST: 'audit:list',
  SANDBOX_DETECT: 'sandbox:detect',
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
