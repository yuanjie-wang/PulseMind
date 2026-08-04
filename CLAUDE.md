# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev             # Dev mode: esbuild main+preload+worker → Vite HMR (port 5173) → Electron (waits on port)
npm run build           # Production: esbuild main+preload+worker → Vite production build → out/renderer/
npm run preview         # Preview production build via Vite
npm run postinstall     # electron-builder install-app-deps (runs after npm install)
npx electron-builder --mac    # Package macOS DMG
npx electron-builder --win    # Package Windows NSIS installer
npx electron-builder --linux  # Package Linux AppImage
```

```bash
npm run lint            # ESLint check
npm run lint:fix        # ESLint auto-fix
npm run format          # Prettier check
npm run format:fix      # Prettier format
npx tsx scripts/test-compaction.ts  # Run compaction verification tests (no test runner needed)
npm run browsers:install        # Install Playwright Chromium (puppeteer-based browser automation)
```

## Architecture

Three-layer Electron app (sandbox + contextIsolation), with shared types bridging main and renderer:

| Layer | Path | Entry | Role |
|-------|------|-------|------|
| **Shared** | `src/shared/types/` | — | DTO types (`AppSettings`, `Conversation`, `ContentBlock`, `ToolPreferences`, `SkillPreferences`) + `ipc-channels.ts` for IPC channel constants |
| **Main** | `src/main/index.ts` | `main` in `package.json` | Node.js: BrowserWindow, IPC handlers (16 handlers in `src/main/ipc/`), SQLite (`database.ts`), file ops, MCP server manager, knowledge import |
| **Preload** | `src/preload/index.ts` | `contextBridge` | Typed `window.electronAPI` bridge, IPC channel types in `types/electron.d.ts` |
| **Renderer** | `src/renderer/src/` | Vite root `src/renderer/` | React 18, sandboxed browser context |

### Build Pipeline

Three esbuild targets plus Vite:
- **esbuild** (`scripts/build.js`) — builds `src/main/index.ts`, `src/main/storage/extractors/extract-worker.ts`, and `src/preload/index.ts` to `out/main/` and `out/preload/`. Main process and worker: all deps are externals (nothing bundled). Preload: only `electron` is external; other deps bundled inline.
- **Vite** (`vite.config.ts`) — builds renderer at root `src/renderer/`, output to `out/renderer/`. Dev mode serves from `localhost:5173` with HMR.

Dev mode wiring: `concurrently` runs Vite + Electron. `wait-on http://localhost:5173` delays Electron until Vite HMR is ready. `ELECTRON_RENDERER_URL` env var signals dev mode (loads URL instead of file).

Packaging config lives in `package.json`'s `"build"` key. There is no `electron-builder.yml`.

### Runtime Data Paths

Data directory at `~/.pulsemind/`, created by `ensureDataDir()` in `src/main/storage/index.ts`. Data dir, HOOKS_DIR, WORKSPACE_DIR, SKILLS_DIR, and KNOWLEDGE_DIR are all exported from `src/main/storage/index.ts` and consumed by hooks, terminal, and MCP subprocesses.

### App Startup Flow (`src/main/index.ts`)

```
Single-instance lock → app.whenReady()
  → protocol.handle('local-file://')  (sandboxed renderer reads local files)
  → ensureDataDir()
  → createSplashWindow()              (340×360 frameless splash)
  → await initializeDatabase()        (SQLite, must complete before IPC/hooks)
  → await runLaunchHooks()            (app-start hook scripts collect env vars)
  → registerIpcHandlers()
  → skillStore.calibrate()            (sync skill preferences with disk)
  → createWindow()                    (1200×800, min 800×600, sandboxed)
  → Splash→main window crossfade:     (350ms fade, 300ms overlap, min 1.5s splash)
```

The splash-to-main transition runs independently of hooks. On macOS, the dock icon is set explicitly (dev mode runs inside Electron.app which has no icon by default).

### Sleep/Resume Resilience

`powerMonitor.on('resume')` in `src/main/index.ts:226` handles system sleep recovery:
1. Aborts all hanging SSE API streams (`cancelAllRequests()`)
2. Reinitializes SQLite connection (`ensureDbHealthy()`)
3. Notifies renderer via IPC; falls back to full `webContents.reload()` if no ack within 5s

The 3-second delay after resume gives the network stack time to recover. Renderer-side handler in `App.tsx:61` sends the ack via `requestAnimationFrame`.

### Launch Hooks System (`hooks-runner.ts`)

