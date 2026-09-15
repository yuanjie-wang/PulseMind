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
import { updateConversationOrigin, setConversationProject, getConversationProjectId, getConversationExpertId, getConversationApprovalMode, setConversationApprovalMode, deriveConvType } from '../storage/conversation.db'
import { resolveConversationWorkspace } from '../storage/conversation-workspace'
import { projectStore } from '../storage/project-store'
import { expertStore } from '../storage/expert-store'
import { serverManager } from '../mcp/MCPServerManager'
import { getKnowledgeFilesByIds } from '../storage/knowledge.db'
import { composeExpertInstructions, toExpertRefCatalogs, type ExpertRefCatalogs } from '../../shared/expert-context'
import type { ExpertRuntimeContext } from '../../shared/types/expert'
import { sessionSandbox, type SessionSandboxContext } from '../sandbox/session-context'
import { agentClientRegistry } from './client-registry'
import { pickApprovalMode } from '../../shared/sandbox/policy'
import type { SandboxApprovalMode } from '../../shared/sandbox/policy'
import { DEFAULT_PROJECT_ID } from '../../shared/types/project'
import type { AppSettings, LlmProfile } from '../../shared/types/settings'
import { getBundledRipgrepPath, getPlatformName } from '../services/platform-info'
import type { AgentEventData, PlanSnapshot, AgentSessionCreateOptions, PageContext, StatusToolInfo, ModelState } from '../../shared/agent-protocol'
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
    /** Approval mode the session's creator demanded (derived sessions run
     *  unattended). Set = nothing else can change it, ever. */
    approvalOverride?: SandboxApprovalMode
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

  /** Approval precedence, in one place: an explicit per-session override (derived
   *  sessions run unattended) > the conversation's own stored choice (the
   *  composer's 授权 button writes it, as does the panel's) > DEFAULT_APPROVAL_MODE.
   *  Re-read per call, so changing the level takes effect on the conversation's
   *  next message. */
  private effectiveApprovalMode(sessionId: string, entry: SessionEntry): SandboxApprovalMode {
    return pickApprovalMode(entry.pinned.approvalOverride, getConversationApprovalMode(sessionId))
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
          )
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
        await this.syncFeatureToggles(this.managers, await settingsStore.get())
        return this.managers
      })()
    }
    return this.managersPromise
  }

  /** Mirror the 设置 → 记忆/经验 master switches onto the shared managers.
   *  memoryEnabled maps onto MemoryPreferences (auto capture + prompt injection);
   *  experienceEnabled onto ExperienceManager's own flag. */
  private syncFeatureToggles(managers: Managers, settings: AppSettings): void {
    const memoryOn = settings.memoryEnabled ?? true
    managers.memoryManager.setPreferences({ autoCaptureEnabled: memoryOn, autoInjectEnabled: memoryOn })
    managers.experienceManager.setEnabled(settings.experienceEnabled ?? true)
  }

  /** Re-apply the master switches after a settings save (settings.handler). */
  async applyFeatureToggles(settings: AppSettings): Promise<void> {
    const managers = await this.ensureManagers()
    this.syncFeatureToggles(managers, settings)
  }

  /** Resolve the active LLM profile from settings (falls back to first profile). */
  private async resolveProfile(): Promise<LlmProfile> {
    const settings = await settingsStore.get()
    const profile = settings.profiles.find((p) => p.id === settings.activeProfileId) ?? settings.profiles[0]
    if (!profile) throw new Error('未配置 LLM Profile,请先在设置中添加')
    return profile
  }

  /** The selectable models for the remote 模型下拉. Deliberately narrowed to
   *  what a client needs to render the list: the profile's credentials and
   *  endpoint never go on the wire. */
  async modelState(): Promise<ModelState> {
    const settings = await settingsStore.get()
    const active = settings.profiles.find((p) => p.id === settings.activeProfileId) ?? settings.profiles[0]
    return {
      profiles: settings.profiles.map((p) => ({ id: p.id, name: p.name, provider: p.provider, model: p.model })),
      activeId: active?.id ?? '',
    }
  }

  /** Switch the active model. Global, like the desktop's own picker (`settings.activeProfileId`),
   *  so after writing it the live sessions are hot-swapped here: the desktop
   *  renderer only refreshes when *it* changed the setting, and without this
   *  sweep a panel-side switch would not reach a session's next message. */
  async setActiveProfile(profileId: string): Promise<ModelState> {
    const settings = await settingsStore.get()
    const profile = settings.profiles.find((p) => p.id === profileId)
    if (!profile) throw new Error(`unknown profile: ${profileId}`)
    if (settings.activeProfileId !== profile.id) {
      await settingsStore.set({ ...settings, activeProfileId: profile.id })
    }
    for (const sessionId of this.sessions.keys()) {
      await this.refreshOptions(sessionId).catch((err) => {
        console.warn('[AgentSession] model switch: refresh failed', sessionId, err)
      })
    }
    return this.modelState()
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
    await this.refreshOptions(sessionId).catch((err) => {
      console.warn('[AgentSession] approval switch: refresh failed', sessionId, err)
    })
    // The answer is the level in force afterwards, not the one that was asked
    // for: for a pinned session those differ, and the caller must not be told
    // its click took when the run kept its own level.
    const entry = this.sessions.get(sessionId)
    return entry ? this.effectiveApprovalMode(sessionId, entry) : mode
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
    const profile = await this.resolveProfile()
    // Local UI conversations resolve their working directory here (PLAN-0.4.0
    // M8): project-bound ones use the project's fixed workspace, plain ones get
    // a lazily-created timestamped folder under the global workspace. Canvas /
    // spawn ids and callers with an explicit workspaceDir keep the old fallback.
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
    // Approval precedence: an explicit per-session override (derived sessions
    // run unattended) > the conversation's own stored choice > the shared
    // default for a conversation that never chose (按需确认).
    const approvalMode = pickApprovalMode(opts.approvalMode, getConversationApprovalMode(sessionId))

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
      skillsDir: SKILLS_DIR,
      approvalMode,
      locale: settings.locale === 'en' ? 'en' : 'zh',
      // A derived session (prompt override) is not a user conversation: its
      // transcript must not feed the memory/experience pipeline.
      hooks: opts.systemPromptOverride ? undefined : this.buildHooks(profile, managers, sessionId),
      conversationId: sessionId,
      systemPromptOverride: opts.systemPromptOverride,
      allowedTools: opts.allowedTools,
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
        // Only an explicit request pins the approval mode; an ordinary session
        // keeps following its conversation's own choice — see
        // refreshConversationApproval.
        approvalOverride: opts.approvalMode,
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

  /** Re-resolve the session's @-summoned expert config pack from the
   *  conversation's expert_id binding. Runs at session creation and before
   *  every ask (next to refreshConversationApproval) so @ switches and unbinds take
   *  effect immediately; a deleted/disabled expert falls back to an ordinary
   *  session. engine.applyExpertContext invalidates the system-prompt cache
   *  when the expert changed. Derived prompt sessions (tool studio etc.) keep
   *  their pinned override — an expert never applies to them. */
  private async refreshExpertContext(sessionId: string, entry: SessionEntry): Promise<void> {
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
   *  and lands in the prompt's dynamic (non-cached) Current Page section. */
  async ask(sessionId: string, content: string, pageContext?: PageContext): Promise<void> {
    const entry = await this.ensureEntry(sessionId)
    this.refreshConversationApproval(sessionId, entry)
    await this.refreshExpertContext(sessionId, entry)
    entry.engine.opts.pageContext = pageContext
    // Whether page_* tools are on this session's toolset at all: a browser
    // client is connected for it (tool-collection.ts reads this flag). Checked
    // per ask because the binding can come and go with the connection.
    entry.engine.opts.hostedAvailable = agentClientRegistry.isHostedCapable(sessionId)
    if (this.runningLoops >= MAX_CONCURRENT_LOOPS) {
      this.emit(sessionId, { type: 'status', status: 'queued', attempt: this.waitingLoops.length + 1 })
      await new Promise<void>((resolve) => this.waitingLoops.push(resolve))
    }
    this.runningLoops += 1
    const sandboxCtx = this.sandboxContexts.get(sessionId)
    const startLoop = () => entry.engine.startLoop(content)
    void (sandboxCtx ? sessionSandbox.run(sandboxCtx, startLoop) : startLoop())
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
      case 'stopExecution': return engine.stopExecution()
      case 'resumeExecution': return engine.resumeExecution()
      case 'clearError': return engine.clearError()
      case 'retryLastTurn': return engine.retryLastTurn()
      case 'getHistorySummary': return engine.getHistorySummary()
      case 'reset': entry.engine.reset(); return undefined
      case 'dispose': entry.engine.dispose(); this.sessions.delete(sessionId); this.lastSentLen.delete(sessionId); this.sandboxContexts.delete(sessionId); return undefined
      default: throw new Error(`engine method not allowed: ${method}`)
    }
  }

  /** Rebuild engine options from current settings/profile and hot-swap them.
   *  Per-session pins (workspace, approval mode, prompt/tool overrides) survive:
   *  a settings change must not move a session off its working directory, flip
   *  its approval mode, or widen a derived session's toolset mid-run. */
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
      workspaceDir: this.sandboxContexts.get(sessionId)?.workspaceDir ?? settings.workspaceDir ?? WORKSPACE_DIR,
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
      // Re-bound here too: a client can disconnect and reconnect between two
      // refreshes, and updateOptions replaces the bag wholesale.
      hostedAvailable: agentClientRegistry.isHostedCapable(sessionId),
    })
  }

  /** Map engine callbacks onto protocol session events. */
  private makeCallbacks(sessionId: string) {
    return {
      onMessagesChanged: (messages: AgentMessage[]) => this.emitMessages(sessionId, messages),
      onStatusChanged: (status: AgentStatus) => this.emit(sessionId, {
        type: 'status',
        status: status.status,
        // Loop failures carry their reason ({ status: 'error', error } —
        // renderer types/agent.ts); unattended consumers settle on this.
        ...(status.status === 'error' ? { error: status.error } : {}),
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
      }),
      onStreamingBlocksChanged: (blocks: ContentBlock[]) => this.emit(sessionId, { type: 'streaming_blocks', blocks: blocks as unknown[] }),
      onPlanChanged: (plan: Plan | null) => this.emit(sessionId, { type: 'plan_update', plan: plan as unknown as PlanSnapshot | null }),
    }
  }
}

export const agentSessionManager = new AgentSessionManagerImpl()
