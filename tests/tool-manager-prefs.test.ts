import { describe, it, expect } from 'vitest'
import { ToolManager } from '../src/renderer/src/tools/ToolManager'

// The prefs round-trip must distinguish "new built-in" (no row yet → surface
// enabled) from "user disabled it" (explicit row → stays off). The store side
// needs better-sqlite3 (Electron ABI, not CI-runnable); this pins the
// manager half: knownTools must list disabled and never-persisted tools too.
describe('ToolManager preferences round-trip', () => {
  it('getPreferences lists every registered tool as known, not only enabled ones', () => {
    const tm = new ToolManager()
    tm.applyPreferences({ enabledTools: ['read', 'exec'], knownTools: ['read', 'exec'] })
    tm.disable('read')
    const prefs = tm.getPreferences()
    expect(prefs.enabledTools).not.toContain('read')
    expect(prefs.enabledTools).toContain('exec')
    expect(prefs.knownTools).toContain('read')
    expect(prefs.knownTools).toContain('exec')
    expect(prefs.knownTools).toContain('browser')
  })

  it('a built-in absent from persisted prefs is treated as new and surfaces enabled', () => {
    const tm = new ToolManager()
    // Simulates a legacy persisted whitelist written before `browser` existed.
    tm.applyPreferences({ enabledTools: ['read', 'exec'], knownTools: ['read', 'exec'] })
    // The store union (get()) is what adds the missing default-on names; the
    // manager must faithfully apply whatever it receives.
    tm.applyPreferences({ enabledTools: ['read', 'exec', 'browser'], knownTools: ['read', 'exec', 'browser'] })
    expect(tm.getEnabledTools().some((t) => t.definition.name === 'browser')).toBe(true)
  })
})