Runs JS hook scripts from `HOOKS_DIR` at startup. Currently supports `app-start` event:
- Hook scripts export `(context: HookContext) => HookResult` — can return `{ env: Record<string, string> }` to set env vars for terminal/MCP subprocesses
- Hook context includes: `dataDir`, `workspaceDir`, `skillsDir`, `knowledgeDir`, `platform`, and `env`
- Collected env vars stored in module-level `hookEnv` and retrieved by `getHookEnv()`
- `getHookEnv()` also injects the user's login-shell PATH (resolved once at startup via `$SHELL -lic 'echo $PATH'` in `src/main/utils/user-path.ts`) so subprocesses can find tools like `bunx`/`codegraph` that only exist on the shell PATH — packaged apps launched from Finder get a minimal PATH otherwise. A hook-set `PATH` wins over the injected one.

### Main Process Structure

```
src/main/
├── index.ts               # Entry: createWindow, registerIpcHandlers, migrations, local-file protocol
├── ipc/                   # 16 IPC handler files, one per domain
│   ├── index.ts           # Registers all handlers (calls initializeDatabase first)
│   ├── api-proxy.handler.ts   # SSE streaming proxy with abort/multi-request
│   ├── terminal.handler.ts    # Async process spawn/kill with 1MB output limit
│   ├── conversation.handler.ts
│   ├── canvas.handler.ts      # Canvas workdir management, export, open in browser
│   ├── knowledge.handler.ts   # Knowledge file import/compile/list/delete
│   ├── subagent.handler.ts    # Sub-agent profile CRUD
│   ├── memory.handler.ts
│   ├── mcp.handler.ts
│   ├── skills.handler.ts
│   └── ...
├── storage/               # Persistence layer
│   ├── database.ts        # SQLite (better-sqlite3, WAL mode, FTS5 for memories)
│   ├── knowledge-store.ts # Knowledge file registry + schema compilation
│   ├── extractors/        # Child-process extraction worker + format-specific extractors
│   ├── settings-store.ts  # ~/.pulsemind/settings.json (profiles-based format)
│   ├── skill-store.ts     # Skill file management + calibration
│   ├── mcp-server-store.ts
│   ├── tool-preferences-store.ts
│   └── json-store.ts      # Shared JSON read/write helpers
├── mcp/                   # MCP server lifecycle management
│   ├── MCPServerManager.ts
│   ├── MCPClient.ts
│   ├── chrome-fetcher.ts      # Chrome DevTools MCP page navigation + HTML extraction (used by knowledge import)
│   └── transport.ts           # STDIO and SSE MCP transport layer
├── utils/                 # Main-process utilities
│   ├── patch-utils.ts         # Unified file patching (apply diffs, string replacement, edit matching)
│   ├── zip-extractor.ts       # ZIP extraction for skill imports
│   └── skill-parser.ts        # Skill manifest + metadata parsing
├── migration/             # One-time data migrations (experiences → skills)
└── assets/
```

### Database Schema (`pulsemind.db`)

SQLite (WAL mode + FTS5) at `~/.pulsemind/db/pulsemind.db`:

- **conversations**: `id, title, type (normal|canvas|spawn), rect_id, summary, keywords, pinned, plan_json, extracted_msg_count, experience_extracted_count, created_at, updated_at`
- **messages**: `id, conversation_id (FK), role, content, content_blocks (JSON), created_at, liked, favorited, processing_ms, input_tokens, output_tokens, auto_summary, compressed_ids`
- **tool_results**: `ref_id, conversation_id, message_id, block_index, tool_use_id, content, is_error` — tool_result content stored separately to keep messages lightweight
- **memories**: `id, content, type (auto|manual|decision|fact|preference|experience), category (code|architecture|user_pref|decision|general|experience), source, created_at, updated_at`
- **memories_fts**: FTS5 virtual table over `memories.content`
- **knowledge_files**: `id, file_path, title, source_type (file|url|experience), source_url, source_path, conv_id, content_hash, status (raw|compiled), wiki_outputs, created_at, compiled_at`
- **knowledge_fts**: FTS5 virtual table over knowledge file content
- **favorites**: `id, message_id, conversation_id, conversation_title, role, content, content_blocks, created_at`
- **token_usage**: `id, input_tokens, output_tokens, created_at`
- **tool_preferences**: `tool_name, enabled`
- **skill_preferences**: `enabled_skills, skill_keywords, processed_conversations` (singleton row)
- **subagent_profiles**: `id, name, base_prompt, allowed_tools, allowed_mcp_servers, allowed_skills, profile_id, max_tokens, max_loop_iterations, is_built_in, enabled`

