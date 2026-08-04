# AGENTS.md

For detailed architecture, see [CLAUDE.md](./CLAUDE.md). This file covers facts agents commonly miss.

## Commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | esbuild main+preload → Vite HMR (port 5173) → Electron launch (waits on port) |
| `npm run build` | esbuild main+preload → Vite production build |
| `npm run browsers:install` | Install Playwright Chromium for browser tool |

No test, lint, or typecheck script configured. Debugging is `console.log` only.

## Build Pipeline

- **Two independent builds**: esbuild (`scripts/build.js`) runs first, then Vite (`vite.config.ts`).
- Main process: all deps (including `electron`) are externals — nothing bundled, resolved via `require()` at runtime.
- Preload: only `electron` is external; all other deps are bundled inline into `out/preload/index.js`.
- Vite root is `src/renderer/` (not project root) — `index.html` lives there.
- `electron-builder.yml` is the authoritative packaging config; `package.json`'s `"build"` key is legacy/shadow.
- Dev mode: `concurrently` runs Vite + Electron. `wait-on http://localhost:5173` delays Electron until Vite HMR is ready. `ELECTRON_RENDERER_URL` signals dev mode (loads URL instead of file).

## Architecture

| Layer | Path | Entry | Role |
|-------|------|-------|------|
| Main | `src/main/index.ts` | `main` in `package.json` | Window, IPC, SQLite, Playwright, ACP |
| Preload | `src/preload/index.ts` | `contextBridge` | Typed `window.electronAPI` bridge |
| Renderer | `src/renderer/src/` | Vite root `src/renderer/` | React 18, sandboxed browser context |

IPC types: `src/renderer/src/types/electron.d.ts` (~263 lines).

## Complexity Hotspots

- `agent/AgentEngine.ts` (1356 lines) — agent state machine, SSE dispatch, tool execution loop
- `hooks/useChatController.ts` (1120 lines) — orchestrator wiring settings, tools, skills, memory, persistence
- `llm/OpenAIAdapter.ts` / `AnthropicAdapter.ts` — provider-specific SSE parsers (adapter pattern)
- `memory/MemoryManager.ts` (460 lines) — auto-extraction + compression pipeline
- `main/ipc/api-proxy.ts` (126 lines) — SSE streaming proxy with abort support

## Runtime Data (`~/.pulseai/`)

- `settings.json` — profiles (provider, apiKey, baseURL, model, maxTokens), theme, persona, locale, yoloMode, autoCleanup
- `pulseai.db` — SQLite (WAL+FTS5): conversations, messages, memories, experiences
- `MEMORY.md` — auto-injected into every system prompt
- `tool-preferences.json` / `skill-preferences.json` — enabled/disabled state
- `skills/` — installed ZIP-based skill packs
- `api-key.enc` — legacy encrypted key (safeStorage, no longer actively used)

## Gotchas

- **Always `cd` to project root** before running commands. Workspace root contains unrelated projects.
- `browsers/` is gitignored — contains installed Playwright Chromium binary (installed via `npm run browsers:install`).
- `node_modules/better-sqlite3` is unpacked from asar (native module, listed in `asarUnpack`). `adm-zip` is also unpacked.
- No opencode.json or `.opencode/` config exists at repo level.
- Agent engine lives in `agent/AgentEngine.ts` (the class). `hooks/useAgentLoop.ts` (69 lines) is a thin wrapper — do not edit for logic changes.
- Provider adapter pattern: new provider = implement `LlmAdapter` interface + factory key in `llm/index.ts`.
- API calls route through main process IPC proxy (avoids CORS in sandboxed renderer).
- `tsconfig.json` is a project-reference root pointing to `tsconfig.node.json` (main+preload) and `tsconfig.web.json` (renderer). Node config excludes DOM lib. Web config enables `react-jsx`.
- `electron-builder.yml` uses `appId: com.pulseai.app`; `package.json` has `appId: com.cmbchina.ccc.PulseMind` — the YAML wins at build time.
