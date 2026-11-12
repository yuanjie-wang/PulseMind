import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC_CHANNELS } from '../src/shared/ipc-channels'

// 第一代 experiences 池（表 + 磁盘目录 + ExperienceManager + IPC 面）已于
// 2026-11-12 整体弃用：技能中心经验板块 = memory_pages 二代活页 = pick_skill 候选面。
// 本文件是防接回的守卫 —— 任何一处「顺手把它加回来」都会在这里变红。

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const REMOVED_FILES = [
  // experience-store.ts 不在此列：第二代（2026-11-12 经验 SKILL 化）复用了这个文件名
  // 做磁盘 `EXPERIENCE.md` 真源。第一代的池式 API 由下方断言守，文件名不是承诺。
  'src/main/ipc/experiences.handler.ts',
  'src/renderer/src/experiences/ExperienceManager.ts',
  'src/shared/types/experience-types.ts',
  'tests/experience-script-store.test.ts',
]

const REMOVED_BRIDGE_METHODS = [
  'listExperiences',
  'saveExperienceRecord',
  'deleteExperienceRecord',
  'readExperienceRecord',
  'readExperienceFile',
  'touchExperienceRecord',
  'clearExperiences',
  'onExperiencesChanged',
]

describe('第一代 experiences 池已彻底弃用（2026-11-12 裁定，禁止复活）', () => {
  it('IPC 通道表里不再有 EXPERIENCES_* 通道', () => {
    const legacy = Object.keys(IPC_CHANNELS).filter((k) => k.startsWith('EXPERIENCES_'))
    expect(legacy).toEqual([])
  })

  it('第一代源文件与它独占的测试均已移除', () => {
    for (const rel of REMOVED_FILES) {
      expect(existsSync(join(ROOT, rel)), `${rel} 不该再存在`).toBe(false)
    }
  })

  it('experience-store.ts 只做磁盘真源，不含第一代池式 API', () => {
    // 同名文件被第二代复用，所以守 API 面而不是文件名：池、LRU 淘汰、draft 都不得回来。
    const src = readFileSync(join(ROOT, 'src/main/storage/experience-store.ts'), 'utf-8')
    for (const sym of ['MAX_EXPERIENCES', 'ExperienceRecord', 'ExperienceDraft', 'evictLru', 'listExperiences']) {
      expect(src.includes(sym), `experience-store.ts 仍含第一代符号 ${sym}`).toBe(false)
    }
  })

  it('桥类型与 preload 不再暴露经验池方法', () => {
    for (const rel of ['src/shared/types/electron-bridge.ts', 'src/preload/index.ts']) {
      const src = readFileSync(join(ROOT, rel), 'utf-8')
      for (const name of REMOVED_BRIDGE_METHODS) {
        expect(src.includes(name), `${rel} 仍含 ${name}`).toBe(false)
      }
    }
  })

  it('system prompt 不注入经验名索引（M4 裁定：只静态声明 pick_skill 是唯一拉取面）', () => {
    const src = readFileSync(join(ROOT, 'src/renderer/src/agent/system-prompt-builder.ts'), 'utf-8')
    expect(src.includes('buildNameIndex')).toBe(false)
  })

  it('第二代仍在线上：script-fence 自带类型，pick_skill 仍是经验拉取面', () => {
    // script-fence 被 tool-executors（序列化）与 SessionReviewAgent（解析）共用，
    // 是第二代经验页的脚本围栏，必须留在原地。
    const fence = readFileSync(join(ROOT, 'src/shared/experience/script-fence.ts'), 'utf-8')
    expect(fence).toContain('export interface ExperienceDraftFile')
    expect(fence.includes("from '../types/experience-types'")).toBe(false)

    // 活页候选面仍然是 pick_skill 的解析入口；截断常量不得回归
    // （注释里「此处曾 slice(0, EXP_CANDIDATE_MAX=30)」的历史说明不算违规）。
    const exec = readFileSync(join(ROOT, 'src/renderer/src/agent/tool-executors.ts'), 'utf-8')
    expect(exec).toContain('resolveExperiencePage')
    expect(exec.includes('const EXP_CANDIDATE_MAX')).toBe(false)
  })
})
