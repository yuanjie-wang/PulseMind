import { getHost } from './host'
import type { ToolUseBlock, TextBlock } from '../types/agent'
import type { AgentEngineOptions } from './AgentEngine'
import type { SpawnSubAgentConfig, SubAgentHandle } from './agent-utils'
import { writeFileChunked } from './agent-utils'
import { buildCommandFromSkillInput } from './command-builder'
import { SkillKeywordAgent, SkillSelectionAgent, ServerSelectionAgent } from './one-shot-agent'
import { saveImagesInText } from './image-utils'
import { getCachedMcpServers } from './mcp-cache'
import { BUILTIN_CATEGORY_SUMMARIES, builtinCategoryServerId, isBuiltinServerId } from '../tools/builtin-gate'
import type { KnowledgeFile } from '../../../shared/types/knowledge'
import type { GitAction, GitResult, GitStatusInfo, GitDiffResult, GitLogEntry, GitCommitResult, GitRestorePreview } from '../../../shared/types/git'

export type SpawnSubAgentFn = (config: SpawnSubAgentConfig) => SubAgentHandle

// ── Remaining per-tool limits ───────────────────────────────────────
// Executors no longer truncate tool results for context — the global guardrail
// in AgentEngine (MAX_TOOL_RESULT_TOKENS) is the single backstop. These limits
// stay only where they serve a non-context purpose: UI previews and the read
// tool's paging (an intrinsic part of how the model reads large files).
export const UI_PREVIEW_MAX = 3000          // tool block .output preview rendered in the UI
const READ_DEFAULT_LINE_LIMIT = 200        // read: default lines per page
const READ_MAX_LINE_LIMIT = 500            // read: hard cap on lines per page (read bypasses the token guardrail, so this is its only bound)
const SUBAGENT_TEXT_MAX = 10_000           // spawn_agent: assistant text fed back to parent
const MEMORY_PREVIEW_MAX = 2000            // memory_search: tool block .output preview

