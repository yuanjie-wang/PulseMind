// 结构化压缩摘要（PLAN-context-summary-structure，2026-10-05）：三类信息结构
// —— 用户诉求与决策 / 任务执行情况 / 文件与产物 —— 由 HistorySummaryAgent 的
// 分节模板承载（旧「不要标题」散文规则废除；节标题跨 locale 固定，与机械包裹
// 同风格）。被压缩消息的基本信息（首尾时间、条数、用户轮数）是机械事实，不
// 交给 LLM：buildSummaryCoverageHeader 逐请求从 covered 集合现算成〔覆盖〕行，
// 注入摘要消息头部、**不进缓存文本**——缓存保持纯 LLM 产物，20K 帽/滚动输入/
// 持久化/event.summary.text 全不染；covered 生长的 pass，用户重放（排在摘要
// 消息之前）早已破掉请求前缀，覆盖行零额外缓存代价。
import { describe, expect, it, vi } from 'vitest'
import { ContextCompactor, buildSummaryCoverageHeader } from '../src/renderer/src/agent/engine/context-compactor'
import { HistorySummaryAgent } from '../src/renderer/src/agent/one-shot-agent/HistorySummaryAgent'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const text = (t: string): ContentBlock => ({ type: 'text', text: t })

// ── HistorySummaryAgent：分节模板与滚动模式 ──────────────────────────────

