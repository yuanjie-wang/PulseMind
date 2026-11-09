/**
 * PLAN-background-tasks — B 完成事件面 + C 空闲自动投递 的钉子。
 *
 * 分层同 persistent-shell/search 批次：
 *  1. 纯逻辑：合成通知的 marker 契约（shared/background-notice.ts）与 mirror
 *     对 background_task / backgroundPid 的折叠（shared/agent-session/mirror）。
 *  2. wiring 扫描：deliverBackgroundNotice 的闸门矩阵与合成消息、background_task
 *     事件的发射点、渲染端三触发点与通知编排、审批不变量（background 分支先过
 *     write 门；promote 通道 agent-only）、设置归一化与 i18n。
 *
 * deliverBackgroundNotice 本体拖着主进程整棵依赖树（SQLite/浏览器服务），vitest
 * 的 node 环境跑不动它——闸门以「方法体内出现顺序」扫描钉死（与
 * engine-call-whitelist 的静态围栏同一手法），运行时行为由探针走查。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applySessionEvent, freshSessionState } from '../src/shared/agent-session/mirror'
import { BACKGROUND_NOTICE_MARKER, backgroundNoticeBody, isBackgroundNoticeText } from '../src/shared/background-notice'

const REPO = process.cwd()
const src = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

/** session-manager.ts 里 deliverBackgroundNotice 的方法体切片（到下一个成员为止）。 */
function deliveryBody(): string {
  const sm = src('src/main/agent/session-manager.ts')
  const start = sm.indexOf('async deliverBackgroundNotice')
  expect(start, 'deliverBackgroundNotice moved? re-scope the scan').toBeGreaterThan(0)
  const end = sm.indexOf('  /** Rebuild engine options', start)
  expect(end, 'the method after deliverBackgroundNotice moved? re-scope').toBeGreaterThan(start)
  return sm.slice(start, end)
}

describe('background-notice marker contract (shared/background-notice.ts)', () => {
  it('marker prefix identifies the synthetic message; body strips the marker', () => {
    expect(isBackgroundNoticeText(`${BACKGROUND_NOTICE_MARKER} 后台任务已完成`)).toBe(true)
    expect(isBackgroundNoticeText('普通用户消息')).toBe(false)
    expect(isBackgroundNoticeText(undefined)).toBe(false)
    expect(isBackgroundNoticeText(null)).toBe(false)
  })

  // 2026-11-08 裁定：转录系统行只显示任务名 + 执行结果——marker 行的首行
  // （composer 写的汇总）；首行之下的明细段（pid/退出码/输出尾部 + 汇报指令）
  // 是给模型的，永不上屏。
  it('the body is the FIRST line only — the model half below never reaches the transcript', () => {
    const full = [
      `${BACKGROUND_NOTICE_MARKER} 后台任务已完成：npm run build（成功）`,
      '',
      '先前转入后台运行的命令已结束：',
      '',
      '- pid=1「npm run build」退出码 0',
      '',
      '请向用户简要汇报每个任务的结果（成功/失败与关键输出），不要重新执行这些命令。',
    ].join('\n')
    expect(backgroundNoticeBody(full)).toBe('后台任务已完成：npm run build（成功）')
    expect(backgroundNoticeBody(`${BACKGROUND_NOTICE_MARKER} 单行`)).toBe('单行')
    expect(backgroundNoticeBody(`${BACKGROUND_NOTICE_MARKER}\n\n缩进起手`)).toBe('缩进起手')
  })

  it('the composer uses THE shared marker, never an inline literal', () => {
    const sm = src('src/main/agent/session-manager.ts')
    expect(sm).toContain('BACKGROUND_NOTICE_MARKER')
    expect(sm).not.toContain("'[[background-notice]]")
  })
})