export class ToolExecutor {
  constructor(
    private opts: AgentEngineOptions,
    private mcpToolOwner: Map<string, string>,
    private skillKeywordAgent: SkillKeywordAgent,
    private skillSelectionAgent: SkillSelectionAgent,
    private addToolResult: (toolUseId: string, content: string, isError: boolean, imageData?: string, maxTokens?: number) => void,
    private notify: () => void,
    private onProcessStart?: (pid: string) => void,
    private onMemorySaved?: () => void,
    private spawnSubAgent?: SpawnSubAgentFn,
  ) { }

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
  private formatExecResult(exitCode: number | null, stdout: string, stderr: string): string {
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

  /** Build a GitAction from a git_* tool call. */
  private buildGitAction(name: string, input: Record<string, unknown>, cwd: string): GitAction {
    const files = Array.isArray(input.files) ? input.files.map(String) : undefined
    switch (name) {
      case 'git_status':
        return { action: 'status', cwd }
      case 'git_diff':
        return { action: 'diff', cwd, files, staged: input.staged === true, statOnly: input.statOnly === true }
      case 'git_log': {
        const n = Number(input.n)
        return { action: 'log', cwd, ...(Number.isFinite(n) && n > 0 ? { n } : {}) }
      }
      case 'git_commit':
        return { action: 'commit', cwd, message: String(input.message || ''), files }
      case 'git_restore':
        return { action: 'restore', cwd, files: Array.isArray(input.files) ? input.files.map(String) : [], confirm: input.confirm === true }
      default:
        throw new Error(`Unknown git tool: ${name}`)
    }
  }

  /** Render a GitResult into readable text for the model and the tool card. */
  private formatGitResult(name: string, result: GitResult): string {
    if (!result.ok) return `Git error: ${result.error?.message ?? 'unknown'}`
    switch (name) {
      case 'git_status': {
        const data = result.data as GitStatusInfo | undefined
        if (!data?.isRepo) return '(not a git repository — nothing to report)'
        const lines = [`Branch: ${data.branch ?? '(detached)'}${data.ahead ? ` | ahead ${data.ahead}` : ''}${data.behind ? ` | behind ${data.behind}` : ''}`]
        if (data.staged?.length) lines.push(`Staged (${data.staged.length}):`, ...data.staged.map((f) => `  ${f}`))
        if (data.unstaged?.length) lines.push(`Unstaged (${data.unstaged.length}):`, ...data.unstaged.map((f) => `  ${f}`))
        if (data.untracked?.length) lines.push(`Untracked (${data.untracked.length}):`, ...data.untracked.map((f) => `  ${f}`))
        if (data.conflict?.length) lines.push(`Conflicts (${data.conflict.length}):`, ...data.conflict.map((f) => `  ${f}`))
        if (lines.length === 1) lines.push('  (clean working tree)')
        return lines.join('\n')
      }
      case 'git_diff': {
        const data = result.data as GitDiffResult | undefined
        if (data?.isRepo === false) return '(not a git repository)'
        return data?.stat ?? data?.diff ?? '(no changes)'
      }
      case 'git_log': {
        const data = result.data as GitLogEntry[] | undefined
        return data?.map((e) => `${e.shortHash} ${e.summary}`).join('\n') || '(no commits)'
      }
      case 'git_commit': {
        const data = result.data as GitCommitResult | undefined
        return `Committed ${data?.shortHash}: ${data?.summary} (${data?.filesChanged} file(s) changed)`
      }
      case 'git_restore': {
        const data = result.data as GitRestorePreview | { restored: string[] } | undefined
        if (data && 'message' in data) {
          return `PREVIEW ONLY — nothing was restored.\n${data.message}\n\n${data.status || data.stat}`
        }
        const restored = (data as { restored?: string[] } | undefined)?.restored ?? []
        return `Restored ${restored.length} file(s): ${restored.join(', ')}`
      }
      default:
        return JSON.stringify(result, null, 2)
    }
  }

  async execGitTool(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const cwd = String(t.input?.cwd || this.opts.workspaceDir || '')
      const action = this.buildGitAction(t.name, (t.input || {}) as Record<string, unknown>, cwd)
      const result = await getHost().gitInvoke(action)
      const text = this.formatGitResult(t.name, result)
      t.exitCode = result.ok ? 0 : 1
      t.status = 'completed'
      t.output = text
      this.addToolResult(t.id, text, !result.ok)
    } catch (err) {
      t.exitCode = 1; t.status = 'completed'
      const m = `Error: ${err instanceof Error ? err.message : 'git failed'}`
      t.output = m
      this.addToolResult(t.id, m, true)
    }
    this.notify()
  }

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
      const enabledSkills2 = sm!.getEnabledSkills()
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
    t.status = 'running'; this.notify()
    try {
      // Helper: fetch all candidate tools — connected MCP tools + gated built-in tools.
      // Gated built-ins wear synthetic per-category serverIds (`builtin:<category>`,
      // e.g. `builtin:git`) so the MCP selection logic (names / serverName / intent)
      // applies to them uniformly, mirroring per-server granularity.
      const fetchCandidateTools = async () => {
        const servers = await getHost().mcpListServers()
        const all: Array<{ name: string; serverId: string; description: string; inputSchema: any }> = []
        for (const server of servers) {
          if (server.status !== 'connected') continue
          for (const tool of server.tools) {
            all.push({ name: tool.name, serverId: server.id, description: tool.description, inputSchema: tool.inputSchema })
          }
        }
        for (const def of this.opts.toolManager.getEnabledTools().map(t => t.definition)) {
          if (def.availability !== 'gated') continue
          all.push({ name: def.name, serverId: builtinCategoryServerId(def.category), description: def.description, inputSchema: def.input_schema })
        }
        return all
      }

      // Helper: format tool selection result for display
      const srcLabel = (serverId: string): string => isBuiltinServerId(serverId) ? `built-in ${serverId.slice('builtin:'.length)}` : serverId
      const selectHeader = (tools: Array<{ serverId: string }>): string => {
        const hasMcp = tools.some(t => !isBuiltinServerId(t.serverId))
        const hasBuiltin = tools.some(t => isBuiltinServerId(t.serverId))
        if (hasMcp && hasBuiltin) return '## Selected Tools'
        return hasBuiltin ? '## Selected Built-in Tools' : '## Selected MCP Tools'
      }
      const formatResult = (tools: Array<{ name: string; serverId: string; description: string; inputSchema: any }>, header: string): string => {
        const lines = tools.map(t =>
          `- **${t.name}** (from \`${srcLabel(t.serverId)}\`): ${t.description || '(no description)'}`
        )
        const schemas = tools.map(t => {
          const schema = t.inputSchema && Object.keys(t.inputSchema).length > 0
            ? `\`\`\`json\n${JSON.stringify(t.inputSchema, null, 2)}\n\`\`\``
            : '*No parameters*'
          return `**${t.name}** (from \`${srcLabel(t.serverId)}\`)\n\n${schema}`
        }).join('\n\n---\n\n')
        const hasBuiltin = tools.some(t => isBuiltinServerId(t.serverId))
        const hasMcp = tools.some(t => !isBuiltinServerId(t.serverId))
        const availability = hasBuiltin && hasMcp
          ? 'These MCP and built-in tools are now available for you to use.'
          : hasBuiltin
            ? 'These built-in tools are now available for you to use.'
            : 'These MCP tools are now available for you to use.'
        return `${header}\n\n${lines.join('\n')}\n\n### Tool Signatures\n\n${schemas}\n\n${availability}`
      }

      // ── Mode 1: direct name lookup (MCP or gated built-in tools) ──
      const namesInput = t.input?.names as string[] | undefined
      if (namesInput && Array.isArray(namesInput) && namesInput.length > 0) {
        const allTools = await fetchCandidateTools()
        const validNames: string[] = []
        const notFound: string[] = []
        for (const name of namesInput) {
          if (allTools.some(t => t.name === name)) validNames.push(name)
          else notFound.push(name)
        }
        if (validNames.length === 0) {
          this.addToolResult(t.id, `No MCP or built-in tools found matching names: ${notFound.join(', ')}.`, true)
          t.exitCode = 1; t.status = 'completed'; this.notify(); return
        }
        const matched = allTools.filter(t => validNames.includes(t.name))
        setSelectedTools(validNames)
        this.addToolResult(t.id, formatResult(matched, selectHeader(matched)), false)
        t.exitCode = 0; t.status = 'completed'; this.notify(); return
      }

      // ── Mode 2: select by server name (new) ────────────────────────
      const serverNameInput = String(t.input?.serverName || '').trim()
      if (serverNameInput) {
        const servers = await getHost().mcpListServers()
        // Match by id first, then by name (case-insensitive)
        const matchedServer = servers.find(s =>
          s.id.toLowerCase() === serverNameInput.toLowerCase() ||
          s.name.toLowerCase() === serverNameInput.toLowerCase()
        )
        if (matchedServer && matchedServer.status === 'connected') {
          const serverTools = matchedServer.tools.map(t => ({
            name: t.name,
            serverId: matchedServer.id,
            description: t.description,
            inputSchema: t.inputSchema
          }))
          const toolNames = serverTools.map(t => t.name)
          const summary = getCachedMcpServers().find(s => s.id === matchedServer.id)?.summary
          const header = summary
            ? `## Server "${matchedServer.name}" Loaded\n\n${summary}`
            : `## Server "${matchedServer.name}" Loaded (${toolNames.length} tools)`
          setSelectedTools(toolNames)
          this.addToolResult(t.id, formatResult(serverTools, header), false)
          t.exitCode = 0; t.status = 'completed'; this.notify(); return
        }

        // Built-in category fallback: serverName matches a gated category
        // (e.g. "git", "memory", "knowledge", or "builtin:git")
        const category = serverNameInput.replace(/^builtin:/, '').toLowerCase()
        const catDefs = this.opts.toolManager.getEnabledTools().map(t => t.definition).filter(d => d.availability === 'gated' && d.category === category)
        if (catDefs.length > 0) {
          const catTools = catDefs.map(d => ({
            name: d.name,
            serverId: builtinCategoryServerId(d.category),
            description: d.description,
            inputSchema: d.input_schema
          }))
          const names = catTools.map(t => t.name)
          const summary = BUILTIN_CATEGORY_SUMMARIES[category]
          const header = summary
            ? `## Built-in category "${category}" Loaded\n\n${summary}`
            : `## Built-in category "${category}" Loaded (${names.length} tools)`
          setSelectedTools(names)
          this.addToolResult(t.id, formatResult(catTools, header), false)
          t.exitCode = 0; t.status = 'completed'; this.notify(); return
        }

        this.addToolResult(t.id, `Server or category "${serverNameInput}" not found. Available servers: ${servers.filter(s => s.status === 'connected').map(s => s.id).join(', ') || '(none)'}. Available built-in categories: ${Object.keys(BUILTIN_CATEGORY_SUMMARIES).join(', ')}.`, true)
        t.exitCode = 1; t.status = 'completed'; this.notify(); return
      }

      // ── Mode 3: intent-based matching (server level) ───────────────
      const intent = String(t.input?.intent || '')
      if (!intent) throw new Error('One of "names", "serverName", or "intent" must be provided')

      t.output = `Matching intent to MCP servers and built-in tools: ${intent.slice(0, 80)}...`; this.notify()
      const allTools2 = await fetchCandidateTools()
      if (allTools2.length === 0) {
        this.addToolResult(t.id, 'No MCP or built-in tools available.', false)
        t.exitCode = 0; t.status = 'completed'; this.notify(); return
      }

      // Build server-level summary list for the server selection agent
      const servers2 = await getHost().mcpListServers()
      let serverList = servers2
        .filter(s => s.status === 'connected')
        .map(s => {
          const summary = getCachedMcpServers().find(ss => ss.id === s.id)?.summary
          return summary
            ? `- [${s.id}] ${summary}`
            : `- [${s.id}] ${s.name} (${s.tools.length} tools)`
        })
        .join('\n')
      // Synthetic rows (one per gated built-in category) so the selection agent can
      // pick built-ins at the same granularity as MCP servers.
      const gatedBuiltins = this.opts.toolManager.getEnabledTools().map(t => t.definition).filter(d => d.availability === 'gated')
      const builtinByCat = new Map<string, number>()
      for (const d of gatedBuiltins) builtinByCat.set(d.category, (builtinByCat.get(d.category) || 0) + 1)
      for (const [cat, count] of builtinByCat) {
        const summary = BUILTIN_CATEGORY_SUMMARIES[cat]
        serverList += `\n- [${builtinCategoryServerId(cat)}] ${summary || `${cat} (${count} tools)`}`
      }

      const svAgent = new ServerSelectionAgent()
      const selectedServerIds = await svAgent.execute(
        { intent, serverList },
        { llmConfig: { adapter: this.opts.adapter, apiKey: this.opts.apiKey || '', baseURL: this.opts.baseURL, model: this.opts.model }, maxTokens: 200 }
      )

      if (selectedServerIds.length === 0) {
        this.addToolResult(t.id, 'No matching servers or categories found.', false)
        t.exitCode = 0; t.status = 'completed'; this.notify(); return
      }

      // Load ALL tools from matched servers
      const matchedTools = allTools2.filter(t => selectedServerIds.includes(t.serverId))
      if (matchedTools.length === 0) {
        this.addToolResult(t.id, `No tools found for servers: ${selectedServerIds.join(', ')}.`, false)
        t.exitCode = 0; t.status = 'completed'; this.notify(); return
      }

      const selectedNames2 = matchedTools.map(t => t.name)
      const serverNames2 = [...new Set(matchedTools.map(t => t.serverId))].join(', ')
      setSelectedTools(selectedNames2)
      const headerTitle = selectHeader(matchedTools).replace('## ', '')
      this.addToolResult(t.id, formatResult(matchedTools, `## ${headerTitle} from: ${serverNames2}`), false)
      t.exitCode = 0
    } catch (err) { this.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'pick_tool failed'}`, true); t.exitCode = -1 }
    t.status = 'completed'; this.notify()
  }

  // ── Spawn agent tool ───────────────────────────────────────────────────

  async execSpawnAgent(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const subAgentId = String(t.input?.subAgentId || '').trim()
      const task = String(t.input?.task || '')
      if (!subAgentId) throw new Error('subAgentId is required — select the most suitable sub-agent from the available list')
      if (!task.trim()) throw new Error('task is required')

      let allowedTools: string[] = ['read', 'write', 'edit', 'list_dir', 'search', 'find', 'exec']
      let allowedMcpServers: string[] = ['chrome-devtools']
      let maxTokens: number | undefined
      let maxLoopIterations: number | undefined
      let basePrompt = ''
      let disabledError: Error | null = null
      try {
        const profiles = await getHost().subagentList()
        const profile = profiles.find((p: any) => p.id === subAgentId)
        if (profile) {
          if (profile.enabled === false) {
            disabledError = new Error(`子代理 "${profile.name || subAgentId}" 已关闭，请在 设置 → 子代理管理 中启用后再使用`)
          }
          if (profile.allowedTools?.length) allowedTools = profile.allowedTools
          if (profile.allowedMcpServers?.length) allowedMcpServers = profile.allowedMcpServers
          if (profile.maxTokens) maxTokens = profile.maxTokens
          if (profile.maxLoopIterations) maxLoopIterations = profile.maxLoopIterations
          basePrompt = profile.basePrompt || ''
        } else {
          console.warn(`[execSpawnAgent] Sub-agent "${subAgentId}" not found, falling back to defaults`)
        }
      } catch { /* fallback */ }
      if (disabledError) throw disabledError
      if (!basePrompt) {
        basePrompt = `You are a sub-agent executing a delegated task.

