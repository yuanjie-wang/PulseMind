// ── Memory / conversation / knowledge / experience tools (moved out of
// ToolExecutor 0.4.1) ── dispatched by execOtherTool.

import { getHost } from '../host'
import { buildCommandFromSkillInput, detectShellFileWrite, shellFileWriteRejection } from '../command-builder'
import { beginTerminalSpan } from '../terminal-span'
import type { ToolUseBlock } from '../../types/agent'
import { UI_PREVIEW_MAX, type ToolExecContext, type CompactToolOutcome } from './context'
import { MAX_LIVE_OUTPUT_CHARS } from '../engine/engine-constants'
import { MEMORY_ENTRY_MAX_CHARS } from '../../../../shared/memory/limits'
import { MEMORY_PAGE_INLINE_MAX } from '../../../../shared/memory-pages'
import { interleaveRecallHits, RECALL_DEFAULT_LIMIT, type RecallHit } from '../../../../shared/recall'

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
function formatCompactOutcome(o: CompactToolOutcome, hadNotes: boolean, hadFreeResults: boolean): string {
  // Deferred registration (PLAN-tool-issues #6): an in-flight request no longer
  // refuses — the call is armed for the next build. The envelope must say so
  // AND close the two gaps the deferred path cannot cover (fresh notes, named
  // free_results), or the model would assume both landed.
  if (o.deferred) {
    const lines = ['当前有请求在飞，压缩已登记：将在下一次请求构建时自动执行（轻量裁剪，摘要由构建期生成），无需再次调用。']
    if (hadNotes) lines.push('交接笔记在延后模式下不会落地；若重要，请在任务收尾时改用 todo 或 memory 保存。')
    if (hadFreeResults) lines.push('free_results 点名在延后模式下未处理；若那些结果确实碍事，请在正常调用时重发一次。')
    lines.push('继续当前任务——不要因压缩收尾。')
    return lines.join('\n')
  }
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
    const text = formatCompactOutcome(outcome, hadNotes, Array.isArray(input.free_results) && input.free_results.length > 0)
    t.exitCode = outcome.ok ? 0 : 1
    t.output = text.slice(0, UI_PREVIEW_MAX)
    ex.addToolResult(t.id, text, !outcome.ok)
  } catch (err) {
    fail(`压缩执行失败：${err instanceof Error ? err.message : String(err)}`)
  }
  return true
}



/** tool_result_search — resolve the archived-result placeholders back to the
 *  full original tool results (the read half of the compaction pipeline). The
 *  ids come verbatim from the placeholder markers; every tool_result is
 *  persisted under its tool_result_id (the DB's ref_id), so any id the context
 *  ever advertised resolves. Found and missed ids are reported SEPARATELY —
 *  a hallucinated id must come back as a per-id correction, not a whole-call
 *  error that buries what did resolve (conv_20261026154702: the model invented
 *  an id, the call fell through to the shell tier, and `echo "Unrecognized
 *  tool: …"` answered it with Exit Code 0 — this executor is the missing
 *  half; before it existed the tool was advertised by the system prompt and
 *  the compaction notices but no executor was ever wired). */
export async function execToolResultSearchTool(ex: ToolExecContext, t: ToolUseBlock): Promise<boolean> {
  if (t.name !== 'tool_result_search') return false
  const raw = Array.isArray(t.input?.ids) ? t.input.ids : []
  const ids = [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))]
  if (ids.length === 0) {
    const msg = 'No ids given — pass the uuid(s) shown inside the ⟨archived: …⟩ placeholders of earlier tool results, copied verbatim.'
    t.output = msg
    ex.addToolResult(t.id, msg, true)
    t.exitCode = 1
    return true
  }
  try {
    const rows = await getHost().getToolResult(ids)
    const byId = new Map(rows.map((r) => [r.ref_id, r]))
    const found = ids.filter((id) => byId.has(id))
    if (found.length === 0) {
      const msg = `No archived tool result matches ${ids.map((i) => `"${i}"`).join(', ')}. The id must be copied VERBATIM from an ⟨archived: <uuid>⟩ placeholder (or a tool_result_id= pointer) in the conversation — it cannot be guessed or reconstructed.`
      t.output = msg
      ex.addToolResult(t.id, msg, true)
      t.exitCode = 1
      return true
    }
    const sections = found.map((id) => {
      const r = byId.get(id)!
      return `${r.is_error ? '[archived error result' : '[archived tool result'} · ${id}]\n${r.content}`
    })
    const missed = ids.filter((id) => !byId.has(id))
    const missNote = missed.length > 0
      ? `\n\n(${missed.length} of ${ids.length} ids matched nothing: ${missed.join(', ')} — copy ids verbatim from the ⟨archived: …⟩ placeholders.)`
      : ''
    const text = sections.join('\n\n---\n\n') + missNote
    t.output = text.slice(0, UI_PREVIEW_MAX)
    ex.addToolResult(t.id, text, false)
    t.exitCode = 0
  } catch (err) {
    const msg = `tool_result_search failed: ${err instanceof Error ? err.message : String(err)}`
    t.output = msg
    ex.addToolResult(t.id, msg, true)
    t.exitCode = 1
  }
  return true
}

