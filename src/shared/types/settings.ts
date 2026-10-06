export type LLMProvider = 'anthropic' | 'openai'

import type { ProjectSortMode } from './project'
import type { ShortcutActionId } from '../shortcuts'
import type { SandboxApprovalMode } from '../sandbox/policy'

/**
 * 模型配置分两层（供应商 → 模型）：一个供应商只有一份连接配置（接口规范 /
 * baseURL / apiKey / headers），名下挂多个模型条目，各自的模型名、maxTokens、
 * contextLength 独立设置。`LlmProfile` 是「某个模型连同它所属供应商」的解析
 * 视图 —— 设置存储读取时物化（providerId/providerName 与连接字段从供应商填
 * 入），写入时反向拆解，磁盘上永远不存这个扁平形态。
 */

/** 模型条目（模型层）：嵌在 LlmProviderConfig.models 里落盘。 */
export interface LlmModelConfig {
  id: string
  /** API 模型名，如 deepseek-chat / claude-sonnet-4-20250514 */
  model: string
  /** 展示名（模型选择器里优先显示；缺省回落 model） */
  name?: string
  maxTokens: number
  contextLength?: number
}

/** 供应商（连接层）：baseURL / apiKey / headers 被名下所有模型共享。 */
export interface LlmProviderConfig {
  id: string
  name: string
  /** API 规范 —— 旧 LlmProfile.provider 字段的语义：决定请求走 Anthropic
   *  还是 OpenAI 兼容适配器，与「哪家供应商」解耦。 */
  apiFormat: LLMProvider
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  models: LlmModelConfig[]
}

/**
 * 解析视图 = 供应商连接 + 模型参数。所有消费方（引擎、代理、探针、选择器）
 * 读的都是这个形态；id 即模型条目 id —— conversations.profile_id、
 * lastUsedProfileId、插件面板的选中值引用的都是它。
 */
export interface LlmProfile {
  id: string
  name: string
  /** 所属供应商（物化字段，不落盘）。 */
  providerId?: string
  /** 供应商显示名（物化字段，不落盘），模型选择器分组/前缀用。 */
  providerName?: string
  /** API 规范（物化自所属供应商；旧扁平格式的存量字段）。 */
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
  /** 权威形态：供应商及其名下模型。写入路径只认它（派生的 profiles 被忽略）。 */
  providers: LlmProviderConfig[]
  /** 派生只读视图（get() 物化）：每个模型一条、连接字段已从供应商填入。
   *  渲染端与主进程的大量消费方读它；写入时由存储层重算，不要手工维护。 */
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
  /** 项目命令注入（PLAN-coding-contract P1）：把工作区 package.json scripts /
   *  pyproject.toml / Makefile targets 的命令名字符串注入每轮状态块，模型
   *  自测时用现成命令而不是编造。默认关闭（fail-closed 归一化同 git）。 */
  commands?: { projectInjection?: boolean }
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
   *  用户是否继续）。保存后从下一个回合生效。默认 200。 */
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
  /** 上次使用的授权级别 / 模型 —— 「新建会话沿用上次选择」的那个全局变量。
   *  用户在任何会话上做的交互式修改（桌面 composer、welcome 页、插件面板、
   *  设置面板的默认模型）都会写到这里；新建会话把它落成自己的列作为初始值，
   *  之后每个会话各持各的配置，不再跟随。未设 = 沿用旧规则
   *  （DEFAULT_APPROVAL_MODE / activeProfileId），也是首次安装的初始态。 */
  lastUsedApprovalMode?: SandboxApprovalMode
  lastUsedProfileId?: string
  /** 备份保留天数（PLAN-security-hardening P3-a）：db/ 下形如
   *  `pulsemind.backup_*.db` / `pulsemind.db.bak_*.db` 的备份超过该天数即删。
   *  缺失/非法 = 默认 30；显式 0 = 永久保留。UI 暂不暴露（debugLlmRequests
   *  先例），settings.json 手工编辑即生效。 */
  backupRetentionDays?: number
  /** 密钥静态加密开关（PLAN-security-hardening P1，2026-09-25 改为 opt-in）：
   *  true = 非 ${VAR} 占位符的 apiKey/headers 以 enc:v1: 密文落盘（走
   *  safeStorage/钥匙串——macOS 首次会弹一次授权密码）。缺省/false = 明文
   *  落盘，由 P0 的 umask+0600 权限承担防护，完全不触碰钥匙串。已有密文
   *  在开关关闭后读取仍解密（兼容），下次保存自然回落明文。 */
  encryptSecrets?: boolean
  /** 记忆合并层水位（PLAN-memory-extraction-dedup P2）：上次增量合并的时间与
   *  当时提取类记忆总数。触发 = 水位后新增 ≥5 条或总量 >50，且距上次 ≥24h。
   *  lastAttemptAt 是失败/空结果的尝试时钟（2h 重试）——空转修复（2026-09-26）
   *  靠它跨重启仍然有效。主进程的 session-manager 在合并后回写这里，重启后
   *  水位不丢。 */
  memoryMergeWatermark?: { lastRunAt?: string; lastCount?: number; lastAttemptAt?: string }
  /** 例行任务结算的 webhook 触达（PLAN-routine-triggers M1）：run 结算时向
   *  webhookUrl POST 一条 JSON 摘要（HMAC 签名，fire-and-forget，失败只落
   *  日志）。payload 只含 ids 与状态，不含转写正文。secret 支持 ${ENV}
   *  占位符（与供应商密钥同惯例，发送时解析）。桌面通知不受本节控制。 */
  notifications?: {
    webhookUrl?: string
    webhookSecret?: string
    /** Default true. */
    onSettled?: boolean
  }
}
