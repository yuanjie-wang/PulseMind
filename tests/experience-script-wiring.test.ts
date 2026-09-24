import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Source scans pin the three-layer wiring (bridge / handler / preload) and the
// prompt-level hard constraints — the same style as tests/last-used-defaults.
// Empty matches fail loudly, so a broken scan cannot pass by comparing nulls.
const read = (p: string): string => readFileSync(new URL('../' + p, import.meta.url), 'utf-8')

describe('readExperienceFile — three-layer wiring', () => {
  it('the bridge declares it, the preload exposes it, the handler routes it', () => {
    expect(read('src/shared/types/electron-bridge.ts')).toContain('readExperienceFile: (name: string, relPath: string) => Promise<string | null>')
    expect(read('src/preload/index.ts')).toContain('IPC_CHANNELS.EXPERIENCES_READ_FILE')
    expect(read('src/main/ipc/experiences.handler.ts')).toContain('IPC_CHANNELS.EXPERIENCES_READ_FILE')
    expect(read('src/main/agent/main-host.ts')).toContain('readExperienceFile:')
  })

  it('the channel exists in the shared registry', () => {
    expect(read('src/shared/ipc-channels.ts')).toContain("EXPERIENCES_READ_FILE: 'experiences:read-file'")
  })
})

describe('the pick_skill envelope names where the scripts live', () => {
  it('both experience branches append the Location/Directory block', () => {
    const src = read('src/renderer/src/agent/tool-executors.ts')
    expect(src).toContain('async function experienceLocationBlock')
    expect(src).toContain('**Location:**')
    expect(src).toContain('**Directory:**')
    // both call sites (name-driven and intent-driven selection)
    expect(src.match(/experienceLocationBlock\(/g)?.length).toBeGreaterThanOrEqual(3)
    // Runtime shape: every CALL SITE must await — the helper is async, and an
    // un-awaited interpolation ships "[object Promise]" as the envelope tail
    // (review0925's actual bug). Occurrence counts cannot see it; the await
    // prefix can. The lookbehind excludes the `async function` definition.
    const callSites = src.match(/(?<!function )experienceLocationBlock\(/g) ?? []
    const awaited = src.match(/await experienceLocationBlock\(/g) ?? []
    expect(callSites.length).toBeGreaterThanOrEqual(2)
    expect(awaited.length).toBe(callSites.length)
  })
})

describe('the extraction prompt carries the script hard constraints', () => {
  it('node-only builtins, argv parameterization, and the fence form are in the prompt', () => {
    const src = read('src/renderer/src/agent/one-shot-agent/SessionReviewAgent.ts')
    expect(src).toContain('### File: scripts/<name>.mjs')
    expect(src).toContain('ONLY built-in modules')
    expect(src).toContain('NO npm')
    expect(src).toContain('process.argv')
    expect(src).toContain('## 脚本 (Script)')
  })

  it('the parser caps at 3 files and validates the scripts/ prefix', () => {
    const src = read('src/shared/experience/script-fence.ts')
    expect(src).toContain('MAX_SCRIPTS_PER_EXPERIENCE = 3')
    expect(src).toContain("path.startsWith('scripts/')")
  })
})

describe('the store gates', () => {
  it('save runs path + size + syntax gates and the files_json upsert preserves old lists', () => {
    const src = read('src/main/storage/experience-store.ts')
    expect(src).toContain('MAX_SCRIPT_BYTES = 8 * 1024')
    expect(src).toContain('MAX_SCRIPTS_PER_EXPERIENCE')
    expect(src).toContain("['--check', tmp]")
    expect(src).toContain('COALESCE(excluded.files_json, experiences.files_json)')
    expect(src).toContain('rejectedFiles')
  })

  it('the panel shows the 含脚本 badge, a read-only viewer and the eviction message', () => {
    const src = read('src/renderer/src/components/settings/ExperiencePanel.tsx')
    expect(src).toContain('含脚本')
    expect(src).toContain('pm-experience-evicted')
    expect(src).toContain('已淘汰包含脚本的经验')
    expect(src).toContain('readExperienceFile')
  })
})

describe('extraction saves carry files end to end', () => {
  it('SessionReviewOutput → extractAndSaveAll → save call sites', () => {
    expect(read('src/renderer/src/agent/one-shot-agent/SessionReviewAgent.ts')).toContain('parseScriptFences(content)')
    expect(read('src/renderer/src/memory/MemoryManager.ts')).toContain('experienceFiles')
    expect(read('src/main/agent/session-manager.ts')).toContain('files: result.experienceFiles')
    expect(read('src/renderer/src/App.tsx')).toContain('files: result.experienceFiles')
    expect(read('src/renderer/src/hooks/useChatController.ts')).toContain('files: result.experienceFiles')
  })
})
