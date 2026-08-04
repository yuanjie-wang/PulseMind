import type { ToolPreferences } from '../../shared/types/tool-types'
import { getDb } from './database'

const DEFAULT_ENABLED_TOOLS = [
  'exec', 'read', 'write', 'edit', 'search', 'list_dir',
  'browser_interact', 'browser_extract', 'browser_screenshot',
  'browser_evaluate', 'browser_pages', 'browser_dialog',
  'ask_user',
  'memory_search', 'memory_save', 'conversation_search', 'tool_result_search',
  'webfetch', 'install', 'pick_skill', 'pick_tool',
  'find', 'spawn_agent',
  'create_plan', 'advance_plan',
  'knowledge_search', 'knowledge_read',
]

export class ToolPreferencesStore {
  get(): ToolPreferences {
    const rows = getDb().prepare('SELECT tool_name FROM tool_preferences WHERE enabled = 1').all() as { tool_name: string }[]
    if (rows.length === 0) {
      // Seed defaults for new installs
      this.set({ enabledTools: [...DEFAULT_ENABLED_TOOLS] })
      return { enabledTools: [...DEFAULT_ENABLED_TOOLS] }
    }
    return { enabledTools: rows.map(r => r.tool_name) }
  }

  set(prefs: ToolPreferences): void {
    const db = getDb()
    db.transaction(() => {
      db.prepare('DELETE FROM tool_preferences').run()
      const insert = db.prepare('INSERT INTO tool_preferences (tool_name, enabled) VALUES (?, 1)')
      for (const t of prefs.enabledTools) insert.run(t)
    })()
  }
}

export const toolPreferencesStore = new ToolPreferencesStore()
