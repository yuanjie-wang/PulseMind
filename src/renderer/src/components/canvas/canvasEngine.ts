import { AgentEngine, type AgentEngineOptions } from '../../agent/AgentEngine'
import { ToolManager } from '../../tools/ToolManager'
import { SkillManager } from '../../skills/SkillManager'
import { createLlmAdapter } from '../../llm'
import type { LLMProvider } from '../../llm/types'
import type { PlatformInfo } from '../../types/electron'
import { agentMessagesToConversation } from '../../utils/message-utils'

export interface CanvasEngineConfig {
  provider?: string
  apiKey: string
  baseURL: string
  model: string
  maxTokens: number
  profileId?: string
  workDir: string
  platformInfo?: PlatformInfo
  rectId?: string
  skillsDir?: string
}

// ── Prompt builders ──

function buildEnvContext(config: { width?: number; height?: number; contentType?: string; workDir?: string }): string {
  const now = new Date()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const timeStr = now.toLocaleString('zh-CN', { timeZone: tz })
  const dims = config.width && config.height ? `${config.width}×${config.height}px` : '未知'
  const typeLabels: Record<string, string> = { phoneApp: '手机App', tabletApp: '平板App', web: '网页' }
  const typeLabel = typeLabels[config.contentType || 'web'] || '网页'
  const lines = [
    `## 环境信息`,
    `- 当前时间: ${timeStr} (${tz}, GMT${now.getTimezoneOffset() <= 0 ? '+' : '-'}${Math.abs(now.getTimezoneOffset() / 60)})`,
    `- 画布尺寸: ${dims}`,
    `- 生成类型: ${typeLabel}`,
  ]
  if (config.workDir) {
    lines.push(`- index.html 路径: ${config.workDir}/index.html`)
  }
  return lines.join('\n')
}

const CANVAS_SYSTEM_PROMPT = `You are a frontend page generator. Generate HTML content with inline CSS and JavaScript.

Write the output to index.html.

IMPORTANT — Output format:
- Generate only the **inner content** that fills the container. Do NOT include <!DOCTYPE html>, <html>, <head>, or <body> tags — those are provided by the container.
- Include your own <style> and <script> tags inside the content as needed
- Use modern CSS (flexbox, grid, custom properties)
- **Every element in the body must have a unique id attribute** — no element without an id
- **Fill the entire container completely** — the root element must use width:100%;height:100%;margin:0;padding:0 so no gaps remain. All child elements should also span the full available width unless intentionally inset.
- **Responsive layout is required** — use CSS flexbox or grid for fluid layouts that adapt to any container size. Use relative units (%, vh, vw, fr, em/rem). Avoid fixed pixel dimensions for container-level sizing. Add @media (prefers-color-scheme: dark) support for color scheme adaptation.
- **No scrollbars on the container** — content should flex to fit so the container itself has no overflow scrolling. Internal scrollable areas within the design are acceptable for things like lists or chat panes.
- Use CSS transitions/animations sparingly for polish
- Do NOT use external CDN links
- All icons should be done with inline SVGs or Unicode characters — no external icon libraries are available.
- Do NOT open or preview the page in the system browser — the result is rendered automatically inside the application.

The working directory contains an index.html file with the current state. **Always start each task by reading this file** to understand what already exists, then plan your approach before making any changes.

When modifying, replace the entire content of index.html with your complete generated HTML output — do not make partial edits. Do NOT create any additional files.

When the user provides annotations, they describe specific areas of the rendered page that need changes. Pay close attention to the annotation positions and text.

Workflow:
1. Use the **read** tool to examine the current content of index.html
2. Use the **write** tool to output your complete HTML (replaces the file entirely)
3. Iterate as many times as needed using read, write, edit, search, find, and exec tools
4. For complex pages, build incrementally: generate a basic structure first, then refine
5. When you are done, output the final HTML in a code block (no need to call finish — the result is captured automatically)`

export const STYLE_GUIDES: Record<string, string> = {
  phoneApp: 'Design it as a mobile app interface (iOS/Android style) with native-feeling UI components, tab bars, and mobile navigation patterns.',
  tabletApp: 'Design it as a tablet app interface with split-view capable layouts, sidebar navigation, and larger touch targets.',
  web: 'Design it as a web page with standard web layout and styling.',
}

