// ── HTML app generator (PLAN-0.4.0 M5.2) ──
// The generation core shared by the tool studio. Extracted from the canvas
// engine's pattern (agent engine + yolo + workspaceDir + read/write app.html),
// but generates a STANDALONE interactive page (full document) instead of a
// container snippet, and speaks of tools, not canvas regions.

import { AgentEngine, type AgentEngineOptions } from '../agent/AgentEngine'
import { ToolManager } from '../tools/ToolManager'
import { SkillManager } from '../skills/SkillManager'
import { createLlmAdapter } from '../llm'
import type { LLMProvider } from '../llm/types'
import type { PlatformInfo } from '../types/electron'
import { agentMessagesToConversation } from '../utils/message-utils'

export interface ToolGeneratorConfig {
  provider?: string
  apiKey: string
  baseURL: string
  model: string
  maxTokens: number
  profileId?: string
  /** The tool's own directory — the only place the agent writes. */
  toolDir: string
  /** Stable conversation id so iteration keeps history across runs. */
  conversationId: string
  platformInfo?: PlatformInfo
  skillsDir?: string
}

export const TOOL_SYSTEM_PROMPT = `You are a web tool builder. You create and maintain a single self-contained interactive HTML application for the user: a practical tool (calculators, converters, timers, API clients, mini games, utilities, and the like).

The tool lives in app.html in the working directory.

Output contract — app.html must be a COMPLETE standalone document:
- Include <!DOCTYPE html>, <html>, <head> (with <meta charset> and viewport) and <body>
- All CSS in a <style> tag, all JavaScript in a <script> tag — fully self-contained
- NO external CDNs, fonts, icon libraries or network resources — inline SVG or Unicode for icons
- Polish matters: clean layout, good spacing, sensible defaults, @media (prefers-color-scheme: dark) support
- The tool must WORK: wire up every button and input; validate inputs; handle empty and error states
- Persistence: localStorage may be UNAVAILABLE (the preview runs in a sandbox). If the tool benefits from saved state, wrap it in a safe helper that try/catches localStorage and falls back to in-memory storage; prefer window.pulsemind.storage (get/set) when the bridge is present

Workflow:
1. ALWAYS start by reading app.html if it exists — iterate on what is there
2. Use the write tool to replace app.html entirely with your complete output (no partial edits)
3. Do NOT create any other files; do NOT open the page in a browser
4. When done, reply with a 1-3 sentence summary of what the tool now does — in the user's language

When the user asks for changes, treat app.html as the source of truth and modify it. Keep existing features working unless asked to change them.`

export interface ToolEvent {
  toolName: string
  args: string
  status: 'running' | 'done'
  summary?: string
}

function extractToolArgs(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'write': return String(input.file_path || '')
    case 'edit': return String(input.file_path || '')
    case 'read': return String(input.file_path || '')
    case 'exec': return String(input.command || '').slice(0, 60)
    case 'search': return String(input.query || '')
    case 'find': return String(input.pattern || '')
    default: return ''
  }
}

async function readAppHtml(toolDir: string): Promise<string | null> {
  try {
    return await window.electronAPI.readFile(toolDir + '/app.html')
  } catch {
    return null
  }
}

export interface ToolGeneratorHandle {
  /** Run one generation/iteration turn. Resolves with the new app.html. */
  run: (userPrompt: string) => Promise<string>
  cancel: () => void
  onToolEvent: (cb: (event: ToolEvent) => void) => void
  /** True while a run is in flight. */
  isRunning: () => boolean
}

