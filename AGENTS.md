# AGENTS.md

For detailed architecture, see [CLAUDE.md](./CLAUDE.md). This file covers facts agents commonly miss.

## Commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | esbuild main+preload → Vite HMR (port 5173) → Electron launch (waits on port) |
| `npm run build` | esbuild main+preload → Vite production build |
| `npm test` | vitest suite (`tests/`) — pure-logic coverage: env placeholders, settings store, persistence planning, message conversion |
| `npm run browsers:install` | Install Playwright Chromium for browser tool |

No typecheck script configured. `npm run lint` / `lint:fix` (eslint) and `format` / `format:fix` (prettier) exist. Debugging is `console.log` only. Tests that need `better-sqlite3` can't run under plain Node (native module is Electron-ABI) — DB-layer coverage is a known gap.

## Build Pipeline

- **Two independent builds**: esbuild (`scripts/build.js`) runs first, then Vite (`vite.config.ts`).
- Main process: all deps (including `electron`) are externals — nothing bundled, resolved via `require()` at runtime.
- Preload: only `electron` is external; all other deps are bundled inline into `out/preload/index.js`.
- Vite root is `src/renderer/` (not project root) — `index.html` lives there.
- Packaging config is `package.json`'s `"build"` key (appId `com.pulsemind.app`; mac=dmg, win=portable, linux=AppImage). There is no `electron-builder.yml`. Package with `npm run build` then `npx electron-builder --mac --publish never`; output lands in `dist/`.
- Dev mode: `concurrently` runs Vite + Electron. `wait-on http://localhost:5173` delays Electron until Vite HMR is ready. `ELECTRON_RENDERER_URL` signals dev mode (loads URL instead of file).

## Architecture

| Layer | Path | Entry | Role |
|-------|------|-------|------|
| Main | `src/main/index.ts` | `main` in `package.json` | Window, IPC, SQLite, Playwright, ACP |
| Preload | `src/preload/index.ts` | `contextBridge` | Typed `window.electronAPI` bridge |
| Renderer | `src/renderer/src/` | Vite root `src/renderer/` | React 18, sandboxed browser context |

IPC types: `src/renderer/src/types/electron.d.ts` (~311 lines).

## Complexity Hotspots

- `agent/AgentEngine.ts` (944 lines) + `agent/engine/` strategy modules — agent state machine, SSE dispatch, tool execution loop (the 2391-line monolith was split; engine modules hold a back-reference to the engine class)
- `hooks/useChatController.ts` (423 lines) — orchestrator wiring settings, tools, skills, memory, persistence
- `llm/OpenAIAdapter.ts` / `AnthropicAdapter.ts` — provider-specific SSE parsers (adapter pattern)
- `memory/MemoryManager.ts` (653 lines) — auto-extraction + compression pipeline
- `main/ipc/api-proxy.handler.ts` (447 lines) — SSE streaming proxy with abort/retry, env-placeholder resolution

## Runtime Data (`~/.pulsemind/`)

- `settings.json` — profiles (provider, apiKey, baseURL, model, maxTokens, headers), theme, persona, locale, yoloMode, autoCleanup. `apiKey`/`headers` may hold `${ENV_VAR}` placeholders — resolved per-request in the API proxy, never rewritten on save.
- `db/pulsemind.db` — SQLite (WAL+FTS5): conversations, messages, memories, experiences, tool_preferences, tool_results, token_usage
- `memory/MEMORY.md` — auto-injected into every system prompt
- `hooks/` — user hook scripts: `app-start.js` (main-process launch), `llm-request.js` (per LLM request)
- `skills/` — installed ZIP-based skill packs; `experiences/` — skill-format experience records (max 20, LRU)
- `knowledge/` — knowledge base (`raw/` sources, `wiki/` compiled); `workspace/` — agent file workspace; `canvas/`, `logs/`, `mcp/`, `tmp/`
- `routines/` — daily-work routines (one JSON each, PLAN-0.4.0 M4); run history in SQLite `routine_runs`
- `tools/<id>/` — user tools from the tool studio (`tool.json` manifest + `app.html` + `storage.json` KV); `tools/templates/` — preset templates (PLAN-0.4.0 M5)
- `projects` / `routine_runs` / `audit_log` — SQLite tables added by PLAN-0.4.0 (project container model, run history, sandbox/capability audit)

## Gotchas

- **Always `cd` to project root** before running commands. Workspace root contains unrelated projects.
- `browsers/` is gitignored — contains installed Playwright Chromium binary (installed via `npm run browsers:install`).
- `node_modules/better-sqlite3` is unpacked from asar (native module, listed in `asarUnpack`). `adm-zip` is also unpacked.
- `cron-parser` is pinned to v4 (CJS) — v5 is ESM-only and the main process resolves deps via `require()` at runtime.
- No opencode.json or `.opencode/` config exists at repo level.
- Agent engine lives in `agent/AgentEngine.ts` (the class). Renderer creates one engine per conversation in `hooks/useConversationEngine.ts` — there is no separate loop-wrapper hook.

