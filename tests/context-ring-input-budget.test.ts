import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveContextWindow, resolveMaxTokens } from '../src/renderer/src/utils/context-window'
import { DEFAULT_OUTPUT_RESERVE, effectiveInputWindow } from '../src/renderer/src/agent/engine/window-budget'
import { estimateAfterNanoTokens, epochLines } from '../src/renderer/src/agent/engine/context-compactor'
import { applySessionEvent, freshSessionState, seedSessionState } from '../src/shared/agent-session/mirror'
import type { AgentEventData } from '../src/shared/agent-protocol'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

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
    const mixed = [
      { id: 'A', contextLength: 100_000 },
      { id: 'B', contextLength: 200_000, maxTokens: 32_000 },
    ]
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
    const mixed = [
      { id: 'A', contextLength: 100_000 },
      { id: 'B', contextLength: 200_000, maxTokens: 32_000 },
    ]
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

  it('draws the tick THROUGH the ring: a stub inside the hole and one outside', () => {
    // 2026-11-22 user：原来只从描边外沿探出 1.25，在 16px 的环上几乎看不见。
    // 现在两端各自伸出描边：内端进中心空腔、外端出环外。缺任何一端都会退化 ——
    // 只有外端就是旧版那根挂在环外的毛刺，只有内端则埋在空腔里看不出指向。
    expect(ring).toContain('r - RING_STROKE / 2 - TICK_INNER_REACH')
    expect(ring).toContain('r + RING_STROKE / 2 + TICK_OUTER_REACH')
  })

  it('橙色，且压在环的上方（SVG 文档顺序 = 绘制顺序）', () => {
    // 2026-11-22 user 第二刀：改橙色 + 叠到环上面。SVG 没有 z-index，最后一个子
    // 元素就是最上层；挪到两个 circle 前面会被描边盖住，只剩环外那一小截。
    expect(ring).toContain("stroke: 'var(--pm-warn)'")
    const lineAt = ring.indexOf('<line')
    expect(lineAt).toBeGreaterThan(ring.indexOf('strokeDashoffset={offset}'))
    // 线之后再没有别的图形 —— 它确实是最后一个绘制元素。
    expect(ring.slice(lineAt)).not.toContain('<circle')
  })

  it('刻度两端都留在盒内，且内端真的进了空腔（按 16px 的实参算）', () => {
    // 拉到盒边会被抗锯齿抹掉；内端若没越过描边内沿，就还是「贴在环外」的老样子。
    // 这两个数在 24 的盒子里很紧，靠肉眼守不住 —— 用组件自己的常量算一遍。
    const num = (name: string): number => Number((ring.match(new RegExp(`const ${name} = ([0-9.]+)`)) ?? [])[1])
    const box = num('RING_BOX')
    const stroke = num('RING_STROKE')
    const inset = num('RING_INSET')
    const inner = num('TICK_INNER_REACH')
    const outer = num('TICK_OUTER_REACH')
    // InputArea 传 diameter={16}；默认半径是 None 时的兜底。
    for (const r of [(16 - stroke) / 2 - inset, num('DEFAULT_RING_RADIUS')]) {
      const innerEnd = r - stroke / 2 - inner
      const outerEnd = r + stroke / 2 + outer
      expect(outerEnd).toBeLessThan(box / 2) // 不贴盒边
      expect(innerEnd).toBeGreaterThan(0) // 不越过圆心
      expect(innerEnd).toBeLessThan(r - stroke / 2) // 真的进了空腔
      // 长度要撑得住「看得见」：16px 的环上至少 5px。
      expect(outerEnd - innerEnd).toBeGreaterThanOrEqual(5)
    }
  })

  it('浮窗是结构化栅格：一个指标一行，标签列问、值列答（user 2026-11-21）', () => {
    // 旧形态是三句话 <br/> 拼接 —— 读的人要在散文里找数。现钉结构化形态：
    // .pm-ctx-tip 栅格存在，且四个标签全部经 i18n 取词（不许把文案硬编码进组件）。
    // 标题行自带用量（user 同日三刀「上下文使用 59% · 86.3K / 146.5K」，
    // 单独的已用行退役，used 键随删）。
    expect(ring).toContain('pm-ctx-tip')
    for (const key of ['title', 'budget', 'cache', 'strategies']) {
      expect(ring).toContain(`chatView.contextRing.${key}`)
    }
    expect(ring).toContain("hint: `${inK(used)} / ${inK(total)}`")
    expect(ring).not.toContain("t('chatView.contextRing.used')")
  })

  it('刻度行与缓存行是条件行，hint 语义分档保留', () => {
    // 刻度不存在（无预算或口径不符）不出现空行；无缓存计数不出 0% 误导。
    // 命中与「仅供参考」仍是两条文案 —— 少样本的数字必须带保留意见。
    expect(ring).toContain('if (tick != null)')
    expect(ring).toContain('cacheHit.requestCount > 0')
    expect(ring).toContain("cacheHit.reliable ? 'chatView.contextRing.cacheDetail' : 'chatView.contextRing.cacheTentative'")
  })

  it('压缩行只报结果：条数 + 释放量 + pending 分档（user 2026-11-21 四刀）', () => {
    // 每策略一行的机制名+效果描述用户不必看，回到计数形态。droppedMessages
    // 只计 light+hard（nano 是 1:1 不丢条数），释放量取 pass 前后实测差；
    // 非 request 来源的 pass 下次请求才落副本，hint 分档保留。
    expect(ring).toContain('chatView.contextRing.compacted')
    expect(ring).toContain('tokensBefore - lastCompaction.tokensAfter')
    expect(ring).toContain("lastCompaction.source !== 'request'")
    expect(ring).toContain('strategiesPending')
    expect(ring).toContain('if (lastCompaction)')
    // 机制词表与效果描述已随明细行退役，不许在组件里长回来。
    expect(ring).not.toContain('STRATEGY_LABEL_KEYS')
    expect(ring).not.toContain('strategyDesc')
  })
})

