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
npm run browsers:install        # Install Playwright Chromium for the native browser (playwright-core)
```

## Architecture

Three-layer Electron app (sandbox + contextIsolation), with shared types bridging main and renderer:

| Layer | Path | Entry | Role |
|-------|------|-------|------|
| **Shared** | `src/shared/types/` | — | DTO types (`AppSettings`, `Conversation`, `ContentBlock`, `ToolPreferences`, `SkillPreferences`) + `ipc-channels.ts` for IPC channel constants |
| **Main** | `src/main/index.ts` | `main` in `package.json` | Node.js: BrowserWindow, IPC handlers (16 handlers in `src/main/ipc/`), SQLite (`database.ts`), file ops, MCP server manager, knowledge import |
| **Preload** | `src/preload/index.ts` | `contextBridge` | Typed `window.electronAPI` bridge, IPC channel types in `types/electron.d.ts` |
| **Renderer** | `src/renderer/src/` | Vite root `src/renderer/` | React 18, sandboxed browser context |
| **Extension** | `src/extension/` | `manifest.json` → `out/extension/` (`npm run build:extension`) | MV3 companion: the service worker is a JSON-RPC client of the main process' loopback service, the content script is an in-page panel (Shadow Root) plus the `page_*` tools |

The extension is not a fourth Electron layer: it connects over `ws://127.0.0.1:8765` with a token and the main process drives its agent sessions (`main/agent/ws-server.ts`, `main/agent/session-manager.ts`). Its tools act on the user's own tab, so the desktop side forwards them back over reverse RPC — `ToolExecutor.execPageTool` → `hostedToolCall` → `background/tool-router.ts` → content script. Routing rules for the `page_*` family are in AGENTS.md.

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
  → registerIpcHandlers()
  → await runLaunchHooks()            (app-start GATES the window — session check +
                                       possible built-in-browser login; splash holds)
  → createWindow()                    (1200×800, min 800×600, sandboxed)
  → skillStore.calibrate()            (sync skill preferences with disk)
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
- Hook context includes: `dataDir`, `workspaceDir`, `skillsDir`, `knowledgeDir`, `platform`, `env`, and `browser`
- **app-start GATES the main window** (user decision 2026-09-25, reversing the earlier hooks-run-concurrently fix): `index.ts` awaits `ensureLaunchHooks()` *before* `createWindow()`, and the splash holds indefinitely until the gate opens — so the hook can run a login flow (validate session → open the login page → poll the server-side check → `close()`); any hook latency is startup latency by design. `window-all-closed` stays safe because `startupComplete` is still false, and the splash's `MAX_SPLASH_MS` valve re-anchors to `hooksCompletedAt`.
- **`ctx.browser.open(url, opts?) → { close() }`** (`src/main/hook-browser.ts`): opens a standalone built-in-browser window (the app's own Chromium, default persistent session — same profile as the in-app pane), URL gated by the shared `assertAllowedUrl` (http/https/about). Deliberately minimal: open + idempotent `close()` (destroy-based, so a page beforeunload can't block it); the completion signal is the hook's own server-side polling, not any window observation. Opening it CLOSES the splash (user ruling 2026-09-25: the splash and the login window never share the screen — destroyed in the same synchronous tick the window is created), and `scheduleSplashFade`'s splash-less branch keeps the gate hold and the `MAX_SPLASH_MS` valve, so the main window still waits for its own first paint.
- Collected env vars stored in module-level `hookEnv` and retrieved by `getHookEnv()`
- `getHookEnv()` also injects the user's login-shell PATH (resolved once at startup via `$SHELL -lic 'echo $PATH'` in `src/main/utils/user-path.ts`) so subprocesses can find tools like `bunx`/`codegraph` that only exist on the shell PATH — packaged apps launched from Finder get a minimal PATH otherwise. A hook-set `PATH` wins over the injected one.

### Main Process Structure

