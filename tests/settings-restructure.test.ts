// ── Settings restructure (PLAN-settings-restructure) ──
// Source-scan guards for the three moves. Vitest here is node-env: the hooks and
// App cannot be mounted, which is exactly why the wiring is asserted as source.
// Non-vacuity for each assertion is noted inline (what breaks when the guarded
// line is reverted).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')

describe('P1 — built-in tools moved into the capability center', () => {
  const center = read('src/renderer/src/components/capability/CapabilityCenter.tsx')
  const centersPage = read('src/renderer/src/components/centers/CentersPage.tsx')
  const viewHost = read('src/renderer/src/components/layout/ViewHost.tsx')
  const navTypes = read('src/renderer/src/navigation/types.ts')
  const settingsPage = read('src/renderer/src/components/settings/SettingsPage.tsx')
  const zh = read('src/renderer/src/i18n/locales/zh.ts')
  const en = read('src/renderer/src/i18n/locales/en.ts')

  it('the capability tab union carries tools', () => {
    expect(center).toMatch(/export type CapabilityTab = 'mcp' \| 'skills' \| 'expert' \| 'tools'/)
  })

  it('the tabs array is ordered 专家 → 技能 → 连接器 → 内置工具', () => {
    const expert = center.indexOf("key: 'expert'")
    const skills = center.indexOf("key: 'skills'")
    const mcp = center.indexOf("key: 'mcp'")
    const tools = center.indexOf("key: 'tools'")
    for (const i of [expert, skills, mcp, tools]) expect(i).toBeGreaterThan(-1)
    expect(expert).toBeLessThan(skills)
    expect(skills).toBeLessThan(mcp)
    expect(mcp).toBeLessThan(tools)
  })

  it("the default and visited seed are 'expert'", () => {
    expect(center).toMatch(/initialTab \?\? 'expert'/g)
    // Non-vacuity: the seed rides the same expression; count both sites.
    expect(center.match(/initialTab \?\? 'expert'/g)?.length).toBe(2)
  })

  it('CentersPage threads tools/onToggleTool into CapabilityCenter', () => {
    expect(centersPage).toMatch(/tools\?: ToolState\[\]/)
    expect(centersPage).toMatch(/onToggleTool\?: \(name: string\) => void/)
    expect(centersPage).toMatch(/tools=\{tools\}/)
    expect(centersPage).toMatch(/onToggleTool=\{onToggleTool\}/)
  })

  it('ViewHost passes tools/onToggleTool to CentersPage', () => {
    // The element is the lazy wrapper — every view branch is `lazy()`-ed so the
    // entry chunk stops carrying eight pages — and the props still ride it.
    const start = viewHost.indexOf('<LazyCentersPage')
    const end = viewHost.indexOf('/>', start)
    const call = viewHost.slice(start, end)
    expect(call).toContain('tools={tools}')
    expect(call).toContain('onToggleTool={onToggleTool}')
  })

  it("the settings page no longer renders a 'tools' section", () => {
    expect(settingsPage).not.toMatch(/case 'tools':/)
    expect(settingsPage).not.toMatch(/from '\.\/ToolSettings'/)
  })

  it("settingsTab no longer carries 'tools' (moved) — and no navigation targets it", () => {
    expect(navTypes).not.toMatch(/settingsTab\?[^\n]*'tools'/)
    // Non-vacuity: walk every renderer source for a settingsTab: 'tools' deep link.
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const e of require('node:fs').readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) out.push(...walk(p))
        else if (/\.(tsx?|ts)$/.test(e.name)) out.push(p)
      }
      return out
    }
    for (const f of walk('src/renderer/src')) {
      const src = readFileSync(f, 'utf8')
      expect(src, `${f} still deep-links settingsTab: 'tools'`).not.toMatch(/settingsTab:\s*'tools'/)
    }
  })

  it('the sidebar entry reads 创作中心 / Creation Center (D5)', () => {
    expect(zh).toMatch(/tools: '创作中心'/)
    expect(zh).toMatch(/centers: '能力 • 知识 • 创作'/)
    expect(read('src/renderer/src/i18n/locales/en.ts')).toMatch(/tools: 'Creation Center'/)
  })
})
