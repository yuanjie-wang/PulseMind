/** 内置 browser skill 的内容钉（2026-11-13 四轮测试后的手册更新）。
 *
 *  skill 是模型第一次调 browser 工具前唯一会读的完整手册——四轮实测新增的
 *  接口面（readText / waitFor / 真实输入原语 / 后台激活）必须出现在这里，
 *  否则模型继续按旧规则工作（实测案例：上轮模型把「先探测 innerWidth」
 *  记成了新规则）。同时钉住 round-trip 无损：prompt 不得以换行结尾，否则
 *  formatSkillMd ↔ parseSkillMarkdown 签名永不互认、升级臂搁浅。 */

import { describe, expect, it } from 'vitest'
import { BROWSER_SKILL_PROMPT } from '../src/renderer/src/skills/built-in/browser'

describe('browser skill manual content', () => {
  it('teaches the readText reading channel with the read-vs-act split', () => {
    expect(BROWSER_SKILL_PROMPT).toContain('tab.readText()')
    expect(BROWSER_SKILL_PROMPT).toContain('Read with readText, act with domSnapshot')
    expect(BROWSER_SKILL_PROMPT).toContain('`strategy`')
  })

  it('teaches conditional waits with the exact/glob URL semantics and the trailing-slash pattern', () => {
    expect(BROWSER_SKILL_PROMPT).toContain('await tab.waitFor({ ... })')
    // The only pattern that actually matches `https://www.baidu.com/` — the
    // first cut recommended `**/*baidu.com*` (no trailing slash), which the
    // test model measured false and waited out.
    expect(BROWSER_SKILL_PROMPT).toContain("'**/*baidu.com/*'")
    expect(BROWSER_SKILL_PROMPT).toContain('NOT a substring')
    expect(BROWSER_SKILL_PROMPT).toContain('met: false')
  })

  it('retires the innerWidth probe: background tabs activate automatically', () => {
    expect(BROWSER_SKILL_PROMPT).toContain('bring the tab to the pane\'s front automatically')
    expect(BROWSER_SKILL_PROMPT).toContain('obsolete, do not do it')
    expect(BROWSER_SKILL_PROMPT).toContain('视口为 0×0')
  })

  it('teaches the real-input hold primitives and the drag signature', () => {
    expect(BROWSER_SKILL_PROMPT).toContain('tab.mouse.down()/up()')
    expect(BROWSER_SKILL_PROMPT).toContain('tab.mouse.drag({x,y}, {x,y}, { steps? })')
    expect(BROWSER_SKILL_PROMPT).toContain('TWO point objects')
    expect(BROWSER_SKILL_PROMPT).toContain('`down(key)`/`up(key)`')
    expect(BROWSER_SKILL_PROMPT).toContain('clickCount: 2')
    expect(BROWSER_SKILL_PROMPT).toContain('NO success signal')
  })

  it('favorites positional args and per-conversation login state', () => {
    expect(BROWSER_SKILL_PROMPT).toContain('POSITIONAL arguments')
    expect(BROWSER_SKILL_PROMPT).toContain('Login state is shared across ONE conversation')
  })

  it('the prompt never ends with a trailing newline (seed round-trip stays lossless)', () => {
    // parseSkillMarkdown .trim()s the body: a trailing newline here means the
    // definition signature and the seeded SKILL.md signature never agree, and
    // the provenance upgrade arm strands (2026-11-04 lesson).
    expect(BROWSER_SKILL_PROMPT.endsWith('\n')).toBe(false)
    expect(BROWSER_SKILL_PROMPT.endsWith('mega-script.`')).toBe(false)
    expect(BROWSER_SKILL_PROMPT.endsWith('mega-script.')).toBe(true)
  })
})