export function buildUserPrompt(config: {
  prompt: string
  annotations?: string
  existingCode?: string
  contentType?: string
  width?: number
  height?: number
}): string {
  const dims = config.width && config.height ? `${config.width}×${config.height}` : 'container'
  const isRevision = !!config.existingCode
  const styleGuide = STYLE_GUIDES[config.contentType || 'web'] || STYLE_GUIDES.web

  const core = isRevision
    ? `Revise the HTML in this region (${dims}px). Preserve the overall layout unless changes are specified. Ensure it fills the full container and is responsive.`
    : `Generate a self-contained HTML snippet that fills its entire container (${dims}px) completely — no gaps, no container scrollbars, fully responsive layout.`

  let main = ''
  main += `${core}\n${styleGuide}\nUser's request: ${config.prompt}`

  if (config.annotations) {
    main += `\n\nThe user has drawn the following annotations ON this region:\n${config.annotations}\n\nEach annotation includes the real DOM element found at that position. Use the element selectors (tag, id, classes) and bounding rectangles to precisely identify and modify the correct elements.`
  }

  return main
}

// ── Tool event tracking ──

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

/** Read index.html from the workspace directory after agent completes. */
async function readResultHtml(workDir: string): Promise<string | null> {
  try {
    return await window.electronAPI.readFile(workDir + '/index.html')
  } catch {
    return null
  }
}

// ── Handle ──

export interface CanvasEngineHandle {
  /** Start (or continue) generation. Can be called multiple times — each call
   *  appends a new user message to the existing AgentEngine conversation. */
  start: (userPrompt: string) => Promise<string>
  cancel: () => void
  onToolEvent: (cb: (event: ToolEvent) => void) => void
}

