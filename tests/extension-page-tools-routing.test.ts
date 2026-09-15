/** Desktop half of the page-tool wiring (PLAN-browser-extension M2.2/M2.4/M2.5).
 *
 * Pins the three things §3.4.2.1 and §3.4.2.2 call out as easy to get wrong:
 *   1. `page_*` must NOT join the file/shell tier sets — those decide which
 *      *executor* runs, so a page click would be handled as a file write.
 *   2. The page family needs its own branch in `approveTool`, whose fallback is
 *      "run it as a shell command".
 *   3. The page tools are offered only while a client is bound, and an
 *      extension session's whitelist is page tools + ask_user and nothing else.
 *
 * (1) and (2) are structural — the routing is private engine state that would
 * take a full engine + host + LLM stub to exercise — so they are asserted
 * against the source with the ordering that actually matters. (3) is a plain
 * function call and is tested for real. */

import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PAGE_SESSION_ALLOWED_TOOLS, PAGE_TOOL_NAMES, isPageTool } from '../src/shared/agent-protocol/page-tools'
import { READ_TIER_TOOLS, WRITE_TIER_TOOLS, pageToolTier, tierOfTool } from '../src/renderer/src/agent/engine/tool-tiers'
import { collectEnabledTools, type ToolCollectionDeps } from '../src/renderer/src/agent/engine/tool-collection'
import { setHost } from '../src/renderer/src/agent/host'
import type { ToolManager } from '../src/renderer/src/tools/ToolManager'
import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'

const source = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf-8')

// ── Tier classification ──────────────────────────────────────────────

describe('page tool tiers', () => {
  it('keeps page tools out of the file/shell tier sets', () => {
    // The sets are the dispatch classification, not just the approval one: a
    // page tool in WRITE_TIER_TOOLS would be executed by execWorkspaceTool.
    for (const name of PAGE_TOOL_NAMES) {
      expect(READ_TIER_TOOLS.has(name)).toBe(false)
      expect(WRITE_TIER_TOOLS.has(name)).toBe(false)
      expect(isPageTool(name)).toBe(true)
    }
  })

  it('classifies reads as read and page_execute_js as exec', () => {
    expect(pageToolTier('page_get_content')).toBe('read')
    expect(pageToolTier('page_scroll')).toBe('read')
    expect(pageToolTier('page_wait')).toBe('read')
    expect(pageToolTier('page_click')).toBe('write')
    expect(pageToolTier('page_input')).toBe('write')
    expect(pageToolTier('page_select')).toBe('write')
    expect(pageToolTier('page_back')).toBe('write')
    // Arbitrary code in a page holding the user's session — the exec rung.
    expect(pageToolTier('page_execute_js')).toBe('exec')
    expect(pageToolTier('exec')).toBeNull()
  })

  it('answers the approval question for the pre-existing families unchanged', () => {
    expect(tierOfTool('read')).toBe('read')
    expect(tierOfTool('search')).toBe('read')
    expect(tierOfTool('write')).toBe('write')
    expect(tierOfTool('git_commit')).toBe('write')
    expect(tierOfTool('exec')).toBe('exec')
    expect(tierOfTool('page_execute_js')).toBe('exec')
  })
})

// ── Routing sites (§3.4.2.2) ─────────────────────────────────────────