```
src/main/
├── index.ts               # Entry: createWindow, registerIpcHandlers, migrations, local-file protocol
├── ipc/                   # IPC handler files, one per domain
│   ├── index.ts           # Registers all handlers (calls initializeDatabase first)
│   ├── api-proxy.handler.ts   # SSE streaming proxy with abort/multi-request
│   ├── terminal.handler.ts    # Async process spawn/kill with 1MB output limit
│   ├── conversation.handler.ts
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
│   ├── settings-store.ts  # ~/.pulsemind/settings.json (providers→models two-layer format; profiles = derived merged view)
│   ├── skill-store.ts     # Skill file management + calibration
│   ├── mcp-server-store.ts
│   ├── tool-preferences-store.ts
│   └── json-store.ts      # Shared JSON read/write helpers
├── mcp/                   # MCP server lifecycle management
│   ├── MCPServerManager.ts
│   ├── MCPClient.ts
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
- **Global settings** — theme, persona (soul), locale, autoCleanup, workspaceDir
- **Migration** from old single-profile format handled in `SettingsStore.migrate()`. The pre-0.4 `yoloMode` boolean and the short-lived `approvalMode` key are both dropped: approval is per conversation now (`conversations.approval_mode`)
- **Template**: default settings in `templates/pulsemind/settings.json` — includes default soul/persona prompt, empty providers array, theme light, locale zh

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
├── hooks/
│   ├── useChatController.ts    # (~420 lines) Orchestrator: settings, tools, skills, memory, persistence
│   ├── useAppSettings.ts
│   ├── useGreeting.ts
│   └── SettingsContext.tsx
├── agent/                      # Agent engine (shared by chat, tool studio, sub-agents)
│   ├── AgentEngine.ts          # (~940 lines) State machine: SSE dispatch, tool execution, three-layer compaction
│   ├── engine/                 # Strategy modules extracted from the engine (stream-runner, execution-flow, context-compactor, …)
│   ├── tool-executors.ts       # Tool execution implementations (execSpawnAgent, execCommand, etc.)
│   ├── system-prompt-builder.ts # Prompt assembly: invariant core (system) + per-turn state block (final message)
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
├── stores/                     # Zustand stores (navigation, pending composer state, panes)
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
                │                    tool_use → approval (or auto-exec per  │
                │                          the conversation's approvalMode)│
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

Sub-agents are spawned via the `spawn_agent` tool (defined in `built-in-tools.ts:559`):
1. **Tool execution** — `tool-executors.ts:639` extracts `subAgentId` and `task` from the LLM's tool call, looks up profile via IPC
2. **`AgentEngine.spawnSubAgent`** (AgentEngine.ts:680, delegating to `engine/spawn-manager.ts`) — creates a new full AgentEngine instance with a fresh conversation (`sub_<timestamp>_<random>`)
3. **Execution** — runs as an independent agent loop (`startSpawnLoop`) with maxLoopIterations defaulting to 20. The parent agent blocks on `await handle.waitForCompletion()` until the sub-agent finishes
4. **Result** — sub-agent conversation is saved to DB; result text is injected back into the parent's tool_results
5. **Profiles** — stored in `subagent_profiles` SQLite table; managed via `subagent.handler.ts` IPC; default profiles include `subagent-general` and `subagent-canvas`

Key behaviors:
- Sub-agents skip background memory extraction (no background LLM calls within sub-agents)
- Sub-agents bypass the core/state split: they carry their own `spawnSystemPrompt` and get no state block
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
- **writeEditTools**: `write`, `edit`, `git_commit`, `git_restore` — auto-executed except at `always-ask`
- **systemTools**: `install_skill`, `pick_skill`, `spawn_agent` — auto-executed
- **memoryTools**: `memory_search`, `memory_save`, `conversation_search` — auto-executed
- **mcpTools**: MCP-discovered tools — auto-executed (gated ones only when `approvalMode` is `auto`)
- **otherTools**: unlisted tools — held for approval unless `approvalMode` is `auto`

Gating is the `requiresApproval(mode, tier)` ladder (`shared/sandbox/policy.ts`):
`auto` runs everything, `outside-ask` holds shell/ungrouped/gated-MCP calls,
`always-ask` also holds writes. Sub-agent runs hold nothing.
The mode comes from the conversation itself — `conversations.approval_mode`, written
by the composer's 授权 button (and by the extension panel's same-named dropdown over
`session.setApprovalMode`), with an explicit per-session override for derived
sessions (`pickApprovalMode(override, conversation)` in session-manager); the
session manager re-reads it on every ask, so a change lands on the next message.
A conversation that never chose a level runs at `DEFAULT_APPROVAL_MODE` = **按需确认**
(`outside-ask`), not `auto`: reads and workspace writes run unattended and anything
leaving the workspace waits, while the unrestricted level stays a widening the user
asks for (which is why the UI tints it amber). Every resolver — the button's label,
the panel's dropdown, the ladder — reads that one constant, so none of them can
label a fresh conversation as unrestricted while its calls are held.
A conversation that does not exist yet has nowhere to record the choice: the
welcome composer draws 授权 with no active key (the id is generated when the first
message materializes the row), so a click there is held in
`stores/pendingApprovalStore` and applied by `useChatController` to the
conversation it creates — before `startLoop`, so the first turn already runs at
that level. Note that "no conversation open" reaches the UI as the **empty
string** (`useXConversations` opens its store at `''`, not `undefined`), so the
key is always resolved through `shared/conversation-key.ts` `conversationKeyOf()`
— testing it with `typeof` sent the write to a conversation with id `''`
(`conversation.db` even stub-inserted a row for it, which its
`isRealConversationId` guard now refuses). The panel has the same "chosen before
the session exists" case, held per tab in `chrome.storage.session` and replayed
by `ensureSession`.
Scheduled routine runs pin `outside-ask` (unattended D13: the runner auto-rejects).
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
| `agent/AgentEngine.ts` | ~940 | Agent state machine, SSE dispatch, tool execution loop, microCompact (plus `engine/` strategy modules) |
| `components/canvas/CanvasView.tsx` | ~1450 | Canvas (deprecated 0.4.0): pan/zoom, drag/resize, annotations, generation lifecycle |
| `components/knowledge/KnowledgePanel.tsx` | ~980 | Knowledge import, compile queue, wiki view |
| `agent/tool-executors.ts` | ~1090 | Tool execution implementations (spawn, command, read, etc.) |
| `main/storage/knowledge-store.ts` | ~765 | Knowledge file registry, import pipeline, wiki management |
| `components/layout/ChatView.tsx` | ~680 | Message list, input, cursor composition, segment grouping |
| `components/layout/AppLayout.tsx` | ~654 | App shell with sidebar, chat, settings modal orchestration |
| `components/chat/MessageGroup.tsx` | ~648 | Message rendering: text, tool_use, ask_user, action buttons |
| `memory/MemoryManager.ts` | ~643 | Auto-extraction + compression pipeline |
| `tools/built-in-tools.ts` | ~597 | 25 built-in tool definitions with JSON schemas |
| `llm/OpenAIAdapter.ts` | ~486 | OpenAI-compatible provider SSE parser |
| `components/terminal/CommandCard.tsx` | ~472 | Tool_use block with ask_user choices |
| `settings/LlmSettings.tsx` | ~630 | LLM profile CRUD, grouped IA (配置/连接/高级折叠), footer action bar + dirty-leave guard |
| `hooks/useConversationPersistence.ts` | ~431 | Conversation save/hydrate orchestration |
| `components/canvas/RectFrame.tsx` | ~431 | Per-rect iframe + annotation canvas overlay |
| `main/storage/conversation.db.ts` | ~419 | Conversation + message CRUD, tool_result separation |
| `main/mcp/transport.ts` | ~395 | STDIO and SSE MCP transport layer |
| `llm/AnthropicAdapter.ts` | ~383 | Anthropic Messages API SSE parser |
| `App.tsx` | ~376 | Root: providers, locale sync, sleep/resume, hooks-completed |
| `preload/index.ts` | ~330 | Full window.electronAPI typing bridge |
| `main/ipc/api-proxy.handler.ts` | ~130 | SSE streaming proxy with abort |
| `main/mcp/MCPServerManager.ts` | ~170 | MCP server lifecycle |
| `extension/content/page-tree.ts` | ~630 | Page DOM walk: numbering, occlusion, viewport scoping, shadow-DOM piercing, node cap |
| `extension/content/page-tools.ts` | ~230 | `page_*` executors (click sequence, native-setter input, select, wait, JS eval) |

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

- `settings.json` — two-layer model config: `providers[]` (apiFormat/baseURL/apiKey/headers shared) each with nested `models[]` (model/maxTokens/contextLength); `settings.profiles` is the derived merged view; theme, persona, locale, autoCleanup
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
- `better-sqlite3` and `@img` (sharp) are unpacked from asar — native modules that can't be loaded from inside the archive, both listed in `package.json`'s `asarUnpack`. Everything else (`adm-zip`, `jsdom`, `markitdown-js`, `turndown`, `playwright-core`) resolves from the asar.
- Packaging config is in `package.json`'s `"build"` key; there is no `electron-builder.yml`. `appId` is `com.pulsemind.app`.
- `tsconfig.json` is a project-reference root pointing to `tsconfig.node.json` (main+preload) and `tsconfig.web.json` (renderer).
- Agent engine logic lives in `agent/AgentEngine.ts`. Both chat and canvas modes use the same engine; only the presentation layer differs. Engine state (`agentStatus`) must be reset to `idle` before each `startLoop()` to prevent stale `completed` status from premature promise resolution.
- **`src/renderer/src/agent/`, `memory/`, `knowledge/`, `experiences/`, `skills/`, `llm/`, `tools/` are de-facto shared code**: the main process imports them directly (`src/main/agent/session-manager.ts` hosts AgentEngine + the manager stack; `api-proxy.handler.ts` builds LLM adapters). Keep these directories free of DOM/window access; genuinely shared pure logic goes in `src/shared/`.
- There is no settings modal anymore (removed 0.4.0): `SettingsPage.tsx` renders the five sections inline under a left menu; the panels keep their drawer-era `inline`/`open`/`onClose` contract, and several still open standalone Drawers/Modals when invoked from outside the page (e.g. capability center, LLM profile editor).
- Adding a new built-in tool requires updating 3 files: tool definition in `built-in-tools.ts`, command builder in `command-builder.ts`, and tool categorization in `AgentEngine.ts`.
- `agent-utils.ts` contains `shEscape()` and `psEscape()` for shell argument escaping — use these when building shell commands to prevent injection.
- The `find` tool's `extra_args` parameter works on macOS/Linux only (PowerShell can't translate `find -o` expressions).
- Canvas mode uses a separate Zustand store (`canvasStore.ts`) rather than React Context, because canvas zoom/pan/annotation state updates at high frequency and would cause excessive re-renders through Context.
- Font Awesome 6 Free is pre-bundled for canvas-generated pages — inline CSS with Vite-resolved WOFF2 URLs injected into iframe `srcdoc`.
- Knowledge import uses a forked `extract-worker.ts` child process; the worker is built by `scripts/build.js` to `out/main/extract-worker.js`. Long-running knowledge compilations are backed by module-level singleton queues so they survive `KnowledgePanel` unmount.
- Sub-agent conversations use `sub_` prefix IDs and are stored with `type='spawn'` in the DB, which excludes them from the main conversation list (`WHERE type = 'normal'`).
- Sub-agents execute as full AgentEngine instances — the parent agent blocks on `await handle.waitForCompletion()`. Consider this performance impact: each sub-agent LLM call goes through the full streaming path.
- The `browser/rendered-fetcher.ts` module returns post-JS page HTML for knowledge import by delegating to `BrowserService.fetchRendered` — the same managed backend the agent's `browser` tool drives, so a URL renders identically in both paths. Callers fall back to a plain HTTP fetch when it returns null.
- Canvas work directories are persisted via `~/.pulsemind/canvas/manifest.json` mapping rectId → directory path, surviving app restarts. Orphaned directories (not in manifest) are cleaned up on startup.
- File preview pane (PLAN-preview-pane): chat's right-side renderer-local panel (`components/preview/` + `previewPaneStore`, per-conversation tabs). Same geometry pattern as the browser pane (absolute overlay + root `paddingRight`); they stack (preview offsets by the browser pane's width). Write/edit tool cards get an eye button and file chips open the pane instead of the OS; auto-open fires only on successful `write` of a previewable kind, refresh rides `tool_status` diffs in `usePreviewPaneSync` (no fs.watch). `resolvePreviewPath` (shared/preview/file-kind.ts) is the only place tool-relative paths become absolute. CSP was opened to `frame-src local-file:` for the HTML preview iframe; office files show a fallback card by design (phase-2 = `convertFileToMarkdown`). The pane now also EDITS (PLAN-preview-edit, 2026-09-16): markdown/text/html-source/csv edit their source via the zero-dep `FileEditor` (view/edit toggle in the pane toolbar); drafts/edit-modes/conflict-flags live in `previewPaneStore` (components remount per tab switch — component state would drop edits), `stores/preview-edit.ts` owns the pure EOL/BOM round-trip + dirty + external-change decision, >1MB disables editing, closing a dirty tab confirms, and save is ONE path (`serializeDraft → writeFile → baseline → bumpReload`) that both the toolbar button and the editor's ⌘S feed. `scripts/probe-preview-edit.mjs` (23 checks) covers it.
- HTML preview's PRIMARY edit mode is element editing (PLAN-html-element-edit, 2026-09-17): `previewPaneStore.previewModes: 'view' | 'element' | 'source'` (html uses all three; source is the advanced hatch). `?pmPreview=1` responses get CSP-meta stripped + the picker IIFE injected (`shared/preview/html-inject.ts` `buildPreviewCopy` over `src/main/preview/picker-source.generated.ts`, regenerated by `scripts/build-preview-picker.mjs` and drift-guarded by a test). Picker and parent talk `pm:*` postMessage only (opaque-origin frame; `event.source` checked); identity is a pmPath the picker counts (picker's own nodes excluded from indices) and the parent resolves against the DISK text via parse5 `sourceCodeLocationInfo` — `shared/html-edit/{pm-path,resolve,patch}.ts` are the pure core, every write goes through `verifyPatch`, and elements without a source span (script-created) are refused. Per-file sessions (fileText/undo-20/selection/pendingReselect) live in `stores/htmlEditStore.ts`; direct edits message the live DOM, structural ones reload+reselect+restore scroll; external writes clear the undo stack. AI edits run `HtmlElementEditAgent` (JSON `{html}`) through `validateAiElementMarkup` (one element, tag unchanged, no documents, 32KB). `scripts/probe-html-element-edit.mjs` (37 checks, real picker in a real frame) + `tests/html-edit-*.test.ts` (85) pin it.


---

## PLAN-0.4.0 additions (信息架构与工具中心)

- **导航**：`src/renderer/src/navigation/`（`registry.ts` = 唯一视图注册表）+ `stores/navigationStore.ts` + `components/layout/AppMenu.tsx`（左上角菜单）/`ViewHost.tsx`。`canvas` 视图保留但不在菜单（deprecated，入口隐藏）。
- **能力中心** `components/capability/CapabilityCenter.tsx`：MCP / 技能 / 子代理 / 经验四个页签，组件自设置弹窗原样迁入；设置弹窗只留 LLM/助手/环境/记忆/收藏。
- **项目 + 沙箱**：`projects` 表（`conversations.project_id`，默认项目 `default` 合成、不落库，workspace 跟随全局设置）。策略模型 `src/shared/sandbox/policy.ts`（fs/网络/硬隔离，**不含审批**：审批档位按会话存 `conversations.approval_mode`，由输入框的授权控件写入），纯路径裁决 `src/shared/sandbox/path-jail.ts`；强制点= `services/file-ops.ts`（fs）+ `services/terminal.ts` + `mcp/transport.ts`（spawn cwd）。会话上下文走 AsyncLocalStorage（`main/sandbox/session-context.ts`），session-manager 在 ask/engineCall 包裹。硬隔离 `main/sandbox/exec-sandbox.ts`（sandbox-exec/bwrap，探测降级）。
- **日常工作**：`~/.pulsemind/routines/*.json` + SQLite `routine_runs`。调度器 `main/routine/routine-scheduler.ts`（30s tick、纯判定 `shared/schedule/schedule-decision.ts`）、运行器 `routine-runner.ts`（无人值守 D13：审批自动拒绝、ask_user 自动跳过、15 分钟超时）。cron 解析 `shared/schedule/cron.ts`（cron-parser v4 CJS）。
- **工具中心（创意工作室）**：`~/.pulsemind/tools/<id>/`（tool.json/app.html/storage.json）+ `tools/templates/`（6 个预置模板，首启随 templates 拷贝）。生成内核 `renderer/src/tool-studio/generator.ts`（复刻 canvasEngine 模式，产出独立 HTML app）。iframe 严格沙箱（allow-scripts，不透明源），SDK 由 `tool-studio/sdk.ts` 注入、`bridge-host.ts` 校验 event.source 转发；主进程 `main/tool-runtime/` 按 tool.json 的 capabilities 裁决（http 代理封禁 loopback/云元数据、fs 监禁在工具目录、storage KV 1MB 上限、system 剪贴板/通知/外链）并全量审计。