The `deriveConvType(id)` function at `conversation.db.ts:7` maps conversation IDs to types: `canvas_` prefix → `'canvas'`, `spawn_`/`sub_` prefix → `'spawn'`, otherwise `'normal'`. The conversation list query filters `WHERE type = 'normal'`. Sub-agent conversations are automatically excluded.

### Settings & Profiles

Settings stored in `~/.pulsemind/settings.json`:
- **Profiles** — array of `LlmProfile[]` (provider, apiKey, baseURL, model, maxTokens)
- **Global settings** — theme, persona (soul), locale, yoloMode, autoCleanup, workspaceDir
- **Migration** from old single-profile format handled in `SettingsStore.migrate()`
- **Template**: default settings in `templates/pulsemind/settings.json` — includes default soul/persona prompt, empty profiles array, theme light, locale zh, yoloMode true

### Renderer-Side Managers

Renderer code has manager classes that wrap IPC calls for domain logic:

| Manager | Path | Role |
|---------|------|------|
| `MemoryManager` | `src/renderer/src/memory/MemoryManager.ts` | Auto-extraction + compression pipeline |
| `KnowledgeManager` | `src/renderer/src/knowledge/KnowledgeManager.ts` | Knowledge file CRUD, LLM-based compilation orchestration, tracks `wikiVersion` for cache invalidation |
| `ToolManager` | `src/renderer/src/tools/ToolManager.ts` | Registry for `ToolDefinition` (extends `FeatureManager`) |
| `SkillManager` | `src/renderer/src/skills/SkillManager.ts` | Registry for skill definitions (extends `FeatureManager`) |

`KnowledgeManager` stores LLM config (apiKey, baseURL, adapter, model) and exposes `canCompile` check. Its `wikiVersion` counter increments on each successful compile — `AgentEngine` checks this to decide if its cached knowledge snapshot is stale.

### Preload Bridge (`window.electronAPI`)

Single preload file exposes typed async methods via `contextBridge.exposeInMainWorld`. All renderer→main communication goes through `ipcRenderer.invoke()` with channel names from `IPC_CHANNELS` constants. No `send`/`on` for main→renderer streaming (except terminal output which uses `ipcRenderer.on`).

### Renderer Structure

