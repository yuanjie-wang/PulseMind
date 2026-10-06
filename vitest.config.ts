import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Tests run in plain Node with the repo's real modules. The only thing that
// needs faking is `electron` (used by src/main/storage/index.ts for the
// templates dir) — see tests/stubs/electron.ts.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^electron$/, replacement: path.resolve(__dirname, 'tests/stubs/electron.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      // 单测排除清单——结构上不可能被 vitest（node 环境、无 Electron、无布局引擎）测到
      // 的面，理由与完整纪律见 AGENTS.md「单测纪律」；数字只反映可单测面，
      // 这些文件的验收面是 scripts/probe-*.mjs 与 Electron 实跑，别为数字补假测试。
      exclude: [
        '**/*.d.ts',
        // 纯类型声明与数据，无逻辑可测
        'src/shared/types/**',
        'src/renderer/src/i18n/locales/**',
        // 散落的纯类型契约文件（零运行时语句，与 shared/types 同类）——
        // 注意 tools/types.ts、types/agent.ts 等带运行时常数的不在此列
        'src/renderer/src/agent/engine/engine-core.ts',
        'src/renderer/src/agent/one-shot-agent/LlmConfig.ts',
        'src/renderer/src/llm/adapter.ts',
        'src/renderer/src/llm/stream-types.ts',
        'src/renderer/src/llm/types.ts',
        'src/renderer/src/skills/types.ts',
        'src/renderer/src/types/conversation.ts',
        'src/renderer/src/types/hooks.ts',
        'src/renderer/src/types/settings.ts',
        'src/renderer/src/tools/types.ts',
        'src/main/agent/service-sessions.ts',
        'src/main/browser/backends/BackendAdapter.ts',
        'src/shared/office/ops.ts',
        // UI 组件与布局（探针 territory）
        'src/renderer/src/components/**',
        'src/renderer/src/App.tsx',
        'src/renderer/src/main.tsx',
        // Electron 宿主面：contextBridge / 窗口与生命周期 / IPC 薄注册层。
        // main/ipc 不整体排除：api-proxy.handler 装着真逻辑（SSE 代理 /
        // env 占位符 / hook / 请求转储），由 oneshot-proxy-funnel 式本地
        // HTTP 服务器直驱、照常计量——裸 glob 曾把它排除在外，与 AGENTS.md
        // 「单测纪律」节的判据相反（review_20261006 中10）。新 handler 仍按
        // 薄注册层默认排除；装了真逻辑就照 api-proxy 的先例在这里加 ! 例外。
        'src/preload/**',
        'src/main/index.ts',
        'src/main/menu.ts',
        'src/main/tray.ts',
        'src/main/service-runtime.ts',
        'src/main/ipc/*.handler.ts',
        '!src/main/ipc/api-proxy.handler.ts',
        'src/main/ipc/index.ts',
        // better-sqlite3 是 Electron ABI，plain Node 加载即崩（probe-project-color-db 式探针的 territory）
        'src/main/storage/routine-store.ts',
        'src/main/storage/tool-store.ts',
        'src/main/storage/stats.db.ts',
        'src/main/storage/extractors/**',
        // 生成物
        '**/*.generated.ts',
        // 插件运行时面：Shadow DOM 面板 / content script / 选项页（probe-page-pipeline、probe-panel-render 的 territory）
        'src/extension/ui/**',
        'src/extension/content/**',
        'src/extension/options/**',
      ],
      // 全局分支覆盖门槛（global，非 perFile——排除清单外仍有个别低覆盖文件是诚实缺口，
      // 逐文件验收见 AGENTS.md「单测纪律」）。超限时 test:coverage 退出码非零，报告照常产出。
      thresholds: { branches: 80 },
    },
  },
})
