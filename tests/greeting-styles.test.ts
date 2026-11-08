// PLAN-greeting-styles（2026-11-07）——欢迎语随机性从模型收回到代码：
// 5 风格池 + pickGreetingStyle 代码预选（lastId 排除不连续同风格）注入 prompt。
// 钉住：池不变量、pick 确定性与排除臂、GreetingAgent 风格注入、useGreeting 两处
// execute 均传 pickGreetingStyle（防回退成 void 输入）。

import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GREETING_STYLES, pickGreetingStyle, pickGreetingEnv } from '../src/renderer/src/agent/one-shot-agent/greeting-styles'
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

// ── 环境要素概率注入（user 2026-11-08 裁定：时段/季节各自 50%）──

describe('pickGreetingEnv', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // rand 被独立调用两次（第一次季节、第二次时段）——用序列桩区分两拍。
  const seq = (vals: number[]) => {
    let i = 0
    return () => vals[i++ % vals.length]
  }

  it('两次独立判定：各拍 <0.5 上送、≥0.5 缺席，互不联动', () => {
    expect(pickGreetingEnv(seq([0.1, 0.1]))).toEqual({ season: expect.any(String), slot: expect.any(String) })
    expect(pickGreetingEnv(seq([0.7, 0.7]))).toEqual({ season: null, slot: null })
    expect(pickGreetingEnv(seq([0.3, 0.7]))).toEqual({ season: expect.any(String), slot: null })
    expect(pickGreetingEnv(seq([0.7, 0.3]))).toEqual({ season: null, slot: expect.any(String) })
  })

  it('边界 0.5 恰好缺席（< 0.5 才上送）', () => {
    expect(pickGreetingEnv(seq([0.5, 0.5]))).toEqual({ season: null, slot: null })
  })
})

// ── GreetingAgent 风格注入 ──

class ProbeGreetingAgent extends GreetingAgent {
  expose(input: Parameters<GreetingAgent['buildSystemPrompt']>[0]): string {
    return this.buildSystemPrompt(input)
  }
}

describe('GreetingAgent prompt', () => {
  const style = GREETING_STYLES[2]
  const req = (env: { season: string | null; slot: string | null }) => ({ style, env })

  it('buildSystemPrompt 注入所选风格的 name 与 instruction', () => {
    const prompt = new ProbeGreetingAgent().expose(req({ season: null, slot: null }))
    expect(prompt).toContain(`风格为「${style.name}：${style.instruction}」`)
    expect(prompt).not.toContain('可随机风格')
  })

  it('环境行条件化：两要素都在/只在一个/全缺席（行号顺延）', () => {
    const both = new ProbeGreetingAgent().expose(req({ season: '秋天', slot: '下午' }))
    expect(both).toContain('4. 环境信息： 秋天 下午')
    expect(both).toContain('5. 禁令')
    const seasonOnly = new ProbeGreetingAgent().expose(req({ season: '秋天', slot: null }))
    expect(seasonOnly).toContain('4. 环境信息： 秋天')
    expect(seasonOnly).toContain('5. 禁令')
    const none = new ProbeGreetingAgent().expose(req({ season: null, slot: null }))
    expect(none).not.toContain('环境信息')
    expect(none).toContain('4. 禁令')
  })

  it('buildUserMessages：有要素带「当前是…」，全缺席是中性指令', () => {
    const agent = new ProbeGreetingAgent()
    const build = (env: { season: string | null; slot: string | null }): string =>
      (agent as unknown as { buildUserMessages(r: unknown): Array<{ content: string }> }).buildUserMessages(req(env))[0].content
    expect(build({ season: '春天', slot: '清晨' })).toBe('当前是春天清晨')
    expect(build({ season: null, slot: '清晨' })).toBe('当前是清晨')
    expect(build({ season: null, slot: null })).toBe('请输出问候语')
  })
})

// ── 接线扫描（防回退成 void 输入）──

describe('wiring', () => {
  const agentSrc = readFileSync(AGENT_PATH, 'utf-8')
  const hookSrc = readFileSync(HOOK_PATH, 'utf-8')

  it('GreetingAgent 的 TInput 是 GreetingRequest（风格 + 概率环境），prompt 含风格插值', () => {
    expect(agentSrc).toMatch(/OneShotAgent<GreetingRequest,/)
    expect(agentSrc).toContain('${style.name}')
    expect(agentSrc).toContain('${style.instruction}')
  })

  it('useGreeting 两处 execute 均传 { style, env: pickGreetingEnv() }，无 execute(undefined 残留', () => {
    expect(hookSrc.match(/const style = pickGreetingStyle\(lastStyleRef\.current\)/g)?.length).toBe(2)
    // prettier 会把 execute( 换行——匹配须空白容忍
    expect(hookSrc.match(/execute\(\s*\{ style, env: pickGreetingEnv\(\) \},/g)?.length).toBe(2)
    expect(hookSrc).not.toContain('execute(undefined')
    expect(hookSrc).toContain('lastStyleRef')
  })
})
