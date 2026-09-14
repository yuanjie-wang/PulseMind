// ── Tool executor facade ──
// One ToolExecutor per engine (constructed in useChatManagers / session-manager)
// that maps a tool_use block to its implementation. This file keeps the small /
// built-in-file tools and the dispatch surface the engine calls; the larger
// per-domain implementations live in executors/* (pick_tool, spawn_agent,
// memory/conversation/knowledge/experience) behind the ToolExecContext
// interface. Results flow back through the injected addToolResult callback
// (which owns the global context-size guardrail) — executors themselves no
// longer truncate.

import { getHost } from './host'
import { execGitTool } from './engine/git-tools'
import type { ToolUseBlock } from '../types/agent'
import type { AgentEngineOptions } from './AgentEngine'
import type { SpawnSubAgentConfig, SubAgentHandle } from './agent-utils'
import { writeFileChunked } from './agent-utils'
import { buildCommandFromSkillInput } from './command-builder'
import { SkillKeywordAgent, SkillSelectionAgent } from './one-shot-agent'
import { saveImagesInText } from './image-utils'
import type { ToolExecContext } from './executors/context'
import { execPickTool as pickToolImpl } from './executors/pick-tool'
import { execSpawnAgent as spawnAgentImpl } from './executors/spawn-tool'
import { execMemoryTool, execConversationTool, execKnowledgeTool, execExperienceTool } from './executors/domain-tools'

export type SpawnSubAgentFn = (config: SpawnSubAgentConfig) => SubAgentHandle
export { UI_PREVIEW_MAX } from './executors/context'

// ── Remaining per-tool limits ───────────────────────────────────────
// Executors no longer truncate tool results for context — the global guardrail
// in AgentEngine (MAX_TOOL_RESULT_TOKENS) is the single backstop. These limits
// stay only where they serve a non-context purpose: UI previews (see
// executors/context.ts) and the read tool's paging (an intrinsic part of how
// the model reads large files).
const READ_DEFAULT_LINE_LIMIT = 200        // read: default lines per page
const READ_MAX_LINE_LIMIT = 500            // read: hard cap on lines per page (read bypasses the token guardrail, so this is its only bound)

export class ToolExecutor implements ToolExecContext {
  constructor(
    /** @internal shared with the executors/* modules via ToolExecContext */
    opts: AgentEngineOptions,
    private mcpToolOwner: Map<string, string>,
    private skillKeywordAgent: SkillKeywordAgent,
    private skillSelectionAgent: SkillSelectionAgent,
    /** @internal shared with the executors/* modules via ToolExecContext */
    addToolResult: (toolUseId: string, content: string, isError: boolean, imageData?: string, maxTokens?: number) => void,
    /** @internal shared with the executors/* modules via ToolExecContext */
    notify: () => void,
    onProcessStart?: (pid: string) => void,
    /** @internal shared with the executors/* modules via ToolExecContext */
    onMemorySaved?: () => void,
    /** @internal shared with the executors/* modules via ToolExecContext */
    spawnSubAgent?: SpawnSubAgentFn,
  ) {
    this.opts = opts
    this.addToolResult = addToolResult
    this.notify = notify
    this.onProcessStart = onProcessStart
    this.onMemorySaved = onMemorySaved
    this.spawnSubAgent = spawnSubAgent
  }

  opts: AgentEngineOptions
  addToolResult: (toolUseId: string, content: string, isError: boolean, imageData?: string, maxTokens?: number) => void
  notify: () => void
  onMemorySaved?: () => void
  onProcessStart?: (pid: string) => void
  spawnSubAgent?: SpawnSubAgentFn