```
App.tsx                         # Root: SettingsProvider > TranslationProvider > AppContent
├── components/layout/          # App shell
│   ├── AppLayout.tsx           # Sidebar + chat area + settings modal
│   ├── ChatView.tsx            # Message list + input + cursor composition
│   ├── ConversationSidebar.tsx
│   ├── SessionManager.tsx
│   └── StatisticsDrawer.tsx
├── components/chat/            # Chat UI components
│   ├── MessageGroup.tsx        # Message renderer with action buttons
│   ├── InputArea.tsx           # Input with file picker, model selector
│   ├── WelcomeContent.tsx      # Landing screen
│   ├── ExecutionSegment.tsx    # Collapsible tool execution segment
│   ├── StreamingBlockPreview.tsx
│   ├── CodeBlock.tsx           # Mermaid + ECharts rendering
│   ├── ThinkingBlockView.tsx
│   ├── ErrorDisplay.tsx
│   └── ExtensionPrompt.tsx
├── components/knowledge/       # Knowledge import & compilation UI
│   ├── KnowledgePanel.tsx      # Folder import, compile queue, wiki view
│   └── KnowledgeDrawer.tsx
├── components/terminal/        # Tool execution renderers
│   ├── CommandCard.tsx         # Tool_use block with ask_user choices
│   ├── TerminalOutput.tsx
│   └── EChartsBlock.tsx
├── components/canvas/          # Canvas/visual generation mode
│   ├── CanvasView.tsx          # (~1410 lines) Main canvas: pan/zoom, drag/resize, annotations, generation
│   ├── canvasEngine.ts         # AgentEngine wrapper with canvas-specific prompts
│   ├── RectFrame.tsx           # Per-rect iframe + child annotation canvas + Grainient overlay
│   ├── Grainient.tsx           # WebGL gradient animation (OGL library)
│   ├── LeftAnnotationToolbar.tsx
│   ├── CanvasToolbar.tsx
│   ├── RegionConfig.tsx
│   ├── ZoomControls.tsx
│   └── AnnotationNotePopup.tsx
├── hooks/
│   ├── useChatController.ts    # (~1020 lines) Orchestrator: settings, tools, skills, memory, persistence
│   ├── useAppSettings.ts
│   ├── useGreeting.ts
│   └── SettingsContext.tsx
├── agent/                      # Agent engine (shared by chat + canvas modes)
│   ├── AgentEngine.ts          # (~1560 lines) State machine: SSE dispatch, tool execution, three-layer compaction
│   ├── tool-executors.ts       # Tool execution implementations (execSpawnAgent, execCommand, etc.)
│   ├── system-prompt-builder.ts # System prompt assembly with caching (6h TTL for main, no cache for sub-agents)
│   ├── command-builder.ts      # Shell command builder (find/search/exec/ask_user)
│   ├── agent-utils.ts          # Shell escaping (shEscape, psEscape)
│   ├── context-gc.ts           # Context pressure detection and garbage collection
│   ├── plan-manager.ts         # Plan step tracking and execution state
│   ├── image-utils.ts          # Base64 image extraction for LLM bandwidth reduction
│   └── one-shot-agent/         # Lightweight non-streaming agents (TitleAgent, SkillKeywordAgent, etc.)
├── llm/                        # Provider-agnostic LlmAdapter pattern
│   ├── adapter.ts              # LlmAdapter interface
│   ├── AnthropicAdapter.ts     # Messages API SSE parser
│   ├── OpenAIAdapter.ts        # Chat Completions SSE parser
│   ├── stream-types.ts
│   ├── stream-utils.ts
│   └── index.ts                # Factory: createLlmAdapter(provider)
├── tools/                      # FeatureRegistry pattern
│   ├── ToolManager.ts          # Registry for ToolDefinition
│   ├── built-in-tools.ts       # 25 built-in tool definitions with JSON schemas
│   └── types.ts
├── skills/                     # Same FeatureRegistry pattern
│   ├── SkillManager.ts
│   ├── built-in-skills.ts
│   └── types.ts
├── memory/
│   └── MemoryManager.ts        # Auto-extraction + compression pipeline
├── stores/                     # Zustand stores (canvas mode only)
│   └── canvasStore.ts          # Canvas annotations, zoom, pan, undo/redo
├── i18n/                       # Chinese/English via useTranslation() hook
│   ├── locales/{zh,en}.ts
│   └── useTranslation.tsx
├── types/                      # Re-exports from shared + renderer-specific
│   ├── agent.ts, conversation.ts, settings.ts, hooks.ts
│   ├── electron.d.ts
│   └── manager.ts              # FeatureRegistry<T> + FeatureManager<T>
└── utils/
    ├── microCompact.ts         # Zero-cost tool_result compression
    ├── canvasDrawUtils.ts      # Annotation drawing on canvas overlays
    ├── snap.ts                 # Snap-to-grid for rect drag/resize
    └── message-utils.ts
```

### Key Data Flow

```
User message → AgentEngine → adapter.buildRequest() → IPC proxy (main) → LLM API
                ↑                                                        │
                │                                            SSE stream → │
                │                                        stream dispatcher│
                │                                                ↓        │
                │                              React state (message list) │
                ↑                                                        │
                │                    tool_use → approval (or auto-exec in  │
                │                              YOLO mode)                │
                └──────── tool_result (→ continueLoop with microCompact) ──┘
                     ↑
                Auto-title (non-streaming LLM call via TitleAgent)
                Auto-memory (non-streaming via MemoryExtractionAgent)
```

### Conversation Persistence Layer

CRUD lives in `src/main/storage/conversation.db.ts` (not in individual handlers):
- **`saveConversation`** — full upsert (conversation + all messages) in a transaction; strips tool_result content into `tool_results` table via `sanitizeToolResults()`
- **`appendConversationMessages`** — incremental save for streaming; only writes specified messages rather than the full list
- **`hydrateConversation(id)`** — loads a conversation and fills in `tool_result` content from the `tool_results` table (used when resuming an agent session)
- **`replaceMessagesAtomic`** — atomically deletes and inserts messages in a single transaction
- **`deriveConvType(id)`** / **`deriveRectId(id)`** — derive conversation type and canvas rect_id from conversation ID prefix

### Two-Layer Compaction + Background Memory Extraction

`AgentEngine.ts` manages context window with two compaction layers (all operate on API copies, this.messages untouched):

1. **nanoCompact** (Layer 1) — replaces stale `tool_result` blocks with `[tool_result_id: uuid]` placeholders on the API copy. Protection window keeps the last 4 tool_result messages intact. Tiered strategy: Tier 1 tools (exec, search, find, list_dir) keep 10, Tier 2 (read, knowledge_read, edit, etc.) keep 20.