describe('deliverBackgroundNotice — the gate matrix (in-body order)', () => {
  const body = deliveryBody()

  it('gates in order: re-entry → notices empty → engine active → global slots', () => {
    const reentry = body.indexOf('this.deliveringBackground.has(sessionId)')
    const empty = body.indexOf('backgroundNotices.length === 0')
    const active = body.indexOf('isActiveStatus(entry.engine.agentStatus)')
    const slots = body.indexOf('this.runningLoops >= MAX_CONCURRENT_LOOPS')
    for (const idx of [reentry, empty, active, slots]) expect(idx, 'a gate went missing').toBeGreaterThan(-1)
    expect(reentry).toBeLessThan(empty)
    expect(empty).toBeLessThan(active)
    expect(active).toBeLessThan(slots)
  })

  it('returns the three-word contract: busy / nothing / delivered', () => {
    expect(body).toContain("return 'busy'")
    expect(body).toContain("return 'nothing'")
    expect(body).toContain("return 'delivered'")
  })

  it('re-entry is armed before any await and always disarmed (try/finally)', () => {
    const add = body.indexOf('this.deliveringBackground.add(sessionId)')
    const firstAwait = body.indexOf('await', add)
    expect(add, 'the re-entry flag must be set').toBeGreaterThan(-1)
    expect(firstAwait, 'the flag must be armed synchronously (before the first await)').toBeGreaterThan(add)
    expect(body).toContain('finally {')
    expect(body).toContain('this.deliveringBackground.delete(sessionId)')
  })

  it('the synthetic turn is ONE message: marker prefix + pid/code + inline 2KB log tail', () => {
    expect(body).toContain('entry.engine.backgroundNotices')
    // NOT drained here — the engine's own request builder drains the same
    // notices into the state block on this turn (双保险), and a user turn that
    // races in keeps its normal wake-up.
    expect(body).toContain('await this.ask(sessionId, content)')
    expect(body).toContain('svcExecLogs(n.pid, 2048)')
    expect(body).toContain('退出码')
    expect(body).toContain('不要重新执行这些命令')
  })

  it('the tail read runs inside the session sandbox (exec_logs pid authorization)', () => {
    expect(body).toContain('sessionSandbox.run(sandboxCtx, () => svcExecLogs(n.pid, 2048))')
  })
})

describe('background_task event face (B)', () => {
  it('payloads carries the exit member as one line', () => {
    const p = src('src/shared/agent-protocol/payloads.ts')
    expect(p).toContain("| { type: 'background_task'; phase: 'exit'; pid: number; code: number | null }")
  })

  it('the backgroundExit listener emits the event right after enqueueing the wake-up', () => {
    const sm = src('src/main/agent/session-manager.ts')
    const i = sm.indexOf('setSessionBackgroundExitListener((sessionId')
    expect(i, 'the listener registration moved?').toBeGreaterThan(0)
    const block = sm.slice(i, i + 1200)
    expect(block).toContain('enqueueBackgroundNotice')
    expect(block).toContain("type: 'background_task', phase: 'exit', pid, code")
    const enqueue = block.indexOf('enqueueBackgroundNotice')
    const emit = block.indexOf("type: 'background_task'")
    expect(emit, 'the event must ride the same exit beat').toBeGreaterThan(enqueue)
  })

  it('the mirror folds it explicitly (consumed-and-ignored, not unknown)', () => {
    const m = src('src/shared/agent-session/mirror.ts')
    expect(m).toContain("case 'background_task':")
    const i = m.indexOf("case 'background_task':")
    expect(m.slice(i, i + 800)).toContain('return false')
  })

  it('tool_status carries backgroundPid over the wire and the fold patches it', () => {
    const p = src('src/shared/agent-protocol/payloads.ts')
    expect(p).toContain('backgroundPid?: number }>')
    const sm = src('src/main/agent/session-manager.ts')
    expect(sm).toContain('backgroundPid: tu.backgroundPid')
    const m = src('src/shared/agent-session/mirror.ts')
    expect(m).toContain('u.backgroundPid !== undefined ? { backgroundPid: u.backgroundPid }')
  })
})