  updateOptions(opts: AgentEngineOptions): void {
    this.opts = opts
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /** Resolve relative file_path against workspaceDir when set. */
  private resolveWorkspacePath(filePath: string): string {
    const wd = this.opts.workspaceDir
    if (!wd) return filePath
    if (/^[/\\]|[A-Za-z]:[/\\]/.test(filePath)) return filePath
    const sep = wd.includes('\\') ? '\\' : '/'
    return wd + sep + filePath
  }

  /** Format exec tool result with exit code and stdout/stderr separation. No truncation — the global guardrail in addToolResult caps it. */
  /** Format exec tool result with exit code and stdout/stderr separation. No truncation — the global guardrail in addToolResult caps it.
   *  @internal shared with the executors/* modules via ToolExecContext */
  formatExecResult(exitCode: number | null, stdout: string, stderr: string): string {
    // Normalize line endings (Windows PowerShell uses \r\n)
    stdout = stdout.replace(/\r\n/g, '\n')
    stderr = stderr.replace(/\r\n/g, '\n')
    const totalLen = stdout.length + stderr.length
    const stderrLines = stderr ? stderr.split('\n').filter(l => l.trim()).length : 0

    const header = `Exit Code: ${exitCode ?? 'signal'}  |  Total: ${totalLen.toLocaleString()} chars  |  Stderr: ${stderrLines} lines`
    const parts: string[] = [header, '', '--- stdout ---', stdout || '(empty)']
    if (stderr) parts.push('', '--- stderr ---', stderr)
    return parts.join('\n')
  }

  // ── Read-only tools (concurrent sync execution) ──────────────────────

  /** Extensions that markitdown can convert to markdown. */
  private static CONVERTIBLE_EXTS = new Set([
    '.pdf', '.docx', '.pptx', '.xlsx', '.xls',
    '.epub', '.msg', '.ipynb',
  ])

  /** Format `read` tool output with file metadata header. */
  private formatReadOutput(
    filePath: string, fileSize: number, totalLines: number,
    offset: number, limit: number, content: string,
    extraNote?: string,
  ): string {
    const sizeStr = fileSize > 1024 * 1024
      ? `${(fileSize / 1024 / 1024).toFixed(1)} MB`
      : fileSize > 1024
        ? `${(fileSize / 1024).toFixed(1)} KB`
        : `${fileSize} B`
    const readLen = totalLines ? Math.min(limit, Math.max(0, totalLines - offset + 1)) : limit
    const lines: string[] = [
      '--- File Metadata ---',
      `  Path: ${filePath}`,
      `  Size: ${sizeStr}${totalLines ? ` (${totalLines} lines)` : ''}`,
      `  Range: lines ${offset}-${offset + readLen - 1}`,
    ]
    if (extraNote) lines.push(`  Note: ${extraNote}`)
    lines.push('--- End File Metadata ---', '', content)
    return lines.join('\n')
  }

  /** Get total line count of a file. Returns 0 on failure. */
  private async getLineCount(filePath: string): Promise<number> {
    try {
      const isWin = this.opts.platformInfo?.platform === 'win32'
      const cmd = isWin
        ? `(Get-Content '${filePath.replace(/'/g, "''")}' -Encoding utf8 | Measure-Object -Line).Lines`
        : `wc -l "${filePath.replace(/"/g, '\\"')}"`
      const r = await getHost().execCommandSync(cmd)
      if (r.code === 0) {
        const trimmed = r.output.trim()
        const n = isWin ? parseInt(trimmed, 10) : parseInt(trimmed.split(/\s+/)[0], 10)
        return Number.isFinite(n) ? n : 0
      }
    } catch { /* ignore */ }
    return 0
  }

  async execReadOnlyTools(tools: ToolUseBlock[]): Promise<void> {
    const platform = this.opts.platformInfo?.platform || ''
    await Promise.all(tools.map(async (t) => {
      try {
        // ── `read` tool: metadata header + content ────────────────────
        if (t.name === 'read') {
          const filePath = String(t.input?.file_path || '')
          const offset = Number(t.input?.offset) || 1
          // read bypasses the token guardrail, so bound its page size here: the LLM's
          // limit (or the 200-line default) never exceeds 500 lines per call.
          const limit = Math.min(Number(t.input?.limit) || READ_DEFAULT_LINE_LIMIT, READ_MAX_LINE_LIMIT)
          const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()

          const stat = await getHost().getFileStat(filePath)
          const fileSize = stat?.size ?? 0

          let content: string
          let totalLines = 0

          // markitdown path for binary document formats (cached in tmp/read-cache)
          if (ToolExecutor.CONVERTIBLE_EXTS.has(ext)) {
            const result = await getHost().convertFileToMarkdown(filePath)
            if (result !== null) {
              const lines = result.content.split('\n')
              totalLines = lines.length
              content = lines.slice(offset - 1, offset - 1 + limit).join('\n')
              t.status = 'completed'; t.exitCode = 0; t.output = content
              const note = result.cachePath
                ? `Content converted from original file to markdown. Full conversion saved at: ${result.cachePath}${result.hit ? ' (cached)' : ''}`
                : 'Content converted from original file to markdown.'
              this.addToolResult(t.id, this.formatReadOutput(
                filePath, fileSize, totalLines, offset, limit, content, note,
              ), false, undefined, Infinity)
              return
            }
            // markitdown failed, fall through to shell
          }

          // shell path (text files, or markitdown fallback)
          const cmd = buildCommandFromSkillInput(t.name, { ...t.input, limit }, platform, this.opts.platformInfo?.ripgrepPath)
          const cwd = String(t.input?.cwd || '')
          const timeoutMs = t.input.timeout != null ? Number(t.input.timeout) * 1000 : undefined
          const result = await getHost().execCommandSync(cmd, cwd || undefined, timeoutMs)
          content = result.output
          const isError = result.code !== 0 && !content

          if (!isError) {
            totalLines = await this.getLineCount(filePath)
          }

          t.status = 'completed'; t.exitCode = result.code; t.output = content
          this.addToolResult(t.id, isError
            ? (content || `Command failed (exit: ${result.code})`)
            : this.formatReadOutput(filePath, fileSize, totalLines, offset, limit, content),
            isError, undefined, Infinity)
          return
        }

        // ── git read-only tools: execFile, no shell ───────────────────
        if (t.name === 'git_status' || t.name === 'git_diff' || t.name === 'git_log') {
          await this.execGitTool(t)
          return
        }

        // ── Other read-only tools ─────────────────────────────────────
        const cmd = buildCommandFromSkillInput(t.name, t.input || {}, platform, this.opts.platformInfo?.ripgrepPath)
        const cwd = String(t.input?.cwd || '')
        const timeoutMs = t.input.timeout != null ? Number(t.input.timeout) * 1000 : undefined
        const result = await getHost().execCommandSync(cmd, cwd || undefined, timeoutMs)
        const output = result.output
        t.status = 'completed'; t.exitCode = result.code; t.output = output
        this.addToolResult(t.id, output || (result.code !== 0 ? `Command failed (exit: ${result.code})` : '(no output)'), result.code !== 0)
      } catch (err) {
        t.status = 'completed'; t.exitCode = -1
        const m = `Error: ${err instanceof Error ? err.message : 'exec failed'}`
        t.output = m
        this.addToolResult(t.id, m, true)
      }
    }))
  }

  // ── Git tools (execFile via main process — never a shell string) ───

  // ── Write/Edit tools ─────────────────────────────────────────────────

  async execWorkspaceTool(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      if (t.name === 'git_commit' || t.name === 'git_restore') {
        await this.execGitTool(t)
        return
      }
      if (t.name === 'write') {
        let fp = String(t.input.file_path || ''); const content = String(t.input.content || ''); const append = t.input.append === true
        if (!fp) throw new Error('file_path is required')
        fp = this.resolveWorkspacePath(fp)
        t.output = `Writing ${content.length} bytes to ${fp}...`; this.notify()
        const result = await writeFileChunked(fp, content, append)
        t.output = result.success ? `Written ${content.length} bytes to ${fp}${append ? ' (appended)' : ''}` : `Error: ${result.error || 'Write failed'}`
        this.addToolResult(t.id, result.success ? `Written ${content.length} bytes to ${fp}${append ? ' (appended)' : ''}` : `Error: ${result.error || 'Write failed'}`, !result.success)
        t.exitCode = result.success ? 0 : 1
      } else if (t.name === 'edit') {
        let fp = String(t.input.file_path || '')
        if (!fp) throw new Error('file_path is required')
        fp = this.resolveWorkspacePath(fp)

        const diff = String(t.input.diff || '')
        if (diff) {
          const result = await getHost().patchFile({ filePath: fp, diff })
          t.output = result.success ? `Applied ${result.replacements} hunk(s) to ${fp}` : `Error: ${result.error || 'Patch failed'}`
          this.addToolResult(t.id, result.success ? `Applied ${result.replacements} hunk(s) to ${fp}` : `Error: ${result.error || 'Patch failed'}`, !result.success)
          t.exitCode = result.success ? 0 : 1
        } else {
          const oldStr = String(t.input.old_str || ''); const newStr = String(t.input.new_str || ''); const multi = t.input.multi === true
          if (!oldStr) throw new Error('old_str is required (or use diff parameter)')
          const result = await getHost().editFile({ filePath: fp, oldStr, newStr, multi })
          t.output = result.success ? `Replaced ${result.replacements} occurrence(s) in ${fp}` : `Error: ${result.error || 'Edit failed'}`
          this.addToolResult(t.id, result.success ? `Replaced ${result.replacements} occurrence(s) in ${fp}` : `Error: ${result.error || 'Edit failed'}`, !result.success)
          t.exitCode = result.success ? 0 : 1
        }
      }
    } catch (err) { const em = `Error: ${err instanceof Error ? err.message : 'exec failed'}`; t.output = em; this.addToolResult(t.id, em, true); t.exitCode = -1 }
    t.status = 'completed'; this.notify()
  }

