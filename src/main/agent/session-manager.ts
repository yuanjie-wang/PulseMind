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
import type { PlatformInfo } from '../../renderer/src/types/electron'
import { setHost } from '../../renderer/src/agent/host'
import { mainHost } from './main-host'
import { settingsStore } from '../storage/settings-store'
import { toolPreferencesStore } from '../storage/tool-preferences-store'
import { skillStore } from '../storage/skill-store'
import { SKILLS_DIR, WORKSPACE_DIR } from '../storage'
import { updateConversationOrigin } from '../storage/conversation.db'
import type { LlmProfile } from '../../shared/types/settings'
import { getBundledRipgrepPath, getPlatformName } from '../services/platform-info'
import type { AgentEventData, PlanSnapshot } from '../../shared/agent-protocol'
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
}

/** Global concurrency guard (M2.2): at most N agent loops run at once;
 *  extra asks queue FIFO and start in arrival order. */
const MAX_CONCURRENT_LOOPS = 2

type SessionEventSink = (sessionId: string, data: AgentEventData) => void

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

class AgentSessionManagerImpl {
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
  private waitingLoops: Array<() => void> = []
  /** Per-session registry of tool_use runtime state (status|exitCode|outputLen) for in-place diffing. */
  private toolStatusRegistry = new Map<string, Map<string, string>>()

  /** Subscribe to session events (the IPC bridge forwards these to renderers). */
  onEvent(sink: SessionEventSink): () => void {
    this.eventSinks.add(sink)
    return () => this.eventSinks.delete(sink)
  }

  private emit(sessionId: string, data: AgentEventData): void {
    for (const sink of this.eventSinks) sink(sessionId, data)
  }

  private emitMessages(sessionId: string, messages: AgentMessage[]): void {
    const lastLen = this.lastSentLen.get(sessionId) ?? 0
    if (messages.length >= lastLen) {
      const items = messages.slice(lastLen)
      // A zero-item append is a no-op for an up-to-date client, but a client
      // whose mirror is ahead of `lastLen` (it hydrated optimistically before
      // this session existed) would apply it as a truncation to empty and tear
      // its view down. Nothing to append means nothing to send.
      if (items.length > 0) {
        this.emit(sessionId, { type: 'messages_append', fromIndex: lastLen, items: items as unknown[] })
      }
    } else {
      // Truncation (regeneration/compaction) — ship the full list.
      this.emit(sessionId, { type: 'messages', messages: messages as unknown[] })
      this.toolStatusRegistry.delete(sessionId)
    }
    this.lastSentLen.set(sessionId, messages.length)
    this.emitToolStatusDiff(sessionId, messages)
  }

  /**
   * tool_use blocks mutate IN PLACE (pending → running → completed, exitCode,
   * terminal output) without changing the messages array length. Diff each
   * block's runtime signature and ship only the changed entries so the
   * renderer's mirror reflects approvals/progress/completion.
   */
  private emitToolStatusDiff(sessionId: string, messages: AgentMessage[]): void {
    const registry = this.toolStatusRegistry.get(sessionId) ?? new Map<string, string>()
    const updates: Array<{ messageId: string; toolUseId: string; status?: string; exitCode?: number; output?: string }> = []
    for (const msg of messages) {
      for (const block of msg.contentBlocks ?? []) {
        if (block.type !== 'tool_use') continue
        const tu = block as { id?: string; status?: string; exitCode?: number; output?: string }
        const key = `${msg.id}:${tu.id ?? ''}`
        const output = typeof tu.output === 'string' ? tu.output : undefined
        const cappedOutput = output && output.length > 200_000 ? output.slice(0, 200_000) : output
        const signature = `${tu.status ?? ''}|${tu.exitCode ?? ''}|${cappedOutput ? cappedOutput.length : 0}|${cappedOutput ? cappedOutput.slice(-80) : ''}`
        if (registry.get(key) === signature) continue
        registry.set(key, signature)
        updates.push({
          messageId: msg.id,
          toolUseId: tu.id ?? '',
          status: tu.status,
          exitCode: tu.exitCode,
          output: cappedOutput,
        })
      }
    }
    if (registry.size > 4000) registry.clear() // runaway guard for very long sessions
    this.toolStatusRegistry.set(sessionId, registry)
    if (updates.length > 0) this.emit(sessionId, { type: 'tool_status', updates })
  }

