/**
 * 后台任务完成唤醒（2026-10-28）：background:true 的进程死亡时，main 在 exit
 * 拍点把 (sessionId, pid, code) 推进属主引擎的队列，引擎在下一次请求构建时把
 * 通知渲染进 state block 的 `## Background Tasks` 节并清空——一次性指针消息，
 * 模型无须记得轮询。旧的死亡发现通道（exec_logs 的 [exited code=N] 日志尾巴）
 * 保持原样：通知丢了就退化为旧行为，日志永远是真的。
 *
 * state block 是每回合重建的易变尾节，通知走 state block 不动持久历史，缓存
 * 前缀不受影响（ready-made 注入载体的裁定）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-bg-wake-'))

const { buildBackgroundTasksSection } = await import('../src/renderer/src/agent/system-prompt-builder')
const { backgroundStartNote } = await import('../src/shared/background-notice')
const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')
const { setHost } = await import('../src/renderer/src/agent/host')

// ── 节格式（纯函数） ─────────────────────────────────────────────────────────

describe('backgroundStartNote', () => {
  it('names the pid and distinguishes the two entry kinds', () => {
    expect(backgroundStartNote(7, 'started')).toContain('Background process started: pid=7')
    expect(backgroundStartNote(7, 'promoted')).toContain('Moved to background by the user: pid=7')
  })

  it('teaches what the freed round trips are for, and bans the sleep workaround by name', () => {
    const note = backgroundStartNote(9, 'started')
    expect(note).toContain('you will be NOTIFIED')
    expect(note).toContain('does not depend on it')
    expect(note).toContain('Do not synthesize a wait')
    expect(note).toContain('end the turn')
    expect(note).toContain('exec_logs(pid=9)')
    expect(note).toContain('exec_kill(pid=9)')
  })
})

describe('buildBackgroundTasksSection', () => {
  it('exit 0 reads as good news; nonzero asks for diagnosis; null names the signal', () => {
    const zero = buildBackgroundTasksSection([{ pid: 42, code: 0 }])
    expect(zero).toContain('## Background Tasks')
    expect(zero).toContain('pid=42 finished (exit code 0)')
    expect(zero).toContain('exec_logs(pid=42)')
    expect(zero).not.toContain('check what went wrong')

    const nonzero = buildBackgroundTasksSection([{ pid: 43, code: 1 }])
    expect(nonzero).toContain('exit code 1')
    expect(nonzero).toContain('check what went wrong')

    const signal = buildBackgroundTasksSection([{ pid: 44, code: null }])
    expect(signal).toContain('killed by a signal')
  })

  it('caps the rendered list at 10 (the engine queue cap)', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ pid: i + 1, code: 0 as number | null }))
    const section = buildBackgroundTasksSection(many)
    expect(section.match(/^- Background task/gm)?.length).toBe(10)
  })
})

// ── 引擎队列（真引擎：同 pid 去重、长度帽） ─────────────────────────────────

describe('engine backgroundNotices queue', () => {
  it('keeps the LATEST notice per pid and caps the queue length', () => {
    const noop = () => Promise.resolve([] as unknown[])
    setHost({
      getSettings: () => Promise.resolve({ locale: 'zh' }),
      onMcpServersChanged: noop, onSkillsChanged: noop, mcpListServers: noop,
      expertList: noop, getSkillPreferences: noop,
    } as never)
    const engine = new AgentEngine({
      apiKey: '', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 512,
      myName: '', soul: '', yourName: '', adapter: {} as never,
      toolManager: new ToolManager(), skillManager: new SkillManager(),
      conversationId: 'conv_bg_queue',
    })
    engine.enqueueBackgroundNotice(1, 0)
    engine.enqueueBackgroundNotice(2, 0)
    engine.enqueueBackgroundNotice(1, 3) // same pid → replace
    expect(engine.backgroundNotices).toEqual([{ pid: 2, code: 0 }, { pid: 1, code: 3 }])
    for (let pid = 10; pid < 25; pid++) engine.enqueueBackgroundNotice(pid, 0)
    expect(engine.backgroundNotices.length).toBeLessThanOrEqual(10)
  })
})

// ── wiring 扫描：三个环节的连接处 ────────────────────────────────────────────

const ROOT = join(process.cwd(), 'src')

describe('background wake-up wiring', () => {
  const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

  it('main: terminal exit handlers push into the session registry', () => {
    const term = read('main/services/terminal.ts')
    expect(term).toContain('notifySessionBackgroundExit(sandboxCtx.sessionId, pid, code)')
    expect(term).toContain('notifySessionBackgroundExit(sandboxCtx.sessionId, pid, null)')
  })

  it('main: session-manager forwards to the owning engine', () => {
    expect(read('main/agent/session-manager.ts')).toContain('setSessionBackgroundExitListener')
    expect(read('main/agent/session-manager.ts')).toContain('.enqueueBackgroundNotice(pid, code)')
  })

  it('renderer: the engine drains the queue into the state block and clears it', () => {
    const eng = read('renderer/src/agent/AgentEngine.ts')
    expect(eng).toContain('backgroundNotices')
    expect(eng).toContain('if (backgroundNotices) this.backgroundNotices = []')
    const spb = read('renderer/src/agent/system-prompt-builder.ts')
    expect(spb).toContain('buildBackgroundTasksSection(backgroundNotices)')
  })

  it('the background envelope teaches the wake-up AND the freed time, from ONE source', () => {
    const shared = read('shared/background-notice.ts')
    expect(shared).toContain('you will be NOTIFIED')
    expect(shared).toContain('Do not synthesize a wait')
    expect(shared).toContain('end the turn')
    // Three dispatch sites — each must call the helper, never re-inline the text.
    const tools = read('renderer/src/agent/executors/domain-tools.ts')
    expect(tools).toContain("backgroundStartNote(pid, 'started')")
    expect(tools).toContain("backgroundStartNote(promoted.pid, 'promoted')")
    expect(read('renderer/src/agent/engine/execution-flow.ts')).toContain("backgroundStartNote(promoted.pid, 'promoted')")
    expect(tools).not.toContain('This result is immediate')
  })
})