2. **lightCompact** (Layer 2, on pressure >70%) — scans oldest messages on the API copy for removable `assistant(tool_uses) → user(tool_results)` pairs. Three protections: keeps last text user message, 3 most recent rounds, and an 8K token hot zone.

3. **hardTruncate** (Layer 3, last resort) — drops oldest messages from the API copy when still over limit. Guarantees MIN_KEEP messages and MIN_USER_TURNS.

**Background memory extraction** — when context pressure exceeds 70%, silently extracts memories from old tool_use→tool_result pairs and saves to the memory store (fire-and-forget, no message modification). Replaces the old autoCompact mechanism.

### Sub-Agent System

Sub-agents are spawned via the `spawn_agent` tool (defined in `built-in-tools.ts:504`):
1. **Tool execution** — `tool-executors.ts:196` extracts `subAgentId` and `task` from the LLM's tool call, looks up profile via IPC
2. **`AgentEngine.spawnSubAgent`** (AgentEngine.ts:864) — creates a new full AgentEngine instance with a fresh conversation (`sub_<timestamp>_<random>`)
3. **Execution** — runs as an independent agent loop (`startSpawnLoop`) with maxLoopIterations defaulting to 20. The parent agent blocks on `await handle.waitForCompletion()` until the sub-agent finishes
4. **Result** — sub-agent conversation is saved to DB; result text is injected back into the parent's tool_results
5. **Profiles** — stored in `subagent_profiles` SQLite table; managed via `subagent.handler.ts` IPC; default profiles include `subagent-general` and `subagent-canvas`

Key behaviors:
- Sub-agents skip background memory extraction (no background LLM calls within sub-agents)
- Sub-agents bypass the 6-hour system prompt cache
- Sub-agents can recursively spawn sub-agents
- `spawnSystemPrompt` flag controls sub-agent-specific branch behavior in the loop

### Canvas Mode Architecture

Canvas and chat modes share the same `AgentEngine` — only the presentation/UI differs:

1. **RectFrame** — iframe rendering generated HTML, with annotation overlay canvas and Grainient WebGL loading animation
2. **canvasEngine.ts** — wraps AgentEngine with canvas-specific system prompt (HTML generation), reads `workDir/index.html` from disk after each generation cycle
3. **Annotation system** — annotations drawn on canvas overlays, coordinates mapped to iframe elements via `getBoundingClientRect()`, per-annotation element matching for LLM context
4. **`canvasStore` (Zustand)** — manages annotations (parent rects + child annotations), zoom/pan, undo/redo, persistence
5. **Workdir** — per-rect work directories at `~/.pulsemind/canvas/{timestamp}/`, reused across generations by storing `CanvasEngineHandle` in a `Map<string, CanvasEngineHandle>`

### Knowledge System

Knowledge files are imported, extracted, and compiled into a markdown wiki that is injected into context:

1. **Import** — `knowledge.handler.ts` accepts file paths or folders; files are registered in `knowledge_files` with `status: 'raw'`
2. **Extraction** — `extract-worker.ts` runs as a forked child process to parse PDFs, HTML, Office docs, etc. via `markitdown-js` and format-specific extractors in `src/main/storage/extractors/`
3. **Compilation** — `KnowledgeCompilerAgent.ts` processes extracted raw text into a structured markdown wiki stored under `~/.pulsemind/knowledge/wiki/`
4. **Usage** — compiled knowledge is loaded into the system prompt context by `useChatController` / `AgentEngine`
5. **UI** — `KnowledgePanel.tsx` shows import progress, compile queue, and wiki contents; queue state is maintained in module-level singletons so it survives view switches/unmounts

### Streaming Blocks Lifecycle

LLM response streaming flows through four event stages per block:

1. **`onContentBlockStart`** — block created with `type` and `name` (tool_use blocks get `status: 'pending'`)
2. **`onContentBlockDelta`** — content accumulated: `text_delta` for text, `input_json_delta` for tool params
3. **`onContentBlockStop`** — block finalized, truncated JSON handled via `_jsonTruncated` fallback
4. **`onStreamComplete`** — all blocks committed to `this.messages` as an `assistant` message

During streaming, `this.streamingBlocks` (mirrored to React via `setStreamingBlocks`) shows live content. After `onStreamComplete`, `streamingBlocks` is cleared and the committed message appears.

### Message Segment Grouping