describe('mirror behavior (unit)', () => {
  it('background_task folds to false and leaves the state untouched', () => {
    const st = freshSessionState()
    st.messages = [{ id: 'm1', role: 'assistant', contentBlocks: [{ type: 'text', text: 'hi' }], createdAt: 'now' }]
    const before = st.messages
    expect(applySessionEvent(st, { type: 'background_task', phase: 'exit', pid: 42, code: 0 })).toBe(false)
    expect(st.messages).toBe(before)
    expect(st.agentStatus).toEqual({ status: 'idle' })
  })

  it('tool_status patches backgroundPid onto the mirrored block', () => {
    const st = freshSessionState()
    st.messages = [
      {
        id: 'm1',
        role: 'assistant',
        contentBlocks: [{ type: 'tool_use', id: 't1', name: 'exec', input: { command: 'sleep 30' }, status: 'running' }],
        createdAt: 'now',
      },
    ]
    const ok = applySessionEvent(st, {
      type: 'tool_status',
      updates: [{ messageId: 'm1', toolUseId: 't1', status: 'completed', exitCode: 0, backgroundPid: 4242 }],
    })
    expect(ok).toBe(true)
    const block = st.messages[0].contentBlocks[0] as { backgroundPid?: number; status?: string }
    expect(block.backgroundPid).toBe(4242)
    expect(block.status).toBe('completed')
  })
})

describe('approval invariant — background buys no bypass (裁定 4)', () => {
  it('execSkillCommand: the write gate scans BEFORE the background branch AND the promotion continuation', () => {
    const d = src('src/renderer/src/agent/executors/domain-tools.ts')
    const fn = d.indexOf('export async function execSkillCommand')
    const body = d.slice(fn, d.indexOf('\n}', fn))
    const gate = body.indexOf('detectShellFileWrite(t.input.command)')
    const bgBranch = body.indexOf('t.input?.background === true')
    const promoted = body.indexOf("outcome === 'promoted'")
    expect(gate).toBeGreaterThan(-1)
    expect(bgBranch).toBeGreaterThan(gate)
    expect(promoted).toBeGreaterThan(gate)
  })

  it('approveTool released path keeps the same gate; promotion happens AFTER approval by construction', () => {
    const f = src('src/renderer/src/agent/engine/execution-flow.ts')
    const fn = f.indexOf('approveTool = async')
    const body = f.slice(fn, f.indexOf('promoteReleasedTool', fn))
    const gate = body.indexOf('detectShellFileWrite(targetBlock.input.command)')
    const register = body.indexOf('registerForegroundExec(toolUseId')
    expect(gate).toBeGreaterThan(-1)
    expect(register, 'the promotion handle registers after the gate, on the released path').toBeGreaterThan(gate)
    // The released-path promotion settles via the host move (promoteReleasedTool):
    // nothing is re-spawned, so no executeBackground call exists anywhere on it.
    const promote = f.indexOf('promoteReleasedTool = (toolUseId')
    const promoteBody = f.slice(promote, f.indexOf('rejectTool =', promote))
    expect(promoteBody).toContain('getHost().promoteToBackground(processId)')
    expect(promoteBody).not.toContain('executeBackground(')
  })

  it('the promote IPC channel is agent-only (renderer reach-around throws)', () => {
    const h = src('src/main/ipc/terminal.handler.ts')
    const i = h.indexOf('TERMINAL_PROMOTE_BACKGROUND')
    expect(h.slice(i, i + 300)).toContain('agent-only')
  })
})

