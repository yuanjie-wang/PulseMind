/**
 * Tool collection (PLAN-0.3.5 refactor, split 6/5): merged view of built-in
 * tools, MCP tools and gated selections — extracted from AgentEngine.
 */
import type { AgentMessage, TextBlock } from '../../types/agent'
import type { ToolManager } from '../../tools/ToolManager'
import type { ToolInputSchema } from '../../tools/types'
import { BUILTIN_CATEGORY_SUMMARIES, builtinCategoryServerId } from '../../tools/builtin-gate'
import { sanitizeSchema } from '../agent-utils'
import type { AgentEngineOptions } from '../AgentEngine'
import { ensureCache, getCachedExpertProfiles, getCachedMcpServers, refreshMcpServers } from '../mcp-cache'

export interface ToolCollectionDeps {
  mcpToolOwner: Map<string, string>
  allowedMcpServersSet?: Set<string>
  allowedToolsSet?: Set<string>
  selectedBuiltinTools: string[]
  selectedMcpTools: string[]
  messages: AgentMessage[]
  spawnSystemPrompt?: string
  opts: AgentEngineOptions
}

export async function collectEnabledTools(deps: ToolCollectionDeps, toolManager: ToolManager): Promise<any[]> {
  // Ensure the MCP cache is populated before reading (constructor fires ensureCache
  // as fire-and-forget, so this may be the first time we await it).
  await ensureCache()

  let enabledTools = toolManager.getEnabledTools().map((t) => t.definition)

  // ── Hosted page tools: only while a browser client is bound (M2.4) ──
  // The tool list is what makes the model reach for these; hiding them when
  // nothing can execute them is the whole gate (Anywhere's rule: "the model
  // must not see browser tools while the extension is offline").
  if (!deps.opts.hostedAvailable) {
    enabledTools = enabledTools.filter((t) => t.category !== 'page')
  }

  // ── Gated built-in tools: keyword auto-trigger + session activation ──
  // Category-level: any trigger hit activates the whole gated category (git/memory/knowledge),
  // so "commit my changes" surfaces status/diff/log/commit/restore together.
  {
    const userText = deps.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.contentBlocks)
      .filter((b) => b.type === 'text')
      .map((b) => (b as TextBlock).text)
      .join('\n')
      .toLowerCase()
    const gatedByCategory = new Map<string, string[]>()
    for (const def of enabledTools) {
      if (def.availability !== 'gated') continue
      const arr = gatedByCategory.get(def.category) || []
      gatedByCategory.set(def.category, [...arr, ...(def.triggers || [])])
    }
    const activated = new Set(deps.selectedBuiltinTools)
    for (const [category, keywords] of gatedByCategory) {
      if (keywords.some((kw) => userText.includes(kw.toLowerCase()))) {
        for (const def of enabledTools) {
          if (def.availability === 'gated' && def.category === category) activated.add(def.name)
        }
      }
    }
    deps.selectedBuiltinTools = [...activated]
  }
  // Apply the gate: hide gated tools unless activated (spawned-agent whitelist forces them in).
  {
    const activated = new Set(deps.selectedBuiltinTools)
    const allowed = deps.allowedToolsSet
    enabledTools = enabledTools.filter((t) => t.availability !== 'gated' || activated.has(t.name) || allowed?.has(t.name))
  }

  const skillManager = deps.opts.skillManager
  if (skillManager) {
    const pickSkillIdx = enabledTools.findIndex((t) => t.name === 'pick_skill')
    if (pickSkillIdx !== -1) {
      // Expert/spawn skill whitelist: `undefined` = no restriction, an EMPTY
      // ARRAY = no skill is allowed (mirrors allowedTools/allowedMcpServers).
      const allowedSkills = deps.opts.allowedSkills
      const allowedSkillSet = allowedSkills ? new Set(allowedSkills) : null
      const eSkills = skillManager.getEnabledSkills().filter((s) => !allowedSkillSet || allowedSkillSet.has(s.definition.name))
      if (eSkills.length > 0) {
        const skillNames = eSkills.map((s) => s.definition.name).join(', ')
        enabledTools[pickSkillIdx] = {
          ...enabledTools[pickSkillIdx],
          description: `${enabledTools[pickSkillIdx].description} Available skills: ${skillNames}.`,
        }
      }
    }
  }

  // ── Sub-agent list (injected into spawn_agent description) ──────────
  const spawnAgentIdx = enabledTools.findIndex((t) => t.name === 'spawn_agent')
  if (spawnAgentIdx !== -1) {
    try {
      const profiles = getCachedExpertProfiles()
      const available = profiles.filter((p: any) => p.enabled ?? true)
      if (available.length > 0) {
        const listStr = available
          .map((p: any) => {
            // Prefer the curated one-liner; fall back to a persona snippet.
            const blurb = p.description?.trim() || p.basePrompt?.slice(0, 120).replace(/\n/g, ' ')
            return `- **${p.name}** (ID: \`${p.id}\`)${blurb ? ': ' + blurb : ''}`
          })
          .join('\n')
        enabledTools[spawnAgentIdx] = {
          ...enabledTools[spawnAgentIdx],
          description: `${enabledTools[spawnAgentIdx].description}\n\nAvailable experts:\n${listStr}`,
        }
      }
    } catch {
      /* non-critical */
    }
  }

  // ── MCP tools (from connected MCP servers) ──────────────────────
  // Skipped only for sessions whose toolset is explicitly pinned (tool studio,
  // canvas): those carry their own restricted whitelist and never pick MCP
  // tools. An expert spawn inherits the host toolset, so it discovers servers
  // exactly like a normal session.
  const doMcpDiscovery = !deps.spawnSystemPrompt || !deps.allowedToolsSet
  if (doMcpDiscovery) {
    deps.mcpToolOwner.clear()
    const mcpToolList: Array<{ name: string; serverId: string; description: string; inputSchema: any }> = []
    try {
      // Force-refresh cache so we don't miss newly-connected servers.
      // pick_tool reads fresh via IPC, but collectEnabledTools uses the cache — without this
      // refresh, tools from a recently connected server would be missing from mcpToolOwner.
      await refreshMcpServers()
      const servers = getCachedMcpServers()
      for (const server of servers) {
        if (server.status !== 'connected') continue
        if (deps.allowedMcpServersSet && !deps.allowedMcpServersSet.has(server.id)) continue
        for (const tool of server.tools) {
          if (!deps.mcpToolOwner.has(tool.name)) {
            deps.mcpToolOwner.set(tool.name, server.id)
            mcpToolList.push({ name: tool.name, serverId: server.id, description: tool.description, inputSchema: tool.inputSchema })
          } else {
            console.warn(
              `[AgentEngine] MCP tool name collision: "${tool.name}" from server "${server.id}" conflicts with server "${deps.mcpToolOwner.get(tool.name)}" — skipping`,
            )
          }
        }
      }

      // Enrich pick_tool description with server-level summaries (NOT individual tool descriptions)
      // Include both connected and connecting servers so the LLM knows what's available
      const pickToolIdx = enabledTools.findIndex((t) => t.name === 'pick_tool')
      if (pickToolIdx !== -1) {
        // Build description from all servers that are or will be available
        const serverRows: string[] = []
        for (const server of servers) {
          if (server.status !== 'connected' && server.status !== 'connecting') continue
          if (deps.allowedMcpServersSet && !deps.allowedMcpServersSet.has(server.id)) continue
          const statusTag = server.status === 'connecting' ? ' [连接中]' : ''
          const summary = server.summary || `${server.name} (${server.tools.length} tools)`
          // Append tool names (truncated) so the LLM knows what tools each server exposes
          const toolNames = server.tools.map((t) => t.name)
          const toolSuffix =
            toolNames.length > 0
              ? (() => {
                  const all = toolNames.join(', ')
                  const truncated = all.length > 120
                  return ` | tools(${toolNames.length}): ${truncated ? all.slice(0, 120) + '...' : all}`
                })()
              : ''
          serverRows.push(`- [${server.id}]${statusTag} ${summary}${toolSuffix}`)
        }

        // Gated built-in categories the model can still activate via pick_tool —
        // one row per category (mirrors the per-server MCP rows above).
        const activatedBuiltins = new Set(deps.selectedBuiltinTools)
        const builtinByCat = new Map<string, string[]>()
        for (const d of toolManager.getEnabledTools().map((t) => t.definition)) {
          if (d.availability !== 'gated' || activatedBuiltins.has(d.name)) continue
          const arr = builtinByCat.get(d.category) || []
          arr.push(d.name)
          builtinByCat.set(d.category, arr)
        }
        const builtinRows = [...builtinByCat.entries()].map(([cat, names]) => {
          const summary = BUILTIN_CATEGORY_SUMMARIES[cat] || `${cat} (${names.length} tools)`
          return `- [${builtinCategoryServerId(cat)}] ${summary} | tools(${names.length}): ${names.join(', ')}`
        })

        // Servers and built-in categories are activation units of the same kind,
        // so they share one list (rows are formatted identically).
        const availableRows = [...serverRows, ...builtinRows]
        if (availableRows.length > 0) {
          enabledTools[pickToolIdx] = {
            ...enabledTools[pickToolIdx],
            description: `${enabledTools[pickToolIdx].description}\n\nAvailable servers & tool categories (hidden until activated — mention their topic, or use \`pick_tool\` with \`names\`/\`serverName\`/\`intent\`):\n${availableRows.join('\n')}`,
          }
        }
      }

      // URL-based browser activation lives in the gated-keyword block above
      // ('http://'/'https://' are browser triggers) — it must run BEFORE the
      // gate filter, so no late mutation happens here.
      const selectedSet = new Set(deps.selectedMcpTools)

      for (const t of mcpToolList) {
        if (selectedSet.size === 0 || !selectedSet.has(t.name)) continue
        if (!t.inputSchema) continue
        const cleanSchema = sanitizeSchema(t.inputSchema)
        enabledTools.push({
          name: t.name,
          description: t.description,
          category: 'browser',
          input_schema: cleanSchema as ToolInputSchema,
          instructions: '',
        })
      }
    } catch (err) {
      console.log('[AgentEngine] MCP tool discovery failed:', err)
    }
  }

  // ── Tool whitelist for spawned agents ───────────────────────────
  if (deps.allowedToolsSet) {
    const originalCount = enabledTools.length
    for (let i = enabledTools.length - 1; i >= 0; i--) {
      if (!deps.allowedToolsSet.has(enabledTools[i].name)) {
        // Don't filter MCP tools — they're already gated by allowedMcpServersSet
        if (deps.mcpToolOwner.has(enabledTools[i].name)) continue
        enabledTools.splice(i, 1)
      }
    }
    console.log(`[AgentEngine] Sub-agent tool whitelist: kept ${enabledTools.length}/${originalCount} tools`)
  }

  return enabledTools
}
