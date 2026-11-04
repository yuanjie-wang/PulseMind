// ── UI zip 导入 → 主进程共享 SkillManager 的活体登记（2026-11-04）──
// ensureManagers 只在首个会话创建时扫一次盘：import 只写盘时 pick_skill 要
// 重启才能找到；delete 只删盘时 freshSkillDefinition 回落注册表旧副本 =
// 已删除的技能继续可用。钉两层：(1) live-skill-registry 对真 SkillManager
// 的行为；(2) 两个 IPC 门与 ensureManagers 的接线形状（源码扫描——
// session-manager 拖着 better-sqlite3 链，vitest 起不来，见 AGENTS「单测
// 纪律」）。

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SkillManager } from '../src/renderer/src/skills/SkillManager'
import { bindLiveSkillManager, registerLiveSkills, unregisterLiveSkill } from '../src/main/agent/live-skill-registry'
import type { SkillDefinition } from '../src/shared/types/skill-types'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

const skill = (name: string): SkillDefinition => ({
  name,
  description: `${name} 的用途`,
  category: 'user',
  systemPrompt: 'body',
})

const enabledNames = (m: SkillManager): string[] => m.getEnabledSkills().map((s) => s.definition.name)

describe('live-skill-registry against a real SkillManager', () => {
  let manager: SkillManager

  beforeEach(() => {
    manager = new SkillManager()
    bindLiveSkillManager(manager)
  })

  it('registers an imported skill enabled — pick_skill by name AND by intent find it', () => {
    // execPickSkill 的名字臂读 getSkill（不看 enabled），intent 臂的候选表读
    // getEnabledSkills——两臂都要命中才算「立即可用」。
    registerLiveSkills([skill('zip-imported')])
    expect(manager.getSkill('zip-imported')?.definition.name).toBe('zip-imported')
    expect(enabledNames(manager)).toContain('zip-imported')
  })

  it('re-enables an already-registered skill the registry had disabled', () => {
    // registerSkill 对同名已注册项返回 false 且保留原 enabled 态——不补那
    // 次 enable，重装一个曾被用户关掉的技能会带着 disabled 回来，intent 臂
    // 选不中它。
    registerLiveSkills([skill('zip-imported')])
    manager.disable('zip-imported')
    registerLiveSkills([skill('zip-imported')])
    expect(enabledNames(manager)).toContain('zip-imported')
  })

  it('no-ops before the shared manager is assembled', () => {
    // 首个会话创建前导入：这里什么都不做是对的——之后的 ensureManagers 会
    // 用 listImported 把盘上的新技能全量收进来。
    bindLiveSkillManager(null)
    expect(() => registerLiveSkills([skill('early-import')])).not.toThrow()
    expect(() => unregisterLiveSkill('early-import')).not.toThrow()
  })

  it('unregisters a deleted imported skill and refuses built-ins', () => {
    registerLiveSkills([skill('zip-imported')])
    unregisterLiveSkill('zip-imported')
    expect(manager.getSkill('zip-imported')).toBeUndefined()
    // 内置技能在构造器里播种（builtIn: true），FeatureManager.unregister 拒
    // 绝摘除——删除门只该作用于导入技能。
    unregisterLiveSkill('create_skill')
    expect(manager.getSkill('create_skill')).toBeDefined()
  })
})

describe('wiring: the two IPC doors and the assembly bind', () => {
  const HANDLER = read('src', 'main', 'ipc', 'skills.handler.ts')
  const SESSION_MANAGER = read('src', 'main', 'agent', 'session-manager.ts')

  it('SKILLS_IMPORT registers what the zip landed on disk', () => {
    const start = HANDLER.indexOf('SKILLS_IMPORT')
    expect(start).toBeGreaterThan(-1)
    const body = HANDLER.slice(start, HANDLER.indexOf('SKILLS_LIST_IMPORTED'))
    // 非空条件：先落盘再登记，登记吃 importFromZip 的返回值（只有真正写入
    // 的 def 才在其中，重名 skipped 的不进）。
    expect(body).toContain('skillStore.importFromZip')
    expect(body).toContain('registerLiveSkills(imported.imported)')
    expect(body.indexOf('skillStore.importFromZip')).toBeLessThan(body.indexOf('registerLiveSkills'))
  })

  it('SKILLS_DELETE_IMPORTED unregisters the live entry after the disk delete', () => {
    const start = HANDLER.indexOf('SKILLS_DELETE_IMPORTED')
    expect(start).toBeGreaterThan(-1)
    const body = HANDLER.slice(start, HANDLER.indexOf('SKILLS_ENSURE_BUILT_IN'))
    expect(body).toContain('skillStore.deleteImported')
    expect(body).toContain('unregisterLiveSkill(name)')
    expect(body.indexOf('skillStore.deleteImported')).toBeLessThan(body.indexOf('unregisterLiveSkill'))
  })

  it('ensureManagers binds the shared skill manager once assembled', () => {
    // 绑定必须发生在 this.managers 装配之后、任何会话拿到它之前——扫描锚
    // 定在装配块内而非文件任意位置。
    const assignIdx = SESSION_MANAGER.indexOf('this.managers = {')
    const bindIdx = SESSION_MANAGER.indexOf('bindLiveSkillManager(this.managers.skillManager)')
    const settingsIdx = SESSION_MANAGER.indexOf('const startupSettings = await settingsStore.get()')
    expect(assignIdx).toBeGreaterThan(-1)
    expect(bindIdx).toBeGreaterThan(assignIdx)
    expect(bindIdx).toBeLessThan(settingsIdx)
  })
})