/** recall（PLAN-recall-unification，2026-10-25）：memory / conversation /
 *  knowledge 三库联邦检索。用户裁定：数据源类型对模型无意义——无 sources/type
 *  参数，query 进、相关信息出；源只出现在结果信封的标签里（后续动作说明书：
 *  knowledge→md 绝对路径（read 直读，E8）、长记忆页→page 指针、conversation→会话 id）。 */
export async function execRecallTool(ex: ToolExecContext, t: ToolUseBlock): Promise<boolean> {
    if (t.name !== 'recall') return false
    const query = String(t.input.query || '').trim()
    const limit = Number(t.input.limit) || RECALL_DEFAULT_LIMIT
    if (!query) {
      ex.addToolResult(t.id, 'Empty query — pass keywords (2-4 char terms work, Chinese supported).', true)
      t.exitCode = 1; return true
    }
    const km = ex.opts.knowledgeManager
    const scopeBaseId = ex.opts.knowledgeBaseScope?.id ?? undefined

    // 源异常记账（2026-10-28 recall 零命中修复）：四个源各自吞错成空数组，曾让
    // 「检索挂了」与「库里没有」共用一个出口、话术无法区分。失败源按名记账，
    // 零命中与部分命中两条出口都回读。
    const sourceErrors: string[] = []
    const swallowSource = (label: string) => (_err: unknown): never[] => {
      sourceErrors.push(label)
      return []
    }

    const [memoryPages, conversations, rawMatches, wikiMatches] = await Promise.all([
      // 经验与 recall 彻底隔离（PLAN-capability-followups E6/E7）：列表召回排除 experience
      getHost().searchMemoryPages({ query, limit: limit * 2 }).then((rs) => rs.filter((r) => r.type !== 'experience')).catch(swallowSource('memory')),
      getHost().searchConversationsByKeyword(query).catch(swallowSource('conversations')),
      km ? km.searchContent(query, scopeBaseId).catch(swallowSource('knowledge (raw)')) : Promise.resolve([]),
      km ? km.searchWiki(query, scopeBaseId).catch(swallowSource('knowledge (wiki)')) : Promise.resolve([]),
    ])

    const hits: RecallHit[] = []
    for (const r of memoryPages) {
      hits.push({
        source: 'memory',
        title: r.title,
        body: r.body.length > MEMORY_PAGE_INLINE_MAX
          ? `${r.summary ?? r.body.slice(0, 400)}… (page: ${r.id}, ${r.body.length} chars)`
          : r.body,
        meta: { pageId: r.id, type: r.type, updatedAt: r.updatedAt.slice(0, 10), aliases: r.aliases.join(', ') },
      })
    }
    for (const r of conversations) {
      hits.push({
        source: 'conversation',
        title: r.title,
        body: r.summary || '(no summary)',
        meta: { conversationId: r.id, updatedAt: (r.updatedAt || '').slice(0, 10) },
      })
    }
    for (const r of wikiMatches) {
      hits.push({
        source: 'knowledge',
        title: r.title,
        body: r.content,
        meta: { path: r.wikiPath, kind: 'wiki' },
      })
    }
    for (const r of rawMatches.slice(0, limit)) {
      hits.push({
        source: 'knowledge',
        title: r.title,
        body: (r.excerpts[0] ?? '').slice(0, 300),
        meta: { path: r.filePath, kind: 'raw' },
      })
    }

    const top = interleaveRecallHits(hits, limit)
    if (top.length === 0) {
      // OR-semantics honesty (PLAN-tool-issues #9, 2026-10-28; conversation 源
      // 切词 OR 同日落地——四个源现在全部词级 OR，零命中即没有任何一个词在任何一个
      // 源出现，单词重探结构性不可能非零，所以线索是失败源而不是降级重跑):
      // the bare one-liner read as a malfunction and sent the model into
      // full-tree greps. Name the semantics and, when a source errored, the
      // difference between a search failure and an empty corpus.
      const failureNote = sourceErrors.length > 0
        ? ` ${sourceErrors.length} source(s) errored during this search (${sourceErrors.join(', ')}) — zero hits may be a search failure rather than an empty corpus.`
        : ''
      const note = `No results for "${query}" across memory, conversations, or the knowledge base.${failureNote} (Keywords are matched with OR, so zero hits means none of them appear in any source — if you expected content, the corpus likely does not have it; try different keywords, or use pick_skill for capabilities.)`
      t.output = note; ex.addToolResult(t.id, note, false); t.exitCode = 0; return true
    }
    const sections = top.map((h, i) => {
      // 零信息命中降级（review_20261025：title=body 头部切片的迁移形态印三遍同句）——
      // 正文去除标题后为空/近重复时只印单行（title 即全部信息）。
      const normalizedTitle = h.title.replace(/\s+/g, '')
      const normalizedBody = h.body.replace(/\s+/g, '')
      const isTitleEcho = normalizedBody === normalizedTitle || (normalizedTitle.length >= 12 && normalizedBody.startsWith(normalizedTitle))
      if (isTitleEcho && h.source !== 'knowledge') {
        const ptr = h.meta.pageId ? ` (page: ${h.meta.pageId})` : ''
        return `[${i + 1}] [${h.source}] ${h.title} (${h.meta.type ?? 'page'}${ptr})`
      }
      const singleLine = `[${i + 1}] [${h.source}] ${h.title}`
      void singleLine
      const alias = h.meta.aliases ? `\n    别名: ${h.meta.aliases}` : ''
      const head = `[${i + 1}] [${h.source}] ${h.title}`
      const path = h.source === 'knowledge' ? `\n    path: ${h.meta.path}` : ''
      return `${head}${alias}${path}\n    ${h.body.replace(/\n/g, '\n    ')}`
    })
    const out = sections.join('\n')
    // 部分失败也要说（零命中分支的同款记账）：有命中时源挂了不会自证，
    // 结果页看起来完整、实则缺源。
    const partialNote = sourceErrors.length > 0
      ? `\n\n(${sourceErrors.length} source(s) errored during this search — ${sourceErrors.join(', ')}; results may be incomplete.)`
      : ''
    t.output = (out + partialNote).slice(0, MEMORY_PREVIEW_MAX)
    ex.addToolResult(t.id, t.output, false)
    t.exitCode = 0
    return true
}

