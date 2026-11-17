import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveContextWindow, resolveMaxTokens } from '../src/renderer/src/utils/context-window'
import { DEFAULT_OUTPUT_RESERVE, effectiveInputWindow } from '../src/renderer/src/agent/engine/window-budget'

/**
 * 输入预算刻度（方案 A，user 2026-11-17 拍板）。
 *
 * 环的分母是**总窗口** —— 用户理解的「这个模型多大」；引擎压缩的分母是
 * `effectiveInputWindow`，扣掉了输出预留。200K 窗口配 32K 的 ask 时两者差
 * 32K：环显示 84% 时压缩其实已经触发。刻度线画在引擎真正的边界上，这一组
 * 断言钉的就是「刻度位置 == 引擎的边界」，而不是各算一套。
 *
 * 组件本身在 node 环境（无 jsdom）渲染不了，所以几何与接线走源码扫描 ——
 * 与本仓库对 hook/组件层的既定测法一致（staged-queue-wiring.test.ts 同款）。
 * 能直接算的那部分（解析链、刻度百分比）用真函数跑，不复制实现。
 */

const src = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const RING = 'src/renderer/src/components/chat/ContextRing.tsx'
const APP = 'src/renderer/src/App.tsx'
const POPOUT = 'src/renderer/src/popout/PopoutApp.tsx'

describe('resolveMaxTokens — 解析链镜像主进程', () => {
  const profiles = [
    { id: 'A', contextLength: 100_000, maxTokens: 4_000 },
    { id: 'B', contextLength: 200_000, maxTokens: 32_000 },
  ]

  it('prefers the session-pinned model', () => {
    // 会话钉在 A：拿 A 的预留。拿成 B 的 32K 就会把 A 的输入预算算小
    // 28K —— 那正是 2026-10-18 报告的那类错。
    expect(resolveMaxTokens(profiles, 'A', 'B')).toBe(4_000)
  })

  it('falls back to the active profile, then the first entry', () => {
    expect(resolveMaxTokens(profiles, undefined, 'B')).toBe(32_000)
    expect(resolveMaxTokens(profiles, undefined, undefined)).toBe(4_000)
  })

  it('never borrows another model’s reserve when the hit entry has none', () => {
    // 红线：命中的条目没设 maxTokens 时给 undefined（下游按缺省预留算：
    // DEFAULT_OUTPUT_RESERVE = 32_768，镜像主进程装配缺省，见下方钉子），
    // 不顺延到 profiles[0]。这里 profiles[0] 恰好有 32_000，若实现写成
    // `?.maxTokens ?? profiles[0]?.maxTokens` 就会静默通过 —— 所以另配一组
    // 让「别人有、它有」的差异可见。
    const mixed = [{ id: 'A', contextLength: 100_000 }, { id: 'B', contextLength: 200_000, maxTokens: 32_000 }]
    expect(resolveMaxTokens(mixed, 'A', 'B')).toBeUndefined()
  })

  it('preserves an explicit zero instead of swallowing it', () => {
    // 与主进程 `profile.maxTokens ?? 32_768` 同型：`??` 只吞 null/undefined。
    // 0 是显式值，这里只保证不被解析链吞掉；0 在下游被当成「无法表述」
    // 而回落默认预留，那是 window-budget 的口径，已有单测覆盖。
    expect(resolveMaxTokens([{ id: 'A', maxTokens: 0 }], 'A', undefined)).toBe(0)
  })

  it('缺省预留镜像主进程装配缺省（session-manager 的 ?? 32768）', () => {
    // 渲染端刻度对「profile 没设 maxTokens」的回落值，必须与主进程喂给引擎
    // 的装配缺省是同一个数——两边各说各话时，刻度与引擎真实边界差 768
    // tokens（32_000 vs 32_768，2026-11-17 评审钉死）。扫装配处的字面量：
    // 将来改主进程缺省而忘了改 DEFAULT_OUTPUT_RESERVE（或反之），这里先红。
    const sessions = src('src/main/agent/session-manager.ts')
    const defaults = [...sessions.matchAll(/maxTokens: profile\.maxTokens \?\? (\d+)/g)].map((m) => m[1])
    expect(defaults.length, 'main process assembles maxTokens in at least one place').toBeGreaterThan(0)
    expect(new Set(defaults)).toEqual(new Set([String(DEFAULT_OUTPUT_RESERVE)]))
  })

  it('reads window and reserve off the SAME entry', () => {
    // 拆成两份实现就会漂移：窗口取 A、预留取 B 时，预算会凭空多出 28K。
    const mixed = [{ id: 'A', contextLength: 100_000 }, { id: 'B', contextLength: 200_000, maxTokens: 32_000 }]
    expect(resolveContextWindow(mixed, 'A', 'B')).toBe(100_000)
    expect(resolveMaxTokens(mixed, 'A', 'B')).toBeUndefined()
    // 非空性：B 的两个值都不是上面读到的，证明确实是按 A 读的。
    expect(mixed[1].contextLength).not.toBe(100_000)
    expect(mixed[1].maxTokens).not.toBeUndefined()
  })
})

