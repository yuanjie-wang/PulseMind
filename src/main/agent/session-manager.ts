/**
 * Agent session manager (PLAN-0.3.5 M1.4④): hosts AgentEngine instances in
 * the main process, keyed by sessionId. Mirrors the renderer's
 * useChatManagers/useConversationEngine assembly (manager construction,
 * preference loading, engine option building) but with the main-process host
 * and direct service access — no IPC round-trips.
 */
import { platform, release, arch } from 'node:os'
import { AgentEngine, type AgentEngineOptions } from '../../renderer/src/agent/AgentEngine'
import type { AgentMessage, AgentStatus, ContentBlock, Plan } from '../../renderer/src/types/agent'
import { ToolManager } from '../../renderer/src/tools/ToolManager'
import { SkillManager } from '../../renderer/src/skills/SkillManager'
import { BUILT_IN_SKILLS } from '../../renderer/src/skills/built-in-skills'
import { MemoryManager } from '../../renderer/src/memory/MemoryManager'
import { KnowledgeManager } from '../../renderer/src/knowledge/KnowledgeManager'
import { ExperienceManager } from '../../renderer/src/experiences/ExperienceManager'
import { createLlmAdapter } from '../../renderer/src/llm'
import { SkillKeywordAgent } from '../../renderer/src/agent/one-shot-agent'
import type { PlatformInfo } from '../../shared/types/electron-bridge'
import { setHost } from '../../renderer/src/agent/host'
import { mainHost } from './main-host'
import { bindLiveSkillManager } from './live-skill-registry'
import { settingsStore } from '../storage/settings-store'
import { toolPreferencesStore } from '../storage/tool-preferences-store'
import { skillStore } from '../storage/skill-store'
import { SKILLS_DIR, WORKSPACE_DIR } from '../storage'
import { updateConversationOrigin, setConversationProject, getConversationProjectId, getConversationExpertId, getConversationApprovalMode, setConversationApprovalMode, getConversationProfileId, setConversationProfile, deriveConvType, listMemorySweepCandidates, getConversation, updateMessageStats } from '../storage/conversation.db'
import { judgeSweepCandidate, nextSweepDelayMs, sweepIntervalMs, SWEEP_ACTIVE_WINDOW_MS, SWEEP_BATCH_LIMIT, SWEEP_MIN_DELTA } from '../../shared/memory-sweep'
import { setMemorySweepTrigger, setSopDistillTrigger } from '../ipc/memory.handler'
import { distillSop as runSopDistill, isSopDistilling } from './sop-runner'
import { judgeSopCandidate, sortBySopPriority, SOP_SWEEP_BATCH } from '../../shared/sop-sweep'
import { isLivePage } from '../../shared/memory-pages'
import { listMemoryPages } from '../storage/memory-pages-store'
import { migrateExperiencesToPages, listFlatMemoriesForMigration, fallbackFlatMemoryOps, applyFlatMemoryMigration } from '../services/memory-migration'
import { resolveConversationWorkspace, ensureHostedConversationWorkspace } from '../storage/conversation-workspace'
import { projectStore } from '../storage/project-store'
import { expertStore } from '../storage/expert-store'
import { serverManager } from '../mcp/MCPServerManager'
import { composeExpertInstructions, normalizeSummonedExperts, toExpertRefCatalogs, type ExpertRefCatalogs } from '../../shared/expert-context'
import type { SummonedExpert } from '../../shared/expert-context'
import type { ExpertProfile, ExpertRuntimeContext } from '../../shared/types/expert'
import type { PipelineContract } from '../../shared/workflow/contract'
import type { StageFinishConfig } from '../../shared/workflow/finish-tool'
import { sessionSandbox, setSessionBackgroundExitListener, type SessionSandboxContext } from '../sandbox/session-context'
import { svcReapBackgroundPids as reapBackgroundPids, svcReapSessionShells as reapSessionShells, svcExecLogs, svcIsBackgroundPidAlive } from '../services/terminal'
import { agentClientRegistry } from './client-registry'
import { browserService } from '../browser/BrowserService'
import { diffMessageStats, messageStatsSignature } from '../../shared/agent-session/message-stats'
import { isActiveStatus } from '../../shared/agent-session/mirror'
import { BACKGROUND_NOTICE_MARKER } from '../../shared/background-notice'
import { messageContentSignature } from '../../shared/agent-session/message-content'
import { setLoopIterationLimit } from '../../renderer/src/agent/agent-utils'
import { setSubAgentParallelLimit } from '../../renderer/src/agent/engine/subagent-limiter'
import { pickApprovalMode } from '../../shared/sandbox/policy'
import type { SandboxApprovalMode } from '../../shared/sandbox/policy'
import { DEFAULT_PROJECT_ID } from '../../shared/types/project'
import type { AppSettings, LlmProfile } from '../../shared/types/settings'
import { getBundledRipgrepPath, getPlatformName } from '../services/platform-info'
import { perfTime } from '../perf/perf-log'
import { keepAwake } from '../system/keep-awake'
import { rememberLastUsedApprovalMode, rememberLastUsedProfileId, seedLastUsedDefaults } from './last-used-defaults'
import type { AgentEventData, PlanSnapshot, AgentSessionCreateOptions, PageContext, StatusToolInfo, StatusSnapshot, ModelState, CompactionEvent, SessionFileChange } from '../../shared/agent-protocol'

interface Managers {
  toolManager: ToolManager
  skillManager: SkillManager
  memoryManager: MemoryManager
  knowledgeManager: KnowledgeManager
  experienceManager: ExperienceManager
  skillKeywordAgent: SkillKeywordAgent
  platformInfo: PlatformInfo
}

interface SessionEntry {
  engine: AgentEngine
  agentId: string
  title?: string
  createdAt: string
  /** Client that owns the session: 'local' (desktop UI) or a ws clientId. */
  clientId: string
  /** Per-session engine config that a settings-driven refresh must not clobber:
   *  prompt/tool overrides (also engine instance state) and the approval mode a
   *  session was created with (explicit override for unattended sessions). */
  pinned: {
    systemPromptOverride?: string
    allowedTools?: string[]
    /** Create-time internal expert pack (the assistants): owns this session's
     *  expert identity for its whole life — DB-bound experts never apply. */
    expertProfile?: ExpertProfile
    /** Approval mode the session's creator demanded (derived sessions run
     *  unattended). Set = nothing else can change it, ever. */
    approvalOverride?: SandboxApprovalMode
    /** LLM profile the session's creator demanded (a routine pinned to one
     *  model). Set = refreshOptions re-resolves THIS profile, so a global
     *  model switch cannot move the session off its chosen model. */
    profileId?: string
    /** 流水线阶段的完成协议（2026-11-11）：pinned 全程不变，refreshOptions
     *  原样重挂——阶段会话的 finish_stage 不会因设置刷新而消失。 */
    stageFinish?: StageFinishConfig
  }
  /** Last expert context resolved by refreshExpertContext. refreshOptions
   *  replaces the option bag wholesale, so the expert pack must be re-attached
   *  there (a settings refresh mid-session must not silently strip the
   *  @-summoned role). */
  expertState?: ExpertRuntimeContext | null
}

/** Global concurrency guard (M2.2): at most N agent loops run at once;
 *  extra asks queue FIFO and start in arrival order. */
const MAX_CONCURRENT_LOOPS = 2

type SessionEventSink = (sessionId: string, data: AgentEventData) => void

/** Statuses at which emitMessages re-diffs tool runtime state from scratch
 *  (see the reconciliation comment in emitMessages). Deliberately excludes
 *  awaiting_* — the turn is parked mid-decision there, not finished. */
const TERMINAL_SWEEP_STATUSES = new Set(['completed', 'error', 'idle'])

/** Project an engine status onto the wire's status carrier — the ONE place the
 *  live event and the re-attach snapshot agree on which optional fields a word
 *  carries (`error`'s reason; `retrying`'s count, delay and message;
 *  `awaiting_extension`'s reached/cap loop counts — the unattended routine
 *  runner settles on this word and records the numbers in the run row). */
function statusSnapshotOf(status: AgentStatus): StatusSnapshot {
  return {
    status: status.status,
    ...(status.status === 'error' ? { error: status.error } : {}),
    ...(status.status === 'retrying'
      ? { attempt: status.attempt, maxRetries: status.maxRetries, delayMs: status.delay, message: status.message,
          // The overflow re-aim's live window hint (see AgentStatus.contextWindow)
          // — the renderer ring's denominator needs it when the provider just
          // corrected a phantom profile number.
          ...(status.contextWindow != null ? { contextWindow: status.contextWindow } : {}) }
      : {}),
    ...(status.status === 'awaiting_extension' ? { currentCount: status.currentCount, limit: status.limit } : {}),
  }
}

function sessionPlatformInfo(): PlatformInfo {
  const p = platform()
  return {
    platform: p,
    platformName: getPlatformName(p),
    release: release(),
    arch: arch(),
    ripgrepPath: getBundledRipgrepPath(),
  }
}

/** The state block's `## Current Page` source for a desktop session
 *  (2026-11-04): the conversation's OWN built-in browser pane, read live each
 *  time the block is built. Pulled rather than pushed at ask time because the
 *  block rebuilds on every tool-loop iteration — a page the agent just
 *  navigated must not be reported as the one it left. Two values only
 *  (url + title); `source: 'builtin'` is what makes the section name the
 *  `browser` tool instead of the extension's `page_*` family. */
function builtinPageContextProvider(sessionId: string): () => PageContext | null {
  return () => {
    const page = browserService.currentPageOf(sessionId)
    return page ? { url: page.url, title: page.title, source: 'builtin' } : null
  }
}

/** Exported for the transport tests (`tests/turn-duration.test.ts`); the app
 *  only ever uses the singleton below. */
export class AgentSessionManagerImpl {
  private sessions = new Map<string, SessionEntry>()
  /** In-flight creations — ask/cancel/history/engineCall await these so a
   *  command that races the create (renderer fires both back-to-back) lands
   *  after the session is registered. */
  private pendingCreates = new Map<string, Promise<void>>()
  private managersPromise: Promise<Managers> | null = null
  private managers: Managers | null = null
  private eventSinks = new Set<SessionEventSink>()
  /** Per-session length of the last 'messages' snapshot for append diffing. */
  private lastSentLen = new Map<string, number>()
  private runningLoops = 0
  /** FIFO queue of asks waiting for a loop slot. `parked` is the per-entry
   *  stop flag: dispatchEngineCall('stopExecution') sets it on this session's
   *  entries, and the woken ask consumes it to decline a turn that was already
   *  settled while it sat in the queue (review_20260923 M1). */
  private waitingLoops: Array<{ sessionId: string; parked: { stopped: boolean }; resolve: () => void }> = []
  /** Per-session registry of tool_use runtime state (status|exitCode|outputLen) for in-place diffing. */
  private toolStatusRegistry = new Map<string, Map<string, string>>()
  /** Per-session registry of message-level stat signatures (the turn's wall
   *  clock / token counts) for the same in-place diffing. */
  private messageStatsRegistry = new Map<string, Map<string, string>>()
  private messageContentRegistry = new Map<string, Map<string, string>>()