`ChatView.tsx::groupMessages()` partitions `AgentMessage[]` into `Segment[]` for rendering:

```
Segment = { type: 'single', msg: AgentMessage }        // text / ask_user — always visible
        | { type: 'execution', msgs: AgentMessage[] }  // tool_use ↔ tool_result cycles — collapsible
        | { type: 'streaming', blocks: ContentBlock[] } // live streaming text
```

- **Text** and **ask_user** are breakpoints that flush pending execution segments.
- Tool_use blocks between consecutive breakpoints are grouped into one `execution` segment.
- During streaming, `allSegments` append streaming blocks and optionally merge streaming tool_use into the last committed execution segment.

### ExecutionSegment States

Collapsed header shows lifecycle in priority order:
1. **Receiving** (prop `isReceiving=true`): `"{toolName} 指令生成中..."`
2. **Initial** (all tools `status === 'pending'` or `undefined`): `"开始执行"`
3. **Executing** (mixed statuses): last extracted tool text
4. **Done** (all tools completed AND `isActive=false`): `"已完成（工具调用X次）"`

### Tool Execution Flow

After `onStreamComplete`, tools are categorized and dispatched:
- **readOnlyTools**: `read`, `list_dir`, `find` — always auto-executed
- **writeEditTools**: `write`, `edit` — auto-executed in YOLO mode, pending approval in mixed mode
- **systemTools**: `install_skill`, `pick_skill`, `spawn_agent` — auto-executed
- **memoryTools**: `memory_search`, `memory_save`, `conversation_search` — auto-executed
- **mcpTools**: MCP-discovered tools — auto-executed
- **otherTools**: unlisted tools — auto-executed only in YOLO mode
- **askUserTools**: always require user response

Tool blocks transition: `pending` → `running` → `completed` or `rejected`.

### Terminal Execution Architecture

IPC-based async process management in `terminal.handler.ts`:
- Processes tracked in `Map<string, ProcessEntry>` (stdout/stderr up to 1MB, 60s default timeout)
- Output streamed to renderer via `webContents.send(TERMINAL_OUTPUT/TERMINAL_ERROR/TERMINAL_EXIT)` events
- Kill via `TERMINAL_KILL` which sends SIGTERM → SIGKILL after 3s grace period

### App.tsx Key Behaviors

`App.tsx` + `AppContent` component:
1. **Provider chain**: `SettingsProvider > TranslationProvider > AppContent`
2. **Locale sync**: watches `settings.locale`, syncs to `TranslationProvider` state
3. **Tab key disabled globally** via `window.addEventListener('keydown', { capture: true })` — prevents focus navigation across entire app
4. **Hooks-completed listener**: when main process signals hooks done, reloads settings
5. **Sleep/resume listener**: `onSystemResumed` callback sends ack to main (prevents full reload)
6. **API key**: sourced synchronously from `activeProfile.apiKey` (stored in `settings.json`, not async)

### Code Quality & Formatting

| Tool | Config | Commands |
|------|--------|---------|
| **ESLint** | `eslint.config.mjs` — `@eslint/js` + `typescript-eslint` + `eslint-plugin-react` + `eslint-plugin-react-hooks` | `npm run lint` / `npm run lint:fix` |
| **Prettier** | `.prettierrc` — `semi: false, singleQuote: true, trailingComma: "all", printWidth: 160` | `npm run format` / `npm run format:fix` |

ESLint applies `no-require-imports: off` for main/preload (CommonJS). Renderer gets React + React Hooks rules with `react-in-jsx-scope: off` and `prop-types: off`.

### Complexity Hotspots

