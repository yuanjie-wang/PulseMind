// ── 设置保存 → 活会话引擎 option bag 的判定（2026-11-22）──
// 病例：改「最大上下文」只存盘，已打开的会话继续用建会话那一刻的袋子。实测
// conv_20261122211023 在 21:13 存了 contextLength 50000，21:14–21:16 六个请求
// 仍按 150K 计价（状态块 150K、main.log 的预算 b=117232 = 150000 − 32768），
// 一次压缩都没触发。
//
// 这里钉两件事：
//   1. 判据本身 —— 只有引擎 option bag 的**输入**变了才刷新。判据宽一寸，保存
//      主题就会重建所有活会话的 adapter；窄一寸，就又回到「改了不生效」。
//   2. 接线 —— 判定函数造得再对，没人在保存路径上调用它也是零。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { optionBagSignature, refreshOptionBags } from '../src/main/services/option-bag-sync'
import type { AppSettings, LlmProfile } from '../src/shared/types/settings'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

const PROFILE_A: LlmProfile = {
  id: 'model_a',
  name: 'A',
  provider: 'openai',
  baseURL: 'https://api.example.com/v1',
  model: 'model-a',
  maxTokens: 32768,
  contextLength: 150000,
  apiKey: 'sk-a',
}

const PROFILE_B: LlmProfile = {
  id: 'model_b',
  name: 'B',
  provider: 'anthropic',
  baseURL: 'https://api.example.com',
  model: 'model-b',
  maxTokens: 8192,
  contextLength: 50000,
}

/** A settings snapshot with only the required fields spelled out. */
function settings(over: Partial<AppSettings> = {}): AppSettings {
  return {
    activeProfileId: 'model_a',
    providers: [],
    profiles: [PROFILE_A, PROFILE_B],
    theme: 'dark',
    myName: '王',
    soul: '',
    yourName: 'PulseMind',
    ...over,
  }
}

/** Patch one profile in place (the panel's own edit shape). */
function withProfile(id: string, patch: Partial<LlmProfile>, base = settings()): AppSettings {
  return {
    ...base,
    profiles: base.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
  }
}

/** Drive the gate with a spy — returns [called, returnValue]. */
async function gate(prev: AppSettings | null, next: AppSettings): Promise<{ called: number; refreshed: boolean }> {
  let called = 0
  const refreshed = await refreshOptionBags(prev, next, async () => {
    called++
  })
  return { called, refreshed }
}

describe('judge: 引擎 option bag 的输入变了才刷', () => {
  it('同一份设置重放一次（保存前没改任何东西）不刷', async () => {
    const s = settings()
    expect(await gate(s, settings())).toEqual({ called: 0, refreshed: false })
    // 同引用也不算「没变」——比较的是内容，不是引用。
    expect(await gate(s, s)).toEqual({ called: 0, refreshed: false })
  })

  it('改最大上下文 → 刷（本轮的原始病例）', async () => {
    const before = settings()
    const after = withProfile('model_a', { contextLength: 50000 }, before)
    expect(await gate(before, after)).toEqual({ called: 1, refreshed: true })
  })

  it('改输出上限 → 刷', async () => {
    const before = settings()
    const after = withProfile('model_a', { maxTokens: 8192 }, before)
    expect(await gate(before, after)).toEqual({ called: 1, refreshed: true })
  })

  it('改一个**非默认**模型的预算也刷（会话可能自己钉着那个模型）', async () => {
    const before = settings()
    const after = withProfile('model_b', { contextLength: 64000 }, before)
    expect(await gate(before, after)).toEqual({ called: 1, refreshed: true })
  })

  it('改 API Key / Base URL / 模型名 / 协议 → 刷', async () => {
    const before = settings()
    for (const patch of [
      { apiKey: 'sk-rotated' },
      { baseURL: 'https://proxy.example.com/v1' },
      { model: 'model-a-0613' },
      { provider: 'anthropic' as const },
    ]) {
      expect(await gate(before, withProfile('model_a', patch, before)), JSON.stringify(patch))
        .toEqual({ called: 1, refreshed: true })
    }
  })

  it('改人名 / 人格 / 助手名 / 语言 / 工作区 → 刷（它们进系统提示）', async () => {
    const before = settings()
    for (const patch of [
      { myName: '李' },
      { soul: '先给结论。' },
      { yourName: '小脉' },
      { locale: 'en' as const },
      { workspaceDir: '/tmp/other' },
    ]) {
      expect(await gate(before, { ...before, ...patch }), JSON.stringify(patch))
        .toEqual({ called: 1, refreshed: true })
    }
  })

  it('增删模型条目 → 刷', async () => {
    const before = settings()
    const dropped = { ...before, profiles: [PROFILE_A] }
    expect(await gate(before, dropped)).toEqual({ called: 1, refreshed: true })
    const added = { ...before, profiles: [...before.profiles, { ...PROFILE_B, id: 'model_c' }] }
    expect(await gate(before, added)).toEqual({ called: 1, refreshed: true })
  })

  it('没有旧值（模板包导入）按「一定变了」处理', async () => {
    expect(await gate(null, settings())).toEqual({ called: 1, refreshed: true })
  })
})