  constructor() {
    // 投递守门计时器（PLAN-background-tasks E #2）：渲染端三触发点（正在看/
    // busy→completed 边沿/切回会话）是「尽力而为」——用户一直不切回、窗口失
    // 焦、或边沿恰好错过，通知就一直躺在引擎队列里。主进程每 30s 扫一遍：有
    // 未投递通知 && 引擎空闲 && 全局槽位有空 && 不在投递中 → 自动开一回合汇
    // 报。deliverBackgroundNotice 自带幂等闸门，与渲染端触发竞态安全。
    this.deliverSweepTimer = setInterval(() => {
      for (const [sessionId, entry] of this.sessions) {
        if (entry.engine.backgroundNotices.length === 0) continue
        if (isActiveStatus(entry.engine.agentStatus)) continue
        if (this.deliveringBackground.has(sessionId)) continue
        if (this.runningLoops >= MAX_CONCURRENT_LOOPS) continue
        void this.deliverBackgroundNotice(sessionId).catch(() => { /* sweep retries in 30s */ })
      }
    }, 30_000)
    this.deliverSweepTimer.unref()
    // 后台任务唤醒（2026-10-28）：terminal.ts 在后台子进程 exit 的同一拍把
    // (sessionId, pid, code) 推到这里，转发给属主会话的引擎排队——引擎在下一次
    // 请求构建时把未投递的通知渲染进 state block（一次性）。引擎不存在（会话
    // 已关/重建中）就静默丢：exec_logs 的日志尾巴仍是完整的发现通道。
    setSessionBackgroundExitListener((sessionId, pid, code) => {
      try {
        this.sessions.get(sessionId)?.engine.enqueueBackgroundNotice(pid, code)
      } catch (err) {
        console.warn(`[AgentSession] background exit notice failed (${sessionId} pid=${pid}):`, err)
      }
      // 完成事件面（PLAN-background-tasks B）：后台进程退出同拍发 session 事件
      // ——渲染端据此亮侧栏灯/减后台计数/触发投递与系统通知。此前 exit 对 UI
      // 完全不可见（唤醒只搭下一次请求的车）。
      try {
        this.emit(sessionId, { type: 'background_task', phase: 'exit', pid, code })
      } catch (err) {
        console.warn(`[AgentSession] background exit event failed (${sessionId} pid=${pid}):`, err)
      }
    })
  }

  /** Subscribe to session events (the IPC bridge forwards these to renderers). */
  onEvent(sink: SessionEventSink): () => void {
    this.eventSinks.add(sink)
    return () => this.eventSinks.delete(sink)
  }

  private emit(sessionId: string, data: AgentEventData): void {
    // 逐 sink 隔离：一个 sink 抛异常（webContents 正在销毁、ws send 失败）不得
    // 中断兄弟 sink，更不得把异常沿 notify() 掷回引擎——notify 在引擎的结算
    // 路径上被同步调用（handleEndTurnResponse），一个坏 sink 曾因此吞掉
    // resolveCompletionIfSpawned，派发方的 `await waitForCompletion()` 永远
    // 挂起，整回合停在 busy（conv_20260929224057，5 专家评审 4 个不结算、
    // 光标常亮数小时）。
    for (const sink of this.eventSinks) {
      try { sink(sessionId, data) } catch (err) {
        console.warn(`[AgentSession] event sink failed (${sessionId} ${String((data as { type?: string }).type)}):`, err)
      }
    }
  }

  /** Approval precedence, in one place: an explicit per-session override (derived
   *  sessions run unattended) > the conversation's own stored choice (the
   *  composer's 授权 button writes it, as does the panel's) > DEFAULT_APPROVAL_MODE.
   *  Re-read per call, so changing the level takes effect on the conversation's
   *  next message. */
  private effectiveApprovalMode(sessionId: string, entry: SessionEntry): SandboxApprovalMode {
    return pickApprovalMode(entry.pinned.approvalOverride, getConversationApprovalMode(sessionId))
  }

  /** Model precedence, in one place (mirrors effectiveApprovalMode): the
   *  create-time pin (a routine's model choice) > the conversation's own stored
   *  choice (the composer's 模型下拉 writes it, as does the panel's) >
   *  undefined, which resolveProfile resolves to the global default. */
  private effectiveProfileId(sessionId: string, entry: SessionEntry): string | undefined {
    return entry.pinned.profileId ?? getConversationProfileId(sessionId)
  }

  private emitMessages(sessionId: string, messages: AgentMessage[]): void {
    // PLAN-long-task-perf M0-T2: the every-notify full-history diff is one of
    // the two suspects the perf gate watches (B1). The wrapper keeps the body
    // byte-identical and prints one [perf] line per call when the gate is on.
    perfTime(`emitMessages conv=${sessionId} msgs=${messages.length}`, () => this.emitMessagesInner(sessionId, messages))
  }

  private emitMessagesInner(sessionId: string, messages: AgentMessage[]): void {
    const lastLen = this.lastSentLen.get(sessionId) ?? 0
    const previous = this.messageContentRegistry.get(sessionId) ?? new Map<string, string>()
    const content = new Map(messages.map(message => [message.id, messageContentSignature(message)]))
    // Equal-length history replacement is not an append either.
    const replaced = messages.slice(0, lastLen).some(message => previous.size > 0 && !previous.has(message.id))
    if (messages.length >= lastLen && !replaced) {
      const items = messages.slice(lastLen)
      // A zero-item append is a no-op for an up-to-date client, but a client
      // whose mirror is ahead of `lastLen` (it hydrated optimistically before
      // this session existed) would apply it as a truncation to empty and tear
      // its view down. Nothing to append means nothing to send.
      if (items.length > 0) {
        this.emit(sessionId, { type: 'messages_append', fromIndex: lastLen, items: items as unknown[] })
        // The append just delivered these messages' current stats, so record
        // them as sent: the diff below exists for what changes AFTER a message
        // is on the wire, and re-shipping the same numbers on every append
        // would re-render every client for nothing.
        const stats = this.messageStatsRegistry.get(sessionId) ?? new Map<string, string>()
        for (const item of items) stats.set((item as AgentMessage).id, messageStatsSignature(item as AgentMessage))
        this.messageStatsRegistry.set(sessionId, stats)
      }
    } else {
      // Truncation (regeneration/compaction) — ship the full list.
      this.emit(sessionId, { type: 'messages', messages: messages as unknown[] })
      this.toolStatusRegistry.delete(sessionId)
      this.messageStatsRegistry.delete(sessionId)
    }
    if (messages.length >= lastLen && !replaced) {
      const updates = messages.slice(0, lastLen).filter(message => previous.get(message.id) !== content.get(message.id))
      if (updates.length > 0) this.emit(sessionId, { type: 'messages_update', items: updates })
    }
    this.messageContentRegistry.set(sessionId, content)
    this.lastSentLen.set(sessionId, messages.length)
    // Reconciliation point for the diff channels below. Every diff assumes the
    // client saw everything ever shipped — which stops holding the moment a
    // mirror is rebuilt behind the manager's back: a conversation re-open
    // hydrates from DB (runtime fields absent), a renderer reload remounts the
    // hook with empty state, and any single dropped event is never re-sent
    // because the registry says it was. The client cannot ask for a re-diff,
    // so the manager re-diffs from scratch at the one moment the user is
    // guaranteed to be looking at the result: the turn's terminal notify
    // (completed / error, or idle after 停止). Clearing the registries makes
    // THIS emit re-ship every tool block's current runtime state, so a patch
    // lost mid-turn heals here instead of sticking as 执行状态未知 forever.
    const entry = this.sessions.get(sessionId)
    if (entry && TERMINAL_SWEEP_STATUSES.has(entry.engine.agentStatus.status)) {
      this.toolStatusRegistry.delete(sessionId)
      this.messageStatsRegistry.delete(sessionId)
    }
    this.emitToolStatusDiff(sessionId, messages)
    this.emitMessageStatsDiff(sessionId, messages)
  }

  /**
   * tool_use blocks mutate IN PLACE (pending → running → completed, exitCode,
   * terminal output) without changing the messages array length. Diff each
   * block's runtime signature and ship only the changed entries so the
   * renderer's mirror reflects approvals/progress/completion.
   *
   * The spawn link (subConvId/planNodeId) rides the same diff and for the same
   * reason: spawn_agent writes it while executing, i.e. long after the assistant
   * message it belongs to was appended, so a snapshot-only transport would never
   * deliver it — the DAG node click and the card's sub-agent preview both had
   * nothing to open with.
   */
  private emitToolStatusDiff(sessionId: string, messages: AgentMessage[]): void {
    const registry = this.toolStatusRegistry.get(sessionId) ?? new Map<string, string>()
    const updates: Array<{ messageId: string; toolUseId: string; status?: string; exitCode?: number; output?: string; subConvId?: string; planNodeId?: string; backgroundPid?: number }> = []
    for (const msg of messages) {
      for (const block of msg.contentBlocks ?? []) {
        if (block.type !== 'tool_use') continue
        const tu = block as { id?: string; status?: string; exitCode?: number; output?: string; subConvId?: string; planNodeId?: string; backgroundPid?: number }
        const key = `${msg.id}:${tu.id ?? ''}`
        const output = typeof tu.output === 'string' ? tu.output : undefined
        const cappedOutput = output && output.length > 200_000 ? output.slice(0, 200_000) : output
        // DEAD pids stay off the wire (PLAN-background-tasks D): the turn-terminal
        // reconciliation sweep below re-ships every settled block, and a
        // re-shipped backgroundPid would resurrect the renderer's strip row /
        // sidebar running-count for a process whose exit event already fired
        // (and will never fire again). Alive = in backgroundByPid right now —
        // the exit handler deletes membership in the same beat it pushes the
        // session wake. The block KEEPS its field (hydration and the kill
        // button read the mirror/DB copy); only the diff omits it.
        const bgAlive = typeof tu.backgroundPid === 'number' && tu.backgroundPid > 0 && svcIsBackgroundPidAlive(tu.backgroundPid)
        const shippedPid = bgAlive ? tu.backgroundPid : undefined
        const signature = `${tu.status ?? ''}|${tu.exitCode ?? ''}|${cappedOutput ? cappedOutput.length : 0}|${cappedOutput ? cappedOutput.slice(-80) : ''}|${tu.subConvId ?? ''}|${tu.planNodeId ?? ''}|${shippedPid ?? ''}`
        if (registry.get(key) === signature) continue
        registry.set(key, signature)
        updates.push({
          messageId: msg.id,
          toolUseId: tu.id ?? '',
          status: tu.status,
          exitCode: tu.exitCode,
          output: cappedOutput,
          subConvId: tu.subConvId,
          planNodeId: tu.planNodeId,
          ...(bgAlive ? { backgroundPid: tu.backgroundPid } : {}),
        })
      }
    }
    if (registry.size > 4000) registry.clear() // runaway guard for very long sessions
    this.toolStatusRegistry.set(sessionId, registry)
    if (updates.length > 0) this.emit(sessionId, { type: 'tool_status', updates })
  }

