// ── 技能缺省开启（2026-11-04 用户裁定「把缺省当作打开就行」）──
// 旧模型把 `enabledSkills` 当精确白名单：全新安装的回退值只写了两个技能，
// 于是 templates/ 随包播种的技能（templates/pulsemind/skills/cloud-doc-ops）
// 与 zip 导入的技能一律以「关」的面貌出现，用户得自己去技能面板找开关。
// 现在权威开关是**显式关闭名单** `disabledSkills`：缺省/空 = 全部开启，
// 内置技能永不可关，前者的 triggers 还会落成关键词供自动激活。
// 存储层（better-sqlite3）在纯 Node 下起不来，这里钉两层：真 SkillManager
// 的行为 + store/DB/renderer 的接线形状（源码扫描，见 AGENTS「单测纪律」）。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SkillManager } from '../src/renderer/src/skills/SkillManager'
import { BUILT_IN_SKILLS } from '../src/renderer/src/skills/built-in-skills'
import type { SkillDefinition } from '../src/shared/types/skill-types'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

const skill = (name: string, triggers?: string[]): SkillDefinition => ({
  name,
  description: `${name} 的用途`,
  category: 'automation',
  triggers,
  systemPrompt: 'body',
})

const enabledNames = (m: SkillManager): string[] => m.getEnabledSkills().map((s) => s.definition.name)
const builtInNames = BUILT_IN_SKILLS.map((s) => s.name)

describe('skills default to enabled', () => {
  it('a freshly registered (template/imported) skill is on', () => {
    const manager = new SkillManager()
    manager.registerSkill(skill('cloud-doc-ops'))
    expect(enabledNames(manager)).toContain('cloud-doc-ops')
  })

  it('every built-in is on without any persisted preference', () => {
    const manager = new SkillManager()
    for (const name of builtInNames) expect(enabledNames(manager)).toContain(name)
  })

  it('a legacy enabledSkills allow-list does not switch skills off', () => {
    // 老机器上的偏好只有 enabledSkills（精确名单）。它不再驱动状态——
    // 名单之外的模板技能必须照常可用，否则升级机器永远看不到它们。
    const manager = new SkillManager()
    manager.registerSkill(skill('cloud-doc-ops'))
    manager.applyPreferences({ enabledSkills: ['create_skill', 'create_mcp'] })
    expect(enabledNames(manager)).toContain('cloud-doc-ops')
    expect(manager.getPreferences().disabledSkills).toEqual([])
  })

  it('an explicit disable persists and survives a reload', () => {
    const manager = new SkillManager()
    manager.registerSkill(skill('cloud-doc-ops'))
    manager.toggle('cloud-doc-ops')

    const persisted = manager.getPreferences()
    expect(persisted.disabledSkills).toEqual(['cloud-doc-ops'])

    const reloaded = new SkillManager()
    reloaded.registerSkill(skill('cloud-doc-ops'))
    reloaded.applyPreferences(persisted)
    expect(enabledNames(reloaded)).not.toContain('cloud-doc-ops')
  })

  it('an explicit disable is sticky across re-registration (disk refresh)', () => {
    const manager = new SkillManager()
    manager.applyPreferences({ enabledSkills: [], disabledSkills: ['cloud-doc-ops'] })
    // registerSkill 的 autoEnable 不得把用户关掉的技能又打开。
    manager.registerSkill(skill('cloud-doc-ops'))
    expect(enabledNames(manager)).not.toContain('cloud-doc-ops')
  })

  it('built-ins cannot be disabled through preferences', () => {
    const manager = new SkillManager()
    manager.applyPreferences({ enabledSkills: [], disabledSkills: [...builtInNames] })
    for (const name of builtInNames) expect(enabledNames(manager)).toContain(name)
  })

  it('seeds triggers as keywords for every skill, not just built-ins', () => {
    // 自动激活（system-prompt-builder 的 matchSkills）读 skillKeywords，
    // 旧实现只给 BUILT_IN_SKILLS 播种——模板技能即使开了也不会被关键词唤起。
    const manager = new SkillManager()
    manager.registerSkill(skill('cloud-doc-ops', ['云文档', '在线Excel']))
    expect(manager.getPreferences().skillKeywords?.['cloud-doc-ops']).toEqual(['云文档', '在线Excel'])
  })

  it('never overwrites keywords already recorded for a skill', () => {
    const manager = new SkillManager()
    manager.applyPreferences({ enabledSkills: [], disabledSkills: [], skillKeywords: { 'cloud-doc-ops': ['backfilled'] } })
    manager.registerSkill(skill('cloud-doc-ops', ['云文档']))
    expect(manager.getPreferences().skillKeywords?.['cloud-doc-ops']).toEqual(['backfilled', '云文档'])
  })
})

describe('default-open wiring', () => {
  it('persists the opt-OUT column, not the legacy allow-list', () => {
    const db = read('src/main/storage/database.ts')
    expect(db).toContain('disabled_skills')
    expect(db).toMatch(/ALTER TABLE skill_preferences ADD COLUMN disabled_skills/)

    const store = read('src/main/storage/skill-store.ts')
    expect(store).toContain('disabled_skills')
    expect(store).toContain('replaceDisabledSkills')
    expect(store).not.toContain('replaceEnabledSkills')
    // 没有落过盘的行 = 缺省开启；calibrate 不得在此时写回空名单
    // （它跑在 ensureBuiltInSkills 播种之前，skills 目录还是空的）。
    expect(store).toMatch(/SELECT id FROM skill_preferences WHERE id = 1[\s\S]{0,200}?return/)

    const hook = read('src/renderer/src/hooks/useChatManagers.ts')
    expect(hook).toContain('replaceDisabledSkills')
    // 技能面板的开关写穿到同一列：切 off 走 getPreferences().disabledSkills。
    expect(read('src/renderer/src/skills/SkillManager.ts')).toMatch(/disabledSkills: all\.filter/)
  })
})
