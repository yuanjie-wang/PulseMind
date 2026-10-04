// ── Memory / conversation / knowledge / experience tools (moved out of
// ToolExecutor 0.4.1) ── dispatched by execOtherTool.

import { getHost } from '../host'
import { buildCommandFromSkillInput } from '../command-builder'
import { beginTerminalSpan } from '../terminal-span'
import type { ToolUseBlock } from '../../types/agent'
import type { KnowledgeFile } from '../../../../shared/types/knowledge'
import { EXPERIENCE_CATEGORIES, type ExperienceDraft } from '../../../../shared/types/experience-types'
import { UI_PREVIEW_MAX, type ToolExecContext, type CompactToolOutcome } from './context'

/** memory_search: tool block .output preview. */
const MEMORY_PREVIEW_MAX = 2000

/** freed/skipped 点名回执段——成功与拒绝信封共用。free_results 豁免主动作的
 *  全部守卫，mandate 在拒绝返回前已写入（下一请求即压缩）：拒绝信封若丢回执，
 *  模型点名的压缩就「生效了却没有凭据」（review 2026-10-04 中1）。 */
function formatFreeResultsReceipt(o: CompactToolOutcome): string[] {
  const lines: string[] = []
  if (o.freedResults?.length) {
    lines.push(`已压缩 ${o.freedResults.length} 条点名结果为占位符（下一请求生效），原文经 tool_result_search 取回。`)
  }
  if (o.skippedIds?.length) {
    const label: Record<string, string> = {
      tier3_protected: '受保护类别，永不压缩',
      recent_protected: '最近 4 轮保护内',
      unknown_id: '查无此 id',
    }
    const rows = o.skippedIds.map((s) => `- ${s.id}（${label[s.reason] ?? s.reason}）`)
    lines.push(`跳过 ${o.skippedIds.length} 条点名：\n${rows.join('\n')}`)
  }
  return lines
}

/** context_compact 结果信封（PLAN-context-compact-tool §3）：最后字节点名
 *  下一步——模型靠工具结果的最后字节决定下一个动作，压缩成功的收尾必须
 *  明确「继续任务，不要收尾」。拒绝路径同样回执已生效的 free_results 点名。 */
function formatCompactOutcome(o: CompactToolOutcome, hadNotes: boolean): string {
  if (!o.ok) {
    let refusal: string
    switch (o.reason) {
      case 'request_in_flight':
        refusal = '当前有请求在飞，无法压缩。等当前回合的这一轮结束后再调用。'
        break
      case 'already_this_turn':
        refusal = '本回合已压缩过（每回合至多一次主动压缩）。继续当前任务。'
        break
      case 'not_worthwhile': {
        const pct = o.window ? Math.round(((o.tokens ?? 0) / o.window) * 100) : 0
        const k = (n?: number) => `${Math.round((n ?? 0) / 1024)}K`
        refusal = `当前上下文约占窗口的 ${pct}%（~${k(o.tokens)} / ${k(o.window)} tokens），无需压缩。请在真正的阶段边界（探索完成/话题切换）再调用。`
        break
      }
      case 'nothing_to_drop':
        refusal = '没有可归档的工具循环——剩余重量是文本消息，只有自动层在窗口紧张时才会裁剪，你无法强制。'
        break
      default:
        refusal = '压缩未执行。'
    }
    return [refusal, ...formatFreeResultsReceipt(o)].join('\n')
  }
  const lines: string[] = []
  if (o.droppedMessages != null) {
    const pct = o.window && o.tokensAfter != null ? Math.round((o.tokensAfter / o.window) * 100) : null
    const pctNote = pct != null ? `，现为窗口的 ${pct}%` : ''
    lines.push(`已压缩：归档 ${o.droppedMessages} 条旧消息（估算 ~${Math.round((o.tokensBefore ?? 0) / 1024)}K → ~${Math.round((o.tokensAfter ?? 0) / 1024)}K tokens${pctNote}）。`)
    const notesNote = hadNotes ? (o.notesKept ? '摘要+交接笔记' : '摘要（注意：交接笔记未能落地）') : '摘要'
    lines.push(
      o.summaryLanded
        ? `${notesNote}已注入后续请求；被归档原文仍可用 tool_result_search 按 tool_result_id 取回。`
        : `历史摘要未生成（${hadNotes && o.notesKept ? '交接笔记已保留' : '纯截断'}）；被归档原文仍可用 tool_result_search 按 tool_result_id 取回。`
    )
  }
  lines.push(...formatFreeResultsReceipt(o))
  lines.push('继续当前任务——不要因压缩收尾，不要重新探索提醒中已列出的文件。')
  return lines.join('\n')
}