  /**
   * MESSAGE-level stats mutate in place for the same reason tool blocks do, and
   * one of them defines what the user reads as the task's duration: the engine
   * stamps the turn's wall clock (user send → last output character, thinking
   * and tool rounds included) onto the last assistant message when the turn
   * ends — which is after that message was appended, so the length diff above
   * has already run and would never carry it. Without this the chat showed the
   * final answer's own LLM round (user feedback 2026-09-16).
   */
  private emitMessageStatsDiff(sessionId: string, messages: AgentMessage[]): void {
    const registry = this.messageStatsRegistry.get(sessionId) ?? new Map<string, string>()
    const updates = diffMessageStats(registry, messages)
    if (registry.size > 4000) registry.clear() // runaway guard, as above
    this.messageStatsRegistry.set(sessionId, registry)
    if (updates.length > 0) {
      // Persist, don't just announce. The turn total is stamped on an assistant
      // message AFTER that row was inserted, and `upsertMsg` only runs on a full
      // save — one a finished turn no longer triggers — so the number used to
      // reach the renderer's mirror and die there: reopening the conversation
      // read the single-round value straight back out of the DB
      // (用户反馈 2026-11-06，「处理时间只算了一部分」).
      for (const u of updates) {
        updateMessageStats(u.messageId, {
          processingMs: u.processingMs,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          promptCacheHitTokens: u.promptCacheHitTokens,
        })
      }
      this.emit(sessionId, { type: 'message_stats', updates })
    }
  }


  /** Assemble the shared managers once (mirrors useChatManagers.loadPrefs). */
  async ensureManagers(): Promise<Managers> {
    if (this.managers) return this.managers
    if (!this.managersPromise) {
      this.managersPromise = (async () => {
        // Route the whole agent graph through the main-process host BEFORE any
        // engine is constructed (the renderer bridge default throws in main).
        setHost(mainHost)

        const [toolPrefs, skillPrefs, importedDefs] = await Promise.all([
          toolPreferencesStore.get(),
          Promise.resolve(skillStore.get()),
          skillStore.listImported(),
        ])

        const toolManager = new ToolManager()
        toolManager.applyPreferences(toolPrefs)

        const skillManager = new SkillManager()
        for (const def of importedDefs) skillManager.registerSkill(def)
        skillManager.applyPreferences(skillPrefs)

        await skillStore.ensureBuiltInSkills(BUILT_IN_SKILLS).catch((e) =>
          console.error('[session-manager] ensureBuiltInSkills failed:', e)
        )
        const seededPrefs = skillManager.getPreferences()
        if (seededPrefs.skillKeywords) skillStore.set(seededPrefs)

        this.managers = {
          toolManager,
          skillManager,
          memoryManager: new MemoryManager(),
          knowledgeManager: new KnowledgeManager(),
          experienceManager: new ExperienceManager(),
          skillKeywordAgent: new SkillKeywordAgent(),
          platformInfo: sessionPlatformInfo(),
        }
        // UI zip 导入/删除的活体登记口（live-skill-registry）：共享 manager
        // 装配完成即绑入——此后 skills.handler 的 import/delete 才能对这份
        // 注册表做增量，否则只动盘、引擎要重启才看得见。
        bindLiveSkillManager(this.managers.skillManager)
        const startupSettings = await settingsStore.get()
        await this.syncFeatureToggles(this.managers, startupSettings)
        this.syncRunLimits(startupSettings)
        this.seedCompileWatermark(this.managers.memoryManager, startupSettings)
        // P2 (PLAN-memory-extraction-dedup): the merge layer's own sweep — a
        // few minutes after startup so first paint never waits on an LLM call.
        // 页面编译层（M6）：取代旧扁平归并 sweep，同一 3 分钟启动位。
        setTimeout(() => {
          void this.runMemoryCompileSweep().catch((e) => console.warn('[session-manager] memory compile failed:', e))
        }, 3 * 60 * 1000).unref?.()
        this.scheduleMemorySweep()
        // SOP 固化入口（PLAN-experience-sop 刀三）：IPC → 托管无人值守运行
        setSopDistillTrigger((pageId) => runSopDistill(pageId))
        // M5：一次性迁移（幂等旗标）；fire-and-forget，不挡首绘
        void this.runMemoryPagesMigration().catch((e) => console.warn('[memory-migration] failed:', e))
        return this.managers
      })()
    }
    return this.managersPromise
  }

  /** Seed the compile watermark from settings.json (memoryCompileWatermark)。 */
  private seedCompileWatermark(memoryManager: MemoryManager, settings: AppSettings): void {
    const w = settings.memoryCompileWatermark
    memoryManager.seedCompileWatermark({
      lastRunAt: w?.lastRunAt ? new Date(w.lastRunAt).getTime() : 0,
      lastCount: w?.lastCount ?? 0,
      lastAttemptAt: w?.lastAttemptAt ? new Date(w.lastAttemptAt).getTime() : 0,
      lastCursorAt: w?.lastCursorAt ? new Date(w.lastCursorAt).getTime() : 0,
    })
  }

  /** Seed the merge layer's LLM config onto the shared manager. The merge
   *  reads these instance fields; without the pre-seed it ran on whichever
   *  profile the previous sweep left behind (review 2026-10-10 中4).
   *  setConfig refuses to swap the config while a merge is in flight (中5). */
  private seedLlmConfig(memoryManager: MemoryManager, profile: LlmProfile): void {
    memoryManager.setConfig(profile.apiKey ?? '', profile.baseURL, createLlmAdapter(profile.provider ?? 'anthropic'), profile.model, profile.maxTokens)
  }

  /** 页面编译 sweep（M6）：到期则跑一轮 ensurePagesCompiled 并持久化 watermark。
   *  `profile` 缺席（启动定时器）回落活动模型——与代理同一解析序。 */
  async runMemoryCompileSweep(profile?: LlmProfile): Promise<boolean> {
    if (!this.managers) return false
    const memoryManager = this.managers.memoryManager
    const p = profile ?? (await this.resolveActiveLlmProfile())
    if (p) this.seedLlmConfig(memoryManager, p)
    const ran = await memoryManager.ensurePagesCompiled()
    const w = memoryManager.getCompileWatermark()
    // 每次触碰都持久化（含纯尝试）：lastAttemptAt 活过重启是空转帽的前提
    if (w.lastRunAt === 0 && !w.lastAttemptAt && !w.lastCursorAt) return ran
    await settingsStore.update((s0) => ({
      ...s0,
      memoryCompileWatermark: {
        ...(w.lastRunAt !== 0 ? { lastRunAt: new Date(w.lastRunAt).toISOString() } : {}),
        lastCount: w.lastCount,
        ...(w.lastAttemptAt ? { lastAttemptAt: new Date(w.lastAttemptAt).toISOString() } : {}),
        ...(w.lastCursorAt ? { lastCursorAt: new Date(w.lastCursorAt).toISOString() } : {}),
      },
    })).catch((e) => console.warn('[session-manager] compile watermark persist failed:', e))
    return ran
  }

  /** M5 一次性迁移：经验池字节平移 + 扁平记忆确定性落页（LLM 归并进 M6 的
   *  compile pass 波次——本步先保数据连续与可检索）。旧表/旧目录冻结不删。 */
  private async runMemoryPagesMigration(): Promise<void> {
    if (!this.managers) return
    const settings = await settingsStore.get()
    if (settings.memoryPagesMigratedAt) return
    const expCount = migrateExperiencesToPages()
    const flatRows = listFlatMemoriesForMigration()
    const memCount = applyFlatMemoryMigration(fallbackFlatMemoryOps(flatRows))
    await settingsStore.update((s0) => ({ ...s0, memoryPagesMigratedAt: new Date().toISOString() }))
    console.log(`[memory-migration] ${expCount} experience page(s) byte-shifted, ${memCount} flat memorie(s) paged (fallback arm; merge rides the compile-pass wave)`)
  }

  // ── 记忆提取定时清扫（PLAN-memory-wiki M2c）────────────────────────────
  // 用户裁定（2026-10-25）：主时机 = 定时（默认 6h、可设、0=仅手动），
  // afterSession/启动回填退役；游标制补课——应用没跑的时段下次启动自然扫掉。
  private sweepTimer: NodeJS.Timeout | null = null
  private sweepInFlight = false
  /** 最近一次挂表时的调度状态（intervalMs=null = 未挂表：0=仅手动 或 记忆/经验
   *  双开关全关）。applyFeatureToggles 拿新设置重算同款状态做比对，只有真变了
   *  才重排——任意 settings 保存（切主题/改排序）都无条件重挂满间隔，曾把
   *  倒计时一遍遍推回起点（2026-11-01「16h 未提取」的第二根因）。 */
  private armedSweepState: { intervalMs: number | null; enabled: boolean } | null = null
  /** 无可用 profile 的早退警告只发一次（补跑锚不动的空转期防日志刷屏）；成功跑过一轮后复位。 */
  private sweepNoProfileWarned = false

