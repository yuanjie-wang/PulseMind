// ── pick_tool implementation (moved out of ToolExecutor 0.4.1) ──
// Tool discovery/selection: direct names, per-server / built-in category
// lookup, and LLM intent matching over MCP tools + gated built-ins.

import { getHost } from '../host'
import { getCachedMcpServers } from '../mcp-cache'
import { ServerSelectionAgent } from '../one-shot-agent'
import { BUILTIN_CATEGORY_SUMMARIES, builtinCategoryServerId, isBuiltinServerId } from '../../tools/builtin-gate'
import type { ToolUseBlock } from '../../types/agent'
import type { ToolExecContext } from './context'

/** Rejection-side teaching (failure-time, zero cost on the happy path): every
 *  "not found" answer names the self-check so the model never has to guess at
 *  tool existence twice. */
const LIST_HINT = 'Call pick_tool with no arguments to list every pick-able tool and category (and which are already active).'

/** One pickable tool: an MCP tool, or a gated built-in (whose `instructions`
 *  manual rides the activation result — gated manuals are excluded from the
 *  system prompt's Tool Protocols so the shared trunk stays byte-stable). */
interface PickCandidate {
  name: string
  serverId: string
  description: string
  inputSchema: any
  instructions?: string
}

export async function execPickTool(
  ex: ToolExecContext, t: ToolUseBlock, setSelectedTools: (names: string[]) => void,
  getActivatedTools?: () => string[],
): Promise<void> {
  t.status = 'running'; ex.notify()
  try {
    // 可用连接器白名单（专家 / 子代理）：白名单外的服务器连候选都不进，
    // 否则 pick_tool 会成为绕过限制的入口。undefined = 不限制，空数组 = 一个
    // 都不许用。三个模式共用——serverName/intent 曾绕过这份过滤直接列全量
    // 服务器，信封承诺「now available」的武器在受限会话里永远调不动
    // （audit 2026-10-10 #8；引擎侧 mcpToolOwner 只装白名单服务器，漏的只是
    // 信封诚实性，这里是把源头顶回去）。
    const allowedServers = ex.opts.allowedMcpServers ? new Set(ex.opts.allowedMcpServers) : null
    const fetchCandidateTools = async () => {
      const servers = await getHost().mcpListServers()
      const all: PickCandidate[] = []
      for (const server of servers) {
        if (server.status !== 'connected') continue
        if (allowedServers && !allowedServers.has(server.id)) continue
        for (const tool of server.tools) {
          all.push({ name: tool.name, serverId: server.id, description: tool.description, inputSchema: tool.inputSchema })
        }
      }
      for (const def of ex.opts.toolManager.getEnabledTools().map(t => t.definition)) {
        if (def.availability !== 'gated') continue
        all.push({ name: def.name, serverId: builtinCategoryServerId(def.category), description: def.description, inputSchema: def.input_schema, instructions: def.instructions })
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
    const formatResult = (tools: PickCandidate[], header: string): string => {
      const lines = tools.map(t =>
        `- **${t.name}** (from \`${srcLabel(t.serverId)}\`): ${t.description || '(no description)'}`
      )
      const schemas = tools.map(t => {
        const schema = t.inputSchema && Object.keys(t.inputSchema).length > 0
          ? `\`\`\`json\n${JSON.stringify(t.inputSchema, null, 2)}\n\`\`\``
          : '*No parameters*'
        return `**${t.name}** (from \`${srcLabel(t.serverId)}\`)\n\n${schema}`
      }).join('\n\n---\n\n')
      // Gated built-ins carry their `instructions` manuals HERE instead of the
      // system prompt: the manual lands as ordinary conversation content at the
      // moment of activation, and the shared prefix never moves.
      const manuals = tools
        .map((t) => (t.instructions || '').trim())
        .filter(Boolean)
      const protocols = manuals.length > 0
        ? `\n\n### Usage Protocols\n\n${manuals.join('\n\n')}`
        : ''
      const hasBuiltin = tools.some(t => isBuiltinServerId(t.serverId))
      const hasMcp = tools.some(t => !isBuiltinServerId(t.serverId))
      const availability = hasBuiltin && hasMcp
        ? 'These MCP and built-in tools are now available for you to use.'
        : hasBuiltin
          ? 'These built-in tools are now available for you to use.'
          : 'These MCP tools are now available for you to use.'
      return `${header}\n\n${lines.join('\n')}\n\n### Tool Signatures\n\n${schemas}${protocols}\n\n${availability}`
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
        ex.addToolResult(t.id, `No MCP or built-in tools found matching names: ${notFound.join(', ')}. ${LIST_HINT}`, true)
        t.exitCode = 1; t.status = 'completed'; ex.notify(); return
      }
      const matched = allTools.filter(t => validNames.includes(t.name))
      setSelectedTools(validNames)
      ex.addToolResult(t.id, formatResult(matched, selectHeader(matched)), false)
      t.exitCode = 0; t.status = 'completed'; ex.notify(); return
    }

    // ── Mode 2: select by server name (new) ────────────────────────
    const serverNameInput = String(t.input?.serverName || '').trim()
    if (serverNameInput) {
      const servers = (await getHost().mcpListServers()).filter(s => !allowedServers || allowedServers.has(s.id))
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
        ex.addToolResult(t.id, formatResult(serverTools, header), false)
        t.exitCode = 0; t.status = 'completed'; ex.notify(); return
      }

      // Built-in category fallback: serverName matches a gated category
      // (e.g. "git", "memory", "knowledge", or "builtin:git")
      const category = serverNameInput.replace(/^builtin:/, '').toLowerCase()
      const catDefs = ex.opts.toolManager.getEnabledTools().map(t => t.definition).filter(d => d.availability === 'gated' && d.category === category)
      if (catDefs.length > 0) {
        const catTools: PickCandidate[] = catDefs.map(d => ({
          name: d.name,
          serverId: builtinCategoryServerId(d.category),
          description: d.description,
          inputSchema: d.input_schema,
          instructions: d.instructions
        }))
        const names = catTools.map(t => t.name)
        const summary = BUILTIN_CATEGORY_SUMMARIES[category]
        const header = summary
          ? `## Built-in category "${category}" Loaded\n\n${summary}`
          : `## Built-in category "${category}" Loaded (${names.length} tools)`
        setSelectedTools(names)
        ex.addToolResult(t.id, formatResult(catTools, header), false)
        t.exitCode = 0; t.status = 'completed'; ex.notify(); return
      }

      ex.addToolResult(t.id, `Server or category "${serverNameInput}" not found. Available servers: ${servers.filter(s => s.status === 'connected').map(s => s.id).join(', ') || '(none)'}. Available built-in categories: ${Object.keys(BUILTIN_CATEGORY_SUMMARIES).join(', ')}. ${LIST_HINT}`, true)
      t.exitCode = 1; t.status = 'completed'; ex.notify(); return
    }

    // ── Mode 0: no arguments → list what is pick-able (PLAN-tool-issues #5) ──
    // The pick_tool description already names the categories, but a model that
    // called an unactivated tool by name got only a rejection and had no way to
    // ASK (8 such rejections in the user's library). The listing is the same
    // whitelist-filtered candidate set the other modes draw from; `*` marks
    // what is already active, read through the engine getter when wired.
    const intent = String(t.input?.intent || '')
    if (!intent) {
      const servers = (await getHost().mcpListServers()).filter(s => s.status === 'connected' && (!allowedServers || allowedServers.has(s.id)))
      const gated = ex.opts.toolManager.getEnabledTools().map(x => x.definition).filter(d => d.availability === 'gated')
      const active = new Set(getActivatedTools?.() ?? [])
      const mark = (name: string): string => active.has(name) ? `${name}*` : name
      const byCategory = new Map<string, string[]>()
      for (const d of gated) byCategory.set(d.category, [...(byCategory.get(d.category) ?? []), d.name])
      const builtinRows = [...byCategory].map(([cat, names]) => {
        const summary = BUILTIN_CATEGORY_SUMMARIES[cat]
        return `- **${cat}**: ${names.map(mark).join(', ')}${summary ? ` — ${summary}` : ''}`
      })
      const mcpRows = servers.map(s => {
        const summary = getCachedMcpServers().find(ss => ss.id === s.id)?.summary
        return `- **${s.id}** "${s.name}": ${s.tools.map(x => mark(x.name)).join(', ') || '(no tools)'}${summary ? ` — ${summary}` : ''}`
      })
      if (builtinRows.length === 0 && mcpRows.length === 0) {
        ex.addToolResult(t.id, 'Nothing is pick-able right now: no connected MCP servers and no gated built-in categories. Every enabled tool is already in your tool list.', false)
        t.exitCode = 0; t.status = 'completed'; ex.notify(); return
      }
      const sections = [
        '## Pick-able Tools (hidden until activated)',
        'Always-on tools are already in your tool list and are not repeated here. `*` = already activated in this conversation.',
        ...(builtinRows.length > 0 ? ['### Built-in categories', ...builtinRows] : []),
        ...(mcpRows.length > 0 ? ['### MCP servers (connected)', ...mcpRows] : []),
        'Activate with `pick_tool({ names: [...] })`, `pick_tool({ serverName: "<category or server id>" })`, or `pick_tool({ intent: "..." })`. Activated tools become regular tools in subsequent turns.',
      ]
      ex.addToolResult(t.id, sections.join('\n\n'), false)
      t.exitCode = 0; t.status = 'completed'; ex.notify(); return
    }

    // ── Mode 3: intent-based matching (server level) ───────────────

    t.output = `Matching intent to MCP servers and built-in tools: ${intent.slice(0, 80)}...`; ex.notify()
    const allTools2 = await fetchCandidateTools()
    if (allTools2.length === 0) {
      ex.addToolResult(t.id, 'No MCP or built-in tools available.', false)
      t.exitCode = 0; t.status = 'completed'; ex.notify(); return
    }

    // Build server-level summary list for the server selection agent — the
    // same whitelist filter as everywhere else, or the agent would hand back
    // ids whose tools fetchCandidateTools never carried ("No tools found").
    const servers2 = (await getHost().mcpListServers()).filter(s => !allowedServers || allowedServers.has(s.id))
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
    const gatedBuiltins = ex.opts.toolManager.getEnabledTools().map(t => t.definition).filter(d => d.availability === 'gated')
    const builtinByCat = new Map<string, number>()
    for (const d of gatedBuiltins) builtinByCat.set(d.category, (builtinByCat.get(d.category) || 0) + 1)
    for (const [cat, count] of builtinByCat) {
      const summary = BUILTIN_CATEGORY_SUMMARIES[cat]
      serverList += `\n- [${builtinCategoryServerId(cat)}] ${summary || `${cat} (${count} tools)`}`
    }

    const svAgent = new ServerSelectionAgent()
    const selectedServerIds = await svAgent.execute(
      { intent, serverList },
      { llmConfig: { adapter: ex.opts.adapter, apiKey: ex.opts.apiKey || '', baseURL: ex.opts.baseURL, model: ex.opts.model, modelMaxTokens: ex.opts.maxTokens }, maxOutputTokens: 200 }
    )

    if (selectedServerIds.length === 0) {
      ex.addToolResult(t.id, 'No matching servers or categories found.', false)
      t.exitCode = 0; t.status = 'completed'; ex.notify(); return
    }

    // Load ALL tools from matched servers
    const matchedTools = allTools2.filter(t => selectedServerIds.includes(t.serverId))
    if (matchedTools.length === 0) {
      ex.addToolResult(t.id, `No tools found for servers: ${selectedServerIds.join(', ')}.`, false)
      t.exitCode = 0; t.status = 'completed'; ex.notify(); return
    }

    const selectedNames2 = matchedTools.map(t => t.name)
    const serverNames2 = [...new Set(matchedTools.map(t => t.serverId))].join(', ')
    setSelectedTools(selectedNames2)
    const headerTitle = selectHeader(matchedTools).replace('## ', '')
    ex.addToolResult(t.id, formatResult(matchedTools, `## ${headerTitle} from: ${serverNames2}`), false)
    t.exitCode = 0
  } catch (err) { ex.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'pick_tool failed'}`, true); t.exitCode = -1 }
  t.status = 'completed'; ex.notify()
}