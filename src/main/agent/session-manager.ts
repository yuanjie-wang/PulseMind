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
import type { LlmProfile } from '../../shared/types/settings'
import { getBundledRipgrepPath, getPlatformName } from '../ipc/app.handler'
import type { AgentEventData, PlanSnapshot } from '../../shared/agent-protocol'

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
}

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
  private managersPromise: Promise<Managers> | null = null
  private managers: Managers | null = null
  private eventSinks = new Set<SessionEventSink>()

  /** Subscribe to session events (the IPC bridge forwards these to renderers). */
  onEvent(sink: SessionEventSink): () => void {
    this.eventSinks.add(sink)
    return () => this.eventSinks.delete(sink)
  }

  private emit(sessionId: string, data: AgentEventData): void {
    for (const sink of this.eventSinks) sink(sessionId, data)
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

  async createSession(sessionId: string, opts: { agentId?: string; title?: string } = {}): Promise<{ sessionId: string; agentId: string }> {
    if (this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId)!
      return { sessionId, agentId: existing.agentId }
    }
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
      conversationId: sessionId,
    }
    const engine = new AgentEngine(engineOptions, this.makeCallbacks(sessionId))
    this.sessions.set(sessionId, { engine, agentId: opts.agentId ?? 'default', title: opts.title, createdAt: new Date().toISOString() })
    return { sessionId, agentId: opts.agentId ?? 'default' }
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** Kick off an agent loop; progress arrives as session events. */
  async ask(sessionId: string, content: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) throw new Error(`session not found: ${sessionId}`)
    void entry.engine.startLoop(content).catch((err) => {
      this.emit(sessionId, { type: 'error', message: err instanceof Error ? err.message : String(err) })
    })
  }

  cancel(sessionId: string): void {
    this.sessions.get(sessionId)?.engine.cancelLoop()
  }

  history(sessionId: string): { messages: unknown[]; agentId: string } {
    const entry = this.sessions.get(sessionId)
    if (!entry) throw new Error(`session not found: ${sessionId}`)
    return { messages: entry.engine.messages as unknown[], agentId: entry.agentId }
  }

  /** Map engine callbacks onto protocol session events. */
  private makeCallbacks(sessionId: string) {
    return {
      onMessagesChanged: (messages: AgentMessage[]) => this.emit(sessionId, { type: 'messages', messages: messages as unknown[] }),
      onStatusChanged: (status: AgentStatus) => this.emit(sessionId, { type: 'status', status: status.status }),
      onStreamingBlocksChanged: (blocks: ContentBlock[]) => this.emit(sessionId, { type: 'streaming_blocks', blocks: blocks as unknown[] }),
      onPlanChanged: (plan: Plan | null) => this.emit(sessionId, { type: 'plan_update', plan: plan as unknown as PlanSnapshot | null }),
    }
  }
}

export const agentSessionManager = new AgentSessionManagerImpl()
