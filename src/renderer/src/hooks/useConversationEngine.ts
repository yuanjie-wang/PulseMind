import { useEffect, useRef, useState, useCallback } from 'react'
import { AgentEngine, type AgentEngineOptions } from '../agent/AgentEngine'
import type { AgentMessage, AgentStatus, ContentBlock, Plan } from '../types/agent'
import type { LlmAdapter } from '../llm/adapter'
import type { ToolManager } from '../tools/ToolManager'
import type { SkillManager } from '../skills/SkillManager'
import type { MemoryManager } from '../memory/MemoryManager'
import type { KnowledgeManager } from '../knowledge/KnowledgeManager'
import type { PlatformInfo } from '../types/electron'
import type { HooksConfig } from '../types/hooks'

// ── Internal: tracking active loop convs ──

function isActiveStatus(status: AgentStatus): boolean {
  return status.status === 'streaming'
    || status.status === 'awaiting_approval'
    || status.status === 'awaiting_user_input'
    || status.status === 'executing'
    || status.status === 'awaiting_extension'
    || status.status === 'retrying'
}

// ── Hook ──

interface UseConversationEngineOptions {
  apiKey: string | null
  baseURL: string
  model: string
  maxTokens: number
  contextLength?: number
  adapter: LlmAdapter
  myName: string
  soul: string
  yourName: string
  workspaceDir?: string
  yoloMode?: boolean
  hooks?: HooksConfig
  locale?: 'zh' | 'en'
  // Injected managers
  toolManager: ToolManager
  skillManager: SkillManager
  memoryManager: MemoryManager
  knowledgeManager: KnowledgeManager
  skillsDir: string
  platformInfo: PlatformInfo | undefined
  /** Called when a non-active engine transitions to 'completed' status. */
  onBackgroundComplete?: (convId: string, engine: AgentEngine) => void
  /** Called when a tool/skill state changes (e.g. install_skill). */
  onSkillStateChange?: () => void
}