Navigation is a persistent sidebar button column (PLAN-0.4.0, revised 2026-09-12 after user feedback): entries come from `navigation/registry.ts` (`SIDEBAR_NAV`) — the single source of truth for top-level views (`chat | search | project | routines | capability | knowledge | tools`; `canvas` is hidden). An entry declaring a `submenu` renders as a split button that reveals it on hover — 新建任务 → 对话/项目, 能力 • 知识 • 工具 → the three centers — rendered by `components/layout/SidebarNav.tsx`. The three centers share one page (`components/centers/CentersPage.tsx`): the tab IS the view kind, so the plain-button switcher in the header (right of the sidebar toggle, fed by the same `CENTERS_SUBMENU` data) and deep links like the install notifier's `capabilityTab` jump all read the same state. 搜索 aggregates four stores (conversation titles, message bodies, memories, knowledge) in `components/search/SearchView.tsx`; message-body search is main-side (`searchMessagesByKeyword` in `storage/conversation.db.ts`). View state lives in `stores/navigationStore.ts`; `ViewHost.tsx` renders non-chat views; 设置/用量统计/关于 sit at the sidebar's bottom as icon entries that navigate to standard views (the former settings modal and drawers are gone — `SettingsPage.tsx`, `StatisticsPage.tsx`, `AboutPage.tsx`; the settings section IS the `settingsTab` view param). There is deliberately no hamburger menu. Capability configs (MCP/skills/subagents) live in the Capability Center, not the settings page; 经验 lives in the settings page next to 记忆, both behind master switches (`memoryEnabled` / `experienceEnabled` in settings.json, mirrored onto the shared managers by `settings.handler` + `session-manager.syncFeatureToggles`).

Sandbox (PLAN-0.4.0 M3): project conversations get a per-project `workspaceDir` + `ProjectSandboxPolicy`. Enforcement points: `src/shared/sandbox/path-jail.ts` (pure decision) wired into `src/main/services/file-ops.ts`; shell commands go through `src/main/sandbox/exec-sandbox.ts` (macOS `sandbox-exec` / Linux bwrap, opt-in `hardIsolation`) and the session's AsyncLocalStorage context (`src/main/sandbox/session-context.ts`). Tool studio bridge calls are capability-checked + audited in `src/main/tool-runtime/`.
- Provider adapter pattern: new provider = implement `LlmAdapter` interface + factory key in `llm/index.ts`.
- API calls route through main process IPC proxy (`main/ipc/api-proxy.handler.ts`, avoids CORS in sandboxed renderer).
- `tsconfig.json` is a project-reference root pointing to `tsconfig.node.json` (main+preload) and `tsconfig.web.json` (renderer). Node config excludes DOM lib. Web config enables `react-jsx`.
- Templates live in `templates/pulsemind/` (dev) and are copied to `~/.pulsemind/` on first run; user-editable hook scripts land in `~/.pulsemind/hooks/`.

# 编码规范

## 设计原则

- **高内聚低耦合**：一个模块/类只负责一件事，内部元素围绕同一职责组织；模块之间通过明确接口通信，不直接依赖彼此内部实现。跨模块共享的状态与逻辑下沉到独立模块，禁止隐式全局依赖。
- **识别可抽象的类**：出现重复的结构或行为模式时，提取基类 / 抽象类统一骨架，差异部分由子类实现（模板方法模式）；同一概念的多种变体优先抽象为一个类 + 配置，而非复制多份。
- **提取公共方法**：同一段逻辑出现第二次时就应提取为公共方法；方法只做一层事——要么编排流程，要么实现细节，不混在一起。
- **使用公共的工具方法**：写新工具函数前先检索项目已有的 utils（如 `src/shared/`、`src/renderer/src/utils/`、`src/main/utils/`），能复用绝不重写；通用工具一律放公共位置并导出，不允许在业务代码里私藏副本。

## 硬性限制

- **单个方法不超过 200 行**：超限说明职责过多，按步骤拆分为多个私有方法再编排。
- **单个类不超过 1000 行**：超限说明承担了多个职责，按职责拆分为协作的多个类。

## 落地检查

提交前自查：

1. 新增代码是否与既有代码存在重复逻辑？（→ 提取公共方法）
2. 新增能力是否放进了正确的模块？（→ 高内聚）
3. 是否复用了已有工具方法？（→ 检索 utils 后再动手）
4. 方法 / 类行数是否超限？（→ 拆分）