export async function execMemoryTool(ex: ToolExecContext, t: ToolUseBlock): Promise<boolean> {
    if (t.name === 'memory_save') {
      const title = String(t.input.title || '').trim()
      const content = String(t.input.content || '')
      const type = ['fact', 'decision', 'preference', 'experience'].includes(String(t.input.type)) ? String(t.input.type) : 'fact'
      const aliases = Array.isArray(t.input.aliases) ? t.input.aliases.filter((a: unknown) => typeof a === 'string') : []
      if (!title || !content.trim()) {
        ex.addToolResult(t.id, 'NOT saved — title and content are both required.', true)
        t.exitCode = 1; return true
      }
      if ((type === 'preference' || type === 'fact') && content.length > MEMORY_ENTRY_MAX_CHARS) {
        ex.addToolResult(t.id, `NOT saved — ${type} pages are ONE sentence of at most ${MEMORY_ENTRY_MAX_CHARS} characters. Distill the conclusion, or use type "decision"/"experience" for long content.`, true)
        t.exitCode = 1; return true
      }
      // title 命中既有页 → update（content 即完整修订稿）；未命中 → create。
      const create = { action: 'create' as const, title, type: type as never, content, aliases, links: [] as string[] }
      let results = await getHost().applyMemoryPageOps([create])
      if (!results[0].ok && /撞名/.test(results[0].error ?? '')) {
        results = await getHost().applyMemoryPageOps([{ action: 'update', target: title, content, aliases, links: [] }])
      }
      const r = results[0]
      t.output = r.ok ? `Saved memory page: "${title}" (${type})` : `NOT saved: ${r.error}`
      ex.addToolResult(t.id, t.output, !r.ok)
      t.exitCode = r.ok ? 0 : 1
      return true
    }
  return false
}