/** context_compact — the model's own compaction handle. All mechanics live
 *  engine-side (ex.compactContext); this branch only formats the structured
 *  outcome into the envelope. */
export async function execContextCompactTool(ex: ToolExecContext, t: ToolUseBlock): Promise<boolean> {
  if (t.name !== 'context_compact') return false
  const fail = (msg: string): void => { t.output = msg; t.exitCode = 1; ex.addToolResult(t.id, msg, true) }
  if (!ex.compactContext) { fail('Context compaction is not available in this session.'); return true }
  const input = (t.input || {}) as Record<string, unknown>
  const hadNotes = typeof input.notes === 'string' && input.notes.trim().length > 0
  try {
    const outcome = await ex.compactContext({
      instruction: typeof input.instruction === 'string' ? input.instruction : undefined,
      notes: hadNotes ? input.notes as string : undefined,
      freeResults: Array.isArray(input.free_results) ? input.free_results.map((v) => String(v)) : undefined,
    })
    const text = formatCompactOutcome(outcome, hadNotes)
    t.exitCode = outcome.ok ? 0 : 1
    t.output = text.slice(0, UI_PREVIEW_MAX)
    ex.addToolResult(t.id, text, !outcome.ok)
  } catch (err) {
    fail(`压缩执行失败：${err instanceof Error ? err.message : String(err)}`)
  }
  return true
}

/** Create-path title default (the first meaningful line, heading markers
 *  stripped) when the model supplies neither a title nor a target to keep. */
