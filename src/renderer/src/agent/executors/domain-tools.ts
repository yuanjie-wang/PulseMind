// ── Memory / conversation / knowledge / experience tools (moved out of
// ToolExecutor 0.4.1) ── dispatched by execOtherTool.

import { getHost } from '../host'
import { buildCommandFromSkillInput } from '../command-builder'
import { beginTerminalSpan } from '../terminal-span'
import type { ToolUseBlock } from '../../types/agent'
import type { KnowledgeFile } from '../../../../shared/types/knowledge'
import { UI_PREVIEW_MAX, type ToolExecContext } from './context'

/** memory_search: tool block .output preview. */
const MEMORY_PREVIEW_MAX = 2000

export async function execMemoryTool(ex: ToolExecContext, t: ToolUseBlock): Promise<boolean> {
    if (t.name === 'memory_search') {
      const mm = ex.opts.memoryManager
      if (mm) {
        const q = String(t.input.query || ''); const cat = String(t.input.category || '') as any; const lim = Number(t.input.limit) || 5
        const results = await mm.searchMemories({ query: q, category: cat, limit: lim })
        const formatted = results.length > 0 ? results.map((r, i) => `[${i + 1}] ${r.content} (${r.type}, ${r.category}, ${new Date(r.createdAt).toLocaleDateString()})`).join('\n') : 'No matching memories found.'
        t.output = formatted.slice(0, MEMORY_PREVIEW_MAX); ex.addToolResult(t.id, formatted, false); t.exitCode = 0
      } else { t.output = 'Memory manager not available'; ex.addToolResult(t.id, 'Memory manager not available', true); t.exitCode = 1 }
    return true
    }
    if (t.name === 'memory_save') {
      const mm = ex.opts.memoryManager; const content = String(t.input.content || '')
      if (!content.trim()) { ex.addToolResult(t.id, 'Nothing to save — content was empty.', true); t.exitCode = 1 }
      else {
        const type = (String(t.input.type || 'fact') as any); const cat = (String(t.input.category || 'general') as any)
        const entry = await mm!.saveMemory({ content, type, category: cat })
        // No prompt-cache bookkeeping here: the session-state block is rebuilt on
        // every request, so a memory saved now is visible to the very next call.
        t.output = entry ? content.slice(0,200) : 'Already in memory'; ex.addToolResult(t.id, entry ? `Saved to memory: "${content}" (${type}, ${cat})` : `Already in memory (duplicate): "${content}"`, false)
        t.exitCode = 0
      }
    return true
    }
  return false
}

export async function execConversationTool(ex: ToolExecContext, t: ToolUseBlock): Promise<boolean> {
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
          ex.addToolResult(t.id, `No conversations found matching "${query}".`, false)
        } else {
          const parts = results.map(r =>
            `- **${r.title}** (ID: \`${r.id}\`)\n  Summary: ${r.summary || '(no summary)'}\n  Keywords: ${r.keywords || '(none)'}\n  Updated: ${r.updatedAt}`
          )
          ex.addToolResult(t.id, `## Conversations matching "${query}"\n\nFound ${results.length} conversation(s):\n\n` + parts.join('\n\n'), false)
        }
        t.exitCode = 0
      } else if (convId2) {
        const conv = await getHost().getConversation(convId2)
        if (conv) { const parts = [`**Title:** ${conv.title}`]; if (conv.summary) parts.push(`**Summary:** ${conv.summary}`); parts.push(`**ID:** ${conv.id}`); ex.addToolResult(t.id, parts.join('\n'), false) }
        else { ex.addToolResult(t.id, `Conversation "${convId2}" not found.`, false) }
        t.exitCode = 0
      } else {
        ex.addToolResult(t.id, 'Error: provide either "query" (keyword search) or "id" (direct lookup).', true); t.exitCode = 1
      }
    return true
    }
    if (t.name === 'tool_result_search') {
      const ids = t.input.ids as string[] | undefined
      if (!ids || ids.length === 0) {
        ex.addToolResult(t.id, 'Error: at least one tool_result_id is required.', true); t.exitCode = 1
      } else {
        try {
          const results = await getHost().getToolResult(ids)
          if (results.length === 0) {
            ex.addToolResult(t.id, `No tool results found for IDs: ${ids.join(', ')}`, false)
          } else {
            const parts = results.map(r =>
              `[ref_id: ${r.ref_id}]\nConversation: ${r.conversation_id}\nTool use: ${r.tool_use_id}\n\n${r.content}`
            )
            ex.addToolResult(t.id, parts.join('\n\n---\n\n'), false)
          }
          t.exitCode = 0
        } catch (e) {
          ex.addToolResult(t.id, `Error looking up tool results: ${e}`, true); t.exitCode = 1
        }
      }
    return true
    }
  return false
}