/** Skill-command exec path（从 v1 execExperienceTool 的 else 半边忠实恢复——
 *  2026-10-25 M2b 拆除经验工具时被尾部切割误伤，exec 工具的 background 分支与
 *  输出缓冲帽都在这里）。经验池脚本记账随池退役（use_count 由检索 touch 记）。 */
export async function execSkillCommand(ex: ToolExecContext, t: ToolUseBlock): Promise<boolean> {
    // File-write gate (2026-10-27, the exec manual's rule #1 as code): the
    // model-authored `command` never reaches a shell when it writes files via
    // redirection/heredoc/tee — write/edit own file creation. Runs BEFORE the
    // background branch too, so `background: true` buys no bypass. The auto
    // path lands here (execOtherTool → this fallback); approveTool's shell
    // default carries the SAME gate for released calls.
    if (typeof t.input?.command === 'string' && t.input.command.trim()) {
      const trip = detectShellFileWrite(t.input.command)
      if (trip) {
        const msg = shellFileWriteRejection(trip)
        t.exitCode = 1
        t.status = 'completed'
        t.output = msg
        ex.addToolResult(t.id, msg, true)
        ex.notify()
        return true
      }
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
    // 兜底执行器（原 execExperienceTool 的 else 半边）：各专属执行器都没认领的
    // 裸技能命令在这里按 buildCommandFromSkillInput 组装执行。
    const platform = ex.opts.platformInfo?.platform || ''
    const command = buildCommandFromSkillInput(t.name, t.input || {}, platform, ex.opts.platformInfo?.ripgrepPath)
    const cwd = String(t.input?.cwd || '')
    t.output = ''; ex.notify()
    // Background mode (PLAN-coding-contract P0-3 #11): settle NOW with the
    // pid — no span, no exit subscription, and deliberately no onProcessStart,
    // so the engine's foreground-process scalar never sees this process.
    if (t.input?.background === true) {
      try {
        const { pid } = await getHost().executeBackground(command, cwd || undefined, ex.opts.conversationId)
        t.exitCode = 0
        t.status = 'completed'
        t.backgroundPid = pid
        const note = `Background process started: pid=${pid}\n\nThis result is immediate — the process keeps running beyond the turn. When it exits you will be NOTIFIED in a later turn's context (a Background Tasks section appears automatically — no polling needed); you can also read its output anytime with exec_logs(pid=${pid}) (the log tail also reports "[exited code=N]" once it ends). Stop it with exec_kill(pid=${pid}).`
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
      // Live-output cap (MAX_LIVE_OUTPUT_CHARS): same shape as the shell
      // path in execution-flow — head-kept so the frozen head also freezes
      // the wire diff signature past the cap.
      const capBuf = (buf: string): string => (buf.length > MAX_LIVE_OUTPUT_CHARS ? buf.slice(0, MAX_LIVE_OUTPUT_CHARS) : buf)
      // The terminal bus broadcasts by channel — concurrent engines' process
      // events land here too (PLAN-parallel-experts T7): the span filters by
      // processId and parks the window before executeCommand returns a pid.
      const span = beginTerminalSpan(getHost(), {
        onOutput: d => {
          if (d.type === 'stderr') stderrBuf = capBuf(stderrBuf + d.data)
          else stdoutBuf = capBuf(stdoutBuf + d.data)
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
        ex.noteVerifyExec?.(command)
        resolve()
      }
      // conversationId doubles as the persistent-shell key (review P0-1): this
      // engine's cd/export live in its own shell, apart from its sub-agents'.
      getHost().executeCommand(command, cwd || undefined, t.input.timeout != null ? Number(t.input.timeout) * 1000 : undefined, ex.opts.conversationId)
        .then(pid => { ex.onProcessStart?.(pid); span.claim(pid) })
        .catch(err => { stderrBuf += `\n[Error: ${err instanceof Error ? err.message : 'Failed'}]`; finish(-1, true) })
    })
    return true
}