describe('HistorySummaryAgent: the structured template', () => {
  const agent = new HistorySummaryAgent()
  const prompt = (input: Record<string, unknown>): string =>
    (agent as unknown as { buildSystemPrompt: (i: unknown) => string }).buildSystemPrompt(input)

  it('the region prompt fixes the three sections and drops the old prose-only rule', () => {
    const p = prompt({ locale: 'zh' })
    for (const s of ['【用户诉求与决策】', '【任务执行情况】', '【文件与产物】']) expect(p).toContain(s)
    expect(p).toContain('不增删节')
    expect(p).not.toContain('不要标题') // the prose-only rule is gone
    expect(p).toContain('500 字')
    // The user-message instruction channel is intact (compaction-wiring pins it).
    const userMsg = (agent as unknown as { buildUserMessages: (i: unknown) => { content: string }[] })
      .buildUserMessages({ regionText: 'R', instruction: '重点保留决策' })
    expect(userMsg[0].content).toContain('[摘要额外要求] 重点保留决策')
  })

  it('the roll prompt consolidates the accumulated chain instead of re-compressing prose', () => {
    const region = prompt({ locale: 'zh' })
    const roll = prompt({ locale: 'zh', mode: 'roll' })
    expect(roll).not.toBe(region)
    expect(roll).toContain('摘要链')
    expect(roll).toContain('【交接笔记】')
    expect(roll).toContain('800 字')
    expect(prompt({ locale: 'en', mode: 'roll' })).toContain('accumulated chain')
  })

  it('the section headers are fixed across locales (they sit next to the mechanical wrappers)', () => {
    const zh = prompt({ locale: 'zh' })
    const en = prompt({ locale: 'en' })
    for (const s of ['【用户诉求与决策】', '【任务执行情况】', '【文件与产物】']) {
      expect(zh).toContain(s)
      expect(en).toContain(s)
    }
  })

  it('parseResponse keeps the structured body, strips fences and lead-ins, caps at 2000', () => {
    const parse = (raw: string): string =>
      (agent as unknown as { parseResponse: (r: string) => string }).parseResponse(raw)
    const body = '【用户诉求与决策】\n- 用 pnpm\n【任务执行情况】\n- 已完成 X\n【文件与产物】\n- a.ts — 已改'
    expect(parse('```markdown\n' + body + '\n```')).toBe(body)
    expect(parse('摘要：' + body)).toBe(body)
    expect(parse('长'.repeat(2500))).toHaveLength(2000)
  })

  it('a fenced body with lead-in or trailer prose keeps the body, not the prose (review_20261006 中6)', () => {
    const parse = (raw: string): string =>
      (agent as unknown as { parseResponse: (r: string) => string }).parseResponse(raw)
    const body = '【用户诉求与决策】\n- 用 pnpm\n【任务执行情况】\n- 已完成 X\n【文件与产物】\n- a.ts — 已改'
    // 前导语 / 尾随语击破了旧的 ^```…```$ 锚——整段正文被毯式规则吃掉，
    // 剩下的残句非空、照常落地并把整区盖 covered 章。
    expect(parse('好的，以下是摘要：\n```markdown\n' + body + '\n```')).toBe(body)
    expect(parse('```markdown\n' + body + '\n```\n以上是摘要')).toBe(body)
  })

  // review_20261007 中2: the header-fence layer matched LAZILY and closed at
  // the FIRST inner fence — a structured body quoting a ```bash snippet (the
  // 【文件与产物】 norm) lost everything after that snippet while the surviving
  // head still named the header, so the ghost passed the honesty gate AND
  // stamped the region covered. Real parseResponse old-vs-new run in the review.
  it('a wrapped body quoting an inner fenced snippet keeps its whole body (review_20261007 中2)', () => {
    const parse = (raw: string): string =>
      (agent as unknown as { parseResponse: (r: string) => string }).parseResponse(raw)
    const wrapped = [
      '【用户诉求与决策】',
      '- 要求补齐回归测试',
      '【任务执行情况】',
      '- 已完成中2修复',
      '【文件与产物】',
      '- a.ts 修复完成，验证命令：',
      '```bash',
      'npm test -- a.test.ts',
      '```',
      '- b.ts — 待办，下一轮处理',
    ].join('\n')
    const raw = '好的，以下是摘要：\n```markdown\n' + wrapped + '\n```\n以上是摘要'
    expect(parse(raw)).toBe(wrapped)
    // Tail beyond the inner snippet survives verbatim — the lazy cut dropped it.
    expect(parse(raw)).toContain('b.ts — 待办')
  })

  // review_20261008 中3: the greedy sweep ran first opener → LAST closer —
  // correct only when the last closer IS the wrapper's. A response whose
  // header fence closes properly and is FOLLOWED by an independent sibling
  // fence got glued: bare ``` lines, the prose between and the whole sibling
  // block rode into the summary past the header check. The header region
  // alone is the summary; the sibling is not.
  it('a properly closed header fence followed by an independent sibling fence keeps only the header body (review_20261008 中3)', () => {
    const parse = (raw: string): string =>
      (agent as unknown as { parseResponse: (r: string) => string }).parseResponse(raw)
    const headerBody = '【用户诉求与决策】\n- 要求补齐回归测试\n【任务执行情况】\n- 已完成\n【文件与产物】\n- a.ts — 已改'
    const raw = ['```markdown', headerBody, '```', '附：回归命令备查', '```bash', 'npm test -- a.test.ts', '```'].join('\n')
    const out = parse(raw)
    expect(out).toBe(headerBody)
    expect(out).not.toContain('npm test')
    expect(out).not.toContain('备查')
    expect(out).not.toContain('```')
  })

  it('a sub-20-char fragment without section headers THROWS the parse — one-shot retry re-asks (review_20261006 中6, 中3)', () => {
    const parse = (raw: string): string =>
      (agent as unknown as { parseResponse: (r: string) => string }).parseResponse(raw)
    // 围栏救不回的无节标题正文：毯式规则吃掉正文后残句非空——旧行为把残句
    // 当摘要落地。THROW（不再返回 ''）：OneShotAgent 只对 falsy raw 与抛错
    // 重试，返回值原样穿透——旧注释承诺的「重问」从未发生，区域零补偿直落
    // 纯截断（review_20261007 中3）。抛错借道既有 catch → 重试一次，第二次
    // 失败才落 getDefaultOutput('')。
    expect(() => parse('好的，以下是摘要：\n```markdown\n真实正文在这里但被吃了\n```')).toThrow()
    expect(() => parse('```markdown\n真实正文在这里但被吃了\n```\n以上是摘要')).toThrow()
    // 三个节标题本身就超过 20 字——合法结构化摘要绝不会触发该门槛。
    const body = '【用户诉求与决策】\n- 用 pnpm\n【任务执行情况】\n- 已完成 X\n【文件与产物】\n- a.ts — 已改'
    expect(parse(body)).toBe(body)
    // 无节标题但长度足够的散文体（锚定围栏路径）不回退。
    expect(parse('```\n这是一段超过二十字的、无节标题的散文体摘要，不应被失败门槛误伤。\n```')).toBe('这是一段超过二十字的、无节标题的散文体摘要，不应被失败门槛误伤。')
  })
})

