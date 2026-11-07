// PLAN-greeting-styles（2026-11-07）——欢迎语随机性从模型收回到代码：
// 5 风格池 + pickGreetingStyle 代码预选（lastId 排除不连续同风格）注入 prompt。
// 钉住：池不变量、pick 确定性与排除臂、GreetingAgent 风格注入、useGreeting 两处
// execute 均传 pickGreetingStyle（防回退成 void 输入）。

import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GREETING_STYLES, pickGreetingStyle } from '../src/renderer/src/agent/one-shot-agent/greeting-styles'
import { GreetingAgent } from '../src/renderer/src/agent/one-shot-agent/GreetingAgent'

const ROOT = join(import.meta.dirname, '..')
const AGENT_PATH = join(ROOT, 'src/renderer/src/agent/one-shot-agent/GreetingAgent.ts')
const HOOK_PATH = join(ROOT, 'src/renderer/src/hooks/useGreeting.ts')

// ── 风格池不变量 ──

describe('GREETING_STYLES', () => {
  it('数量 ≥3、id 唯一', () => {
    expect(GREETING_STYLES.length).toBeGreaterThanOrEqual(3)
    expect(new Set(GREETING_STYLES.map((s) => s.id)).size).toBe(GREETING_STYLES.length)
  })

  it('每条 instruction 非空且含字数约束关键词', () => {
    for (const style of GREETING_STYLES) {
      expect(style.name.trim().length).toBeGreaterThan(0)
      expect(style.instruction.trim().length).toBeGreaterThan(0)
      expect(style.instruction).toContain('15字以内')
    }
  })
})

// ── pickGreetingStyle ──

describe('pickGreetingStyle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mock Math.random 钉确定性：0 → 首个', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(pickGreetingStyle()).toBe(GREETING_STYLES[0])
  })

  it('恰好落在末位边界内的随机值 → 末个（越界值夹取不炸）', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999999)
    const picked = pickGreetingStyle()
    expect(picked).toBe(GREETING_STYLES[GREETING_STYLES.length - 1])
  })

  it('传 lastId 时必不返回 lastId（池 > 1，全随机值域覆盖）', () => {
    const last = GREETING_STYLES[0]
    const rest = GREETING_STYLES.filter((s) => s.id !== last.id)
    const spy = vi.spyOn(Math, 'random')
    for (let i = 0; i < 200; i++) {
      spy.mockReturnValue(i / 200)
      const picked = pickGreetingStyle(last.id)
      expect(picked.id).not.toBe(last.id)
      expect(rest).toContain(picked)
    }
  })

  it('循环 mock 值覆盖全池可达（每个风格都有落点）', () => {
    const hit = new Set<string>()
    const spy = vi.spyOn(Math, 'random')
    for (let i = 0; i < GREETING_STYLES.length * 10; i++) {
      spy.mockReturnValue(i / (GREETING_STYLES.length * 10))
      hit.add(pickGreetingStyle().id)
    }
    expect(hit.size).toBe(GREETING_STYLES.length)
  })
})

// ── GreetingAgent 风格注入 ──

class ProbeGreetingAgent extends GreetingAgent {
  expose(input: Parameters<GreetingAgent['buildSystemPrompt']>[0]): string {
    return this.buildSystemPrompt(input)
  }
}

describe('GreetingAgent prompt', () => {
  it('buildSystemPrompt 注入所选风格的 name 与 instruction', () => {
    const prompt = new ProbeGreetingAgent().expose(GREETING_STYLES[2])
    expect(prompt).toContain(`风格为「${GREETING_STYLES[2].name}：${GREETING_STYLES[2].instruction}」`)
    expect(prompt).not.toContain('可随机风格')
  })
})

// ── 接线扫描（防回退成 void 输入）──

describe('wiring', () => {
  const agentSrc = readFileSync(AGENT_PATH, 'utf-8')
  const hookSrc = readFileSync(HOOK_PATH, 'utf-8')

  it('GreetingAgent 的 TInput 是 GreetingStyle，prompt 含风格插值', () => {
    expect(agentSrc).toMatch(/OneShotAgent<GreetingStyle,/)
    expect(agentSrc).toContain('${style.name}')
    expect(agentSrc).toContain('${style.instruction}')
  })

  it('useGreeting 两处 execute 均传 pickGreetingStyle(...)，无 execute(undefined 残留', () => {
    expect(hookSrc.match(/const style = pickGreetingStyle\(lastStyleRef\.current\)/g)?.length).toBe(2)
    expect(hookSrc.match(/execute\(style,/g)?.length).toBe(2)
    expect(hookSrc).not.toContain('execute(undefined')
    expect(hookSrc).toContain('lastStyleRef')
  })
})