describe('page tool routing sites', () => {
  it('dispatches the page family to execPageTool, not to a file or shell path', () => {
    const flow = source('src/renderer/src/agent/engine/execution-flow.ts')
    expect(flow).toContain('execPageReadTools(pageReadTools)')
    expect(flow).toContain('execPageTool(t)')
    // Page tools are excluded from `otherTools` (whose held branch routes to the
    // shell default when approved).
    expect(flow).toMatch(/!pageTools\.includes\(t\)/)
  })

  it('gives approveTool its own page branch, ahead of the shell fallback', () => {
    const flow = source('src/renderer/src/agent/engine/execution-flow.ts')
    const approve = flow.slice(flow.indexOf('approveTool = '), flow.indexOf('rejectTool = '))
    const pageBranch = approve.indexOf('isPageTool(targetBlock.name)')
    const shellFallback = approve.indexOf('// Shell execution (default)')

    expect(pageBranch).toBeGreaterThan(-1)
    expect(shellFallback).toBeGreaterThan(-1)
    // Ordering IS the guarantee here: anything after the fallback is dead code.
    expect(pageBranch).toBeLessThan(shellFallback)
  })

  it('holds page writes by their own tier instead of by the desktop tier sets', () => {
    const flow = source('src/renderer/src/agent/engine/execution-flow.ts')
    expect(flow).toContain('pageHeldTools')
    expect(flow).toMatch(/requiresApproval\(this\.engine\.opts\.approvalMode \?\? 'auto', tierOfTool\(t\.name\)\)/)
  })
})

// ── Online gate + session whitelist (§3.4.4 / M2.5) ──────────────────

function fakeToolManager(names: string[]): ToolManager {
  return {
    getEnabledTools: () =>
      names.map((name) => ({
        enabled: true,
        definition: {
          name,
          category: isPageTool(name) ? 'page' : 'system',
          description: '',
          instructions: '',
          input_schema: { type: 'object', properties: {}, required: [] },
        },
      })),
  } as unknown as ToolManager
}

const TOOLSET = ['exec', 'read', 'write', 'browser', 'ask_user', ...PAGE_TOOL_NAMES]

async function collect(opts: Partial<AgentEngineOptions>, deps: Partial<ToolCollectionDeps> = {}): Promise<string[]> {
  const defs = deps.allowedToolsSet ? [...TOOLSET] : TOOLSET
  const resolved: ToolCollectionDeps = {
    mcpToolOwner: new Map(),
    selectedBuiltinTools: [],
    selectedMcpTools: [],
    messages: [],
    opts: { toolManager: fakeToolManager(defs), ...opts } as unknown as AgentEngineOptions,
    ...deps,
  }
  const tools = await collectEnabledTools(resolved, resolved.opts.toolManager)
  return tools.map((t) => t.name)
}

describe('page tool availability', () => {
  beforeEach(() => {
    // collectEnabledTools refreshes the MCP cache; an empty server list is all
    // it needs, plus the two change-subscription hooks the cache wires up.
    setHost({
      mcpListServers: async () => [],
      expertList: async () => [],
      getSkillPreferences: async () => ({ enabledSkills: [], skillKeywords: {} }),
      onMcpServersChanged: () => () => {},
      onSkillsChanged: () => () => {},
    } as never)
  })

  it('hides the page tools when no browser client is bound', async () => {
    const names = await collect({ hostedAvailable: false })
    for (const page of PAGE_TOOL_NAMES) expect(names).not.toContain(page)
    // Everything else is untouched — the gate is specific to the page family.
    expect(names).toContain('exec')
    expect(names).toContain('browser')
    expect(names).toContain('ask_user')
  })

  it('hides them when the flag is simply absent (the default for a desktop session)', async () => {
    const names = await collect({})
    for (const page of PAGE_TOOL_NAMES) expect(names).not.toContain(page)
  })

  it('offers them once a browser client is bound', async () => {
    const names = await collect({ hostedAvailable: true })
    for (const page of PAGE_TOOL_NAMES) expect(names).toContain(page)
  })

  it('scopes an extension session to page tools + ask_user', async () => {
    const names = await collect(
      { hostedAvailable: true },
      { allowedToolsSet: new Set(PAGE_SESSION_ALLOWED_TOOLS) },
    )

    expect(names.sort()).toEqual(['ask_user', ...PAGE_TOOL_NAMES].sort())
    // The desktop families the model must not reach for from inside a page.
    expect(names).not.toContain('exec')
    expect(names).not.toContain('write')
    expect(names).not.toContain('browser')
  })
})