describe('renderer orchestration (C) — three triggers, one idempotent entry', () => {
  it('useChatController wires all three triggers through deliverBackground', () => {
    const c = src('src/renderer/src/hooks/useChatController.ts')
    expect(c).toContain('agentSessionDeliverBackground')
    expect(c).toMatch(/shouldDrainOnStatusChange\(prev, \{ convId, status \}\)/)
    // busy→idle edge reuses the staged-drain predicate; switch-back is its own effect.
    const matches = c.match(/void deliverBackground\(convId\)/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(3)
  })

  it('notify fires only for a NOT-watched conversation; popout windows opt out', () => {
    const c = src('src/renderer/src/hooks/useChatController.ts')
    expect(c).toContain('agentSessionNotifyBackgroundComplete')
    expect(c).toContain('options.savesEnabled === false')
  })

  it('the engine hook decrements on exit and increments on the backgroundPid diff', () => {
    const h = src('src/renderer/src/hooks/useConversationEngine.ts')
    expect(h).toContain("data.type === 'background_task' && data.phase === 'exit'")
    expect(h).toContain('bgPidsRef.current.get(sessionId)')
    expect(h).toMatch(/typeof u\.backgroundPid !== 'number'/)
    expect(h).toContain("agentSessionEngineCall(convId, 'promoteToolToBackground'")
  })

  it('the transcript renders the synthetic message as a system row, not a user bubble', () => {
    const g = src('src/renderer/src/components/chat/MessageGroup.tsx')
    expect(g).toContain('isBackgroundNoticeText')
    expect(g).toContain('data-background-notice=""')
    expect(g).toContain('backgroundNoticeBody(')
  })

  it('the sidebar gutter paints the running count when no light is lit', () => {
    const r = src('src/renderer/src/components/layout/ConversationRows.tsx')
    expect(r).toContain('backgroundCounts')
    expect(r).toContain('data-bg-running={convKey}')
    expect(r).toMatch(/\} : backgroundCount > 0|\{!light && backgroundCount > 0/)
  })
})

describe('task names + floating strip (D, 2026-11-08)', () => {
  it('the engine files the command into a pid-keyed ledger and the notice takes it', () => {
    const e = src('src/renderer/src/agent/AgentEngine.ts')
    expect(e).toContain('backgroundCommands = new Map<number, string>()')
    expect(e).toContain('registerBackgroundCommand = (pid: number, command: string)')
    // enqueue takes the name OUT of the ledger (one-shot, no leak) and the
    // notice carries it only when present (unknown-command fallback stays).
    const enqueue = e.slice(e.indexOf('enqueueBackgroundNotice = (pid'))
    expect(enqueue).toContain('this.backgroundCommands.get(pid)')
    expect(enqueue).toContain('this.backgroundCommands.delete(pid)')
    expect(enqueue).toContain('command ? { pid, code, command } : { pid, code }')
    // late-wired into the executor (constructor sequence is full — the
    // followUpSubAgent pattern), never a positional param
    expect(e).toContain('this.toolExecutor.registerBackgroundCommand = (pid, command)')
    // the state-block drain keeps the name for the model too
    expect(e).toContain('n.command ? { pid: n.pid, code: n.code, command: n.command }')
  })

  it('ToolExecContext declares the optional member (test fakes construct)', () => {
    const c = src('src/renderer/src/agent/executors/context.ts')
    expect(c).toContain('registerBackgroundCommand?: (pid: number, command: string) => void')
  })

  it('all three backgrounding paths file the task name at the settle beat', () => {
    const dt = src('src/renderer/src/agent/executors/domain-tools.ts')
    // background:true spawn — the model-supplied short name wins
    expect(dt).toContain('ex.registerBackgroundCommand?.(pid, String(t.input?.name || command))')
    // mid-run 转入后台 (auto path)
    expect(dt).toContain('ex.registerBackgroundCommand?.(promoted.pid, String(t.input?.name || command))')
    const ef = src('src/renderer/src/agent/engine/execution-flow.ts')
    // mid-run 转入后台 (approve path): the command rides the promote closure
    expect(ef).toContain('promote: () => { this.promoteReleasedTool(toolUseId, resolvedCommand) }')
    expect(ef).toContain('promoteReleasedTool = (toolUseId: string, command?: string)')
    expect(ef).toContain("String(rawInput?.name || command || rawInput?.command || '')")
  })

  it('the exec tool offers a task name and the manual makes it a background requirement', () => {
    const tools = src('src/renderer/src/tools/built-in-tools.ts')
    expect(tools).toMatch(/name: \{\s*type: 'string',\s*description: 'A short human task name/)
    const instr = src('src/renderer/src/tools/tool-instructions.ts')
    expect(instr).toContain('Every backgrounded exec carries a short \\`name\\`')
  })

  it('the delivery turns the ledger names into a first-line summary + a model detail block', () => {
    const body = deliveryBody()
    // marker line carries the summary — the transcript row's only visible half
    expect(body).toContain('`${BACKGROUND_NOTICE_MARKER} 后台任务已完成：${summary}`')
    expect(body).toContain('const nameOf')
    expect(body).toContain('const resultOf')
    // model half keeps pid + full context and the report instruction
    expect(body).toContain('- pid=${n.pid}「${nameOf(n)}」退出码')
    expect(body).toContain('请向用户简要汇报每个任务的结果')
  })

  it('the event fold upserts strip rows on the pid diff and removes on exit', () => {
    const h = src('src/renderer/src/hooks/useConversationEngine.ts')
    expect(h).toContain("import { useBackgroundTasksStore, backgroundTaskLabel } from '../stores/backgroundTasksStore'")
    // +1 beat: label off the mirrored tool block (tool_status already patched it)
    expect(h).toContain('useBackgroundTasksStore.getState().upsert(sessionId, {')
    expect(h).toContain("backgroundTaskLabel(block.input, block.name ?? '')")
    expect(h).toContain('useBackgroundTasksStore.getState().remove(sessionId, data.pid)')
    // mirror eviction drops the rows too
    expect(h).toContain('useBackgroundTasksStore.getState().drop(convId)')
  })

  it('the strip mounts in navTopSlot and only flips the slot on presence', () => {
    const v = src('src/renderer/src/components/layout/ChatView.tsx')
    expect(v).toContain("import { BackgroundTasksStrip } from '../chat/BackgroundTasksStrip'")
    // presence flips the slot (else the strip dies with the null slot); row-level
    // changes must NOT be in the memo deps — the strip self-subscribes.
    expect(v).toContain('planStrip || awayFromBottom || hasBgTasks')
    // 会话作用域（2026-11-09 用户实锤「后台任务跨会话了」）：只在当前对话自己
    // 有任务时翻面，别的会话在跑不占本对话的槽。空/未物化的 conversationId
    // 查不到键，?.length 兜成 false，无需显式守卫。
    expect(v).toMatch(/const hasBgTasks = useBackgroundTasksStore\(\(s\) => !!s\.byConversation\[conversationId \?\? ''\]\?\.length\)/)
    expect(v).toContain('<BackgroundTasksStrip conversationId={conversationId} />')
    const memo = v.slice(v.indexOf('const navTopSlot = useMemo'), v.indexOf('const pendingScrollRef'))
    expect(memo).not.toContain('byConversation')
    // conversationId 进 memo 依赖：换会话必须换发 strip 的取数键（行级变化
    // 仍不进——strip 自订阅 store）。
    expect(memo).toContain('conversationId={conversationId}')
    expect(memo).toContain('handleNavJump, conversationId]')
  })

  // 2026-11-09 用户实锤「后台任务跨会话了」：store 按 conversationId 键控，
  // 读侧必须同键取行——Object.values(...).flat() 的全量摊平曾把别的会话的
  // 任务搬进本对话的条子（条子文案与展开卡都是）。负扫钉死不得回归。
  it('the strip lists only the current conversation rows', () => {
    const s = src('src/renderer/src/components/chat/BackgroundTasksStrip.tsx')
    expect(s).toMatch(/useBackgroundTasksStore\(\(s\) => \(conversationId \? s\.byConversation\[conversationId\] : undefined\)\)/)
    expect(s).toContain('const EMPTY_ROWS: BackgroundTaskRow[] = []')
    expect(s).not.toContain('Object.values')
  })

  // 2026-11-08 用户裁定：计划条与后台任务条左对齐到**输入卡左缘**（居中与
  // 【回到底部】圆钮冲突；对齐基准是 COMPOSER_MAX_WIDTH 卡盒而非 Composer
  // 根），MessageNavControls 的 stripAbove 让位机制随之退役。
  it('plan strip and background strip align to the COMPOSER card left edge', () => {
    const v = src('src/renderer/src/components/layout/ChatView.tsx')
    const memo = v.slice(v.indexOf('const navTopSlot = useMemo'), v.indexOf('const pendingScrollRef'))
    expect(memo).toContain("maxWidth: 952, margin: '0 auto', display: 'flex', justifyContent: 'flex-start'")
    expect(memo).not.toContain('stripAbove')
    const nav = src('src/renderer/src/components/chat/MessageNavigator.tsx')
    expect(nav).not.toContain('stripAbove')
    const s = src('src/renderer/src/components/chat/BackgroundTasksStrip.tsx')
    expect(s).toContain('maxWidth: COMPOSER_MAX_WIDTH')
    expect(s).toContain("margin: '6px auto 0'")
    expect(s).toContain("justifyContent: 'flex-start'")
    // the hover card anchors the pill's LEFT edge, not the viewport center
    expect(s).toMatch(/bottom: 'calc\(100% \+ 8px\)',\s*\n\s*left: 0,/)
    expect(s).not.toContain("left: '50%'")
  })

  // 2026-11-10 用户实锤「后台任务悬浮气泡和回到底部按钮冲突」：条子外盒是
  // 全卡宽（952）的对齐框且 zIndex 100 压过导航根的 z-auto——外盒不吃指针
  // 的话，药丸右侧那截透明带正盖住居中的【回到底部】圆钮，悬停中位 120ms
  // 弹卡、点击被吞。修法同 MessageNavControls 的根框纪律：根框透明于指针
  // （pointerEvents none），可见件（药丸 + 展开卡）各自恢复可点；悬停开卡
  // 依赖 React 合成 enter/leave 沿祖先链派发，外框上的防抖逻辑不动。
  it('the strip frame is transparent to pointers; pill and hover card take the hits', () => {
    const s = src('src/renderer/src/components/chat/BackgroundTasksStrip.tsx')
    const wrapper = s.slice(s.indexOf('data-pm-background-tasks=""'), s.indexOf('data-pm-background-tasks-card=""'))
    // 根框 = 对齐框，不吃指针
    expect(wrapper).toContain("pointerEvents: 'none'")
    // 药丸与展开卡是仅有的两个可点件（各一处 auto；外框 none 之外不得再多）
    const autos = s.match(/pointerEvents: 'auto'/g) ?? []
    expect(autos.length).toBe(2)
  })

  it('the strip polls execLogs while expanded and exits with the store', () => {
    const s = src('src/renderer/src/components/chat/BackgroundTasksStrip.tsx')
    expect(s).toContain('window.electronAPI.execLogs(row.pid')
    expect(s).toContain('data-pm-background-tasks=""')
    expect(s).toContain('data-pm-background-tasks-card=""')
  })

  // 回归钉（2026-11-08 用户实锤「面板不消失」）：回合结束拍的对账清扫
  // （TERMINAL_SWEEP_STATUSES 清空 toolStatusRegistry 全量重发）会把已结算
  // 后台块的 backgroundPid 重新上线——exit 事件已把行退场，重发即复活成永久
  // 卡住（侧栏计数同病）。修在源头：diff 只对 backgroundByPid 活值发 pid。
  it('the tool_status diff ships backgroundPid ONLY for alive pids', () => {
    const sm = src('src/main/agent/session-manager.ts')
    expect(sm).toContain('svcIsBackgroundPidAlive')
    const diff = sm.slice(sm.indexOf('private emitToolStatusDiff'), sm.indexOf('private emitMessageStatsDiff'))
    expect(diff).toContain('svcIsBackgroundPidAlive(tu.backgroundPid)')
    expect(diff).toMatch(/\.\.\.\(bgAlive \? \{ backgroundPid: tu\.backgroundPid \} : \{\}\)/)
    expect(diff).toContain("${shippedPid ?? ''}")
  })

  it('terminal exposes background liveness off backgroundByPid', () => {
    const t = src('src/main/services/terminal.ts')
    expect(t).toContain('export function svcIsBackgroundPidAlive(pid: number): boolean')
    expect(t).toMatch(/export function svcIsBackgroundPidAlive[\s\S]{0,200}backgroundByPid\.has\(pid\)/)
  })

  // 悬停看执行过程的回归钉（2026-11-08）：svcExecLogs 的授权读会话 ALS，IPC
  // 处理器不在任何会话作用域里——条子的轮询曾永远拿到 null（「尚无输出」）。
  // 渲染端读走 renderer-facing 通道（授权面 = 全应用后台台账）。
  // ── E 批（2026-11-08 用户实测四缺口）───────────────────────────────────
  it('#1 pid ownership persists across sessions; exec_logs falls back to it', () => {
    const t = src('src/main/services/terminal.ts')
    expect(t).toContain("const PID_OWNERS_FILE = join(PROC_LOG_DIR, 'owners.json')")
    expect(t).toContain('function registerPidOwner(')
    // spawn + both promote paths register ownership
    expect(t).toContain('registerPidOwner(pid, sandboxCtx?.sessionId, name || command, command)')
    expect(t).toContain('registerPidOwner(shellPid, ctx?.sessionId, f.command, f.command)')
    expect(t).toContain('registerPidOwner(pid, entry.sessionCtx?.sessionId, entry.command, entry.command)')
    // authorization fallback: ALS membership miss → ownership table
    expect(t).toContain('readPidOwners()[String(pid)]?.conversationId !== ctx.sessionId')
  })

  it('#2 a main-side sweep auto-delivers pending notices when idle', () => {
    const sm = src('src/main/agent/session-manager.ts')
    expect(sm).toContain('this.deliverSweepTimer = setInterval(')
    expect(sm).toContain('this.deliverSweepTimer.unref()')
    const sweep = sm.slice(sm.indexOf('this.deliverSweepTimer = setInterval'), sm.indexOf('setSessionBackgroundExitListener((sessionId'))
    // the sweep respects the same gates as the manual trigger
    expect(sweep).toContain('backgroundNotices.length === 0')
    expect(sweep).toContain('isActiveStatus(entry.engine.agentStatus)')
    expect(sweep).toContain('this.deliveringBackground.has(sessionId)')
  })

  it('#3 exec_list enumerates the persisted registry; running tasks ride the state block', () => {
    const t = src('src/main/services/terminal.ts')
    expect(t).toContain('export function svcListBackground(')
    expect(t).toMatch(/exitCodeFromLog/)
    const tools = src('src/renderer/src/tools/built-in-tools.ts')
    expect(tools).toContain("name: 'exec_list'")
    const instr = src('src/renderer/src/tools/tool-instructions.ts')
    expect(instr).toContain('exec_list: `## exec_list')
    const tiers = src('src/renderer/src/agent/engine/tool-tiers.ts')
    expect(tiers).toContain("name === 'exec_logs' || name === 'exec_list'")
    const host = src('src/shared/types/electron-bridge.ts')
    expect(host).toContain('execList: () => Promise<{ pid: number; name: string')
    expect(host).toContain('execAlive: (pid: number) => Promise<boolean>')
    // state block: the live set re-renders every turn
    const engine = src('src/renderer/src/agent/AgentEngine.ts')
    expect(engine).toContain('runningBackgroundTasks')
    expect(engine).toContain('getHost().execAlive(pid)')
    const spb = src('src/renderer/src/agent/system-prompt-builder.ts')
    expect(spb).toContain('export function buildRunningBackgroundTasksSection(')
    expect(spb).toContain('do not assume their outcome')
  })

  it('#4 stderr bytes gate the whitewash hint on the exit line', () => {
    const t = src('src/main/services/terminal.ts')
    expect(t).toContain('let stderrBytes = 0')
    expect(t).toContain('stderrBytes += chunk.length')
    expect(t).toContain('a trailing echo/cleanup can whitewash a real failure')
    const instr = src('src/renderer/src/tools/tool-instructions.ts')
    expect(instr).toContain("A compound command's exit code is the LAST command's")
  })

  it('the TERMINAL_EXEC_LOGS channel serves the renderer-facing tail', () => {
    const h = src('src/main/ipc/terminal.handler.ts')
    expect(h).toContain('svcExecLogsForRenderer(Number(pid), tailBytes)')
    expect(h).not.toMatch(/ipcMain\.handle\(IPC_CHANNELS\.TERMINAL_EXEC_LOGS[^\n]*svcExecLogs\(/)
    const t = src('src/main/services/terminal.ts')
    expect(t).toContain('export function svcExecLogsForRenderer(pid: number, tailBytes?: number)')
  })
})

describe('notification + settings (B)', () => {
  it('the notify handler gates on notifications.backgroundComplete (default on)', () => {
    const h = src('src/main/ipc/agent-session.handler.ts')
    expect(h).toContain('AGENT_SESSION_NOTIFY_BACKGROUND')
    expect(h).toContain('settings.notifications?.backgroundComplete === false')
  })

  it('the read-side normalize keeps the group spread and adds the one line', () => {
    const s = src('src/main/storage/settings-store.ts')
    expect(s).toContain('backgroundComplete: group.backgroundComplete !== false,')
  })

  it('settings type + both locales carry the keys', () => {
    expect(src('src/shared/types/settings.ts')).toContain('backgroundComplete?: boolean')
    const zh = src('src/renderer/src/i18n/locales/zh.ts')
    const en = src('src/renderer/src/i18n/locales/en.ts')
    for (const loc of [zh, en]) {
      expect(loc).toContain('notifyTitle:')
      expect(loc).toContain('notifyBody:')
      expect(loc).toContain('bgRunning:')
      expect(loc).toContain('backgroundComplete:')
      expect(loc).toContain('promoteToBackground:')
    }
  })
})

describe('promotion通路 wiring (A)', () => {
  it('dispatch whitelist knows the method and the engine delegates to both registries', () => {
    const sm = src('src/main/agent/session-manager.ts')
    expect(sm).toContain("case 'promoteToolToBackground':")
    const e = src('src/renderer/src/agent/AgentEngine.ts')
    expect(e).toContain('promoteForegroundExec(toolUseId)')
    expect(e).toContain('this.executionFlow.promoteReleasedTool(toolUseId)')
  })

  it('the auto-path executor settles the promoted result with the background envelope', () => {
    const d = src('src/renderer/src/agent/executors/domain-tools.ts')
    const fn = d.indexOf("outcome === 'promoted'")
    const body = d.slice(fn, d.indexOf('return true', fn))
    expect(body).toContain('getHost().promoteToBackground(claimedPid)')
    expect(body).toContain('t.backgroundPid = promoted.pid')
  })

  it('the host seam carries promoteToBackground end to end', () => {
    expect(src('src/renderer/src/agent/host/types.ts')).toContain("'promoteToBackground',")
    expect(src('src/shared/types/electron-bridge.ts')).toMatch(/promoteToBackground: \(processId: string\) => Promise<\{ pid: number \} \| null>/)
    expect(src('src/preload/index.ts')).toContain('TERMINAL_PROMOTE_BACKGROUND')
    expect(src('src/main/agent/main-host.ts')).toContain('promoteToBackground: async (processId) => svcPromoteToBackground(processId)')
  })
})