  /** 定时器编排：到点循环；间隔/开关真变才重排（applyFeatureToggles 调用）。
   *  等待时长以持久化 memoryLastSweepAt 为锚（nextSweepDelayMs）——重启与重排
   *  只补剩余时间，已过期 5 分钟内补跑。此前每次启动都重挂满间隔，「游标制
   *  补课——应用没跑的时段下次启动自然扫掉」的原意从未兑现。 */
  scheduleMemorySweep(): void {
    setMemorySweepTrigger(() => this.triggerMemorySweepNow())
    if (this.sweepTimer) { clearTimeout(this.sweepTimer); this.sweepTimer = null }
    void settingsStore.get().then((settings) => {
      const enabled = (settings.memoryEnabled ?? true) || (settings.experienceEnabled ?? true)
      const ms = enabled ? sweepIntervalMs(settings.memoryExtractIntervalHours) : null
      this.armedSweepState = { intervalMs: ms, enabled }
      if (ms === null) return // 0 = 关闭定时仅手动，或双开关全关：不挂表（锚不动，挂了就是 5min 空转循环）
      const anchor = settings.memoryLastSweepAt ? Date.parse(settings.memoryLastSweepAt) : 0
      const delay = nextSweepDelayMs(ms, Number.isFinite(anchor) ? anchor : 0, Date.now())
      this.sweepTimer = setTimeout(() => {
        this.sweepTimer = null
        void this.runMemoryExtractionSweep().catch((e) => console.warn('[memory-sweep] failed:', e))
          .finally(() => this.scheduleMemorySweep()) // 重排下一轮
      }, delay)
      this.sweepTimer.unref?.()
    })
  }

  /** 「立即提取」入口（设置面板按钮）：无视间隔设置跑一轮（资格条件照常生效）。 */
  async triggerMemorySweepNow(): Promise<number> {
    return this.runMemoryExtractionSweep()
  }

  private async runMemoryExtractionSweep(): Promise<number> {
    if (!this.managers || this.sweepInFlight) return 0
    this.sweepInFlight = true
    try {
      const settings = await settingsStore.get()
      const memoryOn = settings.memoryEnabled ?? true
      const experienceOn = settings.experienceEnabled ?? true
      if (!memoryOn && !experienceOn) return 0
      const profile = await this.resolveActiveLlmProfile()
      if (!profile || !profile.apiKey) {
        if (!this.sweepNoProfileWarned) {
          this.sweepNoProfileWarned = true
          console.warn('[memory-sweep] skipped: 没有可用模型（active profile 缺失或无 apiKey）——不落 memoryLastSweepAt，配置模型后按锚自动补跑')
        }
        return 0
      }

      // SOP 自动清扫（PLAN-experience-sop 刀四）：搭提取清扫的车——资格门在
      // shared/sop-sweep（recurrence ≥2 / 24h 退避 / 3 次退役 / use_count 优先），
      // 每轮批 ≤2，fire-and-forget 派发（运行在后台，本 sweep 不等它）。
      await this.runSopDistillSweep(experienceOn)

      const candidates = listMemorySweepCandidates(new Date(Date.now() - SWEEP_ACTIVE_WINDOW_MS).toISOString(), SWEEP_BATCH_LIMIT * 2)
      let extracted = 0
      for (const c of candidates) {
        if (extracted >= SWEEP_BATCH_LIMIT) break
        const conv = getConversation(c.id)
        if (!conv) continue
        const messages = (conv.messages ?? []).map((m) => ({ ...m, contentBlocks: m.contentBlocks ?? [] }))
        // 文本消息精确计数（游标同一单位）——SQL 的 msgCount 只是粗筛上界
        const textCount = messages.filter(
          (m) => (m.role === 'user' || m.role === 'assistant') && (m.contentBlocks ?? []).some((b) => b.type === 'text')
        ).length
        const verdict = judgeSweepCandidate({ totalTextMessages: textCount, cursor: c.extractedMsgCount, lastActiveAt: new Date(conv.updatedAt).getTime() }, Date.now())
        if (verdict !== 'extract') continue
        const result = await this.managers.memoryManager.extractAndSaveAll(
          messages, profile.apiKey, profile.baseURL, createLlmAdapter(profile.provider ?? 'anthropic'),
          profile.model, c.id, settings.locale, { memory: memoryOn, experience: experienceOn }, { minDelta: SWEEP_MIN_DELTA },
        )
        extracted++
        if (result.pages > 0) console.log(`[memory-sweep] ${c.id}: ${result.pages} page op(s)`)
      }
      // 上次提取时刻落设置（settings.memoryLastSweepAt，渲染端整存时由
      // SETTINGS_SET 保留）：定时与手动「立即提取」同源同款。早退分支（总开关
      // 全关/无可用 profile）不算跑过，不落笔——面板显示的必须是真跑过的时刻；
      // 它同时是下次挂表的调度锚（nextSweepDelayMs），空跑也如实前移。
      console.log(`[memory-sweep] run complete: extracted=${extracted}, candidates=${candidates.length}`)
      this.sweepNoProfileWarned = false
      await settingsStore.update((s) => ({ ...s, memoryLastSweepAt: new Date().toISOString() }))
      return extracted
    } finally {
      this.sweepInFlight = false
    }
  }

  /** SOP 自动清扫（刀四）：从活经验页里选资格页派发固化。批 ≤2、同页在飞跳过；
   *  资格判定与排序的语义在 shared/sop-sweep.ts（vitest 直测）。 */
  private async runSopDistillSweep(experienceOn: boolean): Promise<number> {
    if (!experienceOn) return 0
    const now = Date.now()
    // 停用的经验不进自动固化（用户拨下开关 = 别为它跑无人值守会话）；退役页同排除
    //（园丁判它过时，固化代理不该再为它跑）；手动按钮不受此门
    const candidates = sortBySopPriority(listMemoryPages('experience').filter((p) => isLivePage(p) && p.enabled !== false))
      .filter((p) => judgeSopCandidate({ maturity: p.maturity, recurrence: p.recurrence, attempts: p.sopAttempts, lastAttemptAt: p.sopLastAttemptAt ? Date.parse(p.sopLastAttemptAt) : null }, now) === 'distill')
      .slice(0, SOP_SWEEP_BATCH)
    let dispatched = 0
    for (const c of candidates) {
      if (isSopDistilling(c.id)) continue
      const result = await runSopDistill(c.id)
      if (result.error) console.warn(`[sop-sweep] ${c.id} (${c.title}): ${result.error}`)
      else dispatched++
    }
    if (dispatched > 0) console.log(`[sop-sweep] dispatched ${dispatched} distillation run(s)`)
    return dispatched
  }

  /** Active-profile fallback for main-side one-shot LLM calls made outside a
   *  session (the startup merge sweep). Same resolution order as the proxy. */
  private async resolveActiveLlmProfile(): Promise<LlmProfile | undefined> {
    const settings = await settingsStore.get()
    return settings.profiles.find((p) => p.id === settings.activeProfileId) ?? settings.profiles[0]
  }

  /** Mirror the 设置 → 记忆/经验 master switches onto the shared managers.
   *  memoryEnabled maps onto MemoryPreferences (auto capture + prompt injection);
   *  experienceEnabled onto ExperienceManager's own flag. */
  private syncFeatureToggles(managers: Managers, settings: AppSettings): void {
    const memoryOn = settings.memoryEnabled ?? true
    managers.memoryManager.setPreferences({ autoCaptureEnabled: memoryOn, autoInjectEnabled: memoryOn })
    managers.experienceManager.setEnabled(settings.experienceEnabled ?? true)
  }

  /** Mirror the 设置 → 助手设置 run limits onto the engine-side module state:
   *  the loop iteration base and the parallel sub-agent cap. Both engines and
   *  the limiter read module-level values, and every engine this manager
   *  hosts lives in THIS process, so applying at startup and on each settings
   *  save keeps every session on the saved numbers from its next turn /
   *  next dispatch on. */
  private syncRunLimits(settings: AppSettings): void {
    setLoopIterationLimit(settings.maxLoopIterations)
    setSubAgentParallelLimit(settings.maxParallelSubAgents)
  }

  /** Re-apply the master switches and run limits after a settings save
   *  (settings.handler). */
  async applyFeatureToggles(settings: AppSettings): Promise<void> {
    // 只有调度状态真变了（间隔或记忆/经验开关）才重排定时器；挂表状态在
    // scheduleMemorySweep 的异步段才落，armed 为 null（未挂过/竞态窗口）也重排。
    const enabled = (settings.memoryEnabled ?? true) || (settings.experienceEnabled ?? true)
    const next = { intervalMs: enabled ? sweepIntervalMs(settings.memoryExtractIntervalHours) : null, enabled }
    const armed = this.armedSweepState
    if (!armed || armed.intervalMs !== next.intervalMs || armed.enabled !== next.enabled) {
      this.scheduleMemorySweep() // 间隔/开关变更后重排定时器
    }
    const managers = await this.ensureManagers()
    this.syncFeatureToggles(managers, settings)
    this.syncRunLimits(settings)
  }

  /** Resolve the LLM profile to run a session with: `preferredId` (a
   *  create-time pin, e.g. a routine's model choice) when it still resolves,
   *  otherwise the active profile. Falls back to first profile. The list is
   *  the store's merged view — one entry per model, connection fields already
   *  materialized from its 供应商. */
  private async resolveProfile(preferredId?: string): Promise<LlmProfile> {
    const settings = await settingsStore.get()
    const profile = (preferredId ? settings.profiles.find((p) => p.id === preferredId) : undefined)
      ?? settings.profiles.find((p) => p.id === settings.activeProfileId)
      ?? settings.profiles[0]
    if (!profile) throw new Error('未配置模型，请先在设置中添加供应商和模型')
    return profile
  }

  /** The selectable models for a 模型下拉. Deliberately narrowed to what a
   *  client needs to render the list: the profile's credentials and endpoint
   *  never go on the wire. `providerName` (the 供应商 display name) is what
   *  pickers group/prefix by — a model id alone no longer says whose it is.
   *  With `sessionId` the active id is that session's effective model (its own
   *  choice under the create-time pin); without one it is the global default
   *  the unpinned conversations follow. */
  async modelState(sessionId?: string): Promise<ModelState> {
    const settings = await settingsStore.get()
    const ownId = sessionId
      ? (this.sessions.get(sessionId)?.pinned.profileId ?? getConversationProfileId(sessionId))
      : undefined
    const active = (ownId ? settings.profiles.find((p) => p.id === ownId) : undefined)
      ?? settings.profiles.find((p) => p.id === settings.activeProfileId)
      ?? settings.profiles[0]
    return {
      profiles: settings.profiles.map((p) => ({ id: p.id, name: p.name, provider: p.provider, providerName: p.providerName, model: p.model })),
      activeId: active?.id ?? '',
    }
  }

