import { BUILT_IN_TOOLS } from '../../renderer/src/tools/built-in-tools'
import type { ToolPreferences } from '../../shared/types/tool-types'
import { getDb } from './database'

/**
 * Every built-in tool is enabled by default (user ruling 2026-09-18:
 * 「把所有 tool 都加入白名单…第一层的 enable 开关都默认打开」).
 *
 * This is layer 1 only — the capability-center `enabled` switch. It does NOT
 * mean every tool reaches the model: `availability: 'gated'` (layer 2, see
 * tool-collection.ts) still keeps a gated tool out of the tool list until a
 * trigger keyword or `pick_tool` activates it. The extension-only page_* family
 * is not in BUILT_IN_TOOLS at all (2026-09-20: 「页面系列工具是仅给插件用的」),
 * so it has no preference row and no default — tool-collection.ts merges it
 * into the toolset only for a session the browser extension is driving
 * (`hostedAvailable`). Preference rows naming page_* left by older versions
 * are simply ignored: applyPreferences only touches registered names.
 *
 * Derived from the registry rather than enumerated, so a tool added in a later
 * version is on by default for new AND upgrading installs — which is exactly
 * what `get()`'s missing-row branch exists to guarantee.
 */
const DEFAULT_ENABLED_TOOLS: string[] = BUILT_IN_TOOLS.map((t) => t.name)

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