// ── buildSummaryCoverageHeader：机械覆盖行 ───────────────────────────────

describe('buildSummaryCoverageHeader: the mechanical coverage line', () => {
  const msg = (id: string, role: 'user' | 'assistant', createdAt: string): AgentMessage => ({
    id, role, createdAt, contentBlocks: [text(`${id} 的内容`)],
  })

  it('states the covered span and counts over the covered set', () => {
    const dropped = [
      msg('d1', 'user', '2026-09-27T06:02:00.000Z'),
      msg('d2', 'assistant', '2026-09-28T02:30:00.000Z'),
      msg('d3', 'user', '2026-09-29T12:11:00.000Z'),
      msg('d4', 'assistant', '2026-09-30T08:00:00.000Z'),
    ]
    const line = buildSummaryCoverageHeader(dropped, new Set(['d1', 'd2', 'd3']))!
    // Times render in local timezone — pin the shape, pin the counts exactly.
    expect(line).toMatch(/^〔覆盖〕\d{2}-\d{2} \d{2}:\d{2} – \d{2}-\d{2} \d{2}:\d{2} · 已压缩 3 条消息（用户发言 2 条）$/)
  })

  it('a single-instant span renders one stamp (no dash)', () => {
    const at = '2026-09-27T06:02:00.000Z'
    const dropped = [msg('d1', 'user', at), msg('d2', 'assistant', at)]
    const line = buildSummaryCoverageHeader(dropped, new Set(['d1', 'd2']))!
    expect(line).not.toContain('–')
    expect(line).toContain('已压缩 2 条消息（用户发言 1 条）')
  })

  it('empty coverage (the notes-only landing) renders no line; ids outside the region are ignored', () => {
    const dropped = [msg('d1', 'user', '2026-09-27T06:02:00.000Z')]
    expect(buildSummaryCoverageHeader(dropped, new Set())).toBeNull()
    expect(buildSummaryCoverageHeader(dropped, new Set(['ghost-id']))).toBeNull()
  })

  it('tool-result collector messages (role user, tool_result only) are NOT user turns (review_20261006 中5)', () => {
    // addToolResult 给每个工具批铸造 role:'user'、只含 tool_result 块的收集
    // 消息——按 role 计数会把它算成发言，工具重型会话的「用户发言」可虚报
    // 约 10 倍。口径与 collectUserReplays 一致：必须带 text 块。
    const collector = (id: string, createdAt: string): AgentMessage => ({
      id, role: 'user', createdAt,
      contentBlocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' } as ContentBlock],
    })
    const dropped = [
      msg('d1', 'user', '2026-09-27T06:02:00.000Z'),
      collector('c1', '2026-09-27T06:03:00.000Z'),
      msg('d2', 'assistant', '2026-09-28T02:30:00.000Z'),
      collector('c2', '2026-09-28T02:31:00.000Z'),
      collector('c3', '2026-09-28T02:32:00.000Z'),
      msg('d3', 'user', '2026-09-29T12:11:00.000Z'),
    ]
    const line = buildSummaryCoverageHeader(dropped, new Set(['d1', 'c1', 'd2', 'c2', 'c3', 'd3']))!
    expect(line).toContain('已压缩 6 条消息（用户发言 2 条）')
  })
})

// ── 注入接线：覆盖行随消息走，不进缓存 ──────────────────────────────────