describe('K 单位约定：token 显示一律十进制 K（/1000），/1024 是字节世界的惯例（2026-11-21）', () => {
  // 模型窗口按供应商十进制报价（本例配置值就是字面 150_000）；/1024 把窗口
  // 读成 146.5K、还让浮窗括号里的 X/Y 除不出旁边的百分比。字节面（fileSize
  // KB、content KB）的 /1024 是另一个物理量，不在本约定内。
  const read = (p: string): string => src(p).replace(/\/\/[^\n]*/g, '')
  const files: Array<[string, string]> = [
    ['src/renderer/src/components/chat/ContextRing.tsx', '环浮窗 inK/freedK'],
    ['src/renderer/src/agent/executors/domain-tools.ts', 'compact 信封（拒绝 + 结果）'],
    ['src/renderer/src/hooks/useChatController.ts', '压缩 toast'],
    ['src/extension/ui/StateStrip.tsx', '面板压缩条'],
  ]
  for (const [path, what] of files) {
    it(`${what}（${path}）的 token K 值走 /1000`, () => {
      const s = read(path)
      expect(s).not.toMatch(/\/\s*1024/)
      expect(s).toContain('/ 1000')
    })
  }

  it('进档边界同线：StateStrip 的 K 档 1000 整入档（与 formatTokenCount 同一条线）', () => {
    expect(read('src/extension/ui/StateStrip.tsx')).toContain('if (n >= 1000)')
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

  it('strategies row rides the SAME lastCompaction the chip reads (single source)', () => {
    // 策略行与已压缩 chip 必须同源：InputArea 只有一份 lastCompaction prop，
    // 原样透传给 ContextRing —— 再造一份解析（自己另取事件流）就会与 chip
    // 各说各话（已生效 vs 下次生效的判定分叉）。
    const ring = src(RING)
    expect(ring).toContain('lastCompaction?: CompactionEvent | null')
    const input = src('src/renderer/src/components/chat/InputArea.tsx')
    expect(input).toMatch(/<ContextRing[^>]*lastCompaction=\{lastCompaction\}/)
  })
})

describe('i18n — 浮窗标签与占位符齐全（两 locale）', () => {
  const zh = src('src/renderer/src/i18n/locales/zh.ts')
  const en = src('src/renderer/src/i18n/locales/en.ts')

  it.each([
    ['zh', zh],
    ['en', en],
  ])('%s: budgetHint 带 percent，两档缓存文案都带 count', (_name, text) => {
    // 少一个占位符不会报错，只会在浮窗里原样显示 {{percent}}。
    // 捕获限定在 contextRing 块内 —— 全文匹配会撞上 compaction/approval 的
    // 同名键（它们也有 tooltip: / 但语义无关）。
    const block = text.match(/contextRing: \{([\s\S]*?)\n {4}\},/)?.[1]
    expect(block).toBeDefined()
    expect(block!).toContain("budgetHint: '")
    expect(block!.match(/budgetHint: '([^']+)'/)?.[1]).toContain('{{percent}}')
    expect(block!.match(/cacheDetail: '([^']+)'/)?.[1]).toContain('{{count}}')
    expect(block!.match(/cacheTentative: '([^']+)'/)?.[1]).toContain('{{count}}')
  })

  it.each([
    ['zh', zh],
    ['en', en],
  ])('%s: compacted 行带 dropped+freed 两个占位符，pending 文案在', (_name, text) => {
    // 少一个占位符只会在浮窗里原样显示 {{dropped}}。机制词表
    // （strategy/strategyDesc）已随明细行退役，不许在 locale 里残留。
    const block = text.match(/contextRing: \{([\s\S]*?)\n {4}\},/)?.[1]
    expect(block).toBeDefined()
    const line = block!.match(/compacted: '([^']+)'/)?.[1]
    expect(line).toContain('{{dropped}}')
    expect(line).toContain('{{freed}}')
    expect(block!.match(/strategiesPending: '([^']+)'/)?.[1]).toBeDefined()
    expect(block).not.toContain('strategy:')
    expect(block).not.toContain('strategyDesc:')
    expect(block).not.toContain('strategiesApplied:')
  })

  it('退役的行级键不再残留', () => {
    // 结构化之后旧键留在 locale 里就是邀请 run-on 句/独立已用行长回来。
    for (const text of [zh, en]) {
      const block = text.match(/contextRing: \{([\s\S]*?)\n {4}\},/)?.[1] ?? ''
      expect(block).not.toContain('tooltip:')
      expect(block).not.toContain('cacheHit:')
      expect(block).not.toContain('cacheHitTentative:')
      expect(block).not.toContain('inputBudget:')
      expect(block).not.toContain('used:')
    }
  })
})

// ── 投影分母（2026-11-22）──────────────────────────────────────────────
// 方案 A 只裁定「环的显示分母」是总窗口；投影里 epochLines 的分母必须是引擎
// 真正除以的 inputBudget。此前 ContextRing 把 contextLength（总窗口）喂给
// estimateAfterNanoTokens，等于按一条压缩链永远不会切到的深度问 nano 要空间。
// 这里用真函数钉住：同一个 tail、同一个 anchor，换成 budget 后归档更多。
describe('投影分母 == 引擎的 inputBudget（方案 A 只管显示）', () => {
  const total = 200_000
  const budget = effectiveInputWindow(total, 32_000) // 168_000
  const anchor = 100_000

  /** 24 个 tier-1 工具批（2500 CJK chars ≈ 2500 tokens each）。tier-1 帽 10
   *  ⇒ 14 个可归档；保护窗 4 只挡最新四条，不改变可归档上限。 */
  const tail: AgentMessage[] = Array.from({ length: 24 }, (_, i) => [
    {
      id: `a${i}`, role: 'assistant' as const, createdAt: '2026-11-22T00:00:00.000Z',
      contentBlocks: [{ type: 'tool_use', id: `tu${i}`, name: 'exec', input: {} }] as ContentBlock[],
    },
    {
      id: `u${i}`, role: 'user' as const, createdAt: '2026-11-22T00:00:00.000Z',
      contentBlocks: [{ type: 'tool_result', tool_use_id: `tu${i}`, content: '果'.repeat(2_500) }] as ContentBlock[],
    },
  ]).flat()

  it('冷启动线按输入侧预算算：0.70×168K < 0.70×200K', () => {
    expect(epochLines(budget, []).target).toBe(117_600)
    expect(epochLines(total, []).target).toBe(140_000)
  })

  it('同一 tail 按 budget 投影会归档更多，读数严格更小', () => {
    const byBudget = estimateAfterNanoTokens(tail, budget, anchor)
    const byTotal = estimateAfterNanoTokens(tail, total, anchor)
    expect(byTotal).toBeLessThan(anchor + 24 * 2_500) // 两条都真的开了归档
    expect(byBudget).toBeLessThan(byTotal)
  })

  it('没有 inputBudget 的宿主回落到总窗口（保守，不猜边界）', () => {
    // 源码层的回落接线：两个投影入口都写 `inputBudget ?? contextLength`，
    // 所以 ChatView 传 undefined 时等价于传 total —— 而不是 0（关闭归档）。
    const ring = src(RING)
    expect(ring).toContain('const projectionWindow = inputBudget ?? contextLength')
    expect(ring).toContain('estimateAfterNanoTokens(tailMsgs, inputBudget ?? contextLength, compaction.tokensAfter, epochTarget)')
    // 真函数侧的对照：完全不传预算时走 quota walk，与「按总窗口定向」读数不同，
    // 说明回落确实是把一个窗口传下去，而不是把预算丢了。
    expect(estimateAfterNanoTokens(tail, undefined))
      .not.toBe(estimateAfterNanoTokens(tail, total, anchor))
    expect(estimateAfterNanoTokens(tail, undefined)).toBeGreaterThan(0)
  })
})

describe('投影深度线 == 引擎的热态 epochTarget（冷热形态差，2026-11-22）', () => {
  const total = 200_000
  const budget = effectiveInputWindow(total, 32_000) // 168_000
  const anchor = 100_000
  const tail: AgentMessage[] = Array.from({ length: 24 }, (_, i) => [
    {
      id: `h${i}`, role: 'assistant' as const, createdAt: '2026-11-22T00:00:00.000Z',
      contentBlocks: [{ type: 'tool_use', id: `htu${i}`, name: 'exec', input: {} }] as ContentBlock[],
    },
    {
      id: `v${i}`, role: 'user' as const, createdAt: '2026-11-22T00:00:00.000Z',
      contentBlocks: [{ type: 'tool_result', tool_use_id: `htu${i}`, content: '果'.repeat(2_500) }] as ContentBlock[],
    },
  ]).flat()

  it('热态 target 真正替换冷启动线，而不是只多传一个被忽略的参数', () => {
    const coldLine = epochLines(budget, []).target
    expect(coldLine).toBe(117_600)
    const cold = estimateAfterNanoTokens(tail, budget, anchor)
    // 引擎 warming 后 p75 线可能比冷启动线浅（本例 140K > 117.6K）：定向
    // 预算变小 → 归档变少 → 环读数变高。若第 4 参没接进 planNanoArchival，
    // 这两个读数会完全相等。
    const hot = estimateAfterNanoTokens(tail, budget, anchor, 140_000)
    expect(hot).toBeGreaterThan(cold)
    expect(hot).toBeLessThan(anchor + 24 * 2_500) // 仍真的归档了一部分
  })

  it('非法 target 回落冷启动线：0 是合法值，NaN/负数不是', () => {
    const cold = estimateAfterNanoTokens(tail, budget, anchor)
    expect(estimateAfterNanoTokens(tail, budget, anchor, Number.NaN)).toBe(cold)
    expect(estimateAfterNanoTokens(tail, budget, anchor, -1)).toBe(cold)
    // 0 合法，但上面的 24 批 tail 已吃满 tier 帽（count − size = 14），
    // 换成 12 批未触线的尾段：冷启动线根本不归档，显式 0 会归档到帽。
    // 这样「0 被当成缺省忽略」会立刻红。
    const smallTail = tail.slice(0, 24)
    const smallAnchor = 80_000
    const coldSmall = estimateAfterNanoTokens(smallTail, budget, smallAnchor)
    expect(estimateAfterNanoTokens(smallTail, budget, smallAnchor, 0)).toBeLessThan(coldSmall)
    expect(estimateAfterNanoTokens(smallTail, budget, smallAnchor, Number.NaN)).toBe(coldSmall)
  })

  it('status 事件折进 mirror，缺席即清掉（status 词不变也会更新）', () => {
    const state = freshSessionState()
    applySessionEvent(state, { type: 'status', status: 'executing', epochTarget: 99_000 } as AgentEventData)
    expect(state.epochTarget).toBe(99_000)
    applySessionEvent(state, { type: 'status', status: 'executing' } as AgentEventData)
    expect(state.epochTarget).toBeUndefined()
  })

  it('重连快照从 status 载体读热态 target（与 turnMs 同形，不再漏在顶层）', () => {
    const state = freshSessionState()
    seedSessionState(state, {
      messages: [], status: { status: 'idle', turnMs: 42, epochTarget: 88_000 },
      streamingBlocks: [], plan: null, fileChanges: [],
    })
    expect(state.epochTarget).toBe(88_000)
    expect(state.turnMs).toBe(42)
  })

  it('热态线四层贯通：引擎 → 协议 → mirror → 环', () => {
    const engine = src('src/renderer/src/agent/AgentEngine.ts')
    expect(engine).toContain('this.epochTarget = epochLines.target')
    expect(engine).toContain('this.epochTarget = 0')

    const core = src('src/renderer/src/agent/engine/engine-core.ts')
    expect(core).toContain('epochTarget: number')

    const wire = src('src/shared/agent-protocol/payloads.ts')
    expect(wire).toContain('epochTarget?: number')

    const sm = src('src/main/agent/session-manager.ts')
    expect(sm.match(/epochTargetOf\(this\.sessions, sessionId\)/g)).toHaveLength(2)
    // 两处 spread 都必须落在 status 载体里：快照顶层那条路 mirror 不读。
    expect(sm).toContain('...statusSnapshotOf(entry.engine.agentStatus)')
    expect(sm).toContain('...epochTargetOf(this.sessions, sessionId),\n    }')

    const mirror = src('src/shared/agent-session/mirror.ts')
    expect(mirror).toContain('state.epochTarget = data.epochTarget')
    expect(mirror).toContain('state.epochTarget = snapshot.status.epochTarget')

    // 两个 hook 的 mirror 局部名不同（st / state），但都必须独立比较：
    // status 词不变、只有切深线变化时也要推进 React。
    for (const [rel, needle] of [
      ['src/renderer/src/hooks/useConversationEngine.ts', 'if (st.epochTarget !== last.epochTarget)'],
      ['src/renderer/src/hooks/useHostedAgentSession.ts', 'if (state.epochTarget !== last.epochTarget)'],
    ]) {
      expect(src(rel), rel).toContain(needle)
    }
    expect(src('src/renderer/src/hooks/useChatController.ts')).toContain('epochTarget: engine.epochTarget')

    const view = src('src/renderer/src/components/layout/ChatView.tsx')
    expect(view).toContain('projectContextUsed(messages, lastCompaction, contextLength, inputBudget, epochTarget)')
    expect(view).toContain('[messages, lastCompaction, contextLength, inputBudget, epochTarget]')
    expect(src(APP)).toContain('epochTarget={epochTarget}')
    expect(src(POPOUT)).toContain('epochTarget={epochTarget}')
  })
})
