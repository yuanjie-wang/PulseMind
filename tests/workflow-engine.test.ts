// PLAN-workflow-engine：pipeline-engine 单测（mock agentSessionManager，
// routine-run-context.test.ts 蓝本）。钉：coding 模板全路径（fail→fix 闭环、
// maxVisits 耗尽）、早停激发→补契约、激发超限、队列顺序与失败不挡后续、
// objective 解析序（运行级>工作流级）、脏仓库拒跑、FAILED 回滚基线、DONE
// 保留提交链、stop 句柄、授权档 'auto' 落列、阶段会话 pipe_ 前缀。

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── mocks（vi.mock 提升）──

type Sink = (sessionId: string, data: unknown) => void
const sessionState = {
  sinks: new Set<Sink>(),
  created: [] as Array<{ sessionId: string; opts: Record<string, unknown> }>,
  asks: [] as Array<{ sessionId: string; content: string }>,
  stopped: [] as string[],
  releasedPins: [] as string[],
  approvalModes: [] as Array<{ convId: string; mode: string }>,
  /** 每次ask 消费一个剧本项：'none' = 无契约行，否则是该 verdict 的契约行。 */
  script: [] as Array<'none' | 'hang' | { verdict: string; summary: string; artifacts?: string[] }>,
  /** 阶段会话的落盘面（git checkpoint 用例）：ask 时往这里写文件，模拟
   *  「agent 改了工作区」——否则仓库无改动，commit 是 no-op，提交链断言测空。 */
  stageTouchDir: '' as string,
}
const emit = (sessionId: string, data: unknown): void => {
  for (const s of [...sessionState.sinks]) s(sessionId, data)
}
const contractLine = (item: { verdict: string; summary: string; artifacts?: string[] }): string =>
  `工作完成。\nPIPELINE_RESULT: ${JSON.stringify({ verdict: item.verdict, summary: item.summary, artifacts: item.artifacts ?? [] })}`

vi.mock('../src/main/agent/session-manager', () => ({
  agentSessionManager: {
    onEvent: (sink: Sink) => {
      sessionState.sinks.add(sink)
      return () => sessionState.sinks.delete(sink)
    },
    createSession: async (sessionId: string, opts: Record<string, unknown>) => {
      sessionState.created.push({ sessionId, opts })
      return { sessionId, agentId: 'default' }
    },
    ask: async (sessionId: string, content: string) => {
      sessionState.asks.push({ sessionId, content })
      const item = sessionState.script.shift() ?? 'none'
      if (item === 'hang') return // 挂起的回合：不结算（stop 测的窗口）
      if (sessionState.stageTouchDir) {
        try {
          writeFileSync(join(sessionState.stageTouchDir, 'stage-out.txt'), `x${sessionState.asks.length}\n`, { flag: 'a' })
        } catch {
          /* 夹具面 */
        }
      }
      const text = item === 'none' ? '随便说两句，没有契约行。' : contractLine(item)
      // ask 即回合；回合完 → completed 事件（契约结算面）。下一个 tick，
      // 让 runStage 的事件订阅先挂上。
      await new Promise((r) => setTimeout(r, 10))
      emit(sessionId, { type: 'status', status: 'completed' })
      sessionState.lastAnswer = text
    },
    history: async () => ({
      messages: [{ role: 'assistant', contentBlocks: [{ type: 'text', text: sessionState.lastAnswer ?? '' }] }],
      agentId: 'default',
    }),
    engineCall: async (sessionId: string, method: string) => {
      if (method === 'stopExecution') sessionState.stopped.push(sessionId)
      return undefined
    },
    releaseRunPins: (sessionId: string) => {
      sessionState.releasedPins.push(sessionId)
    },
  },
}))
vi.mock('../src/main/storage/audit-store', () => ({
  auditStore: { record: vi.fn() },
}))
vi.mock('../src/main/storage/conversation.db', () => ({
  saveConversation: vi.fn(),
  setConversationApprovalMode: vi.fn((convId: string, mode: string) => {
    sessionState.approvalModes.push({ convId, mode })
  }),
}))
const runRows = new Map<string, { status: string; currentNode?: string; error?: string; baselineCommit?: string }>()
const stageRows: Array<{ runId: string; nodeId: string }> = []
vi.mock('../src/main/storage/pipeline-run-store', () => ({
  pipelineRunStore: {
    createRun: vi.fn((run: { id: string }) => {
      runRows.set(run.id, { status: 'running' })
      return run
    }),
    updateRun: vi.fn((id: string, patch: Record<string, unknown>) => {
      const row = runRows.get(id)
      if (row) Object.assign(row, patch)
    }),
    startStage: vi.fn((s: { runId: string; nodeId: string }) => {
      stageRows.push({ runId: s.runId, nodeId: s.nodeId })
    }),
    finishStage: vi.fn(),
    listRuns: vi.fn(() => []),
    listStagesOf: vi.fn(() => []),
    getRun: vi.fn(() => null),
  },
}))

