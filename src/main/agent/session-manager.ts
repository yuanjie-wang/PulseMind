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
import { settingsStore } from '../storage/settings-store'
import { toolPreferencesStore } from '../storage/tool-preferences-store'
import { skillStore } from '../storage/skill-store'
import { SKILLS_DIR, WORKSPACE_DIR } from '../storage'
import { updateConversationOrigin, setConversationProject, getConversationProjectId, getConversationExpertId, getConversationApprovalMode, setConversationApprovalMode, getConversationProfileId, setConversationProfile, deriveConvType } from '../storage/conversation.db'
import { resolveConversationWorkspace } from '../storage/conversation-workspace'
import { projectStore } from '../storage/project-store'
import { expertStore } from '../storage/expert-store'
import { serverManager } from '../mcp/MCPServerManager'
import { getKnowledgeFilesByIds } from '../storage/knowledge.db'
import { composeExpertInstructions, normalizeSummonedExperts, toExpertRefCatalogs, type ExpertRefCatalogs } from '../../shared/expert-context'
import type { SummonedExpert } from '../../shared/expert-context'
import type { ExpertProfile, ExpertRuntimeContext } from '../../shared/types/expert'
import { sessionSandbox, type SessionSandboxContext } from '../sandbox/session-context'
import { agentClientRegistry } from './client-registry'
import { diffMessageStats, messageStatsSignature } from '../../shared/agent-session/message-stats'
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
import type { AgentEventData, PlanSnapshot, AgentSessionCreateOptions, PageContext, StatusToolInfo, StatusSnapshot, ModelState, CompactionEvent } from '../../shared/agent-protocol'
import type { HooksConfig } from '../../renderer/src/types/hooks'

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
 *  carries (`error`'s reason; `retrying`'s count, delay and message). */