export function createCanvasEngine(config: CanvasEngineConfig, envCfg: { width?: number; height?: number; contentType?: string }): CanvasEngineHandle {
  const adapter = createLlmAdapter((config.provider || 'anthropic') as LLMProvider)
  const toolManager = new ToolManager()
  const skillManager = new SkillManager()

  let toolEventCb: ((event: ToolEvent) => void) | null = null
  let resolveStart: ((html: string) => void) | null = null
  let rejectStart: ((err: Error) => void) | null = null
  const emittedToolEvents = new Set<string>() // "blockId:status" dedup
  let pendingGeneration = false
  const convId = `canvas_${config.rectId || 'unknown'}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

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
    workspaceDir: config.workDir,
    platformInfo: config.platformInfo,
    yoloMode: true,
    conversationId: convId,
  }

  // ── Bootstrap tool preferences (async, completes before first start) ──
  let toolPrefsLoaded = false
  window.electronAPI.getToolPreferences().then((prefs) => {
    toolManager.applyPreferences(prefs)
    toolPrefsLoaded = true
  }).catch(() => {
    toolManager.applyPreferences({ enabledTools: [] })
    toolPrefsLoaded = true
  })

  // ── Bootstrap skill preferences (async, completes before first start) ──
  let skillPrefsLoaded = false
  window.electronAPI.getSkillPreferences().then((prefs) => {
    skillManager.applyPreferences(prefs)
    skillPrefsLoaded = true
  }).catch(() => {
    skillPrefsLoaded = true
  })

  const engine = new AgentEngine(options, {
    onMessagesChanged: (messages) => {
      if (toolEventCb) {
        for (const msg of messages) {
          for (const block of msg.contentBlocks) {
            if (block.type === 'tool_use') {
              const tb = block as any
              const statusKey = `${tb.id}:${tb.status}`
              if (emittedToolEvents.has(statusKey)) continue
              emittedToolEvents.add(statusKey)
              if (tb.status === 'running') {
                toolEventCb({ toolName: tb.name, args: extractToolArgs(tb.name, tb.input || {}), status: 'running' })
              } else if (tb.status === 'completed') {
                toolEventCb({ toolName: tb.name, args: extractToolArgs(tb.name, tb.input || {}), status: 'done', summary: (tb.output || '').slice(0, 100) })
              }
            }
          }
        }
      }
    },
    onStatusChanged: (status) => {
      // Completion detection — read the generated HTML from disk since the
      // model writes index.html via the write tool (file is source of truth).
      if (!pendingGeneration) return
      if (status.status === 'completed') {
        pendingGeneration = false
        // Save conversation for token usage statistics
        const msgs = engine.messages
        if (msgs.length > 0) {
          const firstText = msgs[0]?.contentBlocks?.find(b => b.type === 'text')?.text || ''
          const title = firstText.slice(0, 50) || 'Canvas generation'
          const conv = agentMessagesToConversation(msgs, convId, title)
          window.electronAPI.saveConversation(conv).catch(err =>
            console.warn('[canvasEngine] Failed to save conversation:', err)
          )
        }
        readResultHtml(config.workDir).then((html) => {
          if (html) {
            resolveStart?.(html)
          } else {
            console.warn('[canvasEngine] Agent completed but index.html not found or empty in', config.workDir)
            rejectStart?.(new Error('No HTML generated'))
          }
        })
      } else if (status.status === 'error') {
        pendingGeneration = false
        rejectStart?.(new Error(status.error || 'Generation failed'))
      }
    },
  })

  return {
    async start(userPrompt: string): Promise<string> {
      // Guard against concurrent generation
      if (pendingGeneration) {
        throw new Error('Engine already running')
      }

      // Ensure tool preferences are loaded
      if (!toolPrefsLoaded) {
        try {
          const prefs = await window.electronAPI.getToolPreferences()
          toolManager.applyPreferences(prefs)
        } catch {
          toolManager.applyPreferences({ enabledTools: [] })
        }
        toolPrefsLoaded = true
      }

      // Ensure skill preferences are loaded
      if (!skillPrefsLoaded) {
        try {
          const prefs = await window.electronAPI.getSkillPreferences()
          skillManager.applyPreferences(prefs)
        } catch {
          skillManager.applyPreferences({ enabledSkills: ['create_skill'] })
        }
        skillPrefsLoaded = true
      }

      // Register imported/custom skills so keyword matching can find them
      try {
        const importedDefs = await window.electronAPI.listImportedSkills()
        for (const def of importedDefs) {
          skillManager.registerSkill(def)
        }
      } catch (err) {
        console.warn('[canvasEngine] Failed to load imported skills:', err)
      }

      return new Promise((resolve, reject) => {
        resolveStart = resolve
        rejectStart = reject
        pendingGeneration = true

        // Fetch profile from canvas sub-agent, fall back to hardcoded defaults
        window.electronAPI.subagentList()
          .then((profiles) => {
            const p = profiles.find((p: any) => p.id === 'subagent-canvas')

            // Respect the enabled toggle — a disabled canvas sub-agent blocks generation
            if (p?.enabled === false) {
              pendingGeneration = false
              rejectStart?.(new Error('画布子代理已关闭，请在 设置 → 子代理管理 中启用后再生成'))
              return null
            }

            // Apply allowedMcpServers from profile so MCP discovery works
            if (p?.allowedMcpServers) {
              ;(engine as any).allowedMcpServersSet = new Set(p.allowedMcpServers)
            }

            // Apply allowedTools from profile (with fallback)
            const allowedTools = p?.allowedTools?.length
              ? p.allowedTools
              : ['read', 'write', 'edit', 'list_dir', 'search', 'find', 'exec', 'pick_skill']
            ;(engine as any).allowedToolsSet = new Set(allowedTools)

            // Apply allowedSkills from profile — disable skills not in the list
            if (p?.allowedSkills?.length) {
              const allCanvasSkills = skillManager.getAllSkills()
              for (const s of allCanvasSkills) {
                if (!p.allowedSkills.includes(s.definition.name)) {
                  skillManager.disable(s.definition.name)
                }
              }
            }

            return p?.basePrompt || CANVAS_SYSTEM_PROMPT
          })
          .catch(() => CANVAS_SYSTEM_PROMPT)
          .then((basePrompt) => {
            if (basePrompt === null) return

            // Build system prompt from env context + base prompt
            let fullPrompt = buildEnvContext({ ...envCfg, workDir: config.workDir }) + '\n\n' + basePrompt

            // Append available skills context so LLM always sees them
            const skillsCtx = skillManager.getSystemPromptAppendix(config.skillsDir)
            if (skillsCtx) {
              fullPrompt += '\n\n' + skillsCtx
            }

            ;(engine as any).spawnSystemPrompt = fullPrompt
            engine.startLoop(userPrompt).catch((err: any) => {
              pendingGeneration = false
              reject(err?.message === 'cancelled' ? new Error('cancelled') : (err || new Error('Engine loop failed')))
            })
          })
      })
    },

    cancel() {
      pendingGeneration = false
      engine.cancelLoop()
      rejectStart?.(new Error('cancelled'))
      resolveStart = null
      rejectStart = null
    },

    onToolEvent(cb: (event: ToolEvent) => void) {
      toolEventCb = cb
    },
  }
}
