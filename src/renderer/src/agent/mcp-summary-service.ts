import { getHost } from './host'
/**
 * MCP server summary generation — standalone service, not tied to AgentEngine.
 *
 * Call generateMcpSummaries() when MCP servers change or on app startup.
 * Summaries are persisted via IPC and survive restarts.
 */

import type { LlmAdapter } from '../llm/adapter'
import { MCPServerSummaryAgent } from './one-shot-agent'
import { ensureCache, getCachedMcpServers } from './mcp-cache'

interface LlmConfig {
  adapter: LlmAdapter
  apiKey: string
  baseURL: string
  model: string
  locale?: string
}

const summaryAgent = new MCPServerSummaryAgent()

/**
 * Generate summaries for connected MCP servers that lack one.
 * Runs sequentially (one LLM call per server) in the background.
 * Already-persisted summaries (`server.summary`) are skipped.
 * Results are persisted immediately via IPC.
 */
/**
 * Check if a summary looks like the auto-generated fallback (from getDefaultOutput)
 * rather than an LLM-generated description. Fallback summaries follow the pattern:
 * `ServerName (N tools): tool1, tool2...`
 */
function isFallbackSummary(summary: string): boolean {
  return /^.+? \(\d+ tools\)/.test(summary)
}

export async function generateMcpSummaries(llmCfg: LlmConfig, force?: boolean): Promise<void> {
  if (!llmCfg.apiKey) { console.warn('[generateMcpSummaries] skipped: no apiKey'); return }

  console.warn(`[generateMcpSummaries] starting: baseURL=${llmCfg.baseURL} model=${llmCfg.model} force=${force}`)

  // Ensure the MCP cache is populated (may not be if AgentEngine hasn't been constructed yet)
  await ensureCache()

  const servers = getCachedMcpServers()
  console.warn(`[generateMcpSummaries] cache has ${servers.length} servers:`, servers.map(s => `${s.id}=${s.status} summary=${!!s.summary}`))
  const connected = servers.filter(s => s.status === 'connected')
  console.warn(`[generateMcpSummaries] ${connected.length} connected servers`)
  if (connected.length === 0) return

  for (const server of connected) {
    const existing = server.summary || ''
    const isFallback = isFallbackSummary(existing)
    const skip = !!(server.summary && !force && !isFallback)
    console.warn(`[generateMcpSummaries] server="${server.name}" summary="${existing.slice(0, 80)}" isFallback=${isFallback} skip=${skip}`)
    if (skip) continue

    // Pre-seed chrome-devtools (fixed tool set, no LLM call needed)
    if (server.id === 'chrome-devtools') {
      if (!server.summary || force) {
        const summary = 'Browser automation: page navigation, screenshot, click, type, JavaScript evaluation, DOM & console & network control'
        await getHost().mcpUpdateServerSummary(server.id, summary)
      }
      continue
    }

    console.warn(`[generateMcpSummaries] generating summary for "${server.name}" (existing: ${server.summary ? server.summary.slice(0, 50) : 'none'})`)
    try {
      const result = await summaryAgent.execute(
        {
          serverName: server.name,
          tools: server.tools.map(t => ({ name: t.name, description: t.description })),
          locale: llmCfg.locale,
        },
        { llmConfig: { adapter: llmCfg.adapter, apiKey: llmCfg.apiKey, baseURL: llmCfg.baseURL, model: llmCfg.model }, maxTokens: 150 }
      )
      // Only persist LLM-generated summaries (not fallback from getDefaultOutput).
      // Fallback summaries match the `isFallbackSummary` pattern — skip persistence
      // so the server gets retried next time.
      if (result && !isFallbackSummary(result)) {
        console.warn(`[generateMcpSummaries] new summary for "${server.name}": ${result.slice(0, 80)}`)
        await getHost().mcpUpdateServerSummary(server.id, result)
      } else if (result && isFallbackSummary(result)) {
        console.warn(`[generateMcpSummaries] LLM returned fallback for "${server.name}", NOT persisting (will retry)`)
      } else {
        console.warn(`[generateMcpSummaries] LLM returned null for "${server.name}"`)
      }
    } catch (err) {
      console.warn(`[generateMcpSummaries] error for "${server.name}":`, err)
    }
  }
}
