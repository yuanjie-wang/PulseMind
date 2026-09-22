export type LLMProvider = 'anthropic' | 'openai'

import type { ProjectSortMode } from './project'
import type { ShortcutActionId } from '../shortcuts'

export interface LlmProfile {
  id: string
  name: string
  provider?: LLMProvider
  baseURL: string
  model: string
  maxTokens: number
  contextLength?: number
  apiKey?: string
  headers?: Record<string, string>
}

export interface AppSettings {
  activeProfileId: string
  profiles: LlmProfile[]
  /** PLAN-dark-mode M1: 'system' follows the OS — the renderer resolves it via
   *  prefers-color-scheme, main via nativeTheme. Existing settings.json files
   *  carry an explicit 'light' and are untouched. */
  theme: 'light' | 'dark' | 'system'
  myName: string
  soul: string
  yourName: string
  workspaceDir?: string
  autoCleanup?: boolean
  locale?: 'zh' | 'en'
  /** Launch the app at OS login (applied via app.setLoginItemSettings; also toggled from the tray). */
  launchAtLogin?: boolean
  /** Local agent service (loopback WebSocket for browser extensions). Default on. */
  serviceEnabled?: boolean
  servicePort?: number
  git?: { contextInjection?: boolean }
  /** 记忆系统总开关：会话后自动提取 + 记忆注入系统提示。默认开。手动记忆编辑不受影响。 */
  memoryEnabled?: boolean
  /** 经验系统总开关：会话后自动沉淀 + 经验索引注入系统提示。默认开。已有经验保留可查看。 */
  experienceEnabled?: boolean
  /** 运行期间阻止系统休眠总开关：有会话在干活时持有 powerSaveBlocker，
   *  全部结束/停止后自动恢复，屏幕仍可正常熄灭。默认关（高级面板的开关一律
   *  默认关闭）。保存即生效。 */
  keepAwakeEnabled?: boolean
  /** 运行历史自动清理策略：保留天数（未设 / 0 = 永久保留）。启动时按此清理已结束的运行记录。 */
  routineRunRetentionDays?: number
  /** PLAN-knowledge-base D7: 导入完成后自动把新源压入编译队列。默认关（手动编译为主）。 */
  knowledge?: { autoCompile?: boolean }
  /** 会话自动清理策略（对话管理 · 最长保留时长）：保留天数（未设 / 0 = 永久保留）。
   *  启动时及每次保存设置时按此清理过期的未置顶会话（置顶会话永不过期）。 */
  conversationRetentionDays?: number
  /** 侧边栏项目列表的排序方式（未设 = 'created'，即创建时间倒序）。 */
  projectSortMode?: ProjectSortMode
  /** 单次任务内 agent loop 的循环次数上限（每次 LLM 请求计一轮；达到上限会询问
   *  用户是否继续）。保存后从下一个回合生效。默认 50。 */
  maxLoopIterations?: number
  /** 同一会话内并行运行的子代理（专家）数量上限，超出的排队等待。保存后对
   *  下一次 spawn 生效。默认 5。 */
  maxParallelSubAgents?: number
  /**
   * 调试用：把每次 LLM 请求的完整报文原样写到 ~/.pulsemind/logs/llm-requests/。
   * 开发版默认开启；打包版需显式设为 true（读取按文件 mtime 缓存，改完下一次请求即生效）。
   */
  debugLlmRequests?: boolean
  /** 调试用：主线程关键路径计时（src/main/perf/perf-log.ts 的 [perf] 行，
   *  现覆盖 emitMessages 与 saveConversation）。开关语义与 debugLlmRequests 相同。 */
  debugPerfLogs?: boolean
  /** Browser runtime (A-M4). */
  browser?: {
    /** Default backend for conversations that never chose one ('managed'). */
    backend?: 'managed' | 'app-view'
    /** Launch the managed Chromium headless (default true). */
    headless?: boolean
    /** Per-call wall-clock budget in ms (default 60000, cap 300000). */
    timeoutMs?: number
    /** In-app pane width in px (A-M5) — remembered globally across sessions. */
    paneWidth?: number
  }
  /** Rebound app-level shortcuts: action id → Electron accelerator. Only the
   *  overrides live here; defaults come from shared/shortcuts.ts, and both
   *  the native menu and the before-input fallback re-derive on save. */
  shortcuts?: Partial<Record<ShortcutActionId, string>>
}