function statusSnapshotOf(status: AgentStatus): StatusSnapshot {
  return {
    status: status.status,
    ...(status.status === 'error' ? { error: status.error } : {}),
    ...(status.status === 'retrying'
      ? { attempt: status.attempt, maxRetries: status.maxRetries, delayMs: status.delay, message: status.message }
      : {}),
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

  /** Subscribe to session events (the IPC bridge forwards these to renderers). */
  onEvent(sink: SessionEventSink): () => void {
    this.eventSinks.add(sink)
    return () => this.eventSinks.delete(sink)
  }

  private emit(sessionId: string, data: AgentEventData): void {
    for (const sink of this.eventSinks) sink(sessionId, data)
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
    const updates: Array<{ messageId: string; toolUseId: string; status?: string; exitCode?: number; output?: string; subConvId?: string; planNodeId?: string }> = []
    for (const msg of messages) {
      for (const block of msg.contentBlocks ?? []) {
        if (block.type !== 'tool_use') continue
        const tu = block as { id?: string; status?: string; exitCode?: number; output?: string; subConvId?: string; planNodeId?: string }
        const key = `${msg.id}:${tu.id ?? ''}`
        const output = typeof tu.output === 'string' ? tu.output : undefined
        const cappedOutput = output && output.length > 200_000 ? output.slice(0, 200_000) : output
        const signature = `${tu.status ?? ''}|${tu.exitCode ?? ''}|${cappedOutput ? cappedOutput.length : 0}|${cappedOutput ? cappedOutput.slice(-80) : ''}|${tu.subConvId ?? ''}|${tu.planNodeId ?? ''}`
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
    if (updates.length > 0) this.emit(sessionId, { type: 'message_stats', updates })
  }

  /** Port of App.tsx afterSession hook: auto-capture memories + experience. */
  private buildHooks(
    profile: LlmProfile,
    managers: Managers,
    sessionId: string,
  ): HooksConfig {
    return {
      afterSession: (ctx) => {
        void (async () => {
          // Master switches (设置 → 记忆/经验) are read at session end, so a
          // toggle takes effect on the next session without touching engines.
          const settings = await settingsStore.get()
          const memoryOn = settings.memoryEnabled ?? true
          const experienceOn = settings.experienceEnabled ?? true
          if (!memoryOn && !experienceOn) return

          const llmConfig = { adapter: createLlmAdapter(profile.provider ?? 'anthropic'), apiKey: profile.apiKey ?? '', baseURL: profile.baseURL, model: profile.model }
          const messages = ctx.messages.filter((m) => m.contentBlocks?.some((b) => b.type === 'text'))
          if (messages.length === 0) return
          // Fire-and-forget — single LLM call extracts memories + experience.
          const result = await managers.memoryManager.extractAndSaveAll(
            messages, profile.apiKey ?? '', profile.baseURL, createLlmAdapter(profile.provider ?? 'anthropic'),
            profile.model, sessionId, undefined, { memory: memoryOn, experience: experienceOn },
            // minDelta=4 (PLAN-memory-extraction-dedup): same contract as the
            // desktop hook — a thin delta waits, accumulates, extracts once.
            { minDelta: 4 },
          )
          if (result.memories > 0) console.log(`[SessionReview] Saved ${result.memories} memory/ies`)
          // extractAndSaveAll may have run the incremental merge — advance
          // settings.json's watermark so a restart doesn't re-merge.
          await this.runMemoryMergeSweep().catch((e) => console.warn('[SessionReview] merge sweep failed:', e))
          if (result.experienceContent) {
            managers.experienceManager.save({
              title: result.experienceTitle ?? 'Untitled experience',
              description: result.experienceContent.slice(0, 120),
              content: result.experienceContent,
              category: result.experienceCategory ?? 'general',
              sourceConversationId: sessionId,
            }).then(({ record }) => {
              managers.experienceManager.ensureTriggers(record.name, llmConfig).catch((err: unknown) =>
                console.warn('[SessionReview] Trigger extraction failed:', err))
            }).catch((err: unknown) => console.warn('[SessionReview] Failed to save experience:', err))
          }
        })().catch((err) => console.warn('[SessionReview] extraction failed:', err))
      },
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
        const startupSettings = await settingsStore.get()
        await this.syncFeatureToggles(this.managers, startupSettings)
        this.syncRunLimits(startupSettings)
        this.seedMergeWatermark(this.managers.memoryManager, startupSettings)
        // P2 (PLAN-memory-extraction-dedup): the merge layer's own sweep — a
        // few minutes after startup so first paint never waits on an LLM call.
        // Also runs from extractAndSaveAll (turn ends); the watermark keeps
        // both entry points honest about "what changed since the last merge".
        setTimeout(() => {
          void this.runMemoryMergeSweep().catch((e) => console.warn('[session-manager] memory merge failed:', e))
        }, 3 * 60 * 1000).unref?.()
        return this.managers
      })()
    }
    return this.managersPromise
  }

  /** Seed the merge watermark from settings.json onto the manager instance. */
  private seedMergeWatermark(memoryManager: MemoryManager, settings: AppSettings): void {
    const w = settings.memoryMergeWatermark
    memoryManager.setMergeWatermark({
      lastRunAt: w?.lastRunAt ? new Date(w.lastRunAt).getTime() : 0,
      lastCount: w?.lastCount ?? 0,
    })
  }

  /** Run the incremental memory merge (if due) and persist the watermark.
   *  Both the delayed startup sweep and the afterSession path land here, so
   *  settings.json is written by exactly one shape. */
  async runMemoryMergeSweep(): Promise<boolean> {
    if (!this.managers) return false
    const memoryManager = this.managers.memoryManager
    const ran = await memoryManager.ensureMemoryMerged()
    const w = memoryManager.getMergeWatermark()
    if (w.lastRunAt === 0) return ran // never merged — nothing to persist
    await settingsStore.update((s) => ({
      ...s,
      memoryMergeWatermark: { lastRunAt: new Date(w.lastRunAt).toISOString(), lastCount: w.lastCount },
    })).catch((e) => console.warn('[session-manager] watermark persist failed:', e))
    return ran
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
    const managers = await this.ensureManagers()
    this.syncFeatureToggles(managers, settings)
    this.syncRunLimits(settings)
  }

  /** Resolve the LLM profile to run a session with: `preferredId` (a
   *  create-time pin, e.g. a routine's model choice) when it still resolves,
   *  otherwise the active profile. Falls back to first profile. */
  private async resolveProfile(preferredId?: string): Promise<LlmProfile> {
    const settings = await settingsStore.get()
    const profile = (preferredId ? settings.profiles.find((p) => p.id === preferredId) : undefined)
      ?? settings.profiles.find((p) => p.id === settings.activeProfileId)
      ?? settings.profiles[0]
    if (!profile) throw new Error('未配置 LLM Profile,请先在设置中添加')
    return profile
  }

  /** The selectable models for a 模型下拉. Deliberately narrowed to what a
   *  client needs to render the list: the profile's credentials and endpoint
   *  never go on the wire. With `sessionId` the active id is that session's
   *  effective model (its own choice under the create-time pin); without one
   *  it is the global default the unpinned conversations follow. */
  async modelState(sessionId?: string): Promise<ModelState> {
    const settings = await settingsStore.get()
    const ownId = sessionId
      ? (this.sessions.get(sessionId)?.pinned.profileId ?? getConversationProfileId(sessionId))
      : undefined
    const active = (ownId ? settings.profiles.find((p) => p.id === ownId) : undefined)
      ?? settings.profiles.find((p) => p.id === settings.activeProfileId)
      ?? settings.profiles[0]
    return {
      profiles: settings.profiles.map((p) => ({ id: p.id, name: p.name, provider: p.provider, model: p.model })),
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

  /** Drop a creation-time approval pin once its unattended window is over —
   *  the routine runner calls this when a run settles, so post-run
   *  continuations in the run transcript follow the conversation's own stored
   *  choice (the 授权 button's column) instead of the run's frozen unattended
   *  default. The pin exists to keep a run nobody is watching from widening;
   *  a finished run has no such window left to protect. */
  releaseApprovalPin(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.pinned.approvalOverride === undefined) return
    entry.pinned.approvalOverride = undefined
    entry.engine.opts.approvalMode = this.effectiveApprovalMode(sessionId, entry)
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
      hooks: opts.systemPromptOverride ? undefined : this.buildHooks(profile, managers, sessionId),
      conversationId: sessionId,
      systemPromptOverride: opts.systemPromptOverride,
      allowedTools: opts.allowedTools,
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
      },
    })
    // Per-session sandbox context: wrapped around every tool-executing entry
    // point (ask / engineCall) so the file-ops and terminal services can
    // adjudicate against the right workspace (PLAN-0.4.0 M3.5).
    this.sandboxContexts.set(sessionId, { sessionId, workspaceDir })
    try { updateConversationOrigin(sessionId, opts.clientId ?? 'local') } catch { /* origin is best-effort */ }
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
          const knowledgeFiles = getKnowledgeFilesByIds(profile.knowledgeFileIds || []).map((f) => {
            let wikiPages: string[] = []
            try { wikiPages = f.wiki_outputs ? JSON.parse(f.wiki_outputs) : [] } catch { /* uncompiled */ }
            return { id: f.id, title: f.title || f.file_path, filePath: f.file_path, wikiPages }
          })
          next = {
            id: profile.id,
            name: profile.name,
            instructions: composeExpertInstructions(profile, knowledgeFiles, this.resolveExpertRefCatalogs()),
            knowledgeFiles,
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
   *  scope; null (no mention) unscopes. */
  async ask(
    sessionId: string,
    content: string,
    pageContext?: PageContext,
    summon?: SummonedExpert[],
    knowledgeBase?: { id: string; name: string } | null,
  ): Promise<void> {
    const entry = await this.ensureEntry(sessionId)
    this.refreshConversationApproval(sessionId, entry)
    await this.refreshExpertContext(sessionId, entry)
    entry.engine.opts.pageContext = pageContext
    entry.engine.setKnowledgeBaseScope(knowledgeBase ?? null)
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
    messages: AgentMessage[]; status: StatusSnapshot; streamingBlocks: unknown[]; plan: PlanSnapshot | null
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
    }
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
      case 'approveTool': return engine.approveTool(args[0] as string)
      case 'rejectTool': return engine.rejectTool(args[0] as string)
      case 'killTool': return engine.killTool(args[0] as string)
      case 'respondToTool': return engine.respondToTool(args[0] as string, args[1] as string)
      case 'extendLoop': return engine.extendLoop()
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
      case 'compactNow': return engine.compactNow(args[0] as string | undefined)
      case 'reset': entry.engine.reset(); return undefined
      case 'dispose':
        entry.engine.dispose()
        this.sessions.delete(sessionId)
        this.lastSentLen.delete(sessionId)
        this.messageContentRegistry.delete(sessionId)
        this.toolStatusRegistry.delete(sessionId)
        this.messageStatsRegistry.delete(sessionId)
        this.sandboxContexts.delete(sessionId)
        // The disposed engine's last status may still read executing (dispose
        // itself can notify), and no further event will ever arrive for this
        // id — forget it explicitly or the wake lock pins forever.
        keepAwake.forgetSession(sessionId)
        return undefined
      default: throw new Error(`engine method not allowed: ${method}`)
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
      // updateOptions replaces the option bag wholesale — re-attach the pins
      // (and the session-review hooks, which the refresh used to drop).
      hooks: entry.pinned.systemPromptOverride ? undefined : this.buildHooks(profile, managers, sessionId),
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
      onCompaction: (event: CompactionEvent) => this.emit(sessionId, { type: 'compaction', event }),
    }
  }
}

export const agentSessionManager = new AgentSessionManagerImpl()
