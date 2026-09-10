/**
 * Git tool (PLAN-0.3.5 class-size refactor): build/format/execute extracted
 * from ToolExecutor as pure functions over an explicit deps object.
 */
import { getHost } from '../host'
import type { ToolUseBlock } from '../../types/agent'
import type { AgentEngineOptions } from '../AgentEngine'
import type { GitAction, GitResult, GitStatusInfo, GitDiffResult, GitLogEntry, GitCommitResult, GitRestorePreview } from '../../../../shared/types/git'

export interface GitToolDeps {
  opts: AgentEngineOptions
  addToolResult(toolUseId: string, content: string, isError: boolean): void
  notify(): void
}

export async function execGitTool(deps: GitToolDeps, t: ToolUseBlock): Promise<void> {
    t.status = 'running'; deps.notify()
    try {
      const cwd = String(t.input?.cwd || deps.opts.workspaceDir || '')
      const action = buildGitAction(t.name, (t.input || {}) as Record<string, unknown>, cwd)
      const result = await getHost().gitInvoke(action)
      const text = formatGitResult(t.name, result)
      t.exitCode = result.ok ? 0 : 1
      t.status = 'completed'
      t.output = text
      deps.addToolResult(t.id, text, !result.ok)
    } catch (err) {
      t.exitCode = 1; t.status = 'completed'
      const m = `Error: ${err instanceof Error ? err.message : 'git failed'}`
      t.output = m
      deps.addToolResult(t.id, m, true)
    }
    deps.notify()
  }

  /** Build a GitAction from a git_* tool call. */
export function buildGitAction(name: string, input: Record<string, unknown>, cwd: string): GitAction {
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
export function formatGitResult(name: string, result: GitResult): string {
    if (!result.ok) return `Git error: ${result.error?.message ?? 'unknown'}`
    switch (name) {
      case 'git_status': {
        const data = result.data as GitStatusInfo | undefined
        if (!data?.isRepo) return '(not a git repository — nothing to report)'
        const lines = [`Branch: ${data.branch ?? '(detached)'}${data.ahead ? ` | ahead ${data.ahead}` : ''}${data.behind ? ` | behind ${data.behind}` : ''}`]
        if (data.staged?.length) lines.push(`Staged (${data.staged.length}):`, ...data.staged.map((f: string) => `  ${f}`))
        if (data.unstaged?.length) lines.push(`Unstaged (${data.unstaged.length}):`, ...data.unstaged.map((f: string) => `  ${f}`))
        if (data.untracked?.length) lines.push(`Untracked (${data.untracked.length}):`, ...data.untracked.map((f: string) => `  ${f}`))
        if (data.conflict?.length) lines.push(`Conflicts (${data.conflict.length}):`, ...data.conflict.map((f: string) => `  ${f}`))
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