export async function execKnowledgeTool(ex: ToolExecContext, t: ToolUseBlock): Promise<boolean> {
    if (t.name === 'knowledge_search') {
      const km = ex.opts.knowledgeManager
      if (!km) {
        t.output = 'Knowledge base not available.'; ex.addToolResult(t.id, 'Knowledge base not available.', true); t.exitCode = 1
      } else {
        // G5: an @知识库 mention scopes this turn's searches to one base
        // (undefined = the whole base). Every search shape below funnels it.
        const scopeBaseId = ex.opts.knowledgeBaseScope?.id ?? undefined
        const query = String(t.input.query || '').toLowerCase()
        const mode = String(t.input.mode || 'title')
        const sourceType = String(t.input.sourceType || '')
        const status = String(t.input.status || '')
        const doContentSearch = (mode === 'content' || mode === 'both') && !!query

        const contentMatchIds = new Set<string>()
        const contentExcerpts = new Map<string, string[]>()
        if (doContentSearch) {
          const matches = await km.searchContent(query, scopeBaseId)
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
          if (scopeBaseId !== undefined) opts.baseId = scopeBaseId
          return opts
        }

        if (mode === 'wiki') {
          // Wiki mode: ripgrep search across compiled wiki pages (fastest path)
          let matches = query ? await km.searchWiki(query, scopeBaseId) : []
          if (matches.length === 0) {
            t.output = 'No matching wiki pages found.'; ex.addToolResult(t.id, 'No matching wiki pages found.', false)
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
            t.output = stats.slice(0, UI_PREVIEW_MAX); ex.addToolResult(t.id, stats, false)
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
            const fallbackMatches = await km.searchContent(query, scopeBaseId)
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
          t.output = 'No matching knowledge files found.'; ex.addToolResult(t.id, 'No matching knowledge files found.', false)
        } else {
          const lines = filtered.map(f => {
            let readSuggestion: string
            if (f.status === 'compiled' && f.wikiOutputs && f.wikiOutputs.length > 0) {
              const wikiCmds = f.wikiOutputs.map(wp => `\`knowledge_read\` 参数: path="${wp}", type="wiki"`).join('\n  ')
              readSuggestion = `${wikiCmds}\n  \`knowledge_read\` 参数: path="${f.filePath}", type="raw"`
            } else {
              readSuggestion = `\`knowledge_read\` 参数: path="${f.filePath}", type="raw"`
            }
            // H2: non-default bases must name themselves — the read resolves
            // through bases/<id>/, and without the base parameter a hit from
            // another base reads the default one and fails.
            if (f.baseId && f.baseId !== 'default') {
              readSuggestion += `, base="${f.baseId}"`
            }
            const line = `- **${f.title || f.filePath}** (${f.sourceType === 'url' ? '链接' : f.sourceType === 'file' ? '文件' : f.sourceType}, ${f.status === 'compiled' ? '已编译' : '原始'})\n  ${readSuggestion}`
            const ex = contentExcerpts.get(f.id)
            if (ex && ex.length > 0) {
              return line + '\n  ' + ex.map(e => `...${e}...`).join('\n  ')
            }
            return line
          })
          const stats = `找到 ${filtered.length} 个知识文件:\n` + lines.join('\n')
          t.output = stats.slice(0, UI_PREVIEW_MAX); ex.addToolResult(t.id, stats, false)
        }
        t.exitCode = 0
      }
    return true
    }
    if (t.name === 'knowledge_read') {
      const km = ex.opts.knowledgeManager
      const filePath = String(t.input.path || '')
      // K6: the DOC said default raw while the code defaulted wiki — docs and
      // implementation now agree (default wiki), and a miss in the named
      // directory falls back to the other one, with the result noting where
      // the content actually came from.
      const readType = String(t.input.type || 'wiki')
      // H2: an explicit `base` wins; otherwise the turn's @知识库 scope; the
      // default base is the last resort. All three ride every read below.
      const readBaseId = (typeof t.input.base === 'string' && t.input.base.trim() !== '')
        ? t.input.base.trim()
        : (ex.opts.knowledgeBaseScope?.id ?? undefined)
      const offset = Math.max(1, Math.floor(Number(t.input.offset) || 1))
      const lineCount = Math.max(0, Math.floor(Number(t.input.lines) || 0))
      if (!filePath) {
        t.output = 'Error: path is required.'; ex.addToolResult(t.id, 'Error: path is required.', true); t.exitCode = 1
      } else if (!km) {
        t.output = 'Knowledge base not available.'; ex.addToolResult(t.id, 'Knowledge base not available.', true); t.exitCode = 1
      } else {
        try {
          let content: string | null = null
          let actualType = readType
          if (readType === 'raw') {
            content = await km.readRawContent(filePath, readBaseId).catch(() => null)
            if (content === null) {
              const result = await km.readWiki(filePath, readBaseId)
              content = result.content
              if (content !== null) actualType = 'wiki'
            }
          } else {
            const result = await km.readWiki(filePath, readBaseId)
            content = result.content
            if (content === null) {
              content = await km.readRawContent(filePath, readBaseId).catch(() => null)
              if (content !== null) actualType = 'raw'
            }
          }
          if (content) {
            // Paging happens INSIDE the knowledge dirs — the content no longer
            // has to ride the 4000-token truncation + tmp offload path.
            const allLines = content.split('\n')
            const start = offset - 1
            const page = lineCount > 0 ? allLines.slice(start, start + lineCount) : allLines.slice(start)
            const header = `[type=${actualType}${actualType !== readType ? `, fallback from ${readType}` : ''}]`
            const footer = start + page.length < allLines.length
              ? `\n\n[... ${allLines.length - start - page.length} more lines — read again with offset=${start + page.length + 1}]`
              : ''
            const paged = header + '\n' + page.join('\n') + footer
            t.output = paged.slice(0, UI_PREVIEW_MAX); ex.addToolResult(t.id, paged, false)
          } else {
            t.output = `File "${filePath}" not found in knowledge base.`; ex.addToolResult(t.id, `File "${filePath}" not found in knowledge base.`, false)
          }
          t.exitCode = 0
        } catch {
          t.output = `Error reading "${filePath}" from knowledge base.`; ex.addToolResult(t.id, `Error reading "${filePath}" from knowledge base.`, true)
          t.exitCode = 1
        }
      }
    return true
    }
  return false
}

export async function execExperienceTool(ex: ToolExecContext, t: ToolUseBlock): Promise<boolean> {
    if (t.name === 'experience_read') {
      const name = String(t.input.name || '')
      if (!name) {
        t.output = 'Error: name is required.'; ex.addToolResult(t.id, 'Error: name is required.', true); t.exitCode = 1
      } else {
        try {
          const content = await getHost().readExperienceRecord(name)
          if (content) {
            // Touching records that the experience was actually used — feeds the LRU eviction
            getHost().touchExperienceRecord(name).catch(() => {})
            t.output = content.slice(0, UI_PREVIEW_MAX); ex.addToolResult(t.id, content, false)
          } else {
            t.output = `Experience "${name}" not found.`; ex.addToolResult(t.id, `Experience "${name}" not found.`, false)
          }
          t.exitCode = 0
        } catch {
          t.output = `Error reading experience "${name}".`; ex.addToolResult(t.id, `Error reading experience "${name}".`, true)
          t.exitCode = 1
        }
      }
    } else {
      const platform = ex.opts.platformInfo?.platform || ''
      const command = buildCommandFromSkillInput(t.name, t.input || {}, platform, ex.opts.platformInfo?.ripgrepPath)
      const cwd = String(t.input?.cwd || '')
      t.output = ''; ex.notify()
      await new Promise<void>((resolve) => {
        let stdoutBuf = ''
        let stderrBuf = ''
        let settled = false
        // The terminal bus broadcasts by channel — concurrent engines' process
        // events land here too (PLAN-parallel-experts T7): the span filters by
        // processId and parks the window before executeCommand returns a pid.
        const span = beginTerminalSpan(getHost(), {
          onOutput: d => {
            if (d.type === 'stderr') stderrBuf += d.data
            else stdoutBuf += d.data
            t.output = stdoutBuf + stderrBuf
            ex.notify()
          },
          onExit: d => finish(d.code, d.code !== 0),
          onError: d => { stderrBuf += `\n[Error: ${d.message}]`; finish(-1, true) },
        })
        span.start()
        const finish = (exitCode: number | null, isError: boolean) => {
          if (settled) return; settled = true
          span.stop()
          t.exitCode = exitCode
          const formatted = ex.formatExecResult(exitCode, stdoutBuf, stderrBuf)
          t.output = formatted
          ex.addToolResult(t.id, formatted, isError)
          resolve()
        }
        getHost().executeCommand(command, cwd || undefined, t.input.timeout != null ? Number(t.input.timeout) * 1000 : undefined)
          .then(pid => { ex.onProcessStart?.(pid); span.claim(pid) })
          .catch(err => { stderrBuf += `\n[Error: ${err instanceof Error ? err.message : 'Failed'}]`; finish(-1, true) })
      })
    return true
    }

  return false
}