describe('the coverage line rides the summary message, never the cache', () => {
  function pair(i: number, createdAt: string): AgentMessage[] {
    return [
      { id: `cu${i}`, role: 'user', createdAt, contentBlocks: [text(`用户指令 MARKER-${i}。` + '言'.repeat(2400))] },
      { id: `ca${i}`, role: 'assistant', createdAt, contentBlocks: [text(`回复 MARKER-${i}。` + '述'.repeat(2400))] },
    ]
  }
  const build = (n: number): AgentMessage[] => {
    const msgs: AgentMessage[] = []
    for (let i = 0; i < n; i++) msgs.push(...pair(i, new Date(Date.UTC(2026, 8, 1, i)).toISOString()))
    return msgs
  }
  const makeCompactor = (messages: AgentMessage[]) => {
    const runHistorySummary = vi.fn(async () => '摘要内容')
    return { compactor: new ContextCompactor({ runHistorySummary, getMessages: () => messages }), runHistorySummary }
  }
  const summaryText = (copy: AgentMessage[]): string => {
    const m = copy.find((x) => (x.contentBlocks[0] as { text?: string }).text?.includes('【历史对话摘要】'))
    return (m!.contentBlocks[0] as { text: string }).text
  }

  it('first build: the line states the covered span; the cache text stays pure', async () => {
    const msgs = build(10)
    const { compactor } = makeCompactor(msgs)
    const final = await compactor.injectHistorySummary(msgs, msgs, msgs.slice(10))

    const t = summaryText(final)
    expect(t.startsWith('【历史对话摘要】\n〔覆盖〕')).toBe(true)
    expect(t).toContain('已压缩 10 条消息（用户发言 5 条）')
    expect(t).toContain('摘要内容')
    // The CACHE stays pure LLM output — the line is per-pass decoration.
    expect(compactor.getHistorySummary()!.text).toBe('摘要内容')
  })

  it('cache-hit passes re-render the identical line (the wire prefix must not churn)', async () => {
    const msgs = build(10)
    const { compactor } = makeCompactor(msgs)
    const first = await compactor.injectHistorySummary(msgs, msgs, msgs.slice(10))
    const second = await compactor.injectHistorySummary(msgs, msgs, msgs.slice(10))
    expect(summaryText(first)).toBe(summaryText(second))
  })

  it('an extension re-renders the line over the grown coverage', async () => {
    const msgs = build(18)
    const { compactor, runHistorySummary } = makeCompactor(msgs)
    await compactor.injectHistorySummary(msgs, msgs, msgs.slice(10))
    expect(summaryText(await compactor.injectHistorySummary(msgs, msgs, msgs.slice(10))))
      .toContain('已压缩 10 条消息（用户发言 5 条）')

    // Pairs 5-8 accrue past the 12K line → one extension call → the ledger and
    // the line grow together.
    const second = await compactor.injectHistorySummary(msgs, msgs, msgs.slice(18))
    expect(runHistorySummary).toHaveBeenCalledTimes(2)
    expect(summaryText(second)).toContain('已压缩 18 条消息（用户发言 9 条）')
  })

  it('a notes-only landing (the summarizer failed) renders no coverage line', async () => {
    const msgs = build(10)
    const runHistorySummary = vi.fn(async () => '')
    const compactor = new ContextCompactor({ runHistorySummary, getMessages: () => msgs })
    const final = await (compactor as unknown as {
      injectHistorySummaryInto: (
        o: AgentMessage[], l: AgentMessage[], t: AgentMessage[], instruction?: string, notes?: string
      ) => Promise<AgentMessage[]>
    }).injectHistorySummaryInto(msgs, msgs, msgs.slice(10), undefined, '交接笔记：记住这个坑')

    const t = summaryText(final)
    expect(t).toContain('【交接笔记】')
    expect(t).not.toContain('〔覆盖〕')
    expect(compactor.getHistorySummary()!.firstKeptId).toBe('')
  })

  it('a rehydrated cache (no covered ledger) derives the line positionally from the frontier', async () => {
    const msgs = build(10)
    const { compactor } = makeCompactor(msgs)
    await compactor.injectHistorySummary(msgs, msgs, msgs.slice(10))
    const cache = compactor.getHistorySummary()!

    // Rehydrate the way persistence does: text + frontier id, no ledger.
    const rehydrated = new ContextCompactor({ runHistorySummary: vi.fn(async () => '摘要内容'), getMessages: () => msgs })
    rehydrated.seedHistorySummary(cache.text, cache.firstKeptId)
    const final = await rehydrated.injectHistorySummary(msgs, msgs, msgs.slice(10))
    expect(summaryText(final)).toContain('已压缩 10 条消息（用户发言 5 条）')
  })
})
