import type { ToolPreferences } from '../../shared/types/tool-types'
import { getDb } from './database'

const DEFAULT_ENABLED_TOOLS = [
  'exec',
  'read',
  'write',
  'edit',
  'search',
  'list_dir',
  'git_status',
  'git_diff',
  'git_log',
  'git_commit',
  'git_restore',
  'browser',
  'ask_user',
  'memory_search',
  'memory_save',
  'conversation_search',
  'tool_result_search',
  'webfetch',
  'install',
  'pick_skill',
  'pick_tool',
  'find',
  'spawn_agent',
  'create_plan',
  'advance_plan',
  'knowledge_search',
  'knowledge_read',
  'experience_read',
]

interface PrefRow {
  tool_name: string
  enabled: number
}

export class ToolPreferencesStore {
  get(): ToolPreferences {
    const rows = getDb().prepare('SELECT tool_name, enabled FROM tool_preferences').all() as PrefRow[]
    if (rows.length === 0) {
      // Seed defaults for new installs
      this.set({ enabledTools: [...DEFAULT_ENABLED_TOOLS] })
      return { enabledTools: [...DEFAULT_ENABLED_TOOLS] }
    }
    const enabled = rows.filter((r) => r.enabled === 1).map((r) => r.tool_name)
    const known = rows.map((r) => r.tool_name)
    // A default-on built-in with NO row at all was introduced after these
    // prefs were written — surface it enabled, or upgrades silently hide it
    // behind a stale whitelist. A row with enabled=0 stays off (explicit).
    const missing = DEFAULT_ENABLED_TOOLS.filter((n) => !known.includes(n))
    return {
      enabledTools: [...enabled, ...missing],
      knownTools: [...known, ...missing],
    }
  }

  set(prefs: ToolPreferences): void {
    const db = getDb()
    db.transaction(() => {
      const prior = db.prepare('SELECT tool_name FROM tool_preferences').all() as { tool_name: string }[]
      const known = new Set([...(prefs.knownTools ?? []), ...prior.map((r) => r.tool_name), ...prefs.enabledTools])
      const enabledSet = new Set(prefs.enabledTools)
      db.prepare('DELETE FROM tool_preferences').run()
      const insert = db.prepare('INSERT INTO tool_preferences (tool_name, enabled) VALUES (?, ?)')
      for (const t of known) insert.run(t, enabledSet.has(t) ? 1 : 0)
    })()
  }
}

export const toolPreferencesStore = new ToolPreferencesStore()
