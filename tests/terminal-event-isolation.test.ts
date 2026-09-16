import { describe, expect, it } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { AgentEngine } from '../src/renderer/src/agent/AgentEngine'
import { ToolManager } from '../src/renderer/src/tools/ToolManager'
import { SkillManager } from '../src/renderer/src/skills/SkillManager'
import type { ToolManager as ToolManagerType } from '../src/renderer/src/tools/ToolManager'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'
import { beginTerminalSpan } from '../src/renderer/src/agent/terminal-span'
import type { TerminalOutputEvent, TerminalExitEvent } from '../src/renderer/src/types/electron'

/**
 * PLAN-parallel-experts T7: the terminal bus broadcasts by channel, so while
 * two engines each have a process running, A's output/exit used to settle B's
 * tool block (mixed output, B's exit code, B's listeners torn down) and B's
 * real process became unkillable. Both consumers now filter by processId and
 * park the pre-pid window. The fake bus below is the same shape main-host and
 * the preload forward: every event carries the emitting processId.
 */

type OutputListener = (d: TerminalOutputEvent) => void
type ExitListener = (d: TerminalExitEvent) => void
type ErrorListener = (d: { processId: string; message: string }) => void

interface Bus {
  outputL: OutputListener[]
  exitL: ExitListener[]
  errorL: ErrorListener[]
  output(pid: string, data: string): void
  exit(pid: string, code: number | null): void
  error(pid: string, message: string): void
}

function makeBus(): Bus {
  const bus: Bus = {
    outputL: [], exitL: [], errorL: [],
    output: (pid, data) => bus.outputL.forEach(fn => fn({ processId: pid, type: 'stdout', data })),
    exit: (pid, code) => bus.exitL.forEach(fn => fn({ processId: pid, code, signal: null })),
    error: (pid, message) => bus.errorL.forEach(fn => fn({ processId: pid, message })),
  }
  return bus
}

function hostOverBus(bus: Bus, pids: Record<string, Promise<string>>): PulseHost {
  return {
    onTerminalOutput: (cb: OutputListener) => { bus.outputL.push(cb); return () => { bus.outputL = bus.outputL.filter(f => f !== cb) } },
    onTerminalExit: (cb: ExitListener) => { bus.exitL.push(cb); return () => { bus.exitL = bus.exitL.filter(f => f !== cb) } },
    onTerminalError: (cb: ErrorListener) => { bus.errorL.push(cb); return () => { bus.errorL = bus.errorL.filter(f => f !== cb) } },
    executeCommand: (command: string) => pids[command] ?? Promise.resolve('pid-default'),
    killCommand: () => Promise.resolve(),
    // mcp-cache's ensureCache (AgentEngine constructor) subscribes these.
    onMcpServersChanged: () => () => {},
    onSkillsChanged: () => () => {},
    mcpListServers: () => Promise.resolve([]),
    expertList: () => Promise.resolve([]),
    getSkillPreferences: () => Promise.resolve({}),
  } as unknown as PulseHost
}

function makeEngine(id: string): AgentEngine {
  const engine = new AgentEngine({
    apiKey: 'test-key',
    baseURL: 'https://example.invalid',
    model: 'test-model',
    maxTokens: 512,
    myName: '',
    soul: '',
    yourName: '',
    adapter: {} as never,
    toolManager: new ToolManager() as ToolManagerType,
    skillManager: new SkillManager(),
    conversationId: id,
  })
  // Contain the loop: addToolResult would otherwise restart the LLM round.
  engine.continueLoop = () => {}
  return engine
}

function plantTool(engine: AgentEngine, id: string, command: string): ToolUseBlock {
  const block = { type: 'tool_use', id, name: 'exec', input: { command }, status: 'running' } as unknown as ToolUseBlock
  engine.messages = [...engine.messages, {
    id: `m_${id}`,
    role: 'assistant',
    contentBlocks: [block],
    createdAt: new Date().toISOString(),
  }]
  return block
}

function toolResultCount(engine: AgentEngine): number {
  return engine.messages.filter(m => (m.contentBlocks || []).some(b => b.type === 'tool_result')).length
}