  /** Switch the DEFAULT model (`settings.activeProfileId`) — what the settings
   *  panel's picker sets. Sessions that carry a model of their own (create-time
   *  pin or the conversation's `profile_id` column) are deliberately NOT
   *  swept — that is what "default" means. The following sessions are
   *  hot-swapped here because the desktop renderer only refreshes when *it*
   *  changed the setting, and a panel-side default switch must still reach
   *  them. */
  async setActiveProfile(profileId: string): Promise<ModelState> {
    const settings = await settingsStore.get()
    const profile = settings.profiles.find((p) => p.id === profileId)
    if (!profile) throw new Error(`unknown profile: ${profileId}`)
    // 换默认模型也是一次「上次使用」的修改 —— 用户刚表达了想用的模型，否则
    // 新建会话会继续沿用旧值而无视这次修改（桌面设置面板的同一动作在
    // settings.handler 里以「比对旧 activeProfileId」实现）。
    rememberLastUsedProfileId(profile.id)
    if (settings.activeProfileId !== profile.id) {
      await settingsStore.update(s => ({ ...s, activeProfileId: profile.id }))
    }
    for (const [sessionId, entry] of this.sessions) {
      if (this.effectiveProfileId(sessionId, entry)) continue // the session owns its model
      await this.refreshOptions(sessionId).catch((err) => {
        console.warn('[AgentSession] model switch: refresh failed', sessionId, err)
      })
    }
    return this.modelState()
  }

  /** Per-conversation 模型 — the remote equivalent of the desktop composer's
   *  model picker (`setConversationProfile` + `agentSessionRefreshOptions`,
   *  moved here so a ws client cannot fork the semantics). `profileId = null`
   *  unpins: the conversation follows the global default again. Precedence
   *  mirrors setApprovalMode: a create-time pin (a routine's model) outranks
   *  the column, so the answer is the model in force afterwards — for a pinned
   *  session those differ, and the caller must not be told its click took when
   *  the session kept its own model. */
  async setSessionProfile(sessionId: string, profileId: string | null): Promise<ModelState> {
    if (profileId) {
      const settings = await settingsStore.get()
      if (!settings.profiles.some((p) => p.id === profileId)) throw new Error(`unknown profile: ${profileId}`)
      // A real pick on the panel's model dropdown is the user's latest model
      // choice — the next new conversation starts here too. null (回到默认)
      // is an unpin, not a choice, and leaves last-used alone.
      rememberLastUsedProfileId(profileId)
    }
    setConversationProfile(sessionId, profileId)
    await this.refreshOptions(sessionId).catch((err) => {
      console.warn('[AgentSession] model switch: refresh failed', sessionId, err)
    })
    return this.modelState(sessionId)
  }

  /** session.setApprovalMode — the remote 授权 button (PLAN-browser-extension
   *  M4.5). Writes the conversation's stored level, which is the same two steps
   *  the desktop's own 授权 button performs over IPC
   *  (`setConversationApprovalMode` + `agentSessionRefreshOptions`), moved here
   *  so a ws client cannot fork the semantics: the column is the one durable
   *  copy, and `refreshOptions` re-resolves the live engine from it so a change
   *  made mid-run lands on the next tool without waiting for the next ask.
   *
   *  A session whose approval was pinned at creation (a derived/unattended run)
   *  keeps its pin — `effectiveApprovalMode` gives the override precedence, so
   *  writing the column cannot loosen a run that must not be loosened. */
  async setApprovalMode(sessionId: string, mode: SandboxApprovalMode): Promise<SandboxApprovalMode> {
    setConversationApprovalMode(sessionId, mode)
    // The panel's 授权 click is a user modification — the sticky last-used
    // value follows it (the desktop's own click remembers in the IPC door,
    // conversation.handler; the studio's first-create seed never reaches here).
    rememberLastUsedApprovalMode(mode)
    await this.refreshOptions(sessionId).catch((err) => {
      console.warn('[AgentSession] approval switch: refresh failed', sessionId, err)
    })
    // The answer is the level in force afterwards, not the one that was asked
    // for: for a pinned session those differ, and the caller must not be told
    // its click took when the run kept its own level.
    const entry = this.sessions.get(sessionId)
    return entry ? this.effectiveApprovalMode(sessionId, entry) : mode
  }

  /** Drop the creation-time pins once the unattended window is over — the
   *  routine runner calls this when a run settles, so post-run continuations
   *  in the run transcript follow the conversation's own stored choices (the
   *  授权 button's column and the 模型 picker's profile column, which the
   *  runner seeded with the run's context at creation) instead of the run's
   *  frozen values. The pins exist to keep a run nobody is watching from
   *  widening or drifting; a finished run has no such window left to protect.
   *  The profile pin must go with the approval one: while it held, the
   *  composer's own model pick could not take effect (effectiveProfileId gave
   *  the pin precedence), and unlike the approval pin nothing else ever
   *  released it. */
  /** PLAN-extension-handoff（user 2026-11-08 实机反馈「工作区不对」）：hosted
   *  会话的 sandbox 兜底是全局 workspace 根（doCreateSession 的
   *  `workspaceDir || settings.workspaceDir || WORKSPACE_DIR`——isLocalUiSession
   *  门把扩展会话关在铸造路径外），且全局根会被持久化进 row，此后 row 有值即
   *  返回，全局根永远冒充会话独立工作区。移交时调它：把全局根形态当「未分配」
   *  重铸会话自己的目录，并**就地修补活引擎的 sandbox ctx**（下一回合的 exec
   *  兜底就从新目录算）。 */
  async ensureConversationWorkspace(sessionId: string): Promise<string> {
    const ctx = this.sandboxContexts.get(sessionId)
    const dir = await ensureHostedConversationWorkspace(sessionId)
    if (ctx && ctx.workspaceDir !== dir) ctx.workspaceDir = dir
    return dir
  }

  /** 阶段会话最近一次合法 `finish_stage`（2026-11-11 完成协议）。
   *  pipeline-engine 结算时先读它、再回落 PIPELINE_RESULT 文本行；普通会话
   *  没有 stageFinish 配置，返回值恒为 null。 */
  getStageFinishRecord(sessionId: string): PipelineContract | null {
    return this.sessions.get(sessionId)?.engine.getStageFinishRecord() ?? null
  }

  releaseRunPins(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    const hadProfilePin = entry.pinned.profileId !== undefined
    entry.pinned.approvalOverride = undefined
    entry.pinned.profileId = undefined
    entry.engine.opts.approvalMode = this.effectiveApprovalMode(sessionId, entry)
    // The approval re-resolution is a cheap synchronous column read; the model
    // rides the full refresh (engine opts carry credentials). In the common
    // case the column holds the very profile the pin did — the runner seeds it
    // at creation — so this is a no-op rebuild, not a model switch.
    if (hadProfilePin) {
      void this.refreshOptions(sessionId).catch((err) => {
        console.warn('[AgentSession] run-pin release: refresh failed', sessionId, err)
      })
    }
  }

