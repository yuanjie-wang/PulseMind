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
import type { SubAgentProfile } from '../../../shared/types/subagent'

// ── State ────────────────────────────────────────────────────────────

let mcpServers: MCPManagedServer[] = []
let subAgentProfiles: SubAgentProfile[] = []
let skillPrefs: SkillPreferences = { enabledSkills: [], skillKeywords: {} }
let ready = false
let unsubs: (() => void)[] = []

// ── Helpers ──────────────────────────────────────────────────────────

/** Ensure chrome-devtools always has a meaningful summary in the cache, even when connecting. */
function ensureChromeSummary(servers: MCPManagedServer[]): MCPManagedServer[] {
  const chrome = servers.find(s => s.id === 'chrome-devtools')
  if (chrome && !chrome.summary) {
    chrome.summary = 'Browser automation: page navigation, screenshot, click, type, JavaScript evaluation, DOM & console & network control'
  }
  return servers
}

function refetchMcp(): void {
  window.electronAPI.mcpListServers().then(data => { mcpServers = ensureChromeSummary(data) }).catch(() => {})
}
function refetchSubAgents(): void {
  window.electronAPI.subagentList().then(data => { subAgentProfiles = data }).catch(() => {})
}
function refetchSkillPrefs(): void {
  window.electronAPI.getSkillPreferences().then(data => { skillPrefs = data }).catch(() => {})
}

// ── Init ─────────────────────────────────────────────────────────────

let initPromise: Promise<void> | null = null

export function ensureCache(): Promise<void> {
  if (ready) return initPromise!
  ready = true

  unsubs.push(
    window.electronAPI.onMcpServersChanged(() => {
      refetchMcp()
      refetchSubAgents()
    }),
    window.electronAPI.onSkillsChanged(refetchSkillPrefs),
  )

  // Initial fetch — return a promise so callers can wait for cache readiness
  initPromise = Promise.all([
    window.electronAPI.mcpListServers().then(data => { mcpServers = ensureChromeSummary(data) }).catch(() => {}),
    window.electronAPI.subagentList().then(data => { subAgentProfiles = data }).catch(() => {}),
    window.electronAPI.getSkillPreferences().then(data => { skillPrefs = data }).catch(() => {}),
  ]).then(() => {})
  return initPromise
}

export function disposeCache(): void {
  for (const fn of unsubs) fn()
  unsubs = []
  ready = false
  mcpServers = []
  subAgentProfiles = []
  skillPrefs = { enabledSkills: [], skillKeywords: {} }
}

// ── Synchronous readers ──────────────────────────────────────────────

export function getCachedMcpServers(): MCPManagedServer[] {
  return mcpServers
}

/** Force-refresh the cached MCP server list and return when done. */
export function refreshMcpServers(): Promise<void> {
  return window.electronAPI.mcpListServers().then(data => { mcpServers = ensureChromeSummary(data) }).catch(() => {})
}

export function getCachedSubAgentProfiles(): SubAgentProfile[] {
  return subAgentProfiles
}

export function getCachedSkillPrefs(): SkillPreferences {
  return skillPrefs
}
