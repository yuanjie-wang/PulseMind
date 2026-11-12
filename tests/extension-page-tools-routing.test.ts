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
 * function call and is tested for real.
 *
 * Since 2026-09-20 (「页面系列工具是仅给插件用的，不用在这里管理」) the family
 * is additionally NOT registered in the desktop tool registry at all: the
 * capability center has nothing to toggle, a desktop toolset never carries it,
 * and `collectEnabledTools` merges `PAGE_BUILT_IN_TOOLS` in only for a hosted
 * session — that merge is the family's only door. */

import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PAGE_SESSION_ALLOWED_TOOLS, PAGE_TOOL_NAMES, isPageTool } from '../src/shared/agent-protocol/page-tools'
import { BUILT_IN_TOOLS, PAGE_BUILT_IN_TOOLS } from '../src/renderer/src/tools/built-in-tools'
import { ToolManager } from '../src/renderer/src/tools/ToolManager'
import { READ_TIER_TOOLS, WRITE_TIER_TOOLS, pageToolTier, tierOfTool } from '../src/renderer/src/agent/engine/tool-tiers'
import { collectEnabledTools, type ToolCollectionDeps } from '../src/renderer/src/agent/engine/tool-collection'
import { setHost } from '../src/renderer/src/agent/host'
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
    expect(pageToolTier('page_navigate')).toBe('write')
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

// ── Registry membership (extension-only, 2026-09-20) ─────────────────

describe('page tool registry membership', () => {
  it('the desktop registry neither defines nor registers the page family', () => {
    expect(BUILT_IN_TOOLS.filter((t) => isPageTool(t.name)).map((t) => t.name)).toEqual([])
    // The standalone list is exactly the eight protocol names — a new page tool
    // must extend PAGE_TOOL_NAMES and this array together, never BUILT_IN_TOOLS.
    expect(PAGE_BUILT_IN_TOOLS.map((t) => t.name).sort()).toEqual([...PAGE_TOOL_NAMES].sort())
    const tm = new ToolManager()
    expect(tm.getAllTools().filter((s) => isPageTool(s.definition.name)).map((s) => s.definition.name)).toEqual([])
    // Nothing to manage: no preference row either.
    expect(tm.getPreferences().knownTools.filter((n) => isPageTool(n))).toEqual([])
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
          category: 'system',
          description: '',
          instructions: '',
          input_schema: { type: 'object', properties: {}, required: [] },
        },
      })),
  } as unknown as ToolManager
}

// The fake registry models the DESKTOP world: no page tools in it. The merge
// under test injects the real PAGE_BUILT_IN_TOOLS when a client is bound.
const TOOLSET = ['exec', 'read', 'write', 'browser', 'ask_user']

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

// ── Session whitelist wiring (§3.4.1 → mechanism, 2026-11-12) ─────────
// PAGE_SESSION_ALLOWED_TOOLS used to be a declared-but-unconsumed constant:
// hosted sessions carried the FULL desktop toolset, held back only by the
// approval ladder. The wiring is cross-layer (ws-server pins, session-manager
// releases at handoff, engine drops the derived set), so the real protocol
// behavior lives in agent-protocol-ws.test.ts; these scans pin the two halves
// no protocol test reaches — the release body and the engine clear.

describe('hosted session whitelist wiring', () => {
  it('ws-server pins sessionCreate to the page whitelist and releases at handoff', () => {
    const ws = source('src/main/agent/ws-server.ts')
    expect(ws).toContain("import { PAGE_SESSION_ALLOWED_TOOLS } from '../../shared/agent-protocol/page-tools'")
    // One gate for both create paths (resume + fresh), shared with the
    // registry bind: a bare (non-extension) client has no reverse channel to
    // execute page tools, so pinning it would only empty its toolset.
    expect(ws).toMatch(/isHostedClientId\(conn\.clientId\) \? \[\.\.\.PAGE_SESSION_ALLOWED_TOOLS\] : undefined/)
    expect(ws.match(/allowedTools: pageToolWhitelist/g)?.length).toBe(2)
    expect(ws).toContain('sessions.releaseToolWhitelist?.(sessionId)')
  })

  it('the manager releases both the pin and the engine-derived set', () => {
    const mgr = source('src/main/agent/session-manager.ts')
    const body = mgr.slice(mgr.indexOf('releaseToolWhitelist(sessionId: string): void'))
    // Either half alone leaves the whitelist alive: the pin is what
    // refreshOptions re-attaches, the derived set is constructor-only state
    // that updateOptions never rebuilds.
    expect(body).toContain('entry.pinned.allowedTools = undefined')
    expect(body).toContain('entry.engine.clearAllowedTools()')
    const engine = source('src/renderer/src/agent/AgentEngine.ts')
    expect(engine).toMatch(/clearAllowedTools\(\): void \{[\s\S]*?this\.allowedToolsSet = undefined/)
  })
})