  async createSession(sessionId: string, opts: AgentSessionCreateOptions = {}): Promise<{ sessionId: string; agentId: string; workspaceDir?: string }> {
    if (this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId)!
      return { sessionId, agentId: existing.agentId, workspaceDir: this.sandboxContexts.get(sessionId)?.workspaceDir }
    }
    const pending = this.pendingCreates.get(sessionId)
    if (pending) {
      await pending
      return { sessionId, agentId: this.sessions.get(sessionId)!.agentId, workspaceDir: this.sandboxContexts.get(sessionId)?.workspaceDir }
    }
    const creation = this.doCreateSession(sessionId, opts)
    this.pendingCreates.set(sessionId, creation)
    creation.then(() => {}, () => {})
    try {
      await creation
    } finally {
      this.pendingCreates.delete(sessionId)
    }
    return { sessionId, agentId: this.sessions.get(sessionId)!.agentId, workspaceDir: this.sandboxContexts.get(sessionId)?.workspaceDir }
  }

  /** Wait for an in-flight creation, then return the entry (throws if absent). */
  private async ensureEntry(sessionId: string): Promise<SessionEntry> {
    const pending = this.pendingCreates.get(sessionId)
    if (pending) await pending
    const entry = this.sessions.get(sessionId)
    if (!entry) throw new Error(`session not found: ${sessionId}`)
    return entry
  }

  private async doCreateSession(sessionId: string, opts: AgentSessionCreateOptions): Promise<void> {
    const managers = await this.ensureManagers()
    const settings = await settingsStore.get()
    // 「新建会话沿用上次选择」：一个没有任何创建期配置的普通会话，把全局的
    // 上次使用值落成自己的列 —— 必须发生在下面 profile/approvalMode 的解析
    // 之前，本次创建就直接以它运行；之后这个会话各持各的，重启或默认切换
    // 都不再漂移（详见 last-used-defaults.ts）。
    seedLastUsedDefaults(sessionId, opts, settings)
    // A create-time profile pin (a routine's model choice) wins when it still
    // resolves; otherwise the conversation's own choice — the model picked on
    // the composer lands on the column before this session exists — and the
    // global default only for a conversation that never chose.
    const profile = await this.resolveProfile(opts.profileId ?? getConversationProfileId(sessionId))
    // Local UI conversations resolve their working directory here (PLAN-0.4.0
    // M8): project-bound ones use the project's fixed workspace, plain ones get
    // a lazily-created timestamped folder under the global workspace. Spawn
    // ids and callers with an explicit workspaceDir keep the old fallback.
    // Gated on clientId because routines/ws extensions create sessions directly
    // and never went through the IPC handler's resolution. Resolving INSIDE
    // doCreateSession matters for ordering: createSession registers the pending
    // create synchronously before awaiting this, so an ask that races the
    // create waits on it instead of failing "session not found" (which lost
    // the first message of every conversation).
    const isLocalUiSession = !opts.clientId || opts.clientId === 'local'
    let workspaceDir = opts.workspaceDir
    if (!workspaceDir && isLocalUiSession && deriveConvType(sessionId) === 'normal') {
      const projectId = opts.projectId ?? getConversationProjectId(sessionId)
      workspaceDir = await resolveConversationWorkspace(sessionId, projectId)
    }
    workspaceDir = workspaceDir || settings.workspaceDir || WORKSPACE_DIR
    // 项目概述 (2026-09-18): the bound project's name/overview ride the state
    // block's `## Project` section (project → workspace hierarchy). Only a real
    // row contributes — the synthesized default project has neither, and the
    // section stays out entirely (若无则忽略). Spawn/derived sessions resolve
    // to 'default' here and are unaffected; spawn prompts carry no state block.
    const boundProjectId = opts.projectId ?? getConversationProjectId(sessionId)
    let projectName: string | undefined
    let projectOverview: string | undefined
    if (boundProjectId && boundProjectId !== DEFAULT_PROJECT_ID) {
      const boundProject = await projectStore.get(boundProjectId).catch(() => null)
      if (boundProject) {
        projectName = boundProject.name
        projectOverview = boundProject.overview
      }
    }
    // Approval precedence: an explicit per-session override (derived sessions
    // run unattended) > the conversation's own stored choice > the shared
    // default for a conversation that never chose (按需确认).
    const approvalMode = pickApprovalMode(opts.approvalMode, getConversationApprovalMode(sessionId))

    // D16: compose the create-time internal pack ONCE. The whitelists go to
    // the mirror fields VERBATIM — all three states survive: an EMPTY array
    // stays empty (「一个都不许用」绝不能塌成 undefined 的「不限制」), and
    // undefined stays undefined (工具创建助手的显式不限制——`?? []` 把它反向
    // 塌成「全禁止」，pick_skill 必败，review0920-H2). Anchored by
    // tests/internal-expert-pack.test.ts.
    const pinnedExpert: ExpertRuntimeContext | null = opts.expertProfile
      ? {
          id: opts.expertProfile.id,
          name: opts.expertProfile.name,
          instructions: composeExpertInstructions(opts.expertProfile, this.resolveExpertRefCatalogs()),
          allowedSkills: opts.expertProfile.skillNames,
          allowedMcpServers: opts.expertProfile.mcpServerIds,
        }
      : null

    const engineOptions: AgentEngineOptions = {
      apiKey: profile.apiKey ?? null,
      baseURL: profile.baseURL,
      model: profile.model,
      maxTokens: profile.maxTokens ?? 32768,
      contextLength: profile.contextLength,
      // Not armed on a pinned-override session (review 20261009 中1): the
      // sentinel protocol is taught only by the core prompt and spawn-tool —
      // buildSystemPrompt returns an override VERBATIM, so here the guard
      // would fire on every text-only close after tool work while the model
      // had never been told to write <<TASK_DONE>> (each progress stretch
      // burning one false continuation). Arm ⇔ taught: no override, no flag.
      earlyStopGuard: profile.earlyStopGuard === true && !opts.systemPromptOverride,
      profileId: profile.id,
      adapter: createLlmAdapter(profile.provider ?? 'anthropic'),
      myName: settings.myName,
      soul: settings.soul,
      yourName: settings.yourName,
      toolManager: managers.toolManager,
      skillManager: managers.skillManager,
      memoryManager: managers.memoryManager,
      knowledgeManager: managers.knowledgeManager,
      experienceManager: managers.experienceManager,
      platformInfo: managers.platformInfo,
      workspaceDir,
      projectName,
      projectOverview,
      skillsDir: SKILLS_DIR,
      approvalMode,
      locale: settings.locale === 'en' ? 'en' : 'zh',
      // A derived session (prompt override) is not a user conversation: its
      // transcript must not feed the memory/experience pipeline.
      conversationId: sessionId,
      pageContextProvider: builtinPageContextProvider(sessionId),
      systemPromptOverride: opts.systemPromptOverride,
      allowedTools: opts.allowedTools,
      // 阶段完成协议（2026-11-11）：只有 pipeline-engine 传，普通会话缺席。
      stageFinish: opts.stageFinish,
      // D16: an explicitly pinned internal pack (the assistants) rides on top
      // of the pinned override — identity over mechanics. Composed once here;
      // refreshOptions re-attaches the whole set (the mirror fields included,
      // since updateOptions replaces the bag wholesale).
      ...(pinnedExpert
        ? {
            expert: pinnedExpert,
            allowedSkills: pinnedExpert.allowedSkills,
            allowedMcpServers: pinnedExpert.allowedMcpServers,
          }
        : {}),
    }
    const engine = new AgentEngine(engineOptions, this.makeCallbacks(sessionId))
    this.lastSentLen.set(sessionId, 0)
    this.sessions.set(sessionId, {
      engine,
      agentId: opts.agentId ?? 'default',
      title: opts.title,
      createdAt: new Date().toISOString(),
      clientId: opts.clientId ?? 'local',
      pinned: {
        systemPromptOverride: opts.systemPromptOverride,
        allowedTools: opts.allowedTools,
        expertProfile: opts.expertProfile,
        // Only an explicit request pins the approval mode; an ordinary session
        // keeps following its conversation's own choice — see
        // refreshConversationApproval.
        approvalOverride: opts.approvalMode,
        // Same pin shape for the model: refreshOptions re-resolves THIS id
        // (falling back to active when deleted), so a global 模型 switch
        // never moves a pinned session off its chosen model.
        profileId: opts.profileId,
        // 阶段完成协议（2026-11-11）：只有 pipeline-engine 传，普通会话缺席。
        // 必须进 pin——refreshOptions 重建 option bag 时要把它原样接回。
        stageFinish: opts.stageFinish,
      },
    })
    // Per-session sandbox context: wrapped around every tool-executing entry
    // point (ask / engineCall) so the file-ops and terminal services can
    // adjudicate against the right workspace (PLAN-0.4.0 M3.5). The exec
    // allowlist and background-pid registry are per-session mutable state that
    // dies with this object — a new session never inherits either.
    this.sandboxContexts.set(sessionId, { sessionId, workspaceDir, execAllowlist: new Set(), backgroundPids: new Set() })
    try { updateConversationOrigin(sessionId, opts.clientId ?? 'local', opts.tabKey) } catch { /* origin is best-effort */ }
    if (opts.projectId && opts.projectId !== DEFAULT_PROJECT_ID) {
      try { setConversationProject(sessionId, opts.projectId) } catch { /* best-effort */ }
    }
    // The renderer binds the @-summoned expert before the first message lands —
    // resolve it now so the very first loop already runs as the expert.
    const entry = this.sessions.get(sessionId)
    // D16: the pinned pack's runtime context is entry state — refreshOptions
    // re-attaches it (with its mirror fields) on every option rebuild.
    if (entry && pinnedExpert) entry.expertState = pinnedExpert
    if (entry) await this.refreshExpertContext(sessionId, entry)
  }

  private sandboxContexts = new Map<string, SessionSandboxContext>()

  /** Re-read the conversation's approval level so the 授权 button's choice
   *  lands on the next message instead of being frozen at the session's first
   *  turn. A session pinned at creation (derived/unattended) keeps its pin. */
  private refreshConversationApproval(sessionId: string, entry: SessionEntry): void {
    if (entry.pinned.approvalOverride === undefined) {
      entry.engine.opts.approvalMode = this.effectiveApprovalMode(sessionId, entry)
    }
  }

  /** Re-resolve the session's conversation-bound expert config pack (the
   *  legacy @-summon binding — new summons delegate via spawn_agent instead,
   *  but rows bound before that still run as the expert). Runs at session
   *  creation and before every ask (next to refreshConversationApproval) so
   *  unbinds take effect immediately; a deleted/disabled expert falls back to
   *  an ordinary session. engine.applyExpertContext invalidates the
   *  system-prompt cache when the expert changed. Derived prompt sessions
   *  (tool studio etc.) and create-time expertProfile pins (D16, the
   *  assistants) keep their pinned identity — a DB-bound expert never
   *  applies to them. */
  private async refreshExpertContext(sessionId: string, entry: SessionEntry): Promise<void> {
    if (entry.pinned.expertProfile) {
      // The pinned pack owns this session's expert identity for its whole
      // life. Nothing to re-resolve: refreshOptions re-attaches the ctx and
      // its mirror fields wholesale on every rebuild.
      return
    }
    if (entry.pinned.systemPromptOverride) return
    try {
      const expertId = getConversationExpertId(sessionId)
      if (!expertId && !entry.engine.opts.expert) return // ordinary session, nothing to do
      let next: ExpertRuntimeContext | null = null
      if (expertId) {
        const profile = expertStore.getById(expertId)
        if (profile && profile.enabled !== false) {
          next = {
            id: profile.id,
            name: profile.name,
            instructions: composeExpertInstructions(profile, this.resolveExpertRefCatalogs()),
          }
        } else {
          console.warn(`[SessionManager] expert "${expertId}" missing or disabled — falling back to ordinary session`)
        }
      }
      entry.engine.applyExpertContext(next)
      entry.expertState = next
    } catch (err) {
      console.warn('[SessionManager] refreshExpertContext failed:', err)
    }
  }

  /** 引用关系（常用技能 / 连接器）的目录：缺省不省略字段就退化成原始 id 注入，
   *  所以这里只在能读到目录时才传，读不到时把字段留空。 */
  private resolveExpertRefCatalogs(): ExpertRefCatalogs {
    const managers = this.managers
    return toExpertRefCatalogs({
      skills: managers?.skillManager.getAll().map((s) => s.definition),
      connectors: serverManager.listServers().map((s) => ({ id: s.id, name: s.name, summary: s.summary })),
    })
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** Kick off an agent loop; progress arrives as session events. Requests
   *  beyond the global concurrency cap queue FIFO. `pageContext` (the browser
   *  extension's current tab) is per-turn state: it rides on the engine opts
   *  and lands in the prompt's dynamic (non-cached) Current Page section.
   *  `summon` (@-mention) is this turn's expert roster, and the ONE routing
   *  rule lives in the engine: one name is a spawn_agent delegation delivered
   *  verbatim, several enter plan mode. Absent/empty is a normal turn.
   *  `knowledgeBase` (PLAN-knowledge-groups G5) is this turn's @知识库 scope:
   *  staged onto the engine so prepareTurn makes it the turn's retrieval
   *  scope; null (no mention) unscopes. `forcedSkills` is this turn's
   *  $-pinned skill names — staged the same way, consumed for one turn. */
  async ask(
    sessionId: string,
    content: string,
    pageContext?: PageContext,
    summon?: SummonedExpert[],
    knowledgeBase?: { id: string; name: string } | null,
    forcedSkills?: string[] | null,
  ): Promise<void> {
    const entry = await this.ensureEntry(sessionId)
    this.refreshConversationApproval(sessionId, entry)
    await this.refreshExpertContext(sessionId, entry)
    entry.engine.opts.pageContext = pageContext
    entry.engine.setKnowledgeBaseScope(knowledgeBase ?? null)
    entry.engine.setForcedSkills(forcedSkills ?? null)
    // Whether page_* tools are on this session's toolset at all: a browser
    // client is connected for it (tool-collection.ts reads this flag). Checked
    // per ask because the binding can come and go with the connection.
    entry.engine.opts.hostedAvailable = agentClientRegistry.isHostedCapable(sessionId)
    if (this.runningLoops >= MAX_CONCURRENT_LOOPS) {
      this.emit(sessionId, { type: 'status', status: 'queued', attempt: this.waitingLoops.length + 1 })
      // Queued counts as working: the turn gets a slot imminently, and the
      // engine's own statuses only start once it runs (see system/keep-awake.ts).
      keepAwake.update(sessionId, 'queued')
      const parked: { stopped: boolean } = { stopped: false }
      await new Promise<void>((resolve) => this.waitingLoops.push({ sessionId, parked, resolve }))
      // A stop that landed while this ask sat parked already settled its turn:
      // stopExecution parked the engine at idle (an unattended row finished
      // 「用户停止」 and tore its gates down), and prepareTurn would reset
      // isCancelled the moment we startTurn — the whole task would run with
      // nobody watching (review_20260923 M1). Decline. This ask never took the
      // slot, so it must not increment; the wake it was handed carries a free
      // slot — pass it on to the next waiter.
      if (parked.stopped) {
        this.waitingLoops.shift()?.resolve()
        return
      }
    }
    this.runningLoops += 1
    const sandboxCtx = this.sandboxContexts.get(sessionId)
    const roster = normalizeSummonedExperts(summon)
    const startTurn = () => roster.length > 0
      ? entry.engine.startPlanningLoop(content, roster)
      : entry.engine.startLoop(content)
    void (sandboxCtx ? sessionSandbox.run(sandboxCtx, startTurn) : startTurn())
      .catch((err) => {
        this.emit(sessionId, { type: 'error', message: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        this.runningLoops -= 1
        this.waitingLoops.shift()?.resolve()
      })
  }

  cancel(sessionId: string): void {
    void this.ensureEntry(sessionId).then((entry) => entry.engine.cancelLoop()).catch(() => {})
  }

  async history(sessionId: string): Promise<{ messages: unknown[]; agentId: string }> {
    const entry = await this.ensureEntry(sessionId)
    return { messages: entry.engine.messages as unknown[], agentId: entry.agentId }
  }

  /** Seed a restored conversation's history into the main-hosted engine. */
  async hydrate(sessionId: string, messages: AgentMessage[], historySummary?: { text: string; firstKeptId: string } | null): Promise<void> {
    const entry = await this.ensureEntry(sessionId)
    entry.engine.loadConversation(messages)
    if (historySummary) {
      entry.engine.seedHistorySummary(historySummary.text, historySummary.firstKeptId)
    }
    entry.engine.loadPlan(sessionId)
    this.lastSentLen.set(sessionId, messages.length)
    this.messageContentRegistry.set(sessionId, new Map(messages.map(message => [message.id, messageContentSignature(message)])))
  }

  /** UI snapshot for (re)activating a session. */
  async snapshot(sessionId: string): Promise<{
    messages: AgentMessage[]; status: StatusSnapshot; streamingBlocks: unknown[]; plan: PlanSnapshot | null; fileChanges: SessionFileChange[]; lastCompaction: CompactionEvent | null
    approvalMode?: SandboxApprovalMode
  } | null> {
    if (!this.sessions.has(sessionId) && !this.pendingCreates.has(sessionId)) return null
    const entry = await this.ensureEntry(sessionId).catch(() => null)
    if (!entry) return null
    const status = entry.engine.agentStatus
    return {
      messages: entry.engine.messages,
      // The optional carriers ride with the status word here exactly as they do
      // on the event stream (statusSnapshotOf via onStatusChanged): a client
      // that re-attaches mid-turn — parked in `error`, or mid-backoff on a
      // retry — has no other carrier and can only show its own fallback.
      status: statusSnapshotOf(status),
      streamingBlocks: entry.engine.streamingBlocks as unknown[],
      plan: entry.engine.plan ?? null,
      fileChanges: entry.engine.getFileChanges(),
      lastCompaction: entry.engine.lastCompaction,
      // The conversation's STORED 授权 choice (the column the composer/panel
      // write) — the same value session.list used to carry per row. Not the
      // effective mode: the override is a derived session's unattended pin,
      // and the picker shows the user's own choice. Undefined when unset —
      // and best-effort like the origin stamp: a column read must not cost
      // the client the still-life it actually asked for.
      approvalMode: this.storedApprovalMode(sessionId),
    }
  }

  private storedApprovalMode(sessionId: string): SandboxApprovalMode | undefined {
    try { return getConversationApprovalMode(sessionId) } catch { return undefined }
  }

  /** Whitelisted engine method calls from the renderer (approvals, loop control…). */
  async engineCall(sessionId: string, method: string, args: unknown[]): Promise<unknown> {
    const entry = await this.ensureEntry(sessionId)
    const sandboxCtx = this.sandboxContexts.get(sessionId)
    const dispatch = () => this.dispatchEngineCall(sessionId, entry, method, args)
    return sandboxCtx ? sessionSandbox.run(sandboxCtx, dispatch) : dispatch()
  }

  private dispatchEngineCall(sessionId: string, entry: { engine: AgentEngine }, method: string, args: unknown[]): unknown {
    const engine = entry.engine as unknown as Record<string, (...a: unknown[]) => unknown>
    switch (method) {
      case 'approveTool': return engine.approveTool(args[0] as string, args[1] as boolean | undefined)
      case 'rejectTool': return engine.rejectTool(args[0] as string)
      // /init 的限时写入窗（2026-11-11）：窗口只放松 .pulsemind/AGENTS.md 的
      // 保护路径扣留，root AGENTS.md / 子代理拒收 / always-ask 三处不动。
      // 只能从渲染端经这条白名单进入（引擎实例随会话生灭）。
      case 'grantProjectInstructionsWrite': return engine.grantProjectInstructionsWrite(args[0] as number)
      case 'killTool': return engine.killTool(args[0] as string)
      case 'respondToTool': return engine.respondToTool(args[0] as string, args[1] as string)
      case 'extendLoop': return engine.extendLoop()
      case 'steer':
        // Mid-stream steering (PLAN-mid-stream-steer M1) deliberately does NOT
        // go through sendUserMessage: the loop semaphore would park the ask
        // behind the very turn it is trying to redirect. The engine's own
        // phase guard rejects what it cannot steer, so a stale client cannot
        // double-dispatch a turn here.
        return engine.steer(args[0] as string)
      case 'stopExecution':
        // A stop aimed at a turn still parked on the loop queue cannot cancel
        // a loop — there is none yet — so mark the parked ask instead: when
        // the queue hands it a slot it must decline to start (review_20260923
        // M1). stopExecution itself still parks the engine at idle, which is
        // what the caller settles on.
        for (const wait of this.waitingLoops) {
          if (wait.sessionId === sessionId) wait.parked.stopped = true
        }
        return engine.stopExecution()
      case 'resumeExecution': return engine.resumeExecution()
      case 'clearError': return engine.clearError()
      case 'retryLastTurn': return engine.retryLastTurn()
      case 'getHistorySummary': return engine.getHistorySummary()
      // 运行中「转入后台」（PLAN-background-tasks A）：把一个在飞的前台 exec
      // 迁到 pid 键控后台通道。审批发生在工具派发之前，转后台不新增也不放松
      // 任何门（background:true 与转后台都买不到绕过 write 门——同一不变量）。
      case 'promoteToolToBackground': return engine.promoteToolToBackground(args[0] as string)
      // The 工作区 tree's initial pull (2026-10-28): the desktop client builds its
      // mirror from events alone and never snapshots, so a tree mounted after
      // the writes happened (tab switch, window reload) reads the ledger here.
      case 'getFileChanges': return entry.engine.getFileChanges()
      case 'ensureConversationWorkspace': return this.ensureConversationWorkspace(sessionId)
      case 'markExtensionHandoff':
        // PLAN-extension-handoff M3：会话自扩展移交而来，state block 带告知行。
        entry.engine.extensionHandoffNotice = true
        return undefined
      case 'compactNow': return engine.compactNow(args[0] as string | undefined)
      case 'debugSubAgents':
        // Read-only diagnostic (conv_20260930091135: two plan sub-agents parked
        // mid-run for hours and nothing in the system could even SEE their
        // state — spawned engines are not hosted sessions, so snapshot/ask
        // paths return null for them). Surfaces the live stall signature:
        // a wedged sub reads status=executing, pendingToolIds=[], request=null.
        return [...(entry.engine.activeSubAgents ?? new Map()).entries()].map(([spawnId, sub]) => ({
          spawnId,
          subConvId: sub.opts.conversationId,
          title: sub.spawnTitle,
          status: sub.agentStatus,
          currentRequestId: sub.currentRequestId,
          pendingToolIds: sub.pendingToolIds ? [...sub.pendingToolIds] : [],
          isAutoExecuting: sub.isAutoExecuting,
          isCancelled: sub.isCancelled,
          loopCount: sub.loopCount,
          msgCount: sub.messages.length,
          lastMsgAt: sub.messages.length ? sub.messages[sub.messages.length - 1].createdAt : null,
        }))
      case 'reset': entry.engine.reset(); return undefined
      case 'dispose':
        entry.engine.dispose()
        // The engine's scalar process cleanup never covered background pids
        // (by design — they must survive pause/abort/new-command), so the
        // session's own teardown is their only remaining reaper.
        reapBackgroundPids(this.sandboxContexts.get(sessionId)?.backgroundPids ?? [])
        // Same for the persistent shells (review P0-1): the engine's cleanup
        // kills a command in flight, but an idle shell — the session's own and
        // every sub-agent's — only dies here. Keyed by session so the sub-agent
        // shells (session::subConvId) go with their parent.
        reapSessionShells(sessionId)
        this.sessions.delete(sessionId)
        this.lastSentLen.delete(sessionId)
        this.messageContentRegistry.delete(sessionId)
        this.toolStatusRegistry.delete(sessionId)
        this.messageStatsRegistry.delete(sessionId)
        this.sandboxContexts.delete(sessionId)
        // The disposed engine's last status may still read executing (dispose
        // itself can notify), and no further status event will ever arrive for
        // this id — forget it explicitly or the wake lock pins forever.
        keepAwake.forget(sessionId)
        return undefined
      default: throw new Error(`engine method not allowed: ${method}`)
    }
  }

  // ── 后台任务完成投递（PLAN-background-tasks C）─────────────────────────
  // 引擎唤醒只搭下一次用户消息的车（enqueueBackgroundNotice → state block）；
  // 本方法是「前台空闲时主动开一回合汇报」的幂等入口，渲染端三个触发点都调
  // 它。闸门同步判定（主进程单线程下原子）：有未投递通知、引擎非活跃状态、
  // 全局槽位未满（满了不进 waitingLoops FIFO——投递不该排队）、未在投递中。
  private deliveringBackground = new Set<string>()
  /** Idle auto-delivery sweep (#2): retries pending notices every 30s — the
   *  renderer's three triggers are best-effort; this one guarantees the report
   *  lands the moment the engine goes idle, regardless of what the UI does. */
  private deliverSweepTimer: NodeJS.Timeout

  /** Deliver every pending background-exit notice as ONE synthetic user turn
   *  (marker-prefixed, so the transcript renders it as a system line, never a
   *  user bubble). The notices STAY on the engine — its own request builder
   *  drains them into the state block on this same turn (双保险), and a turn
   *  the user started in between keeps its normal wake-up. */
  async deliverBackgroundNotice(sessionId: string): Promise<'delivered' | 'busy' | 'nothing'> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return 'nothing'
    if (this.deliveringBackground.has(sessionId)) return 'busy'
    if (entry.engine.backgroundNotices.length === 0) return 'nothing'
    if (isActiveStatus(entry.engine.agentStatus)) return 'busy'
    if (this.runningLoops >= MAX_CONCURRENT_LOOPS) return 'busy'
    this.deliveringBackground.add(sessionId)
    try {
      const notices = [...entry.engine.backgroundNotices]
      const sandboxCtx = this.sandboxContexts.get(sessionId)
      // 任务名（PLAN-background-tasks D）：引擎台账带来的命令首行，超长截到
      // 60 列——首行汇总是给人看的，明细段（模型段）保留完整命令。
      const nameOf = (n: { pid: number; command?: string }): string => {
        const raw = typeof n.command === 'string' ? n.command.trim().split('\n', 1)[0] : ''
        return raw ? (raw.length > 60 ? `${raw.slice(0, 57)}...` : raw) : `pid=${n.pid}`
      }
      const resultOf = (n: { code: number | null }): string =>
        n.code === 0 ? '成功' : n.code === null ? '已结束' : `失败，退出码 ${n.code}`
      // 首行 = marker 行的唯一可见面：转录系统行只渲染 marker 后的第一行
      // （shared/background-notice.backgroundNoticeBody 取首行），所以「任务名
      // + 执行结果」必须全在这一行里；marker 之下的段是给模型的，不上屏。
      const summary = notices.map((n) => `${nameOf(n)}（${resultOf(n)}）`).join('、')
      const lines: string[] = []
      for (const n of notices) {
        // 内联输出尾 2KB：省一次 exec_logs 工具往返。读走会话沙盒（exec_logs
        // 的 pid 鉴权就是 backgroundPids 会员检查），读不到就如实省略。
        let tail = ''
        try {
          tail = sandboxCtx ? (sessionSandbox.run(sandboxCtx, () => svcExecLogs(n.pid, 2048)) ?? '') : ''
        } catch { tail = '' }
        lines.push(`- pid=${n.pid}「${nameOf(n)}」退出码 ${n.code ?? 'null'}${tail ? `\n\n输出尾部：\n${tail}` : ''}`)
      }
      const content = [
        `${BACKGROUND_NOTICE_MARKER} 后台任务已完成：${summary}`,
        '',
        '先前转入后台运行的命令已结束：',
        '',
        ...lines,
        '',
        '请向用户简要汇报每个任务的结果（成功/失败与关键输出），不要重新执行这些命令。',
      ].join('\n')
      // ask 自带并发记账（runningLoops / FIFO）与授权/专家上下文刷新；合成
      // 消息即普通回合——转录、持久化、token 记账全部按既有路径走。
      await this.ask(sessionId, content)
      return 'delivered'
    } finally {
      this.deliveringBackground.delete(sessionId)
    }
  }

  /** Rebuild engine options from current settings/profile and hot-swap them.
   *  Per-session pins (workspace, approval mode, model, prompt/tool overrides)
   *  survive: a settings change must not move a session off its working
   *  directory, flip its approval mode, swap its model, or widen a derived
   *  session's toolset mid-run. */
  async refreshOptions(sessionId: string): Promise<void> {
    const entry = await this.ensureEntry(sessionId).catch(() => null)
    if (!entry) return
    const managers = await this.ensureManagers()
    const settings = await settingsStore.get()
    // The session's OWN model re-resolves here — the create-time pin (a
    // routine's model choice) and, beneath it, the conversation's stored
    // choice (`getConversationProfileId`); undefined falls through to the
    // global default inside resolveProfile. This is what makes
    // setActiveProfile's default sweep a no-op for sessions that own a model.
    const profile = await this.resolveProfile(this.effectiveProfileId(sessionId, entry))
    // 项目概述 is re-read here (NOT a session pin, unlike workspaceDir): a
    // project edit mid-conversation lands on the session's next request via
    // the refreshProjectSessions sweep below.
    const boundProjectId = getConversationProjectId(sessionId)
    let projectName: string | undefined
    let projectOverview: string | undefined
    if (boundProjectId && boundProjectId !== DEFAULT_PROJECT_ID) {
      const boundProject = await projectStore.get(boundProjectId).catch(() => null)
      if (boundProject) {
        projectName = boundProject.name
        projectOverview = boundProject.overview
      }
    }
    entry.engine.updateOptions({
      apiKey: profile.apiKey ?? null,
      baseURL: profile.baseURL,
      model: profile.model,
      maxTokens: profile.maxTokens ?? 32768,
      contextLength: profile.contextLength,
      // Same arm ⇔ taught rule as the constructor (review 20261009 中1): a
      // pinned override is never taught the sentinel, so it is never armed.
      earlyStopGuard: profile.earlyStopGuard === true && !entry.pinned.systemPromptOverride,
      profileId: profile.id,
      adapter: createLlmAdapter(profile.provider ?? 'anthropic'),
      myName: settings.myName,
      soul: settings.soul,
      yourName: settings.yourName,
      toolManager: managers.toolManager,
      skillManager: managers.skillManager,
      memoryManager: managers.memoryManager,
      knowledgeManager: managers.knowledgeManager,
      experienceManager: managers.experienceManager,
      platformInfo: managers.platformInfo,
      workspaceDir: this.sandboxContexts.get(sessionId)?.workspaceDir ?? settings.workspaceDir ?? WORKSPACE_DIR,
      projectName,
      projectOverview,
      skillsDir: SKILLS_DIR,
      approvalMode: this.effectiveApprovalMode(sessionId, entry),
      locale: settings.locale === 'en' ? 'en' : 'zh',
      conversationId: sessionId,
      // Re-attached here too: updateOptions replaces the bag wholesale, and a
      // refresh (settings save, project edit, model switch) must not drop the
      // page the state block reports.
      pageContextProvider: builtinPageContextProvider(sessionId),
      // updateOptions replaces the option bag wholesale — re-attach the pins
      // (and the session-review hooks, which the refresh used to drop).
      systemPromptOverride: entry.pinned.systemPromptOverride,
      allowedTools: entry.pinned.allowedTools,
      expert: entry.expertState ?? undefined,
      // The pack's mirror fields ride with the expert ctx: updateOptions
      // replaces the bag wholesale, so re-deriving them HERE (not inside the
      // engine) is what keeps a pinned pack's whitelists across refreshes —
      // allowedSkills is read live from the bag, allowedMcpServersSet is
      // rebuilt by updateOptions when the key is present.
      allowedSkills: entry.expertState?.allowedSkills,
      allowedMcpServers: entry.expertState?.allowedMcpServers,
      // Re-bound here too: a client can disconnect and reconnect between two
      // refreshes, and updateOptions replaces the bag wholesale.
      hostedAvailable: agentClientRegistry.isHostedCapable(sessionId),
      // 阶段完成协议同属 pin：设置刷新不能把 finish_stage 从阶段会话上摘掉
      // （摘掉后模型会退回文本契约，结算面还会照常兜底，但主通道静默消失）。
      stageFinish: entry.pinned.stageFinish,
    })
  }

  /** A project's name/overview changed (PROJECT_UPDATE): re-read it onto every
   *  live session bound to that project, so the edit takes effect on the very
   *  next request (2026-09-18 立即生效 ruling). Same sweep shape as
   *  setActiveProfile, scoped to the project's own sessions; the derived/
   *  spawn sessions among them carry no state block, and refreshing them is a
   *  harmless no-op. */
  async refreshProjectSessions(projectId: string): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      if (getConversationProjectId(sessionId) !== projectId) continue
      await this.refreshOptions(sessionId).catch((err) => {
        console.warn('[AgentSession] project update: refresh failed', sessionId, err)
      })
    }
  }

  /** Map engine callbacks onto protocol session events. */
  private makeCallbacks(sessionId: string) {
    return {
      onMessagesChanged: (messages: AgentMessage[]) => this.emitMessages(sessionId, messages),
      onStatusChanged: (status: AgentStatus) => {
        // 运行期间阻止系统休眠：每个托管会话的状态变化都过这里，working 状态
        // 持有 powerSaveBlocker，停靠/终态释放（见 system/keep-awake.ts）。
        keepAwake.update(sessionId, status.status)
        this.emit(sessionId, {
          type: 'status',
          // The word plus its optional carriers (error reason / retry count,
          // delay and message) — statusSnapshotOf is the same projection the
          // snapshot makes, so a re-attach sees exactly what the event said.
          ...statusSnapshotOf(status),
          // Held tools ride along on the two "the user must decide" statuses so
          // a remote client (browser extension) can render confirmation cards
          // without holding engine internals. args ships in full only for the
          // small interactive payloads (ask_user prompt/choices).
          ...((status.status === 'awaiting_approval' || status.status === 'awaiting_user_input') && 'tools' in status
            ? { tools: status.tools.map((t): StatusToolInfo => ({
                toolUseId: t.id,
                name: t.name,
                detail: JSON.stringify(t.input ?? {}).slice(0, 200),
                ...(t.name === 'ask_user' ? { args: t.input } : {}),
              })) }
            : {}),
        })
      },
      onStreamingBlocksChanged: (blocks: ContentBlock[]) => this.emit(sessionId, { type: 'streaming_blocks', blocks: blocks as unknown[] }),
      onPlanChanged: (plan: Plan | null) => this.emit(sessionId, { type: 'plan_update', plan }),
      onFileChangesChanged: (changes: SessionFileChange[]) => this.emit(sessionId, { type: 'file_changes', changes }),
      onCompaction: (event: CompactionEvent) => this.emit(sessionId, { type: 'compaction', event }),
    }
  }
}

export const agentSessionManager = new AgentSessionManagerImpl()
