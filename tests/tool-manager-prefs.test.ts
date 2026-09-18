import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
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

// The store side can't run here (better-sqlite3 is Electron-ABI), so the
// default-on contract is pinned as source: the default set must be DERIVED from
// the built-in registry, never hand-enumerated. A curated list is exactly how
// `docx_edit` stayed switched off — the user's message never hit its keyword
// triggers, so the model fell back to Python (2026-09-18: 「把所有 tool 都加入
// 白名单…第一层的 enable 开关都默认打开」). Deriving also makes a tool added in
// a later version default-on for upgrading installs for free, which is the whole
// reason `get()`'s missing-row branch exists.
const DERIVES_FROM_REGISTRY = /const DEFAULT_ENABLED_TOOLS[^\n]*=\s*BUILT_IN_TOOLS\.map\(/
const ENUMERATED_LIST = /const DEFAULT_ENABLED_TOOLS[^=]*=\s*\[/

describe('tool preference defaults', () => {
  it('derive the default-on set from BUILT_IN_TOOLS instead of enumerating names', () => {
    const src = readFileSync('src/main/storage/tool-preferences-store.ts', 'utf8')
    expect(src).toMatch(DERIVES_FROM_REGISTRY)
    expect(src).not.toMatch(ENUMERATED_LIST)
    // Non-vacuity: both matchers must discriminate, or the two assertions above
    // could pass on any input. The pre-fix shape is reproduced inline.
    const oldSource = `const DEFAULT_ENABLED_TOOLS = [\n  'exec',\n  'read',\n  ...PAGE_TOOL_NAMES,\n]`
    expect(oldSource).not.toMatch(DERIVES_FROM_REGISTRY)
    expect(oldSource).toMatch(ENUMERATED_LIST)
  })
})