export function createToolGenerator(config: ToolGeneratorConfig): ToolGeneratorHandle {
  const adapter = createLlmAdapter((config.provider || 'anthropic') as LLMProvider)
  const toolManager = new ToolManager()
  const skillManager = new SkillManager()

  let toolEventCb: ((event: ToolEvent) => void) | null = null
  let resolveRun: ((html: string) => void) | null = null
  let rejectRun: ((err: Error) => void) | null = null
  let prefsLoaded = false
  let pendingRun = false
  const emitted = new Set<string>()

  const options: AgentEngineOptions = {
    adapter,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: config.model,
    maxTokens: config.maxTokens,
    profileId: config.profileId,
    myName: '',
    soul: '',
    yourName: '',
    toolManager,
    skillManager,
    workspaceDir: config.toolDir,
    platformInfo: config.platformInfo,
    yoloMode: true,
    conversationId: config.conversationId,
  }

  const engine = new AgentEngine(options, {
    onMessagesChanged: (messages) => {
      if (!toolEventCb) return
      for (const msg of messages) {
        for (const block of msg.contentBlocks) {
          if (block.type !== 'tool_use') continue
          const tb = block as { id: string; status?: string; name: string; input?: Record<string, unknown>; output?: string }
          const key = `${tb.id}:${tb.status}`
          if (emitted.has(key)) continue
          emitted.add(key)
          if (tb.status === 'running') {
            toolEventCb({ toolName: tb.name, args: extractToolArgs(tb.name, tb.input ?? {}), status: 'running' })
          } else if (tb.status === 'completed') {
            toolEventCb({ toolName: tb.name, args: extractToolArgs(tb.name, tb.input ?? {}), status: 'done', summary: (tb.output ?? '').slice(0, 100) })
          }
        }
      }
    },
    onStatusChanged: (status) => {
      if (!pendingRun) return
      if (status.status === 'completed') {
        pendingRun = false
        const msgs = engine.messages
        if (msgs.length > 0) {
          const conv = agentMessagesToConversation(msgs, config.conversationId, '工具工作室')
          window.electronAPI.saveConversation(conv).catch(() => {})
        }
        readAppHtml(config.toolDir).then((html) => {
          if (html) resolveRun?.(html)
          else rejectRun?.(new Error('生成完成但未找到 app.html'))
        })
      } else if (status.status === 'error') {
        pendingRun = false
        rejectRun?.(new Error(status.error || '生成失败'))
      }
    },
  })

  const ensurePrefs = async (): Promise<void> => {
    if (prefsLoaded) return
    try {
      toolManager.applyPreferences(await window.electronAPI.getToolPreferences())
    } catch {
      toolManager.applyPreferences({ enabledTools: [] })
    }
    try {
      skillManager.applyPreferences(await window.electronAPI.getSkillPreferences())
    } catch {
      skillManager.applyPreferences({ enabledSkills: [] })
    }
    try {
      const imported = await window.electronAPI.listImportedSkills()
      for (const def of imported) skillManager.registerSkill(def)
    } catch { /* best-effort */ }
    prefsLoaded = true
  }

  return {
    async run(userPrompt: string): Promise<string> {
      if (pendingRun) throw new Error('上一次生成还在进行中')
      await ensurePrefs()

      return new Promise((resolve, reject) => {
        resolveRun = resolve
        rejectRun = reject
        pendingRun = true

        const allowedTools = ['read', 'write', 'edit', 'list_dir', 'search', 'find', 'pick_skill']
        ;(engine as unknown as { allowedToolsSet: Set<string> }).allowedToolsSet = new Set(allowedTools)

        let fullPrompt = TOOL_SYSTEM_PROMPT
        const skillsCtx = skillManager.getSystemPromptAppendix(config.skillsDir)
        if (skillsCtx) fullPrompt += '\n\n' + skillsCtx
        ;(engine as unknown as { spawnSystemPrompt: string }).spawnSystemPrompt = fullPrompt

        engine.startLoop(userPrompt).catch((err: Error) => {
          pendingRun = false
          reject(err?.message === 'cancelled' ? new Error('cancelled') : (err || new Error('生成失败')))
        })
      })
    },
    cancel() {
      pendingRun = false
      engine.cancelLoop()
      rejectRun?.(new Error('cancelled'))
      resolveRun = null
      rejectRun = null
    },
    onToolEvent(cb: (event: ToolEvent) => void) {
      toolEventCb = cb
    },
    isRunning: () => pendingRun,
  }
}