describe('beginTerminalSpan (unit)', () => {
  it('drops foreign live events and delivers own ones', () => {
    const bus = makeBus()
    const host = hostOverBus(bus, {})
    setHost(host)
    const seen: string[] = []
    const span = beginTerminalSpan(host, {
      onOutput: d => seen.push(`out:${d.data}`),
      onExit: d => seen.push(`exit:${d.code}`),
      onError: d => seen.push(`err:${d.message}`),
    })
    span.start()
    bus.output('other', 'X')
    bus.exit('other', 1)
    bus.error('other', 'boom')
    expect(seen).toEqual([])
    span.claim('mine')
    bus.output('mine', 'hello')
    bus.exit('mine', 0)
    expect(seen).toEqual(['out:hello', 'exit:0'])
    span.stop()
    bus.output('mine', 'late')
    expect(seen).toEqual(['out:hello', 'exit:0'])
  })

  it('parks pre-pid events and delivers them on claim, in arrival order; foreign parked events are dropped', () => {
    const bus = makeBus()
    const host = hostOverBus(bus, {})
    setHost(host)
    const seen: string[] = []
    const span = beginTerminalSpan(host, {
      onOutput: d => seen.push(`out:${d.data}`),
      onExit: d => seen.push(`exit:${d.code}`),
      onError: () => seen.push('err'),
    })
    span.start()
    // Subscription exists, pid not claimed yet: our own early output, a fast
    // process's whole exit, and a foreign process's event all arrive here.
    bus.output('mine', 'early')
    bus.exit('mine', 0)
    bus.output('foreign', 'X')
    expect(seen).toEqual([])
    span.claim('mine')
    expect(seen).toEqual(['out:early', 'exit:0'])
    span.stop()
  })
})

describe('two engines, one terminal bus (engine-level)', () => {
  it("A's exit does not touch B's block, exitCode, executingProcessId or results; B settles on its own exit", async () => {
    const bus = makeBus()
    let resolveA!: (pid: string) => void
    const pidA = new Promise<string>(r => { resolveA = r })
    setHost(hostOverBus(bus, { 'echo A': pidA, 'echo B': Promise.resolve('pid-B') }))

    const engineA = makeEngine('conv_iso_A')
    const engineB = makeEngine('conv_iso_B')
    const blockA = plantTool(engineA, 'tA', 'echo A')
    const blockB = plantTool(engineB, 'tB', 'echo B')

    const runA = engineA.approveTool('tA')
    const runB = engineB.approveTool('tB')
    await runB // B: subscribed, claimed pid-B, process running

    // A is still waiting for its pid. Its span already receives live events —
    // including B's — and must park foreign ones rather than consume them.
    bus.output('pid-B', 'B-out')
    expect(blockB.output).toBe('B-out')
    expect(blockA.output).toBeUndefined()

    resolveA('pid-A')
    await runA

    // A's whole lifecycle, then B's, over the shared bus.
    bus.output('pid-A', 'A-out')
    bus.exit('pid-A', 0)
    // A's exit must not have settled B.
    expect(blockB.status).toBe('running')
    expect(blockB.exitCode).toBeUndefined()
    expect(blockB.output).toBe('B-out')
    expect(engineB.executingProcessId).toBe('pid-B')
    expect(toolResultCount(engineB)).toBe(0)

    // B settles only on its own exit.
    bus.exit('pid-B', 3)
    expect(blockB.status).toBe('completed')
    expect(blockB.exitCode).toBe(3)
    expect(toolResultCount(engineB)).toBe(1)
    expect(engineB.executingProcessId).toBe(null)
  })

  it('events arriving before the pid resolves are not lost', async () => {
    const bus = makeBus()
    let resolveA!: (pid: string) => void
    const pidA = new Promise<string>(r => { resolveA = r })
    setHost(hostOverBus(bus, { 'echo A': pidA }))

    const engineA = makeEngine('conv_iso_early')
    const blockA = plantTool(engineA, 'tA', 'echo A')
    const runA = engineA.approveTool('tA')
    // approveTool subscribes a few microtasks in (after the beforeTool await) —
    // let it reach span.start() before the bus speaks.
    await new Promise(r => setTimeout(r, 0))

    // Fast command: output AND exit land before executeCommand resolves.
    bus.output('pid-A', 'early-out')
    bus.exit('pid-A', 0)
    expect(blockA.status).toBe('running') // parked, not consumed

    resolveA('pid-A')
    await runA
    // claim() played the parked events in arrival order — the block is settled.
    expect(blockA.output).toBe('early-out')
    expect(blockA.status).toBe('completed')
    expect(blockA.exitCode).toBe(0)
    expect(toolResultCount(engineA)).toBe(1)
  })
})