describe('不刷的那一面（判据不能宽到重建所有会话）', () => {
  it('主题 / 保留期 / 通知 / 代理 / 记忆开关的改动一律不刷', async () => {
    const before = settings()
    const unrelated: Array<Partial<AppSettings>> = [
      { theme: 'light' },
      { conversationRetentionDays: 7 },
      { routineRunRetentionDays: 30 },
      { autoCleanup: true },
      { memoryEnabled: false },
      { experienceEnabled: false },
      { launchAtLogin: true },
      { proxyUrl: 'http://127.0.0.1:8888' },
      { proxyEnabled: false },
      { debugLlmRequests: true },
      { maxLoopIterations: 50 },
      { maxParallelSubAgents: 2 },
    ]
    for (const patch of unrelated) {
      expect(await gate(before, { ...before, ...patch }), JSON.stringify(patch))
        .toEqual({ called: 0, refreshed: false })
    }
  })

  it('签名只看这些面：主题变了但 bag 没变 ⇒ 签名相同', () => {
    expect(optionBagSignature(settings({ theme: 'light' }))).toBe(optionBagSignature(settings({ theme: 'dark' })))
    expect(optionBagSignature(withProfile('model_a', { contextLength: 1000 })))
      .not.toBe(optionBagSignature(settings()))
  })
})

describe('接线：保存路径上真的调了它', () => {
  it('applySettingsSideEffects 拿旧值判、并刷新活会话', () => {
    const src = read('src/main/services/settings-side-effects.ts')
    expect(src).toContain('refreshOptionBags(')
    // 判据必须是「新旧对比」，不是「这次保存发生过」。
    expect(src).toContain('opts.previous')
    expect(src).toContain('agentSessionManager.refreshAllSessions()')
    // 新值必须取存储层视图：写入只认 providers，派生的 profiles 是 set() 重算
    // 的，调用方快照可能是旧的——喂错那边，真改动会被判成没改。
    expect(src).toMatch(/const fresh = await settingsStore\.get\(\)[\s\S]{0,200}?refreshOptionBags\(opts\.previous \?\? null, fresh/)
  })

  it('SETTINGS_SET 把保存前的设置透传下去', () => {
    const src = read('src/main/ipc/settings.handler.ts')
    expect(src).toContain('previous')
    // 旧值必须进 applySettingsSideEffects 的 options（shorthand `previous,` 也算）。
    expect(src).toMatch(/await applySettingsSideEffects\(settings,\s*\{[\s\S]*?\bprevious\b[\s\S]*?\n\s*\}\)/)
    // 旧值读失败时不能变成「跳过」——null 在判据里是「一定变了」。
    expect(src).toContain('let previous: AppSettings | null = null')
  })

  it('会话侧提供整表刷新，且逐个兜底（一个会话的模型被删不该连累其余）', () => {
    const src = read('src/main/agent/session-manager.ts')
    expect(src).toContain('async refreshAllSessions()')
    const body = src.slice(src.indexOf('async refreshAllSessions()'))
    const sweep = body.slice(0, body.indexOf('\n  }'))
    expect(sweep).toContain('this.sessions.keys()')
    expect(sweep).toContain('this.refreshOptions(sessionId)')
    expect(sweep).toContain('catch')
  })
})