| File | Lines | Why |
|------|-------|-----|
| `agent/AgentEngine.ts` | ~1646 | Agent state machine, SSE dispatch, tool execution loop, microCompact |
| `components/canvas/CanvasView.tsx` | ~1447 | Canvas: pan/zoom, drag/resize, annotations, generation lifecycle |
| `components/knowledge/KnowledgePanel.tsx` | ~960 | Knowledge import, compile queue, wiki view |
| `agent/tool-executors.ts` | ~820 | Tool execution implementations (spawn, command, read, etc.) |
| `main/storage/knowledge-store.ts` | ~765 | Knowledge file registry, import pipeline, wiki management |
| `components/layout/ChatView.tsx` | ~680 | Message list, input, cursor composition, segment grouping |
| `components/layout/AppLayout.tsx` | ~654 | App shell with sidebar, chat, settings modal orchestration |
| `components/chat/MessageGroup.tsx` | ~648 | Message rendering: text, tool_use, ask_user, action buttons |
| `memory/MemoryManager.ts` | ~643 | Auto-extraction + compression pipeline |
| `tools/built-in-tools.ts` | ~597 | 25 built-in tool definitions with JSON schemas |
| `llm/OpenAIAdapter.ts` | ~486 | OpenAI-compatible provider SSE parser |
| `components/terminal/CommandCard.tsx` | ~472 | Tool_use block with ask_user choices |
| `settings/LlmSettings.tsx` | ~441 | LLM profile CRUD + model config UI |
| `hooks/useConversationPersistence.ts` | ~431 | Conversation save/hydrate orchestration |
| `components/canvas/RectFrame.tsx` | ~431 | Per-rect iframe + annotation canvas overlay |
| `main/storage/conversation.db.ts` | ~419 | Conversation + message CRUD, tool_result separation |
| `main/mcp/transport.ts` | ~395 | STDIO and SSE MCP transport layer |
| `llm/AnthropicAdapter.ts` | ~383 | Anthropic Messages API SSE parser |
| `App.tsx` | ~376 | Root: providers, locale sync, sleep/resume, hooks-completed |
| `preload/index.ts` | ~330 | Full window.electronAPI typing bridge |
| `main/ipc/api-proxy.handler.ts` | ~130 | SSE streaming proxy with abort |
| `main/mcp/MCPServerManager.ts` | ~170 | MCP server lifecycle |

## Key Dependencies

- **`@ant-design/x`** v2 — Ant Design X SDK for conversation UI patterns (Conversation component, bubble rendering)
- **`@ant-design/x-markdown`** — Markdown rendering for LLM output
- **`@ant-design/x-sdk`** — X SDK state management (`useXConversations` for conversation list, `useXChat` for message input)
- **`zustand`** v5 — Canvas state only (annotations, zoom/pan)
- **`better-sqlite3`** v12 — SQLite with WAL mode, no ORM
- **`echarts`** v6 — Chart rendering in chat responses
- **`ogl`** v1 — WebGL gradient animation (Grainient canvas loading)
- **`sharp`** v0.35 — Image processing (screenshots, canvas exports)

## Key Patterns

- **Settings**: React Context (`SettingsContext.tsx`) for app-wide settings across React tree. Canvas state uses **Zustand** (`canvasStore.ts`) because of frequent zoom/pan/annotation updates.
- **Dual-render drawers**: Settings components accept `inline?: boolean` — renders as `<div>` inside settings modal or as standalone Ant Design `Drawer`.
- **Provider adapters**: Implement `LlmAdapter` interface + register in `llm/index.ts` factory.
- **Feature registry**: `FeatureRegistry<T>` + `FeatureManager<T>` abstract class — `ToolManager` and `SkillManager` both extend `FeatureManager`.
- **Shared types**: `src/shared/types/` contains DTOs used by main and renderer. Renderer type files re-export from shared. Main and preload import directly from shared.
- **IPC channels**: All channel names centralized in `src/shared/ipc-channels.ts`. No raw string literals in handlers or bridge calls.
- **API calls always route through main process IPC proxy** to avoid CORS in sandboxed renderer.
- **Auto-compaction**: `microCompact` replaces stale `tool_result` blocks with placeholders (keeps last 3 intact), called at top of `continueLoop`.
- **Context pressure GC**: `context-gc.ts` tracks token pressure and can drop older messages before the next LLM call.
- **i18n**: `useTranslation()` hook returns `t(key)` function. Locales in `locales/zh.ts` and `locales/en.ts`. All user-visible strings go through `t()`.
- **Canvas coordinates**: Canvas annotations use logical coordinate system (`getCanvasPos` converts screen → logical). IFrame element coordinates from `getBoundingClientRect()` are mapped to annotation space via `childAnnotation.point - parentRect.boundingBox`.
- **Local-file protocol**: `main/index.ts` registers a `local-file://` handler so the sandboxed renderer can read files from `~/.pulsemind/` (the LLM often strips the home directory prefix).

## Runtime Data (`~/.pulsemind/`)

On first launch, the app migrates data from the old `~/.pulseai/` directory to `~/.pulsemind/` and renames `pulseai.db` → `pulsemind.db` if present.