  // ── MCP tools ─────────────────────────────────────────────────────────
  async execGitTool(t: ToolUseBlock): Promise<void> {
    return execGitTool({ opts: this.opts, addToolResult: this.addToolResult, notify: this.notify }, t)
  }

  async execMCPTool(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const serverId = this.mcpToolOwner.get(t.name)
      if (!serverId) throw new Error(`No MCP server provides tool "${t.name}"`)
      const result = await getHost().mcpCallTool(serverId, t.name, { ...t.input })
      if (result.success) {
        const raw = typeof result.result === 'object' && result.result !== null
          ? JSON.stringify(result.result, null, 2)
          : String(result.result || '')
        const text = await saveImagesInText(raw)
        // No per-server truncation — the global guardrail in addToolResult caps it.
        t.exitCode = 0; t.status = 'completed'
        this.addToolResult(t.id, text, false)
      } else {
        t.exitCode = 1; t.status = 'completed'
        this.addToolResult(t.id, `MCP error: ${result.error || 'Unknown'}`, true)
      }
    } catch (err) {
      t.exitCode = 1; t.status = 'completed'
      this.addToolResult(t.id, `MCP error: ${err instanceof Error ? err.message : 'Unknown'}`, true)
    }
    this.notify()
  }

  async execInstall(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const installType = String(t.input?.type || '').trim()
      const name = String(t.input?.name || '').trim()
      if (!installType) throw new Error('Field "type" is required: "skill" or "mcp".')
      if (!name) throw new Error('Field "name" is required.')

      if (installType === 'skill') {
        // ── Install skill from ~/.pulsemind/skills/<name>/SKILL.md ──
        t.output = `Installing skill "${name}"...`; this.notify()
        const def = await getHost().installSkill(name)
        if (!def) throw new Error(`Skill "${name}" not found on disk at ~/.pulsemind/skills/${name}/SKILL.md.`)
        const sm = this.opts.skillManager; sm!.registerSkill(def); sm!.enable(def.name)
        this.opts.onSkillStateChange?.()
        t.exitCode = 0; t.status = 'completed'
        this.addToolResult(t.id, `Skill "${def.name}" installed and enabled successfully.`, false)
        // keyword extraction (fire-and-forget)
        try {
          const rawContent = await getHost().readSkillRaw(name)
          if (rawContent) {
            const keywords = await this.skillKeywordAgent.execute(
              { rawContent },
              {
                llmConfig: { adapter: this.opts.adapter, apiKey: this.opts.apiKey || '', baseURL: this.opts.baseURL, model: this.opts.model },
                maxTokens: 500
              }
            )
            if (keywords.length > 0) {
              const prefs = await getHost().getSkillPreferences()
              const sk = prefs.skillKeywords || {}
              if (!sk[def.name]) { sk[def.name] = keywords; await getHost().setSkillPreferences({ ...prefs, skillKeywords: sk }) }
            }
          }
        } catch (err) { console.warn(`[install] Failed to extract keywords for "${def.name}":`, err) }
      } else if (installType === 'mcp') {
        // ── Register MCP server from config file ─────────────────────
        t.output = `Registering MCP server "${name}"...`; this.notify()
        const configPath = '~/.pulsemind/mcp/mcp-servers.json'
        const configStr = await getHost().readFile(configPath)
        if (!configStr) throw new Error(`MCP config file not found at ${configPath}. Write the MCP server configuration first.`)
        const records = JSON.parse(configStr)
        const record = Array.isArray(records) ? records.find((r: any) => r.config?.name === name || r.name === name) : null
        if (!record) throw new Error(`MCP server "${name}" not found in ${configPath}.`)
        const rawConfig = record.config || record
        const result = await getHost().mcpRegisterServer(rawConfig)
        const serverId = result.server?.id || ''
        if (serverId) await getHost().mcpStartServer(serverId).catch(() => {})
        window.dispatchEvent(new CustomEvent('mcp-state-changed'))
        t.exitCode = 0; t.status = 'completed'
        this.addToolResult(t.id, `MCP server "${name}" registered and started successfully.`, false)
      } else {
        throw new Error(`Unknown install type "${installType}". Must be "skill" or "mcp".`)
      }
    } catch (err) { this.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'install failed'}`, true); t.exitCode = -1 }
    this.notify()
  }

  async execPickSkill(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const sm = this.opts.skillManager; const skillName = String(t.input?.name || '').trim()
      // Expert/spawn skill whitelist: skills outside the pack are off-limits
      // (experiences stay readable — they're progressive-disclosure records).
      const allowedSkillSet = this.opts.allowedSkills?.length ? new Set(this.opts.allowedSkills) : null
      if (skillName && allowedSkillSet && !allowedSkillSet.has(skillName)) {
        const msg = `Skill "${skillName}" is not in this session's allowed skills (${[...allowedSkillSet].join(', ')}). Work with what's available.`
        this.addToolResult(t.id, msg, true); t.exitCode = 1; t.status = 'completed'; this.notify(); return
      }
      if (skillName) {
        t.output = `Looking up skill: ${skillName}...`; this.notify()
        const skill = sm!.getSkill(skillName)
        if (skill) {
          this.addToolResult(t.id, `## Selected Skill: ${skill.definition.name}\n\n**Description:** ${skill.definition.description}\n**Category:** ${skill.definition.category}\n\n### Instructions\n${skill.definition.systemPrompt || '(no instructions)'}`, false)
          t.exitCode = 0; t.status = 'completed'; this.notify(); return
        }
        // Fall back to the experience library (skill-style progressive disclosure)
        const em = this.opts.experienceManager
        if (em) {
          const raw = await em.read(skillName)
          if (raw) {
            em.touch(skillName).catch(() => {})
            this.addToolResult(t.id, `## Selected Experience: ${skillName}\n\n${raw}`, false)
            t.exitCode = 0; t.status = 'completed'; this.notify(); return
          }
        }
        this.addToolResult(t.id, `Skill or experience "${skillName}" not found.`, true); t.exitCode = 1; t.status = 'completed'; this.notify(); return
      }
      const intent = String(t.input?.intent || '')
      if (!intent) throw new Error('Either "name" or "intent" must be provided')
      t.output = `Selecting best skill for: ${intent.slice(0, 80)}...`; this.notify()
      const enabledSkills2 = sm!.getEnabledSkills().filter(s => !allowedSkillSet || allowedSkillSet.has(s.definition.name))
      const experiences2 = this.opts.experienceManager ? await this.opts.experienceManager.list() : []
      if (enabledSkills2.length === 0 && experiences2.length === 0) { this.addToolResult(t.id, 'No skills or experiences enabled.', false); t.exitCode = 0; t.status = 'completed'; this.notify(); return }
      const skillsList = enabledSkills2.map(s => `- ${s.definition.name}: ${s.definition.description} (${s.definition.category})`).join('\n')
      const expList = experiences2.map(e => `- ${e.name}: ${e.description} (experience)`).join('\n')
      const combinedList = [skillsList, expList].filter(Boolean).join('\n')
      const selectedName = await this.skillSelectionAgent.execute(
        { intent, skillsList: combinedList },
        { llmConfig: { adapter: this.opts.adapter, apiKey: this.opts.apiKey || '', baseURL: this.opts.baseURL, model: this.opts.model }, maxTokens: 200 }
      )
      if (!selectedName) { this.addToolResult(t.id, 'No matching skill found.', false); t.exitCode = 0; t.status = 'completed'; this.notify(); return }
      const cleanName = selectedName.trim()
      if (allowedSkillSet && !allowedSkillSet.has(cleanName)) {
        this.addToolResult(t.id, `"${cleanName}" selected but it is outside this session's allowed skills. Pick from: ${[...allowedSkillSet].join(', ')}.`, true)
        t.exitCode = 1; t.status = 'completed'; this.notify(); return
      }
      const skill = sm!.getSkill(cleanName)
      if (skill) {
        this.addToolResult(t.id, `## Selected Skill: ${cleanName}\n\n**Description:** ${skill.definition.description}\n**Category:** ${skill.definition.category}\n\n### Instructions\n${skill.definition.systemPrompt || '(no instructions)'}`, false)
        t.exitCode = 0; t.status = 'completed'; this.notify(); return
      }
      const em2 = this.opts.experienceManager
      if (em2) {
        const raw2 = await em2.read(cleanName)
        if (raw2) {
          em2.touch(cleanName).catch(() => {})
          this.addToolResult(t.id, `## Selected Experience: ${cleanName}\n\n${raw2}`, false)
          t.exitCode = 0; t.status = 'completed'; this.notify(); return
        }
      }
      this.addToolResult(t.id, `"${cleanName}" selected but not available.`, true); t.exitCode = 1
    } catch (err) { this.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'pick_skill failed'}`, true); t.exitCode = -1 }
    t.status = 'completed'; this.notify()
  }

  /** Browser Use (A-M1): run a JS snippet against the host browser runtime.
   *  Screenshots come back as images[] and flow through the existing
   *  base64→tmp-file channel so they render inline in the transcript. */
  async execBrowser(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const code = String(t.input?.code || '')
      if (!code.trim()) throw new Error('code is required')
      const timeoutMs = Number(t.input?.timeoutMs) || undefined
      const r = await getHost().browserRunCode(code, { timeoutMs, conversationId: this.opts.conversationId })
      const parts: string[] = []
      if (r.error) parts.push(`Error: ${r.error}`)
      parts.push(`Result: ${r.result}`)
      if (r.console.length > 0) parts.push(`Console:\n${r.console.slice(0, 20).join('\n')}`)
      if (r.images.length > 0) parts.push(`[${r.images.length} 张截图已附加]`)
      t.exitCode = r.error ? 1 : 0
      t.status = 'completed'
      const text = parts.join('\n\n')
      // imageData is raw base64 (UI prepends the data: prefix); the model gets
      // the textual summary — visual reasoning keeps riding the snapshot.
      const firstImage = r.images[0]
      this.addToolResult(t.id, text, !!r.error, firstImage?.base64)
    } catch (err) {
      t.exitCode = -1
      t.status = 'completed'
      this.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'browser run failed'}`, true)
    }
    this.notify()
  }

  async execWebFetch(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const url = String(t.input?.url || '').trim()
      if (!url) throw new Error('url is required')
      const method = String(t.input?.method || 'GET').toUpperCase()
      const headers = t.input?.headers as Record<string, string> | undefined
      const body = t.input?.body !== undefined ? String(t.input.body) : undefined
      const result = await getHost().apiFetch(url, { method, headers, body })
      if (result === null) throw new Error('Request failed or was blocked')

      // No truncation here — the global guardrail in addToolResult caps it.
      const display = `--- WebFetch ---\n  URL: ${url}\n  Method: ${method}\n  Size: ${result.length.toLocaleString()} chars\n--- End WebFetch ---\n\n${result}`
      this.addToolResult(t.id, display, false)
      t.exitCode = 0
    } catch (err) {
      this.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'fetch failed'}`, true)
      t.exitCode = -1
    }
    t.status = 'completed'; this.notify()
  }

  async execPickTool(t: ToolUseBlock, setSelectedTools: (names: string[]) => void): Promise<void> {
    return pickToolImpl(this, t, setSelectedTools)
  }

  async execSpawnAgent(t: ToolUseBlock): Promise<void> {
    return spawnAgentImpl(this, t)
  }


  // ── Catch-all tool executor ───────────────────────────────────────────

  async execOtherTool(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      if (await execMemoryTool(this, t)) return
      if (await execConversationTool(this, t)) return
      if (await execKnowledgeTool(this, t)) return
      if (await execExperienceTool(this, t)) return
      this.addToolResult(t.id, `Unknown tool: ${t.name}`, true)
    } catch (err) {
      this.addToolResult(t.id, `Tool failed: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

}