  /** Port of App.tsx afterSession hook: auto-capture memories + experience. */
  private buildHooks(
    profile: LlmProfile,
    managers: Managers,
    sessionId: string,
  ): HooksConfig {
    return {
      afterSession: (ctx) => {
        const llmConfig = { adapter: createLlmAdapter(profile.provider ?? 'anthropic'), apiKey: profile.apiKey ?? '', baseURL: profile.baseURL, model: profile.model }
        const messages = ctx.messages.filter((m) => m.contentBlocks?.some((b) => b.type === 'text'))
        if (messages.length === 0) return
        // Fire-and-forget — single LLM call extracts memories + experience.
        managers.memoryManager.extractAndSaveAll(
          messages, profile.apiKey ?? '', profile.baseURL, createLlmAdapter(profile.provider ?? 'anthropic'),
          profile.model, sessionId, undefined,
        ).then((result) => {
          if (result.memories > 0) console.log(`[SessionReview] Saved ${result.memories} memory/ies`)
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
        }).catch((err) => console.warn('[SessionReview] extraction failed:', err))
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
        return this.managers
      })()
    }
    return this.managersPromise
  }

  /** Resolve the active LLM profile from settings (falls back to first profile). */
  private async resolveProfile(): Promise<LlmProfile> {
    const settings = await settingsStore.get()
    const profile = settings.profiles.find((p) => p.id === settings.activeProfileId) ?? settings.profiles[0]
    if (!profile) throw new Error('未配置 LLM Profile,请先在设置中添加')
    return profile
  }

  async createSession(sessionId: string, opts: { agentId?: string; title?: string; clientId?: string } = {}): Promise<{ sessionId: string; agentId: string }> {
    if (this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId)!
      return { sessionId, agentId: existing.agentId }
    }
    const pending = this.pendingCreates.get(sessionId)
    if (pending) {
      await pending
      return { sessionId, agentId: this.sessions.get(sessionId)!.agentId }
    }
    const creation = this.doCreateSession(sessionId, opts)
    this.pendingCreates.set(sessionId, creation)
    creation.then(() => {}, () => {})
    try {
      await creation
    } finally {
      this.pendingCreates.delete(sessionId)
    }
    return { sessionId, agentId: this.sessions.get(sessionId)!.agentId }
  }

  /** Wait for an in-flight creation, then return the entry (throws if absent). */
  private async ensureEntry(sessionId: string): Promise<SessionEntry> {
    const pending = this.pendingCreates.get(sessionId)
    if (pending) await pending
    const entry = this.sessions.get(sessionId)
    if (!entry) throw new Error(`session not found: ${sessionId}`)
    return entry
  }

  private async doCreateSession(sessionId: string, opts: { agentId?: string; title?: string; clientId?: string }): Promise<void> {
    const managers = await this.ensureManagers()
    const settings = await settingsStore.get()
    const profile = await this.resolveProfile()

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
      workspaceDir: settings.workspaceDir ?? WORKSPACE_DIR,
      skillsDir: SKILLS_DIR,
      yoloMode: settings.yoloMode ?? false,
      locale: settings.locale === 'en' ? 'en' : 'zh',
      hooks: this.buildHooks(profile, managers, sessionId),
      conversationId: sessionId,
    }
    const engine = new AgentEngine(engineOptions, this.makeCallbacks(sessionId))
    this.lastSentLen.set(sessionId, 0)
    this.sessions.set(sessionId, {
      engine,
      agentId: opts.agentId ?? 'default',
      title: opts.title,
      createdAt: new Date().toISOString(),
      clientId: opts.clientId ?? 'local',
    })
    try { updateConversationOrigin(sessionId, opts.clientId ?? 'local') } catch { /* origin is best-effort */ }
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** Kick off an agent loop; progress arrives as session events. Requests
   *  beyond the global concurrency cap queue FIFO. */
  async ask(sessionId: string, content: string): Promise<void> {
    const entry = await this.ensureEntry(sessionId)
    if (this.runningLoops >= MAX_CONCURRENT_LOOPS) {
      this.emit(sessionId, { type: 'status', status: 'queued', attempt: this.waitingLoops.length + 1 })
      await new Promise<void>((resolve) => this.waitingLoops.push(resolve))
    }
    this.runningLoops += 1
    void entry.engine.startLoop(content)
      .catch((err) => {
        this.emit(sessionId, { type: 'error', message: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        this.runningLoops -= 1
        this.waitingLoops.shift()?.()
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
  }

  /** UI snapshot for (re)activating a session. */
  async snapshot(sessionId: string): Promise<{
    messages: AgentMessage[]; status: { status: string }; streamingBlocks: unknown[]; plan: PlanSnapshot | null
  } | null> {
    if (!this.sessions.has(sessionId) && !this.pendingCreates.has(sessionId)) return null
    const entry = await this.ensureEntry(sessionId).catch(() => null)
    if (!entry) return null
    return {
      messages: entry.engine.messages,
      status: { status: entry.engine.agentStatus.status },
      streamingBlocks: entry.engine.streamingBlocks as unknown[],
      plan: (entry.engine.plan as unknown as PlanSnapshot | null) ?? null,
    }
  }

  /** Whitelisted engine method calls from the renderer (approvals, loop control…). */
  async engineCall(sessionId: string, method: string, args: unknown[]): Promise<unknown> {
    const entry = await this.ensureEntry(sessionId)
    const engine = entry.engine as unknown as Record<string, (...a: unknown[]) => unknown>
    switch (method) {
      case 'approveTool': return engine.approveTool(args[0] as string)
      case 'rejectTool': return engine.rejectTool(args[0] as string)
      case 'killTool': return engine.killTool(args[0] as string)
      case 'respondToTool': return engine.respondToTool(args[0] as string, args[1] as string)
      case 'extendLoop': return engine.extendLoop()
      case 'stopExecution': return engine.stopExecution()
      case 'resumeExecution': return engine.resumeExecution()
      case 'clearError': return engine.clearError()
      case 'retryLastTurn': return engine.retryLastTurn()
      case 'getHistorySummary': return engine.getHistorySummary()
      case 'reset': entry.engine.reset(); return undefined
      case 'dispose': entry.engine.dispose(); this.sessions.delete(sessionId); this.lastSentLen.delete(sessionId); return undefined
      default: throw new Error(`engine method not allowed: ${method}`)
    }
  }

  /** Rebuild engine options from current settings/profile and hot-swap them. */
  async refreshOptions(sessionId: string): Promise<void> {
    const entry = await this.ensureEntry(sessionId).catch(() => null)
    if (!entry) return
    const managers = await this.ensureManagers()
    const settings = await settingsStore.get()
    const profile = await this.resolveProfile()
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
      workspaceDir: settings.workspaceDir ?? WORKSPACE_DIR,
      skillsDir: SKILLS_DIR,
      yoloMode: settings.yoloMode ?? false,
      locale: settings.locale === 'en' ? 'en' : 'zh',
      conversationId: sessionId,
    })
  }

  /** Map engine callbacks onto protocol session events. */
  private makeCallbacks(sessionId: string) {
    return {
      onMessagesChanged: (messages: AgentMessage[]) => this.emitMessages(sessionId, messages),
      onStatusChanged: (status: AgentStatus) => this.emit(sessionId, { type: 'status', status: status.status }),
      onStreamingBlocksChanged: (blocks: ContentBlock[]) => this.emit(sessionId, { type: 'streaming_blocks', blocks: blocks as unknown[] }),
      onPlanChanged: (plan: Plan | null) => this.emit(sessionId, { type: 'plan_update', plan: plan as unknown as PlanSnapshot | null }),
    }
  }
}

export const agentSessionManager = new AgentSessionManagerImpl()