export function useConversationEngine(options: UseConversationEngineOptions) {
  const {
    toolManager, skillManager, memoryManager, knowledgeManager,
    skillsDir, platformInfo, onBackgroundComplete, onSkillStateChange, hooks
  } = options

  // ── Engine state ──
  const enginesRef = useRef<Map<string, AgentEngine>>(new Map())
  const activeEngineIdRef = useRef<string>('')
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({ status: 'idle' })
  const [streamingBlocks, setStreamingBlocks] = useState<ContentBlock[]>([])
  const [plan, setPlan] = useState<Plan | null>(null)
  const [activeLoopConvIds, setActiveLoopConvIds] = useState<string[]>([])
  const [retryingConvIds, setRetryingConvIds] = useState<string[]>([])

  // Stable ref for the background-complete callback so engine closures always read the latest
  const onBackgroundCompleteRef = useRef(onBackgroundComplete)
  onBackgroundCompleteRef.current = onBackgroundComplete

  /** Build engine options for a given conversation. */
  const buildEngineOptions = useCallback((convId: string): AgentEngineOptions => ({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    model: options.model,
    maxTokens: options.maxTokens,
    contextLength: options.contextLength,
    adapter: options.adapter,
    myName: options.myName,
    soul: options.soul,
    yourName: options.yourName,
    toolManager,
    skillManager,
    memoryManager,
    knowledgeManager,
    platformInfo: platformInfo || undefined,
    workspaceDir: options.workspaceDir,
    skillsDir,
    yoloMode: options.yoloMode ?? false,
    hooks,
    conversationId: convId,
    onSkillStateChange: onSkillStateChange || (() => {})
  }), [options, toolManager, skillManager, memoryManager, knowledgeManager, skillsDir, platformInfo, onSkillStateChange, hooks])

  /** Get or create an engine for a conversation. */
  const getOrCreateEngine = useCallback((convId: string): AgentEngine => {
    let engine = enginesRef.current.get(convId)
    if (!engine) {
      engine = new AgentEngine(buildEngineOptions(convId), {
        onMessagesChanged: (messages) => {
          if (activeEngineIdRef.current === convId) {
            setMessages([...messages])
          }
        },
        onStatusChanged: (status) => {
          setActiveLoopConvIds((prev) => {
            const isActive = isActiveStatus(status)
            const alreadyTracked = prev.includes(convId)
            if (isActive && !alreadyTracked) return [...prev, convId]
            if (!isActive && alreadyTracked) return prev.filter((id) => id !== convId)
            return prev
          })
          setRetryingConvIds((prev) => {
            const isRetrying = status.status === 'retrying'
            const alreadyTracked = prev.includes(convId)
            if (isRetrying && !alreadyTracked) return [...prev, convId]
            if (!isRetrying && alreadyTracked) return prev.filter((id) => id !== convId)
            return prev
          })
          if (activeEngineIdRef.current === convId) {
            setAgentStatus(status)
          } else {
            if (status.status === 'completed') {
              onBackgroundCompleteRef.current?.(convId, engine!)
            }
          }
        },
        onStreamingBlocksChanged: (blocks) => {
          if (activeEngineIdRef.current === convId) {
            setStreamingBlocks([...blocks])
          }
        },
        onPlanChanged: (plan) => {
          if (activeEngineIdRef.current === convId) {
            setPlan(plan ? { ...plan, steps: plan.steps.map(s => ({ ...s })) } : null)
          }
        },
      })
      enginesRef.current.set(convId, engine)
    }
    return engine
  }, [buildEngineOptions])

  // ── Keep all engines' options in sync when global deps change ──
  const prevOptionsRef = useRef<Partial<typeof options>>({})
  const optionsChanged =
    prevOptionsRef.current.apiKey !== options.apiKey ||
    prevOptionsRef.current.baseURL !== options.baseURL ||
    prevOptionsRef.current.model !== options.model ||
    prevOptionsRef.current.maxTokens !== options.maxTokens ||
    prevOptionsRef.current.myName !== options.myName ||
    prevOptionsRef.current.soul !== options.soul ||
    prevOptionsRef.current.yourName !== options.yourName ||
    prevOptionsRef.current.yoloMode !== options.yoloMode ||
    prevOptionsRef.current.locale !== options.locale
  if (optionsChanged) {
    prevOptionsRef.current = {
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      model: options.model,
      maxTokens: options.maxTokens,
      myName: options.myName,
      soul: options.soul,
      yourName: options.yourName,
      yoloMode: options.yoloMode,
      locale: options.locale
    }
  }
  useEffect(() => {
    if (!optionsChanged) return
    console.log(`[useConversationEngine] options changed, updating ${enginesRef.current.size} engine(s)`, {
      model: options.model,
      baseURL: options.baseURL,
      apiKey: options.apiKey ? `${options.apiKey.slice(0, 8)}...` : null
    })
    for (const [convId, engine] of enginesRef.current) {
      engine.updateOptions(buildEngineOptions(convId))
    }
  }, [
    options.apiKey, options.baseURL, options.model, options.maxTokens,
    options.myName, options.soul, options.yourName, options.yoloMode,
    options.locale, buildEngineOptions
  ])

  // ── Engine method proxies ──
  const approveTool = useCallback((toolUseId: string) => {
    enginesRef.current.get(activeEngineIdRef.current)?.approveTool(toolUseId)
  }, [])

  const rejectTool = useCallback((toolUseId: string) => {
    enginesRef.current.get(activeEngineIdRef.current)?.rejectTool(toolUseId)
  }, [])

  const killTool = useCallback((toolUseId: string) => {
    enginesRef.current.get(activeEngineIdRef.current)?.killTool(toolUseId)
  }, [])

  const respondToTool = useCallback((toolUseId: string, response: string) => {
    enginesRef.current.get(activeEngineIdRef.current)?.respondToTool(toolUseId, response)
  }, [])

  const cancelLoop = useCallback(() => {
    enginesRef.current.get(activeEngineIdRef.current)?.cancelLoop()
  }, [])

  const extendLoop = useCallback(() => {
    enginesRef.current.get(activeEngineIdRef.current)?.extendLoop()
  }, [])

  const stopExecution = useCallback(() => {
    enginesRef.current.get(activeEngineIdRef.current)?.stopExecution()
  }, [])

  const resumeExecution = useCallback(() => {
    enginesRef.current.get(activeEngineIdRef.current)?.resumeExecution()
  }, [])

  const clearError = useCallback(() => {
    enginesRef.current.get(activeEngineIdRef.current)?.clearError()
  }, [])

  const retryLast = useCallback(() => {
    enginesRef.current.get(activeEngineIdRef.current)?.retryLastTurn()
  }, [])

  return {
    enginesRef,
    activeEngineIdRef,
    messages,
    agentStatus,
    streamingBlocks,
    plan,
    activeLoopConvIds,
    retryingConvIds,
    getOrCreateEngine,
    buildEngineOptions,
    // State setters exposed for external load/restore operations
    setMessages,
    setAgentStatus,
    setStreamingBlocks,
    setPlan,
    setActiveLoopConvIds,
    // Engine proxies
    approveTool,
    rejectTool,
    killTool,
    respondToTool,
    cancelLoop,
    extendLoop,
    stopExecution,
    resumeExecution,
    clearError,
    retryLast
  }
}
