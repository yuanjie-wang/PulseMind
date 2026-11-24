import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The session-manager import chain touches real stores (it creates MEMORY.md on
// first touch), so point HOME at a temp dir BEFORE importing it — a test must
// never write into the user's live ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-turn-duration-'))

const { AgentSessionManagerImpl } = await import('../src/main/agent/session-manager')
const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { TurnClock, stampTurnDuration } = await import('../src/renderer/src/agent/engine/turn-clock')
const { setHost } = await import('../src/renderer/src/agent/host')
const { applySessionEvent, freshSessionState } = await import('../src/shared/agent-session/mirror')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { agentMessagesToConversation } = await import('../src/renderer/src/utils/message-utils')
const { formatDurationHms } = await import('../src/shared/ui/message-stats')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')

import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'
import type { AgentEventData } from '../src/shared/agent-protocol'

/** Construction-time cache warming pokes the host; nothing in this file needs
 *  it to answer, so every method is a generic async no-op. */
setHost(new Proxy({}, { get: () => () => Promise.resolve([] as unknown[]) }) as never)

const NOW = '2026-09-16T10:00:00.000Z'

const block = (text: string): ContentBlock => ({ type: 'text', text })
const assistant = (id: string, processingMs: number): AgentMessage =>
  ({ id, role: 'assistant', contentBlocks: [block(id)], createdAt: NOW, processingMs })
const user = (): AgentMessage =>
  ({ id: 'u1', role: 'user', contentBlocks: [block('跑一下这个任务')], createdAt: NOW })

function makeEngine(): InstanceType<typeof AgentEngine> {
  return new AgentEngine({
    apiKey: 'test-key', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 1024,
    myName: 'tester', soul: '', yourName: 'user',
    adapter: {} as never, // never exercised: no request is issued here
    toolManager: new ToolManager() as never, skillManager: new SkillManager() as never,
    conversationId: 'conv_turn_duration',
  } as unknown as AgentEngineOptions)
}

/** Type-only view of the private transport so the test can drive the real one. */
type TransportInternals = { emitMessages(sessionId: string, messages: AgentMessage[]): void }

/**
 * 用户反馈 2026-09-16：「任务执行的时长展示不正确，明显小于实际执行时长，期望是从
 * 用户发送消息开始计算，到完成最后一个字符的输出，包括中间多次的 thinking 和 tool use」。
 *
 * Three things had to be true for the user to ever SEE it, and this file pins
 * all three. The engine's `TurnClock` numbers the whole turn rather than its
 * last round (started at the send, stopped at the last output character, and
 * stopped again while parked on the user — a held approval, an ask_user
 * question, the loop-limit prompt, a manual 暂停); `handleEndTurnResponse`
 * stamps that total on the final assistant message; and the transport carries
 * that in-place write to the clients, because the mirror only ever learns about
 * a message when it is appended — and it is appended at the END of its stream,
 * i.e. before the total exists.
 */
describe('turn duration: user send → last output character', () => {
  it('stamps the whole turn on the final message, replacing that round’s own time', () => {
    // A turn of 83s of wall clock, driven by moving the clock rather than by
    // arithmetic on performance.now() — in a fresh process that reading is
    // *smaller* than 83s, and a clock that was never started is idle, so the
    // engine would skip the stamp entirely.
    const engine = makeEngine()
    const first = assistant('a1', 9_000) // round 1: thinking + tool_use
    const second = assistant('a2', 21_000) // round 2: another tool round
    const final = assistant('a3', 15_000) // round 3: the answer, its own stream only
    engine.messages = [user(), first, second, final]

    let clock = 1_000
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      engine.turnClock.start() // the user hits send at t=1s
      clock = 84_000 // …and the last character lands at t=84s
      engine.handleEndTurnResponse('end_turn')
    } finally {
      spy.mockRestore()
    }

    expect(engine.messages[3].processingMs).toBe(83_000)
    // Earlier rounds keep their own round time — they are per-round cards inside
    // the collapsed execution segment, not summaries of the turn.
    expect(engine.messages[1].processingMs).toBe(9_000)
    expect(engine.turnClock.isActive()).toBe(false) // consumed, so the next turn starts fresh
  })

  it('stamps the last ASSISTANT message when a delivery entry trails the tail', () => {
    // Plan mode: a wave's delivery / a tool result lands as a `role: 'user'`
    // entry right after the round that produced it, so the turn's own answer is
    // no longer `messages[len - 1]`. Reading the tail and requiring it to be an
    // assistant skipped the stamp silently — a 13-sub-agent review came back as
    // its final round's 11s (用户反馈 2026-11-06).
    const engine = makeEngine()
    const first = assistant('a1', 9_000)
    const final = assistant('a2', 12_000)
    const delivery: AgentMessage = { id: 'd1', role: 'user', contentBlocks: [block('子代理交付')], createdAt: NOW }
    engine.messages = [user(), first, final, delivery]

    let clock = 1_000
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      engine.turnClock.start() // send
      clock = 601_000 // …ten minutes of rounds and waves later
      engine.handleEndTurnResponse('end_turn')
    } finally {
      spy.mockRestore()
    }

    expect(engine.messages[2].processingMs).toBe(600_000) // the answer carries the whole turn
    expect(engine.messages[3].processingMs).toBeUndefined() // the delivery entry is left alone
  })

  it('does not count the wait for a held approval', () => {
    const engine = makeEngine()
    const final = assistant('a2', 20_000)
    engine.messages = [user(), assistant('a1', 30_000), final]

    let clock = 0
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      engine.turnClock.start() // send
      clock = 30_000 // round 1 ran 30s, then the model asked to write a file…
      engine.agentStatus = { status: 'awaiting_approval', tools: [] }
      engine.notify() // …and the engine parks. The user is away for 5 minutes.
      clock = 330_000
      // Still parked: nothing about being parked may advance the total.
      expect(engine.turnClock.elapsed()).toBe(30_000)

      engine.agentStatus = { status: 'executing' }
      engine.notify() // approval landed — counting again
      clock = 350_000 // round 2 runs 20s
      engine.handleEndTurnResponse('end_turn')
    } finally {
      spy.mockRestore()
    }

    expect(final.processingMs).toBe(50_000)
  })

  it('does not count the time spent paused (停止按钮 → cancelLoop → pauseExecution → awaiting_continue)', () => {
    const engine = makeEngine()
    const final = assistant('a2', 10_000)
    engine.messages = [user(), assistant('a1', 15_000), final]

    let clock = 0
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      engine.turnClock.start()
      clock = 15_000
      // The real pause path: the composer's 停止 → cancelLoop → (delegates to)
      // pauseExecution, which holds the clock explicitly AND parks the engine
      // on awaiting_continue behind the 继续执行/停止任务 strip.
      engine.pauseExecution()
      clock = 315_000 // five minutes of not running
      expect(engine.turnClock.elapsed()).toBe(15_000)
      // Resume the way resumeExecution does: the explicit hold lifts first,
      // then the status flip releases the park — either alone keeps it held.
      engine.turnClock.resume()
      engine.agentStatus = { status: 'executing' }
      engine.notify() // resumed — counting again
      clock = 325_000
      engine.handleEndTurnResponse('end_turn')
    } finally {
      spy.mockRestore()
    }

    expect(final.processingMs).toBe(25_000)
  })

  it('the clock itself banks running segments and ignores the gaps', () => {
    let clock = 100
    const turnClock = new TurnClock(() => clock)
    expect(turnClock.elapsed()).toBe(0)
    turnClock.start()
    clock = 1_100 // 1s of work
    turnClock.sync(true) // parked on the user
    clock = 61_100 // a minute of thumb-twiddling
    expect(turnClock.elapsed()).toBe(1_000)
    turnClock.sync(false) // answered
    clock = 62_100 // 1s more
    expect(turnClock.stop()).toBe(2_000)
    expect(turnClock.isActive()).toBe(false)
    // A finished turn cannot be restarted by the 'completed' status that
    // follows it, or the next stamp would include the idle gap.
    turnClock.sync(false)
    clock = 999_999
    expect(turnClock.elapsed()).toBe(0)
  })

  it('a sub-agent turn is clocked from its kick-off message', () => {
    const engine = makeEngine()
    const round = assistant('a1', 4_000)
    engine.messages = [round]

    let clock = 0
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      engine.startSpawnLoop({ task: 'x' } as never)
      clock = 47_000
      engine.handleEndTurnResponse('end_turn')
    } finally {
      spy.mockRestore()
    }

    expect(round.processingMs).toBe(47_000)
  })

  it('the wire carries the in-place write to the client mirror', () => {
    const manager = new AgentSessionManagerImpl()
    const events: AgentEventData[] = []
    manager.onEvent((_sessionId, data) => events.push(data))
    const t = manager as unknown as TransportInternals

    const messages = [assistant('a1', 9_000), assistant('a2', 21_000), assistant('a3', 15_000)]
    t.emitMessages('s1', messages)
    // The append is what the mirror has: per-round values, the last one 15s.
    expect(events.filter((e) => e.type === 'messages_append')).toHaveLength(1)

    // End of turn — the engine writes the total IN PLACE (no new message, no
    // length change), which is precisely what a length-diffed transport drops.
    messages[2].processingMs = 83_000
    t.emitMessages('s1', messages)

    const state = freshSessionState()
    for (const e of events) applySessionEvent(state, e)
    expect(state.messages[2].processingMs).toBe(83_000)
    expect(state.messages[0].processingMs).toBe(9_000)
  })

  it('ships nothing while the stats are unchanged (notify fires per streamed chunk)', () => {
    const manager = new AgentSessionManagerImpl()
    const events: AgentEventData[] = []
    manager.onEvent((_sessionId, data) => events.push(data))
    const t = manager as unknown as TransportInternals

    const messages = [assistant('a1', 9_000)]
    t.emitMessages('s2', messages)
    t.emitMessages('s2', messages)
    t.emitMessages('s2', messages)
    expect(events.filter((e) => e.type === 'message_stats')).toHaveLength(0)

    messages[0].processingMs = 12_000
    t.emitMessages('s2', messages)
    expect(events.filter((e) => e.type === 'message_stats')).toHaveLength(1)
  })

  // ── 结算即盖章（2026-11-19，用户「还是有场景会有问题」）──────────────────
  // handleEndTurnResponse 曾是唯一盖章点，而一个回合有六种终局：错误终态、
  // 停止任务、输入新消息打断的回合从不盖章——最后一条 assistant 消息停在它
  // 自己那一轮的时长上，跑了十分钟然后死掉的回合显示 11s。

  it('stamps the total when the turn dies in the error terminal (retry chain exhausted)', async () => {
    const engine = makeEngine()
    const first = assistant('a1', 9_000)
    const final = assistant('a2', 21_000)
    engine.messages = [user(), first, final]

    let clock = 1_000
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      engine.turnClock.start()
      clock = 40_000
      // adapter is {} — createStreamParser is missing, the TypeError lands in
      // the runner's catch BEFORE any listener registers (cleanupListeners
      // stays undefined, so the Proxy test host is safe), and the message
      // matches no retry branch: not an idle marker, not transport-shaped,
      // not context overflow, not 'HTTP '-prefixed.
      await (engine as unknown as { streamRunner: { run: (o: unknown, r: unknown) => Promise<void> } })
        .streamRunner.run(engine.opts, { apiUrl: 'https://example.invalid', headers: {}, resolvedBody: {} })
    } finally {
      spy.mockRestore()
    }

    expect(final.processingMs).toBe(39_000)
    expect(engine.agentStatus.status).toBe('error')
    // 时钟归位：error 不在等待集里，不停表它会一直空跑到下一次 start()。
    expect(engine.turnClock.isActive()).toBe(false)
  })

  it('stamps the total when the user stops the task (停止任务 → stopExecution)', () => {
    const engine = makeEngine()
    const final = assistant('a2', 12_000)
    engine.messages = [user(), assistant('a1', 30_000), final]

    let clock = 0
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      engine.turnClock.start()
      clock = 30_000
      engine.agentStatus = { status: 'awaiting_approval', tools: [] }
      engine.notify()
      clock = 330_000 // five minutes parked on the approval card
      engine.stopExecution()
    } finally {
      spy.mockRestore()
    }

    expect(final.processingMs).toBe(30_000) // the parked stretch stays excluded
    expect(engine.turnClock.isActive()).toBe(false)
  })

  it('stamps the interrupted turn before the new send reopens the clock', async () => {
    const engine = makeEngine()
    const final = assistant('a2', 12_000)
    engine.messages = [user(), assistant('a1', 30_000), final]

    let clock = 0
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      engine.turnClock.start()
      clock = 45_000
      await (engine as unknown as { prepareTurn: (t: string) => Promise<string | null> }).prepareTurn('换个方向')
    } finally {
      spy.mockRestore()
    }

    // 旧回合的表在 start() 清零之前结算——终点=打断瞬间的累计。
    expect(final.processingMs).toBe(45_000)
    expect(engine.messages[engine.messages.length - 1].role).toBe('user')
    expect(engine.turnClock.isActive()).toBe(true) // 新表已开
  })

  it('stampTurnDuration: a first-round death stops the clock with nothing to stamp; an idle clock is a no-op', () => {
    let clock = 100
    const tc = new TurnClock(() => clock)
    tc.start()
    clock = 5_100
    stampTurnDuration([user()], tc) // round 1 never produced an answer
    expect(tc.isActive()).toBe(false)

    // 时钟已停（回合并未运行）：零动作、不抛。
    const idle = assistant('a1', 9_000)
    stampTurnDuration([idle], new TurnClock(() => clock))
    expect(idle.processingMs).toBe(9_000)
    expect(idle.stopReason).toBeUndefined()
  })

  it('every settle path stamps (wiring scan: 2 error terminals, stop, steer, finish_stage)', async () => {
    const { readFileSync } = await import('node:fs')
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
    // stream-runner: thinking-only 二次退化 + catch 错误终态，两处。
    expect(read('../src/renderer/src/agent/engine/stream-runner.ts')
      .match(/stampTurnDuration\(this\.engine\.messages, this\.engine\.turnClock\)/g)).toHaveLength(2)
    const flow = read('../src/renderer/src/agent/engine/execution-flow.ts')
    // handleEndTurnResponse（带终态词）+ stopExecution + finish_stage。
    expect(flow).toContain('stampTurnDuration(this.engine.messages, this.engine.turnClock, stop)')
    expect(flow.match(/stampTurnDuration\(this\.engine\.messages/g)).toHaveLength(3)
    expect(read('../src/renderer/src/agent/AgentEngine.ts'))
      .toContain('stampTurnDuration(this.messages, this.turnClock)')
  })

  // ── live 总时长 + 近似总章（2026-11-20，用户「时间偏差太大，会让用户觉得
  // 我们在欺骗」）：引擎在主进程托管，TurnClock 锚点经 status 事件走线
  // （StatusSnapshot.turnMs）；渲染端外推显示；存档快照落近似总章兜异常退出。──

  it('the wire carries turnMs on the status event and the mirror folds it atomically', () => {
    // 渲染端镜像：status 事件带上 turnMs → 折进 state；缺席 → 清掉。
    // （发射面 session-manager turnMsOf 不独立驱动——真跑要建全会话，wiring 扫描盖住。）
    const state = freshSessionState()
    applySessionEvent(state, { type: 'status', status: 'executing', turnMs: 125_000 } as AgentEventData)
    expect(state.turnMs).toBe(125_000)
    applySessionEvent(state, { type: 'status', status: 'streaming' } as AgentEventData)
    expect(state.turnMs).toBeUndefined() // 缺席 = 时钟停了，键离开 state
  })

  it('the persistence snapshot stamps the near-total on the last assistant message', () => {
    const msgs = [user(), assistant('a1', 12_000)]
    // 运行中快照：TurnClock 累计 42s 落在末条 assistant 上（Math.max 盖过单轮值）。
    expect(agentMessagesToConversation(msgs, 'c1', 't', 42_000).messages[1].processingMs).toBe(42_000)
    // 不传（子代理/hosted 调用方）= 行为逐字节不变。
    expect(agentMessagesToConversation(msgs, 'c1', 't').messages[1].processingMs).toBe(12_000)
    // 极端倒挂（锚点小于单轮值）不缩水。
    expect(agentMessagesToConversation(msgs, 'c1', 't', 3_000).messages[1].processingMs).toBe(12_000)
    // 没有 assistant 消息（第一轮运行中）只安静跳过，不抛。
    expect(agentMessagesToConversation([user()], 'c1', 't', 5_000).messages[0].processingMs).toBeUndefined()
  })

  it('the live badge reads whole-clock h/m/s, truncated to integer seconds (2026-11-21)', () => {
    // 截断不进位：跳动的显示不能把 59.9s 提前读成「1分钟」。
    expect(formatDurationHms(59_999, 'zh')).toBe('59秒')
    expect(formatDurationHms(750_000, 'zh')).toBe('12分钟30秒')
    expect(formatDurationHms(3_750_000, 'zh')).toBe('1小时2分钟30秒')
    // 前导零单位省略，秒恒显。
    expect(formatDurationHms(45_000, 'zh')).toBe('45秒')
    expect(formatDurationHms(0, 'zh')).toBe('0秒')
    expect(formatDurationHms(59_999, 'en')).toBe('59s')
    expect(formatDurationHms(3_750_000, 'en')).toBe('1h 2m 30s')
    expect(formatDurationHms(750_000, 'en')).toBe('12m 30s')
  })

  it('the live-elapsed path is wired end to end (wiring scan)', async () => {
    const { readFileSync } = await import('node:fs')
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
    // 发射面：session-manager 的 turnMsOf 在 status 事件与重连快照两处 spread。
    const smSrc = read('../src/main/agent/session-manager.ts')
    expect(smSrc.match(/turnMsOf\(this\.sessions, sessionId\)/g)).toHaveLength(2)
    expect(smSrc).toContain('clock?.isActive()') // 桩引擎无时钟 → 诚实缺席
    // 协议字段存在。
    expect(read('../src/shared/agent-protocol/payloads.ts')).toContain('turnMs?: number')
    // 消费面：控制器外推（等待态冻结谓词 + 1s tick）与脚部渲染。
    const ctl = read('../src/renderer/src/hooks/useChatController.ts')
    expect(ctl).toContain('isWaitingOnUserStatus(anchor.status.status)')
    expect(ctl).toContain('window.setInterval(')
    expect(ctl).toContain('isWaitingOnUserStatus(anchor.status.status)')
    const body = read('../src/renderer/src/components/chat/ChatBody.tsx')
    expect(body).toContain("t('chatView.turnElapsed'")
    expect(body).toContain('formatDurationHms(turnElapsedMs, locale)')
    // 存档面：快照传入 turnMs。
    expect(read('../src/renderer/src/hooks/useConversationPersistence.ts')).toContain('engine.turnMs)')
    // 序钉（2026-11-21 空窗期）：时钟必须先于 streaming 播报启动，否则
    // turnMsOf 跳过怠速时钟，徽章等到首个 delta 才出现。
    const eng = read('../src/renderer/src/agent/AgentEngine.ts')
    expect(eng).not.toMatch(/this\.notify\(\)\s*\n\s*this\.turnClock\.start\(\)/)
    // 正向形态：start → streaming 宣布 → notify，prepareTurn 与 retryLastTurn 两处。
    expect(eng.match(/this\.turnClock\.start\(\)\s*\n\s*this\.agentStatus = \{ status: 'streaming' \}\s*\n\s*this\.notify\(\)/g)).toHaveLength(2)
  })

  it('conversation switches reseed the live turn anchor instead of leaking it (2026-11-24)', async () => {
    // user report「有一个后台任务在运行，前台对话依然会进行执行时间计时」：
    // turnMs 曾是 React 侧唯一不随活动会话重播的切片。切到一个空闲会话时，
    // 它带着上一会话（后台任务宿主）的锚点过去；空闲会话没有 status 事件，
    // flushActiveSync 的 agentStatus 身份门永远不会再推一次 → 徽章在那个会话里
    // 永远外推。锚点必须和 agentStatus 同属「活动会话」状态，一起重播/清零；
    // 同一病根的另两片（epochTarget / lastCompaction）一并收编。
    const { readFileSync } = await import('node:fs')
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
    const eng = read('../src/renderer/src/hooks/useConversationEngine.ts')
    // 激活：镜像有锚点就重播（上一会话仍在跑时切回来读数不断档），无镜像清零。
    expect(eng).toContain('setTurnMs(st.turnMs)')
    expect(eng).toContain('setTurnMs(undefined)')
    // reset 出的空引擎没有回合在跑，三片都不能留在镜像里被下一次激活重播。
    expect(eng).toMatch(/st\.agentStatus = \{ status: 'idle' \}\s*\n\s*\/\/[^\n]*\n\s*st\.turnMs = undefined/)
    expect(eng).toMatch(/st\.turnMs = undefined[\s\S]{0,500}st\.epochTarget = undefined[\s\S]{0,200}st\.lastCompaction = null/)
    const pers = read('../src/renderer/src/hooks/useConversationPersistence.ts')
    // 侧栏/欢迎页切换路径直接写 activeEngineIdRef、从不经 activateEngine：
    // 缓存会话重播它自己的锚点、切深线与压缩基准……
    expect(pers).toContain('setTurnMs(engine.turnMs)')
    expect(pers).toContain('setEpochTarget(engine.epochTarget)')
    expect(pers).toContain('setLastCompaction(engine.lastCompaction)')
    // ……每一处 idle 清空都必须紧跟着清这三片（漏一处 = 一件跨会话的假事实：
    // 徽章永远外推 / 上下文环按上个会话的切深线定价 / 投影基准停在旧压缩事件）。
    const idleSites = pers.match(/setAgentStatus\(\{ status: 'idle' \}\)/g) ?? []
    expect(idleSites.length).toBe(4)
    for (const seg of pers.split("setAgentStatus({ status: 'idle' })").slice(1)) {
      const clear = seg.slice(0, 200)
      expect(clear).toContain('setTurnMs(undefined)')
      expect(clear).toContain('setEpochTarget(undefined)')
      expect(clear).toContain('setLastCompaction(null)')
    }
    // 接线：controller 传下 setter（漏传 = 调用点当场 TypeError）。
    const ctrl = read('../src/renderer/src/hooks/useChatController.ts')
    expect(ctrl).toContain('setTurnMs: engine.setTurnMs')
    expect(ctrl).toContain('setEpochTarget: engine.setEpochTarget')
    expect(ctrl).toContain('setLastCompaction: engine.setLastCompaction')
  })

  it('the live badge is plain scrolled content — pinning lives in tail-follow, not CSS (2026-11-21 jitter)', async () => {
    // user report「执行过程中徽章上下跳」+ 二次裁定「翻历史时跟随滚走」：
    // sticky 底缘方案（视口钳制）语义过重已退役。防跳的保证在引擎侧——
    // tail-follow 的 settle() 同步 pre-paint snap（行为钉见
    // tests/tail-follow.test.ts 的 pre-paint snap 组），徽章就是普通滚动
    // 内容：跟随尾部时被逐帧钉住，翻历史时随内容滚走。
    const { readFileSync } = await import('node:fs')
    const body = readFileSync(new URL('../src/renderer/src/components/chat/ChatBody.tsx', import.meta.url), 'utf8')
    // 负扫：徽章不得改用视口侧定位（sticky/fixed）——那会让它翻历史时留在屏上。
    expect(body).not.toContain("position: 'sticky'")
    expect(body).not.toContain("position: 'fixed'")
    // 徽章住在滚动内容里（composer spacer 内、pad 之上）。
    const spacerIdx = body.indexOf('data-pm-composer-spacer')
    expect(spacerIdx).toBeGreaterThan(-1)
    expect(body.indexOf('data-pm-turn-elapsed')).toBeGreaterThan(spacerIdx)
  })
})