import { pipelineEngine, runWorkflowInstance } from '../src/main/pipeline/pipeline-engine'

// ── fixtures ──

const linearWorkflow = {
  id: 'test-flow',
  name: '测试流水线',
  objective: '工作流级目标',
  entry: 'code',
  params: { stageTimeoutMinutes: 1, maxStageContinues: 2, defaultMaxVisits: 3, gitCheckpoint: false },
  nodes: [
    { id: 'code', title: '编码', prompt: '编码：{{objective}} / {{planContent}} / {{visit}}', verdicts: ['pass', 'fail'] },
    { id: 'test', title: '测试', prompt: '测试', verdicts: ['pass', 'fail'] },
    { id: 'fix', title: '修复', prompt: '修复：{{prevVerdict}} / {{prevSummary}}', verdicts: ['pass', 'fail'] },
  ],
  edges: [
    { from: 'code', when: 'pass', to: 'test' },
    { from: 'test', when: 'pass', to: 'DONE' },
    { from: 'test', when: 'fail', to: 'fix' },
    { from: 'fix', when: 'pass', to: 'test' },
    { from: 'fix', when: 'fail', to: 'test' },
  ],
}

const planPath = 'PLAN.md'

function freshState(script: Array<'none' | { verdict: string; summary: string; artifacts?: string[] }>): void {
  sessionState.sinks.clear()
  sessionState.created.length = 0
  sessionState.asks.length = 0
  sessionState.stopped.length = 0
  sessionState.releasedPins.length = 0
  sessionState.approvalModes.length = 0
  sessionState.script = [...script]
  sessionState.stageTouchDir = ''
  sessionState.lastAnswer = ''
  runRows.clear()
  stageRows.length = 0
}

/** 工作区夹具：临时目录 + 落一个 PLAN.md（readPlanContent 的读取面）。 */
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-pipeline-'))
  writeFileSync(join(dir, 'PLAN.md'), '计划条目 1：实现 X')
  return dir
}

function gitRepo(dir: string, dirty = false): void {
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir })
  writeFileSync(join(dir, 'seed.txt'), 'seed')
  execSync('git add -A && git commit -qm seed', { cwd: dir })
  if (dirty) writeFileSync(join(dir, 'dirty.txt'), 'uncommitted')
}