    Guidelines:
    - Focus exclusively on the task above. Ignore anything not relevant to it.
    - You CANNOT install skills or modify tool preferences.
    - When you complete the task, provide a concise summary of your findings.
    - Do NOT ask the user for input — work autonomously.`
      }

      const toolList = allowedTools.map(t => `- \`${t}\``).join('\n')
      const mcpList = allowedMcpServers.map(id => `- ${id}`).join('\n')

      // Append available skills context
      let skillsCtx = ''
      try {
        const skillsAppendix = this.opts.skillManager?.getSystemPromptAppendix()
        if (skillsAppendix) skillsCtx = '\n\n' + skillsAppendix
      } catch { /* non-critical */ }

      const systemPrompt = `${basePrompt}\n\n## Your Task\n${task}\n\n## Available Tools\n${toolList}\n\n## Available MCP Servers\n${mcpList || '(none)'}${skillsCtx}`

      console.log(`[spawn_agent] subAgentId="${subAgentId}" basePrompt length=${basePrompt.length} first 200 chars:`, basePrompt.slice(0, 200))
      t.output = `Spawning sub-agent for task: ${task.slice(0, 100)}...`
      this.notify()

      const handle = this.spawnSubAgent!({
        systemPrompt,
        initialMessages: [],
        allowedTools,
        allowedMcpServers,
        maxTokens: maxTokens || this.opts.maxTokens,
        maxLoopIterations: maxLoopIterations || 20,
        onProgress: (summary) => {
          // Rolling activity log (cap 8 lines) so the user sees the sub-agent moving live.
          const lines = (t.output || '').split('\n')
          lines.push(summary)
          while (lines.length > 8) lines.shift()
          t.output = lines.join('\n')
          this.notify()
        },
      })

      // Set _subConvId immediately so parent conversation saves link to sub-agent conversation
      // even if the app restarts before the sub-agent completes.
      ;(t as any)._subConvId = handle.subConvId
      // Keep handle reference for live preview while the sub-agent is running.
      // Non-enumerable so JSON.stringify skips it — avoids serializing the entire engine state.
      Object.defineProperty(t, '_subAgentHandle', { value: handle, writable: true, enumerable: false, configurable: true })
      this.notify()

      const result = await handle.waitForCompletion()
      const subAssistantTexts = result.messages
        .filter(m => m.role === 'assistant')
        .flatMap(m => m.contentBlocks)
      const subText = subAssistantTexts.filter(b => b.type === 'text').map(b => (b as TextBlock).text).join('\n\n').slice(0, SUBAGENT_TEXT_MAX)
      const subTools = subAssistantTexts.filter(b => b.type === 'tool_use').map(b => `[tool_use: ${(b as ToolUseBlock).name}]`).join(', ')
      const errorDetail = result.status !== 'completed'
        ? `\n\n### Sub-agent Status: ${result.status}\n` + (subText ? `**Partial Output:**\n${subText}` : '') + (subTools ? `\n**Tool Calls Attempted:** ${subTools}` : '')
        : ''
      const summary = result.status === 'completed'
        ? `## Sub-Agent Result (${result.status})\n\nThe sub-agent completed the delegated task.\n\n### Summary\n${subText}`
        : `## Sub-Agent Result (${result.status})\n\nThe sub-agent did not complete successfully.${errorDetail}`

      t.exitCode = result.status === 'completed' ? 0 : 1
      t.status = 'completed'
      this.addToolResult(t.id, summary, result.status === 'error')
      t.output = `子代理已完成. ${subText}`
    } catch (err) {
      t.exitCode = -1
      t.status = 'completed'
      this.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'spawn_agent failed'}`, true)
    }
    this.notify()
  }

  // ── Catch-all tool executor ───────────────────────────────────────────

  async execOtherTool(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      if (await this.execMemoryTool(t)) return
      if (await this.execConversationTool(t)) return
      if (await this.execKnowledgeTool(t)) return
      if (await this.execExperienceTool(t)) return
      this.addToolResult(t.id, `Unknown tool: ${t.name}`, true)
    } catch (err) {
      this.addToolResult(t.id, `Tool failed: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  private async execMemoryTool(t: ToolUseBlock): Promise<boolean> {
      if (t.name === 'memory_search') {
        const mm = this.opts.memoryManager
        if (mm) {
          const q = String(t.input.query || ''); const cat = String(t.input.category || '') as any; const lim = Number(t.input.limit) || 5
          const results = await mm.searchMemories({ query: q, category: cat, limit: lim })
          const formatted = results.length > 0 ? results.map((r, i) => `[${i + 1}] ${r.content} (${r.type}, ${r.category}, ${new Date(r.createdAt).toLocaleDateString()})`).join('\n') : 'No matching memories found.'
          t.output = formatted.slice(0, MEMORY_PREVIEW_MAX); this.addToolResult(t.id, formatted, false); t.exitCode = 0
        } else { t.output = 'Memory manager not available'; this.addToolResult(t.id, 'Memory manager not available', true); t.exitCode = 1 }
      return true
      }
      if (t.name === 'memory_save') {
        const mm = this.opts.memoryManager; const content = String(t.input.content || '')
        if (!content.trim()) { this.addToolResult(t.id, 'Nothing to save — content was empty.', true); t.exitCode = 1 }
        else {
          const type = (String(t.input.type || 'fact') as any); const cat = (String(t.input.category || 'general') as any)
          const entry = await mm!.saveMemory({ content, type, category: cat })
          if (entry) {
            this.onMemorySaved?.()
          }
          t.output = entry ? content.slice(0,200) : 'Already in memory'; this.addToolResult(t.id, entry ? `Saved to memory: "${content}" (${type}, ${cat})` : `Already in memory (duplicate): "${content}"`, false)
          t.exitCode = 0
        }
      return true
      }
    return false
  }

  private async execConversationTool(t: ToolUseBlock): Promise<boolean> {
      if (t.name === 'conversation_search') {
        const query = String(t.input.query || '').trim()
        const convId2 = String(t.input.id || '').trim()
        const dateFilter: Record<string, string> = {}
        if (t.input.createdAfter) dateFilter.createdAfter = String(t.input.createdAfter)
        if (t.input.createdBefore) dateFilter.createdBefore = String(t.input.createdBefore)
        if (t.input.updatedAfter) dateFilter.updatedAfter = String(t.input.updatedAfter)
        if (t.input.updatedBefore) dateFilter.updatedBefore = String(t.input.updatedBefore)
        if (query && !convId2) {
          const results = await getHost().searchConversationsByKeyword(query)
          if (results.length === 0) {
            this.addToolResult(t.id, `No conversations found matching "${query}".`, false)
          } else {
            const parts = results.map(r =>
              `- **${r.title}** (ID: \`${r.id}\`)\n  Summary: ${r.summary || '(no summary)'}\n  Keywords: ${r.keywords || '(none)'}\n  Updated: ${r.updatedAt}`
            )
            this.addToolResult(t.id, `## Conversations matching "${query}"\n\nFound ${results.length} conversation(s):\n\n` + parts.join('\n\n'), false)
          }
          t.exitCode = 0
        } else if (convId2) {
          const conv = await getHost().getConversation(convId2)
          if (conv) { const parts = [`**Title:** ${conv.title}`]; if (conv.summary) parts.push(`**Summary:** ${conv.summary}`); parts.push(`**ID:** ${conv.id}`); this.addToolResult(t.id, parts.join('\n'), false) }
          else { this.addToolResult(t.id, `Conversation "${convId2}" not found.`, false) }
          t.exitCode = 0
        } else {
          this.addToolResult(t.id, 'Error: provide either "query" (keyword search) or "id" (direct lookup).', true); t.exitCode = 1
        }
      return true
      }
      if (t.name === 'tool_result_search') {
        const ids = t.input.ids as string[] | undefined
        if (!ids || ids.length === 0) {
          this.addToolResult(t.id, 'Error: at least one tool_result_id is required.', true); t.exitCode = 1
        } else {
          try {
            const results = await getHost().getToolResult(ids)
            if (results.length === 0) {
              this.addToolResult(t.id, `No tool results found for IDs: ${ids.join(', ')}`, false)
            } else {
              const parts = results.map(r =>
                `[ref_id: ${r.ref_id}]\nConversation: ${r.conversation_id}\nTool use: ${r.tool_use_id}\n\n${r.content}`
              )
              this.addToolResult(t.id, parts.join('\n\n---\n\n'), false)
            }
            t.exitCode = 0
          } catch (e) {
            this.addToolResult(t.id, `Error looking up tool results: ${e}`, true); t.exitCode = 1
          }
        }
      return true
      }
    return false
  }

  private async execKnowledgeTool(t: ToolUseBlock): Promise<boolean> {
      if (t.name === 'knowledge_search') {
        const km = this.opts.knowledgeManager
        if (!km) {
          t.output = 'Knowledge base not available.'; this.addToolResult(t.id, 'Knowledge base not available.', true); t.exitCode = 1
        } else {
          const query = String(t.input.query || '').toLowerCase()
          const mode = String(t.input.mode || 'title')
          const sourceType = String(t.input.sourceType || '')
          const status = String(t.input.status || '')
          const doContentSearch = (mode === 'content' || mode === 'both') && !!query

          let contentMatchIds = new Set<string>()
          let contentExcerpts = new Map<string, string[]>()
          if (doContentSearch) {
            const matches = await km.searchContent(query)
            for (const m of matches) {
              contentMatchIds.add(m.id)
              contentExcerpts.set(m.id, m.excerpts)
            }
          }

          // Push filtering to SQL instead of pulling all files into memory
          let filtered: KnowledgeFile[] = []
          const buildOpts = (search?: string) => {
            const opts: Record<string, any> = { pageSize: 200 }
            if (search) opts.search = search
            if (sourceType) opts.sourceType = sourceType
            if (status) opts.status = status
            return opts
          }

          if (mode === 'wiki') {
            // Wiki mode: ripgrep search across compiled wiki pages (fastest path)
            const matches = query ? await km.searchWiki(query) : []
            if (matches.length === 0) {
              t.output = 'No matching wiki pages found.'; this.addToolResult(t.id, 'No matching wiki pages found.', false)
            } else {
              const lines = matches.map(m => {
                const typeLabel: Record<string, string> = { sources: '原始资料', entities: '实体', concepts: '概念', syntheses: '综合' }
                return [
                  `- **${m.title}** (${typeLabel[m.type] || m.type})`,
                  `  路径: \`${m.wikiPath}\``,
                  `  片段: ${m.content}`,
                  `  \`knowledge_read\` 参数: path="${m.wikiPath}", type="wiki"`
                ].join('\n')
              })
              const stats = `找到 ${matches.length} 个 wiki 页面 (mode=wiki):\n` + lines.join('\n')
              t.output = stats.slice(0, UI_PREVIEW_MAX); this.addToolResult(t.id, stats, false)
            }
            t.exitCode = 0
          } else if (mode === 'content') {
            // Content-only: SQL filters sourceType/status, JS narrows by FTS5
            const result = await km.listFilesAdvanced(buildOpts())
            filtered = result.items.filter(f => contentMatchIds.has(f.id))
          } else if (mode === 'both') {
            // Both: SQL filters by title/path + sourceType/status, merge FTS5 matches
            const result = await km.listFilesAdvanced(buildOpts(query))
            filtered = result.items
            if (contentMatchIds.size > 0) {
              const titleMatchIds = new Set(filtered.map(f => f.id))
              const extraIds = [...contentMatchIds].filter(id => !titleMatchIds.has(id))
              if (extraIds.length > 0) {
                const extra = await km.listFilesAdvanced(buildOpts())
                for (const f of extra.items) {
                  if (extraIds.includes(f.id)) filtered.push(f)
                }
              }
            }
          } else {
            // Title mode (default) — SQL handles title/path LIKE + sourceType/status
            const result = await km.listFilesAdvanced(buildOpts(query))
            filtered = result.items
            // Fallback: no title match → try content search (for CJK queries)
            if (filtered.length === 0 && query) {
              const fallbackMatches = await km.searchContent(query)
              if (fallbackMatches.length > 0) {
                const fallbackIds = new Set(fallbackMatches.map(m => m.id))
                const fallback = await km.listFilesAdvanced(buildOpts())
                filtered = fallback.items.filter(f => fallbackIds.has(f.id))
                for (const m of fallbackMatches) {
                  contentExcerpts.set(m.id, m.excerpts)
                }
              }
            }
          }

          if (filtered.length === 0) {
            t.output = 'No matching knowledge files found.'; this.addToolResult(t.id, 'No matching knowledge files found.', false)
          } else {
            const lines = filtered.map(f => {
              let readSuggestion: string
              if (f.status === 'compiled' && f.wikiOutputs && f.wikiOutputs.length > 0) {
                const wikiCmds = f.wikiOutputs.map(wp => `\`knowledge_read\` 参数: path="${wp}", type="wiki"`).join('\n  ')
                readSuggestion = `${wikiCmds}\n  \`knowledge_read\` 参数: path="${f.filePath}", type="raw"`
              } else {
                readSuggestion = `\`knowledge_read\` 参数: path="${f.filePath}", type="raw"`
              }
              const line = `- **${f.title || f.filePath}** (${f.sourceType === 'url' ? '链接' : f.sourceType === 'file' ? '文件' : f.sourceType}, ${f.status === 'compiled' ? '已编译' : '原始'})\n  ${readSuggestion}`
              const ex = contentExcerpts.get(f.id)
              if (ex && ex.length > 0) {
                return line + '\n  ' + ex.map(e => `...${e}...`).join('\n  ')
              }
              return line
            })
            const stats = `找到 ${filtered.length} 个知识文件:\n` + lines.join('\n')
            t.output = stats.slice(0, UI_PREVIEW_MAX); this.addToolResult(t.id, stats, false)
          }
          t.exitCode = 0
        }
      return true
      }
      if (t.name === 'knowledge_read') {
        const km = this.opts.knowledgeManager
        const filePath = String(t.input.path || '')
        const readType = String(t.input.type || 'wiki')
        if (!filePath) {
          t.output = 'Error: path is required.'; this.addToolResult(t.id, 'Error: path is required.', true); t.exitCode = 1
        } else if (!km) {
          t.output = 'Knowledge base not available.'; this.addToolResult(t.id, 'Knowledge base not available.', true); t.exitCode = 1
        } else {
          try {
            let content: string | null = null
            if (readType === 'raw') {
              content = await km.readRawContent(filePath)
            } else {
              const result = await km.readWiki(filePath)
              content = result.content
            }
            if (content) {
              t.output = content.slice(0, UI_PREVIEW_MAX); this.addToolResult(t.id, content, false)
            } else {
              t.output = `File "${filePath}" not found in knowledge base.`; this.addToolResult(t.id, `File "${filePath}" not found in knowledge base.`, false)
            }
            t.exitCode = 0
          } catch {
            t.output = `Error reading "${filePath}" from knowledge base.`; this.addToolResult(t.id, `Error reading "${filePath}" from knowledge base.`, true)
            t.exitCode = 1
          }
        }
      return true
      }
    return false
  }

  private async execExperienceTool(t: ToolUseBlock): Promise<boolean> {
      if (t.name === 'experience_read') {
        const name = String(t.input.name || '')
        if (!name) {
          t.output = 'Error: name is required.'; this.addToolResult(t.id, 'Error: name is required.', true); t.exitCode = 1
        } else {
          try {
            const content = await getHost().readExperienceRecord(name)
            if (content) {
              // Touching records that the experience was actually used — feeds the LRU eviction
              getHost().touchExperienceRecord(name).catch(() => {})
              t.output = content.slice(0, UI_PREVIEW_MAX); this.addToolResult(t.id, content, false)
            } else {
              t.output = `Experience "${name}" not found.`; this.addToolResult(t.id, `Experience "${name}" not found.`, false)
            }
            t.exitCode = 0
          } catch {
            t.output = `Error reading experience "${name}".`; this.addToolResult(t.id, `Error reading experience "${name}".`, true)
            t.exitCode = 1
          }
        }
      } else {
        const platform = this.opts.platformInfo?.platform || ''
        const command = buildCommandFromSkillInput(t.name, t.input || {}, platform, this.opts.platformInfo?.ripgrepPath)
        const cwd = String(t.input?.cwd || '')
        t.output = ''; this.notify()
        await new Promise<void>((resolve) => {
          let stdoutBuf = ''
          let stderrBuf = ''
          let settled = false
          const unsubList: (() => void)[] = []
          const finish = (exitCode: number | null, isError: boolean) => {
            if (settled) return; settled = true
            t.exitCode = exitCode
            const formatted = this.formatExecResult(exitCode, stdoutBuf, stderrBuf)
            t.output = formatted
            this.addToolResult(t.id, formatted, isError)
            unsubList.forEach(fn => fn()); resolve()
          }
          const uo = getHost().onTerminalOutput(d => {
            if (d.type === 'stderr') stderrBuf += d.data
            else stdoutBuf += d.data
            t.output = stdoutBuf + stderrBuf
            this.notify()
          }); unsubList.push(uo)
          const ue = getHost().onTerminalExit(d => finish(d.code, d.code !== 0)); unsubList.push(ue)
          const uerr = getHost().onTerminalError(d => { stderrBuf += `\n[Error: ${d.message}]`; finish(-1, true) }); unsubList.push(uerr)
          getHost().executeCommand(command, cwd || undefined, t.input.timeout != null ? Number(t.input.timeout) * 1000 : undefined)
            .then(pid => { this.onProcessStart?.(pid) })
            .catch(err => { stderrBuf += `\n[Error: ${err instanceof Error ? err.message : 'Failed'}]`; finish(-1, true) })
        })
      return true
      }

    return false
  }
}