function deriveExperienceTitle(content: string): string {
  const line = content.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? ''
  const title = line.replace(/^#+\s*/, '').replace(/^[-*>]\s*/, '') || 'Untitled experience'
  return title.length > 60 ? `${title.slice(0, 57)}…` : title
}

/** Only a clean, bounded keyword list counts as explicit triggers — anything
 *  else falls through to the automatic extraction path after the save. */
function experienceTriggers(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.map((v) => String(v).trim()).filter((v) => v.length > 0 && v.length <= 40).slice(0, 12)
  return list.length > 0 ? list : undefined
}

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
          const matches = query ? await km.searchWiki(query, scopeBaseId) : []
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
    // experience_save — the pool's ONE sanctioned writer. The records live under
    // ~/.pulsemind, a path-jail deny root, so neither file ops nor the shell can
    // reach them (read goes through the shell and works; write/edit do not);
    // ExperienceManager.save is the door, and it carries the store's own gates
    // (script paths, 8KB, `node --check`, the 20-record LRU).
    if (t.name === 'experience_save') {
      const em = ex.opts.experienceManager
      const fail = (msg: string): void => { t.output = msg; t.exitCode = 1; ex.addToolResult(t.id, msg, true) }
      if (!em) { fail('Experience manager not available.'); return true }
      const content = String(t.input.content || '').trim()
      if (!content) { fail('Error: content is required.'); return true }
      try {
        const targetName = String(t.input.targetName || '').trim()
        const all = await em.list()
        const existing = targetName ? all.find((r) => r.name === targetName) : undefined
        // The store would fall back to creating a look-alike — for a tool the
        // honest answer is a refusal that names the real candidates, or a
        // revision silently forks a near-duplicate into a 20-slot pool.
        if (targetName && !existing) {
          fail(`经验 "${targetName}" 不存在，已拒绝保存（不会另建一份近似记录）。可用 name：${all.map((r) => r.name).join(', ') || '（池为空）'}`)
          return true
        }
        const askedCategory = String(t.input.category || '')
        const draft: ExperienceDraft = {
          // A revision keeps its own title/category when the model omits them;
          // the body is replaced either way (the store's contract).
          title: String(t.input.title || '').trim() || existing?.title || deriveExperienceTitle(content),
          description: String(t.input.description || '').trim() || content.replace(/\s+/g, ' ').slice(0, 120),
          content,
          category: (EXPERIENCE_CATEGORIES as readonly string[]).includes(askedCategory)
            ? askedCategory
            : existing?.category || 'general',
          sourceConversationId: ex.opts.conversationId ?? existing?.sourceConversationId,
          targetName: targetName || undefined,
          triggers: experienceTriggers(t.input.triggers),
        }
        const { record, evicted, rejectedFiles } = await em.save(draft)
        const lines = [
          `${targetName ? '已修订' : '已保存'}经验「${record.title}」（name: \`${record.name}\`）`,
          `- 类别：${record.category}`,
          record.triggers?.length
            ? `- 触发词：${record.triggers.join('、')}`
            : '- 触发词：稍后自动提取（在此之前按 name 仍可读到）',
        ]
        if (evicted) lines.push(`- 池已满 20 条，最久未用的经验「${evicted.title}」（\`${evicted.name}\`）被挤出`)
        if (rejectedFiles?.length) lines.push(`- 被拒的脚本文件：${rejectedFiles.join('、')}（经验正文已照常保存）`)
        const report = lines.join('\n')
        t.output = report
        t.exitCode = 0
        ex.addToolResult(t.id, report, false)
        // Trigger keywords are the one part a model shouldn't have to spell
        // out. Same fire-and-forget contract as the afterSession hosts, force
        // on a revision (its old keywords may no longer describe the body).
        if (!draft.triggers?.length && ex.opts.apiKey) {
          em.ensureTriggers(record.name, {
            adapter: ex.opts.adapter, apiKey: ex.opts.apiKey, baseURL: ex.opts.baseURL, model: ex.opts.model,
          }, Boolean(targetName)).catch((e: unknown) => console.warn('[experience_save] trigger extraction failed:', e))
        }
      } catch (err) {
        fail(`保存经验失败：${err instanceof Error ? err.message : String(err)}`)
      }
      return true
    }
    // Background-process channels (PLAN-coding-contract P0-3 #14/#15). Both
    // key off the session's pid registry main-side; an unknown pid answers
    // "not found" rather than opening the log reader / killer to the world.
    if (t.name === 'exec_logs') {
      const pid = Number(t.input?.pid)
      const tail = Number.isFinite(pid) && pid > 0 ? await getHost().execLogs(pid, typeof t.input?.tail === 'number' ? t.input.tail : undefined) : null
      let text: string
      if (tail === null) text = `pid=${t.input?.pid ?? ''} not found: no background process with that pid was started by this session.`
      else if (tail === '') text = `pid=${pid}: no output yet.`
      else text = tail
      t.exitCode = tail === null ? 1 : 0
      t.output = text
      ex.addToolResult(t.id, text, tail === null)
      ex.notify()
      return true
    }
    if (t.name === 'exec_kill') {
      const pid = Number(t.input?.pid)
      const ok = Number.isFinite(pid) && pid > 0 ? await getHost().execKill(pid) : false
      const text = ok
        ? `Kill signal sent to background process pid=${pid}. Confirm with exec_logs(pid=${pid}) — its log tail will report "[exited code=...]".`
        : `pid=${t.input?.pid ?? ''} not found: no live background process with that pid was started by this session.`
      t.exitCode = ok ? 0 : 1
      t.output = text
      ex.addToolResult(t.id, text, !ok)
      ex.notify()
      return true
    }
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
      // Background mode (PLAN-coding-contract P0-3 #11): settle NOW with the
      // pid — no span, no exit subscription, and deliberately no
      // onProcessStart, so the engine's foreground-process scalar (and its five
      // kill-on-cleanup sites) never sees this process. Output rides the
      // pid-keyed log; the model polls exec_logs / reaps with exec_kill.
      if (t.input?.background === true) {
        try {
          const { pid } = await getHost().executeBackground(command, cwd || undefined)
          t.exitCode = 0
          t.status = 'completed'
          t.backgroundPid = pid
          const note = `Background process started: pid=${pid}\n\nThis result is immediate — the process keeps running beyond the turn. Read its output with exec_logs(pid=${pid}) (the log tail also reports "[exited code=N]" once it ends); stop it with exec_kill(pid=${pid}).`
          t.output = note
          ex.addToolResult(t.id, note, false)
        } catch (err) {
          t.exitCode = -1
          t.status = 'completed'
          const msg = `Error: ${err instanceof Error ? err.message : 'Failed to start background process'}`
          t.output = msg
          ex.addToolResult(t.id, msg, true)
        }
        ex.notify()
        return true
      }
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