describe('runWorkflowInstance', () => {
  beforeEach(() => {
    freshState([])
  })

  it('coding 全路径：code pass → test fail → fix pass → test pass → DONE；每阶段独立 pipe_ 会话 + 授权 auto + pins 释放', async () => {
    freshState([
      { verdict: 'pass', summary: '编码完成' },
      { verdict: 'fail', summary: '两个测试挂了', artifacts: ['pipeline/test-failures.md'] },
      { verdict: 'pass', summary: '修复完成' },
      { verdict: 'pass', summary: '全绿' },
    ])
    const dir = makeWorkspace()
    const result = await runWorkflowInstance({
      runId: 'prun_ok',
      workflow: linearWorkflow,
      planPath,
      workspaceDir: dir,
      runObjective: '运行级目标',
    })
    expect(result.status).toBe('success')
    // 每阶段一个独立会话，pipe_ 前缀
    expect(sessionState.created).toHaveLength(4)
    for (const c of sessionState.created) expect(String(c.sessionId).startsWith('pipe_')).toBe(true)
    // 授权档 auto（coding 需 exec 层跑测试）
    expect(sessionState.approvalModes.every((m) => m.mode === 'auto')).toBe(true)
    // pins 释放（每阶段结算一次）
    expect(sessionState.releasedPins).toHaveLength(4)
  })

  it('objective 解析序：运行级 > 工作流级；planContent 渲染进 prompt；visit 递增', async () => {
    freshState([
      { verdict: 'pass', summary: 'ok' },
      { verdict: 'pass', summary: 'ok' },
    ])
    await runWorkflowInstance({
      runId: 'prun_obj',
      workflow: linearWorkflow,
      planPath,
      workspaceDir: makeWorkspace(),
      runObjective: '运行级目标',
    })
    expect(sessionState.asks[0].content).toContain('运行级目标')
    expect(sessionState.asks[0].content).toContain('计划条目 1')
    expect(sessionState.asks[0].content).not.toContain('工作流级目标')
    // visit 渲染（code 节点 prompt 带 {{visit}}）
    expect(sessionState.asks[0].content).toContain('/ 1')
  })

  it('早停激发：契约缺失 → 同一会话 ask 补契约提示 → 第二回合带契约 → settled', async () => {
    freshState(['none', { verdict: 'pass', summary: '补交契约' }, { verdict: 'pass', summary: 'ok' }])
    const result = await runWorkflowInstance({
      runId: 'prun_cont',
      workflow: linearWorkflow,
      planPath,
      workspaceDir: makeWorkspace(),
    })
    expect(result.status).toBe('success')
    // 首回合无契约 → 激发一次（第一阶段的第二次 ask 含契约缺失语义）
    expect(sessionState.asks[1].content).toContain('PIPELINE_RESULT')
    expect(sessionState.asks[1].content).toContain('没有正确结束')
  })

  it('激发超限：maxStageContinues=1 且始终无契约 → 阶段失败 → 实例失败', async () => {
    freshState(['none', 'none', 'none'])
    const workflow = { ...linearWorkflow, params: { ...linearWorkflow.params, maxStageContinues: 1 } }
    const result = await runWorkflowInstance({
      runId: 'prun_stall',
      workflow,
      planPath,
      workspaceDir: makeWorkspace(),
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('早停')
    // 第一阶段 ask 了 2 次（首次 + 1 次激发）
    expect(sessionState.asks).toHaveLength(2)
  })

  it('队列顺序排队 + 失败不挡后续：第一条实例 FAILED，第二条仍会跑', async () => {
    freshState([
      { verdict: 'fail', summary: '修不好' }, // 第一条：code fail → 无出边 → FAILED
      { verdict: 'pass', summary: 'ok' },
      { verdict: 'pass', summary: 'ok' },
    ])
    const started = pipelineEngine.start('prun_q1', {
      runId: 'prun_q1',
      workflow: linearWorkflow,
      planPath,
      workspaceDir: makeWorkspace(),
    })
    pipelineEngine.start('prun_q2', {
      runId: 'prun_q2',
      workflow: linearWorkflow,
      planPath,
      workspaceDir: makeWorkspace(),
    })
    expect(started).toBe(true)
    // 轮询直到队列排空（两条 run 都结算）
    for (let i = 0; i < 100; i++) {
      const q1 = runRows.get('prun_q1')
      const q2 = runRows.get('prun_q2')
      if (q1?.status !== 'running' && q2?.status !== 'running') break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(runRows.get('prun_q1')?.status).toBe('failed')
    expect(runRows.get('prun_q2')?.status).toBe('success')
  }, 15_000)

  it('maxVisits 耗尽 → 实例失败（防死循环）', async () => {
    // code pass → test/fix 互转永不 pass：visit 计数在上限 3 处斩断循环
    freshState([
      { verdict: 'pass', summary: 'ok' },
      { verdict: 'fail', summary: '挂' },
      { verdict: 'fail', summary: '挂' },
      { verdict: 'fail', summary: '挂' },
      { verdict: 'fail', summary: '挂' },
      { verdict: 'fail', summary: '挂' },
      { verdict: 'fail', summary: '挂' },
    ])
    const workflow = linearWorkflow
    const result = await runWorkflowInstance({
      runId: 'prun_loop',
      workflow,
      planPath,
      workspaceDir: makeWorkspace(),
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('访问达上限')
  })

  it('git checkpoint：脏仓库拒跑；FAILED 回滚基线（提交链消失）；DONE 保留提交', async () => {
    const dirty = mkdtempSync(join(tmpdir(), 'pm-pipeline-dirty-'))
    writeFileSync(join(dirty, 'PLAN.md'), '计划条目 1：实现 X')
    gitRepo(dirty, true)
    freshState([
      { verdict: 'pass', summary: 'ok' },
      { verdict: 'pass', summary: 'ok' },
    ])
    const gate = await runWorkflowInstance({
      runId: 'prun_dirty',
      workflow: linearWorkflow, // gitCheckpoint false——先换 true 的副本测门
      planPath,
      workspaceDir: dirty,
    })
    expect(gate.status).toBe('success') // gitCheckpoint false 不设门
    const gated = await runWorkflowInstance({
      runId: 'prun_dirty2',
      workflow: { ...linearWorkflow, params: { ...linearWorkflow.params, gitCheckpoint: true } },
      planPath,
      workspaceDir: dirty,
    })
    expect(gated.status).toBe('failed')
    expect(gated.error).toContain('不干净')

    // FAILED 回滚：base 提交之后没有流水线提交留下
    const base = makeWorkspace()
    gitRepo(base)
    const baseline = execSync('git rev-parse HEAD', { cwd: base }).toString().trim()
    freshState([{ verdict: 'fail', summary: '完不成' }])
    await runWorkflowInstance({
      runId: 'prun_rollback',
      workflow: { ...linearWorkflow, params: { ...linearWorkflow.params, gitCheckpoint: true } },
      planPath,
      workspaceDir: base,
    })
    const afterFail = execSync('git rev-parse HEAD', { cwd: base }).toString().trim()
    expect(afterFail).toBe(baseline)

    // DONE 保留提交链
    const done = makeWorkspace()
    gitRepo(done)
    const doneBaseline = execSync('git rev-parse HEAD', { cwd: done }).toString().trim()
    freshState([
      { verdict: 'pass', summary: 'ok' },
      { verdict: 'pass', summary: 'ok' },
    ])
    sessionState.stageTouchDir = done
    await runWorkflowInstance({
      runId: 'prun_done',
      workflow: { ...linearWorkflow, params: { ...linearWorkflow.params, gitCheckpoint: true } },
      planPath,
      workspaceDir: done,
    })
    const afterDone = execSync('git rev-parse HEAD', { cwd: done }).toString().trim()
    expect(afterDone).not.toBe(doneBaseline)
  }, 30_000)
})

describe('pipelineEngine.stop', () => {
  it('stop 句柄命中当前阶段：stopExecution 下发', async () => {
    freshState(['hang'])
    const workflow = linearWorkflow
    pipelineEngine.start('prun_stop', {
      runId: 'prun_stop',
      workflow,
      planPath,
      workspaceDir: makeWorkspace(),
    })
    // 等第一阶段会话铸出来再停
    for (let i = 0; i < 50 && sessionState.created.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    expect(pipelineEngine.stop('prun_stop')).toBe(true)
    // stop 只是钩子；stopExecution 的下发经由 stop 钩子 → 当前阶段会话
    for (let i = 0; i < 100 && sessionState.stopped.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    expect(sessionState.stopped.length).toBeGreaterThan(0)
    // 已结算/未知 run 的 stop 是 no-op
    expect(pipelineEngine.stop('prun_unknown')).toBe(false)
  }, 15_000)
})