describe('刻度位置 == 引擎压缩的边界', () => {
  it('200K 窗口配 32K ask：环上 84% 就是压缩点', () => {
    // 这行断言就是这次功能的全部意义：用户看到指针越过刻度线（84%），
    // 压缩开始 —— 不再对着「才 84% 怎么就压缩了」发懵。
    const total = 200_000
    const budget = effectiveInputWindow(total, 32_000)
    expect(budget).toBe(168_000)
    expect(Math.round((budget / total) * 100)).toBe(84)
  })

  it('小窗口下刻度落在环的半途', () => {
    // 65536 是 re-aim 收回来的真实值（400 振荡那一例）。这里刻度在 51%：
    // 越早画出来越是好事，说明「环还很空就开始压缩」有可见的理由。
    const total = 65_536
    const budget = effectiveInputWindow(total, 32_000)
    expect(budget).toBe(33_536)
    expect(Math.round((budget / total) * 100)).toBe(51)
  })

  it('ask 未知时按默认预留画，与引擎同一回落', () => {
    // 缺省预留 = 32_768（镜像主进程装配缺省），不再是 ZCode 的 32_000：
    // 200_000 - 32_768 = 167_232，环上取整仍显示 84%，与显式 32K ask 的
    // 那条刻度肉眼无差，但数值上与引擎边界严格同值。
    const total = 200_000
    expect(effectiveInputWindow(total, undefined)).toBe(167_232)
    expect(effectiveInputWindow(total, 0)).toBe(167_232)
  })
})

describe('ContextRing — 刻度几何', () => {
  const ring = src(RING)

  it('draws only for 0 < budget < total', () => {
    // 等于 total 时刻度正落在顶点（无信息）；大于 total 说明宿主与本组件
    // 口径不一致 —— 宁可不画，也不画一根与引擎不符的线。
    expect(ring).toContain('inputBudget > 0 && inputBudget < total')
    expect(ring).toContain('inputBudget / total')
  })

  it('places the tick by the same angle convention as the fill arc', () => {
    // 填充弧用 rotate(-90) 把 0% 转到顶点；刻度的角度若也按 0%=顶点算，
    // 必须自己减 π/2。两处约定一旦分叉，刻度就会与指针起点对不齐。
    expect(ring).toContain('rotate(-90')
    const ticks = ring.match(/tick \* 2 \* Math\.PI - Math\.PI \/ 2/g) ?? []
    // cos/sin 各一次（起点与终点各一组 x/y）。
    expect(ticks.length).toBe(4)
  })

  it('draws the tick outside the stroke, not on top of the fill', () => {
    // 压在填充弧上会与弧同色，什么都看不见；贴到盒边又会被抗锯齿抹掉。
    expect(ring).toContain('r + RING_STROKE / 2 + 0.25')
    expect(ring).toContain('r + RING_STROKE / 2 + 1.5')
  })

  it('reads the budget out in the tooltip under its own line', () => {
    expect(ring).toContain("t('chatView.contextRing.inputBudget'")
    // 刻度线与「现在多满」「命中多少」是两个问题，必须分行 —— 混在一句里
    // 就没人读了（见 budgetLine / detailLines）。
    expect(ring).toContain('const budgetLine =')
    expect(ring).toContain('[budgetLine, cacheLine]')
  })
})

