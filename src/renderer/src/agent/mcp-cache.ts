import { getHost } from './host'
import type { PulseHost } from './host/types'
/**
 * Reactive MCP + sub-agent + skill-preferences cache.
 *
 * Initialised on first import (lazily, at the first AgentEngine construction),
 * then kept up-to-date via onMcpServersChanged / onSkillsChanged events.
 * AgentEngine and system-prompt-builder read these synchronously — no IPC
 * on the hot path.
 */

import type { MCPManagedServer } from '../types/electron'
import type { SkillPreferences } from '../skills/types'
import type { ExpertProfile } from '../../../shared/types/expert'

// ── State ────────────────────────────────────────────────────────────

let mcpServers: MCPManagedServer[] = []
let expertProfiles: ExpertProfile[] = []
let skillPrefs: SkillPreferences = { enabledSkills: [], skillKeywords: {} }
let ready = false
let unsubs: (() => void)[] = []

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Defensive wrapper: getHost().mcpListServers can be missing if the
 * running window holds a stale preload (Vite HMR refreshes renderer modules but
 * never the preload bridge). Calling it would SYNC-throw (not a rejection),
 * which .catch() can't absorb — breaking AgentEngine construction. Guard so the
 * app degrades to an empty list instead of crashing.
 */
function safeMcpListServers(): Promise<MCPManagedServer[]> {
  const host = getHost() as Partial<PulseHost>
  const fn = host.mcpListServers
  if (typeof fn !== 'function') {
    console.warn('[mcp-cache] host.mcpListServers missing (stale preload?) — treating as empty list')
    return Promise.resolve([])
  }
  return fn.call(host)
}

// ── Change notification ──────────────────────────────────────────────
// A cache a renderer reads synchronously needs a signal, because the fetch
// always lands AFTER the first paint: a component resolving 执行者 names from
// getCachedExpertProfiles() paints once with nothing and would otherwise show
// the raw id forever. Components subscribe via useSyncExternalStore.
const listeners = new Set<() => void>()

export function subscribeCache(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function emitCacheChange(): void {
  for (const fn of listeners) fn()
}

function refetchMcp(): void {
  safeMcpListServers().then(data => { mcpServers = data; emitCacheChange() }).catch(() => {})
}
function refetchSubAgents(): void {
  getHost().expertList().then(data => { expertProfiles = data; emitCacheChange() }).catch(() => {})
}
function refetchSkillPrefs(): void {
  getHost().getSkillPreferences().then(data => { skillPrefs = data; emitCacheChange() }).catch(() => {})
}

// ── Init ─────────────────────────────────────────────────────────────

let initPromise: Promise<void> | null = null

export function ensureCache(): Promise<void> {
  if (ready) return initPromise!
  ready = true

  unsubs.push(
    getHost().onMcpServersChanged(() => {
      refetchMcp()
      refetchSubAgents()
    }),
    getHost().onSkillsChanged(refetchSkillPrefs),
  )

  // Initial fetch — return a promise so callers can wait for cache readiness
  initPromise = Promise.all([
    safeMcpListServers().then(data => { mcpServers = data }).catch(() => {}),
    getHost().expertList().then(data => { expertProfiles = data }).catch(() => {}),
    getHost().getSkillPreferences().then(data => { skillPrefs = data }).catch(() => {}),
  ]).then(() => { emitCacheChange() })
  return initPromise
}

export function disposeCache(): void {
  for (const fn of unsubs) fn()
  unsubs = []
  ready = false
  mcpServers = []
  expertProfiles = []
  skillPrefs = { enabledSkills: [], skillKeywords: {} }
  emitCacheChange()
}

// ── Synchronous readers ──────────────────────────────────────────────

export function getCachedMcpServers(): MCPManagedServer[] {
  return mcpServers
}

/** Force-refresh the cached MCP server list and return when done. */
export function refreshMcpServers(): Promise<void> {
  return safeMcpListServers().then(data => { mcpServers = data; emitCacheChange() }).catch(() => {})
}

export function getCachedExpertProfiles(): ExpertProfile[] {
  return expertProfiles
}

export function getCachedSkillPrefs(): SkillPreferences {
  return skillPrefs
}
