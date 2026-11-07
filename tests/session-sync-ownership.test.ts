// 活动会话同步的所有权门禁（2026-10-24，「新建会话后视图错乱继续」根因修复）。
//
// 实测（Electron 实跑，假 LLM 流式输出 + 事件派发任务内同步点击）：任务运行中
// 点「新建任务」/切会话时，若点击落在该会话事件的 coalesce 窗口（≤80ms）内，
// flushActiveSync 会把【旧会话】的 messages / streamingBlocks / running 状态
// 推进已被 createNewConversation 清空的 React 状态槽——可见形态两种：
//   ① 点击时刻的事件是 status/messages_append：欢迎页被旧转录顶掉，或视图永久
//      卡在「转圈 + 空白转录」（后续事件不再同步，永远无人结算）；
//   ② 是 streaming_blocks：状态被污染但被欢迎页遮住，下次发送时旧块出现在新
//      会话转录尾部。
// 调度侧的 activeEngineIdRef 门禁只保护「调度」这一刻；调度到 flush 之间隔了
// setTimeout+rAF，切换恰好落在中间。修复：pendingSyncRef 记录归属会话，
// flush 时与 activeEngineIdRef 比对，不再属于活动会话的同步整体丢弃。
//
// 逻辑在 React hook 内（依赖 IPC 与 rAF），vitest 无法真跑——按 wiring-scan
// 惯例钉源码形状。三处断言对修复前的代码各自为红。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

/** 抽取一个函数体（按签名起点到大括号配平），签名变了就红——防扫描空转。 */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  expect(start).toBeGreaterThanOrEqual(0) // 签名不存在 = 契约被改名，直接红
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error('unbalanced braces')
}

describe('active-session sync ownership gate (useConversationEngine)', () => {
  const engine = read('src/renderer/src/hooks/useConversationEngine.ts')

  it('pendingSyncRef carries the owning sessionId, not a bare SessionState', () => {
    // 修复前：useRef<SessionState | null>(null) —— flush 无从知道这份待刷
    // 状态属于哪个会话，换会话后照样推进共享状态槽。
    expect(engine).toMatch(/pendingSyncRef = useRef<\{ sessionId: string; st: SessionState \} \| null>\(null\)/)
  })

  it('scheduleActiveSync takes the sessionId and stores it with the state', () => {
    const body = functionBody(engine, 'const scheduleActiveSync = useCallback')
    expect(body).toContain('sessionId: string')
    expect(body).toMatch(/pendingSyncRef\.current = \{ sessionId, st \}/)
  })

  it('flushActiveSync drops the pending sync once its session is no longer active', () => {
    const body = functionBody(engine, 'const flushActiveSync = useCallback')
    // 所有权门禁必须先于任何 set* 推送：比较对象是 activeEngineIdRef.current
    // ——三条切换路径（activateEngine / handleSelectConversation /
    // createNewConversation）都先写它，flush 是覆盖全部路径的唯一收口点。
    const guard = body.indexOf('pending.sessionId !== activeEngineIdRef.current')
    expect(guard).toBeGreaterThan(-1)
    const firstPush = body.indexOf('setMessages(')
    expect(firstPush).toBeGreaterThan(-1)
    expect(firstPush).toBeGreaterThan(guard)
    // 门禁生效时不得更新 ledger：被丢弃的切片从未进入 React，lastSyncedRef
    // 只描述「React 现在持有的是什么」。
    const ledgerUpdate = body.indexOf('lastSyncAtRef.current = Date.now()')
    expect(ledgerUpdate).toBeGreaterThan(guard)
  })

  it('the event handler passes the owning sessionId to the scheduler', () => {
    expect(engine).toMatch(/scheduleActiveSync\(sessionId, st\)/)
  })
})

// ── 激活即引擎活跃会话（2026-11-04，「浏览器模式启动对话后输入消息无响应」）──
// 同一道 activeEngineIdRef 门的另一面：回合是发给主进程的，与视图无关；但事件
// 进 React 必须过 `activeEngineIdRef.current === sessionId`。存在于「会话切了、
// 引擎活跃 id 没跟」的路径上时，消息发得出去、界面一片不动——草稿已被 submit
// 清空、转录不更新、无 spinner，用户只能描述成「输入无响应」。物化分支（首条
// 消息）一直两半都激活；浏览器任务容器（createBrowserTask）曾经只做了
// persistence 那一半，容器又从不过侧栏切换，于是它的每一条消息都掉进这个洞。
describe('activation makes the conversation the engine-active session', () => {
  const controller = read('src/renderer/src/hooks/useChatController.ts')

  it('the React state sync gate is the active-engine id (the mechanism above)', () => {
    const engineSrc = read('src/renderer/src/hooks/useConversationEngine.ts')
    expect(engineSrc).toMatch(/if \(activeEngineIdRef\.current === sessionId\) \{\s*\n\s*if \(data\.type === 'compaction'\)/)
  })

  it('createBrowserTask activates the engine, before persistence', () => {
    const body = functionBody(controller, 'const createBrowserTask = useCallback')
    const activate = body.indexOf('engine.activateEngine(convId)')
    const persist = body.indexOf('persistence.activateConversation(convId)')
    expect(activate).toBeGreaterThan(-1)
    expect(persist).toBeGreaterThan(-1)
    expect(activate).toBeLessThan(persist)
    // 依赖表必须带上它，否则回调闭包停在旧实例上（functionBody 止于回调的
    // 右大括号，依赖表在它之外，所以这里扫整源）。
    expect(controller).toMatch(/const createBrowserTask = useCallback[\s\S]{0,2600}\[engine\.activateEngine,/)
  })

  it('handleRequest activates a conversation that is not the active engine', () => {
    const body = functionBody(controller, 'const handleRequest = useCallback')
    const guard = body.indexOf('if (engine.activeEngineIdRef.current !== convId) engine.activateEngine(convId)')
    const send = body.indexOf('engineHandle.startLoop(content, knowledgeBase)')
    expect(guard).toBeGreaterThan(-1)
    expect(send).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(send)
  })
})