describe('接线：分母与预算同源，四层贯通', () => {
  it('App derives the budget through effectiveInputWindow, never a local subtraction', () => {
    const app = src(APP)
    expect(app).toContain('effectiveInputWindow(displayContextLength, resolveMaxTokens(')
    // 反证：不许在 App 层自己减一个常数 —— 那会与引擎的预留规则各走一套。
    expect(app).not.toMatch(/displayContextLength\s*-\s*[\d_]/)
    expect(app).toContain('inputBudget={displayInputBudget}')
  })

  it('PopoutApp uses the same derivation (popout must not drift)', () => {
    const popout = src(POPOUT)
    expect(popout).toContain('effectiveInputWindow(displayContextLength, resolveMaxTokens(')
    expect(popout).toContain('inputBudget={displayInputBudget}')
  })

  it('destructures the prop in every layer, not merely declares it', () => {
    // 这组断言来自一次真失败：类型块加了 `inputBudget?: number`、转发点也写了
    // `inputBudget={inputBudget}`，但三处**解构列表**都漏了它。上面的扫描全绿，
    // tsc 才报 `Cannot find name 'inputBudget'` —— 声明一个 prop 与在组件作用域
    // 里拿到它是两件事，接线扫描必须钉后者。
    // 解构项在本仓库的形态是 2 空格缩进的裸标识符行；类型块那条带 `?:`，不会误配。
    for (const rel of [
      'src/renderer/src/components/layout/ChatView.tsx',
      'src/renderer/src/components/chat/ChatBody.tsx',
      'src/renderer/src/components/chat/InputArea.tsx',
    ]) {
      expect(src(rel), rel).toMatch(/^ {2}inputBudget,$/m)
    }
  })

  it('threads the prop through ChatView → ChatBody → InputArea → ContextRing', () => {
    // 计数是刻意的：ChatView 与 ChatBody 各有**两条**渲染分支（主视图 /
    // popout 形态），漏掉一条就会在那种形态下静默少一根刻度。
    const view = src('src/renderer/src/components/layout/ChatView.tsx')
    expect(view).toContain('inputBudget?: number')
    expect((view.match(/inputBudget=\{inputBudget\}/g) ?? []).length).toBe(2)

    const body = src('src/renderer/src/components/chat/ChatBody.tsx')
    expect(body).toContain('inputBudget?: number')
    expect((body.match(/inputBudget=\{inputBudget\}/g) ?? []).length).toBe(2)

    const input = src('src/renderer/src/components/chat/InputArea.tsx')
    expect(input).toContain('inputBudget?: number')
    expect((input.match(/inputBudget=\{inputBudget\}/g) ?? []).length).toBe(1)
    // 唯一那处必须落在 ContextRing 上（非空性）。
    expect(input).toMatch(/<ContextRing[^>]*inputBudget=\{inputBudget\}/)
  })
})

describe('i18n — 两条文案都在且占位符齐全', () => {
  const zh = src('src/renderer/src/i18n/locales/zh.ts')
  const en = src('src/renderer/src/i18n/locales/en.ts')

  it.each([
    ['zh', zh],
    ['en', en],
  ])('%s carries the key with both placeholders', (_name, text) => {
    // 少一个占位符不会报错，只会在 tooltip 里原样显示 {{percent}}。
    const line = text.match(/inputBudget: '([^']+)'/)?.[1]
    expect(line).toBeDefined()
    expect(line).toContain('{{percent}}')
    expect(line).toContain('{{budget}}')
  })
})
