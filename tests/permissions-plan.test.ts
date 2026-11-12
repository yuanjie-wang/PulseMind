import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { buildPermissionPlan } from '../src/main/storage/permissions'

describe('buildPermissionPlan — the explicit checklist (P0)', () => {
  const dataDir = '/home/u/.pulsemind'
  const plan = buildPermissionPlan(dataDir)
  const paths = plan.map((t) => t.path)

  it('covers the sensitive dirs at 0700', () => {
    // experience/（2026-11-12 经验 SKILL 化）：磁盘真源根目录与 db/logs 同待遇。
    for (const dir of [dataDir, join(dataDir, 'db'), join(dataDir, 'logs'), join(dataDir, 'logs', 'llm-requests'), join(dataDir, 'memory'), join(dataDir, 'tmp'), join(dataDir, 'experience')]) {
      const t = plan.find((p) => p.path === dir)
      expect(t, dir).toBeTruthy()
      expect(t!.mode).toBe(0o700)
      expect(t!.kind).toBe('dir')
    }
  })

  it('covers settings.json, service-token and MEMORY.md at 0600', () => {
    expect(paths).toContain(join(dataDir, 'settings.json'))
    expect(paths).toContain(join(dataDir, 'service-token'))
    expect(paths).toContain(join(dataDir, 'memory', 'MEMORY.md'))
    for (const p of [join(dataDir, 'settings.json'), join(dataDir, 'service-token'), join(dataDir, 'memory', 'MEMORY.md')]) {
      expect(plan.find((t) => t.path === p)!.mode).toBe(0o600)
    }
  })

  it('the plan is data-shape only: no recursion into workspace/knowledge/tools', () => {
    expect(paths.some((p) => p.startsWith(join(dataDir, 'workspace')))).toBe(false)
    expect(paths.some((p) => p.startsWith(join(dataDir, 'knowledge')))).toBe(false)
    expect(paths.some((p) => p.startsWith(join(dataDir, 'tools')))).toBe(false)
    // And every entry is one level deep at most beneath its parent dir.
    for (const t of plan) {
      expect(t.path.startsWith(dataDir)).toBe(true)
    }
  })

  it('custom overrides let a test point the same checklist at a sandbox', () => {
    const plan2 = buildPermissionPlan(dataDir, {
      settingsPath: '/elsewhere/settings.json',
      memoryPath: '/elsewhere/MEMORY.md',
      serviceTokenPath: '/elsewhere/service-token',
    })
    expect(plan2.map((t) => t.path)).toContain('/elsewhere/settings.json')
  })
})
