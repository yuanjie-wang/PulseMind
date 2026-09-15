import { describe, expect, it, beforeEach } from 'vitest'
import { SkillManager } from '../src/renderer/src/skills/SkillManager'
import type { SkillDefinition } from '../src/shared/types/skill-types'

/** Two user skills on top of whatever is built in. */
const skill = (name: string): SkillDefinition => ({
  name,
  description: `${name} 的用途`,
  category: 'user',
  systemPrompt: 'body',
})

/**
 * 可用技能白名单（专家 / 子代理）在提示词侧的收敛：勾了就只播报这几项，
 * 一项都没勾则什么都不播报（不是「全都可用」）。运行时拦截在 execPickSkill。
 */
describe('SkillManager.getSystemPromptAppendix whitelist', () => {
  let manager: SkillManager

  beforeEach(() => {
    manager = new SkillManager()
    manager.registerSkill(skill('code-review'))
    manager.registerSkill(skill('longform-writing'))
  })

  const namesIn = (appendix: string): string[] => [...appendix.matchAll(/<name>(.*?)<\/name>/g)].map((m) => m[1])

  it('lists every enabled skill when there is no whitelist', () => {
    const names = namesIn(manager.getSystemPromptAppendix())
    expect(names).toContain('code-review')
    expect(names).toContain('longform-writing')
  })

  it('advertises only the whitelisted skills', () => {
    expect(namesIn(manager.getSystemPromptAppendix(undefined, ['code-review']))).toEqual(['code-review'])
  })

  it('advertises nothing for an empty whitelist (none allowed)', () => {
    expect(manager.getSystemPromptAppendix(undefined, [])).toBe('')
  })

  it('returns nothing when the whitelist matches no installed skill', () => {
    expect(manager.getSystemPromptAppendix(undefined, ['uninstalled'])).toBe('')
  })

  it('keeps the skills directory in each advertised location', () => {
    const appendix = manager.getSystemPromptAppendix('/root/skills', ['code-review'])
    expect(appendix).toContain('/root/skills/code-review/SKILL.md')
  })
})