- `settings.json` — profiles (provider, apiKey, baseURL, model, maxTokens), theme, persona, locale, yoloMode, autoCleanup
- `pulsemind.db` — SQLite (WAL mode + FTS5): conversations, messages, memories, favorites, token_usage, knowledge_files
- `MEMORY.md` — auto-injected into every system prompt
- `tool-preferences.json` / `skill-preferences.json` — enabled/disabled state
- `skills/` — installed ZIP-based skill packs
- `knowledge/` — imported knowledge raw files and compiled wiki
- `canvas/{timestamp}/` — per-rect index.html for canvas generation mode
- `workspace/` — default workspace directory

## Naming Conventions

| Category | Convention | Examples |
|----------|-----------|----------|
| React components (.tsx) | `PascalCase.tsx` | `ChatView.tsx`, `MessageGroup.tsx` |
| Classes / constructs (.ts) | `PascalCase.ts` | `AgentEngine.ts`, `MemoryManager.ts` |
| Pure utilities / functions | `kebab-case.ts` | `agent-utils.ts`, `microCompact.ts`, `command-builder.ts` |
| Hooks | `use{Name}.ts(x)` | `useChatController.ts`, `useTranslation.tsx` |
| IPC handlers | `{resource}.handler.ts` | `conversation.handler.ts`, `settings.handler.ts` |
| Persistence stores | `{resource}.store.ts` | `settings-store.ts`, `tool-preferences-store.ts` |
| Zustand stores | `{resource}Store.ts` | `canvasStore.ts` |
| Config / entry | `index.ts` | — |
| i18n locales | `{lang}.ts` | `en.ts`, `zh.ts` |
| Tool definitions | `built-in-tools.ts` | Singular file for all built-in tool registrations |
| Skill definitions | `built-in-skills.ts` | Singular file for all built-in skill registrations |

## Gotchas

- **Always `cd` to project root** before running commands. Workspace root contains unrelated projects.
- `better-sqlite3`, `@img`, `adm-zip`, `markitdown-js`, `jsdom`, `@mozilla/readability`, `turndown`, and `chrome-devtools-mcp` are unpacked from asar (native modules and runtime deps, listed in `asarUnpack`/`extraFiles`). `chrome-devtools-mcp` must stay unpacked — it's spawned as a subprocess, which can't read inside asar.
- Packaging config is in `package.json`'s `"build"` key; there is no `electron-builder.yml`. `appId` is `com.pulsemind.app`.
- `tsconfig.json` is a project-reference root pointing to `tsconfig.node.json` (main+preload) and `tsconfig.web.json` (renderer).
- Agent engine logic lives in `agent/AgentEngine.ts`. Both chat and canvas modes use the same engine; only the presentation layer differs. Engine state (`agentStatus`) must be reset to `idle` before each `startLoop()` to prevent stale `completed` status from premature promise resolution.
- The settings modal is an Ant Design `Modal` (not Drawer) with side-by-side 150px left menu + right content area. Settings panel components use the `inline` prop pattern.
- Adding a new built-in tool requires updating 3 files: tool definition in `built-in-tools.ts`, command builder in `command-builder.ts`, and tool categorization in `AgentEngine.ts`.
- `agent-utils.ts` contains `shEscape()` and `psEscape()` for shell argument escaping — use these when building shell commands to prevent injection.
- The `find` tool's `extra_args` parameter works on macOS/Linux only (PowerShell can't translate `find -o` expressions).
- Canvas mode uses a separate Zustand store (`canvasStore.ts`) rather than React Context, because canvas zoom/pan/annotation state updates at high frequency and would cause excessive re-renders through Context.
- Font Awesome 6 Free is pre-bundled for canvas-generated pages — inline CSS with Vite-resolved WOFF2 URLs injected into iframe `srcdoc`.
- Knowledge import uses a forked `extract-worker.ts` child process; the worker is built by `scripts/build.js` to `out/main/extract-worker.js`. Long-running knowledge compilations are backed by module-level singleton queues so they survive `KnowledgePanel` unmount.
- Sub-agent conversations use `sub_` prefix IDs and are stored with `type='spawn'` in the DB, which excludes them from the main conversation list (`WHERE type = 'normal'`).
- Sub-agents execute as full AgentEngine instances — the parent agent blocks on `await handle.waitForCompletion()`. Consider this performance impact: each sub-agent LLM call goes through the full streaming path.
- The `chrome-fetcher.ts` module handles Chrome DevTools MCP lifecycle (start/stop/wait) plus cross-origin iframe crawling. It's a standalone module called by `knowledge-store.ts` during URL imports.
- Canvas work directories are persisted via `~/.pulsemind/canvas/manifest.json` mapping rectId → directory path, surviving app restarts. Orphaned directories (not in manifest) are cleaned up on startup.
