// PLAN-workflow-engine：pipeline-engine 单测（mock agentSessionManager，
// routine-run-context.test.ts 蓝本）。钉：coding 模板全路径（fail→fix 闭环、
// maxVisits 耗尽）、早停激发→补契约、激发超限、队列顺序与失败不挡后续、
// objective 解析序（运行级>工作流级）、脏仓库拒跑、FAILED 回滚基线、DONE
// 保留提交链、stop 句柄、授权档 'auto' 落列、阶段会话 pipe_ 前缀。

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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
  /** 每次ask 消费一个剧本项：'none' = 无契约行，否则是该 verdict 的契约行；
   *  finish = 模拟模型调用了 finish_stage（引擎记录的完成契约），text 是那一轮
   *  的可见正文（可故意再放一条不同的 PIPELINE_RESULT 验证记录优先）。 */
  script: [] as Array<
    'none' | 'hang'
    | { verdict: string; summary: string; artifacts?: string[] }
    | { finish: { verdict: string; summary: string; artifacts?: string[]; notes?: string }; text?: string }
  >,
  /** 阶段会话的 finish_stage 记录（sessionId → 契约），getStageFinishRecord 的读面。 */
  stageFinishRecords: new Map<string, { verdict: string; summary: string; artifacts?: string[]; notes?: string }>(),
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
      let text: string
      if (typeof item === 'object' && 'finish' in item) {
        // 阶段完成协议：工具调用的记录落在会话上，正文可以什么都没有（甚至
        // 故意带一条不同 verdict 的文本契约，用来验证结算优先读工具记录）。
        // 真实的 record 来 validateStageFinishArgs，artifacts 永远是数组。
        sessionState.stageFinishRecords.set(sessionId, { artifacts: [], ...item.finish })
        text = item.text ?? '已调用 finish_stage 声明阶段完成。'
      } else {
        text = item === 'none' ? '随便说两句，没有契约行。' : contractLine(item)
      }
      // ask 即回合；回合完 → completed 事件（契约结算面）。下一个 tick，
      // 让 runStage 的事件订阅先挂上。
      await new Promise((r) => setTimeout(r, 10))
      // 顺序是承重的：completed 事件是同步派发给订阅者的，settleStage 当场
      // 读 history()——lastAnswer 必须先写，否则读到的是上一回合的正文（契约
      // 缺失 → 早停激发臂多发一条追问）。
      sessionState.lastAnswer = text
      emit(sessionId, { type: 'status', status: 'completed' })
    },
    history: async () => ({
      messages: [{ role: 'assistant', contentBlocks: [{ type: 'text', text: sessionState.lastAnswer ?? '' }] }],
      agentId: 'default',
    }),
    // 阶段完成协议（2026-11-11）：结算面先读 finish_stage 记录。真实实现挂在
    // 会话引擎上；这里用剧本写入的 map 代替。
    getStageFinishRecord: (sessionId: string) => sessionState.stageFinishRecords.get(sessionId) ?? null,
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
  // P1 任务共享内核：阶段会话的模型 pin 走共享 resolver（仅 pin 存在时调用）。
  setConversationProfile: vi.fn(),
}))
vi.mock('../src/main/storage/conversation-workspace', () => ({
  resolveConversationWorkspace: vi.fn(async (convId: string) => `/tmp/pm-ws-${convId}`),
}))
const runRows = new Map<string, { status: string; currentNode?: string; error?: string; baselineCommit?: string }>()
const stageRows: Array<{ runId: string; nodeId: string }> = []
/** 续跑用例的读面：`listStagesOf(前一次 runId)` 返回这些行（其余 runId 空）。
 *  真实 store 按 runId 过滤；这里只服务「续跑播种」这一组用例。 */
let priorStages: Array<{ nodeId: string; verdict?: string; summary?: string; artifacts?: string[]; error?: string }> = []
vi.mock('../src/main/storage/pipeline-run-store', () => ({
  pipelineRunStore: {
    createRun: vi.fn((run: { id: string; workflowName?: string; batchId?: string }) => {
      // 结算通知（2026-11-18）读的是**落库行**（workflowName 进标题、batchId
      // 决定静默），所以假 store 也得存这两列，否则那条分支永远测不到。
      runRows.set(run.id, { status: 'running', workflowName: run.workflowName, batchId: run.batchId })
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
    listStagesOf: vi.fn(() => priorStages),
    getRun: vi.fn((id: string) => runRows.get(id) ?? null),
  },
}))
// 桌面通知（2026-11-18）：实例结算时发一条，批量实例静默。真实实现 import
// electron（通知窗），测试进程只认调用面。
vi.mock('../src/main/system/notify', () => ({ notify: vi.fn() }))

import { pipelineEngine, runWorkflowInstance } from '../src/main/pipeline/pipeline-engine'
import { pipelineRunStore } from '../src/main/storage/pipeline-run-store'
import { notify } from '../src/main/system/notify'
import { resolveWorkflowHandoff } from '../src/shared/workflow/handoff'

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

function freshState(script: Array<
  'none' | { verdict: string; summary: string; artifacts?: string[] }
  | { finish: { verdict: string; summary: string; artifacts?: string[] }; text?: string }
>): void {
  sessionState.sinks.clear()
  sessionState.created.length = 0
  sessionState.asks.length = 0
  sessionState.stopped.length = 0
  sessionState.releasedPins.length = 0
  sessionState.approvalModes.length = 0
  sessionState.script = [...script]
  sessionState.stageFinishRecords.clear()
  sessionState.stageTouchDir = ''
  sessionState.lastAnswer = ''
  runRows.clear()
  stageRows.length = 0
  priorStages = []
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

  it('自定义输入变量：vars 渲染进 prompt；plan 缺省 = 空态渲染、不读盘', async () => {
    freshState([
      { verdict: 'pass', summary: 'ok' },
      { verdict: 'pass', summary: 'ok' },
    ])
    const workflow = {
      ...linearWorkflow,
      inputs: [{ key: 'target_lang', label: '目标语言', required: true }],
      nodes: [
        { id: 'code', title: '编码', prompt: '译成 {{target_lang}} 第 {{row}} 行；plan={{planContent}}', verdicts: ['pass', 'fail'] },
        ...linearWorkflow.nodes.slice(1),
      ],
    }
    const result = await runWorkflowInstance({
      runId: 'prun_vars',
      workflow,
      // 无 planPath：plan 不再是硬性前置（user 2026-11-08 二期）
      workspaceDir: makeWorkspace(),
      vars: { target_lang: '日语' },
      row: '7',
    })
    expect(result.status).toBe('success')
    expect(sessionState.asks[0].content).toContain('译成 日语')
    expect(sessionState.asks[0].content).toContain('第 7 行')
    expect(sessionState.asks[0].content).toContain('plan=（未提供 plan 内容）')
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

  it('回边重入仍受 maxVisits 兜底（pass 出口也能构成循环）', async () => {
    // 简化模型只有 pass 出口，A⇄B 互指就是可达的循环：forceEnqueue 反复重入，
    // visits 是唯一的闸门。
    const workflow = {
      ...linearWorkflow,
      entry: 'a',
      nodes: [
        { id: 'a', title: 'a', prompt: '节点A', verdicts: ['pass'] },
        { id: 'b', title: 'b', prompt: '节点B', verdicts: ['pass'] },
      ],
      edges: [
        { from: 'a', when: 'pass', to: 'b' },
        { from: 'a', when: 'pass', to: 'DONE' },
        { from: 'b', when: 'pass', to: 'a' },
      ],
    }
    freshState(Array.from({ length: 12 }, () => ({ verdict: 'pass', summary: 'ok' })))
    const result = await runWorkflowInstance({
      runId: 'prun_back',
      workflow,
      planPath,
      workspaceDir: makeWorkspace(),
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('访问达上限')
  })

  it('扇出：A→{B,C} 各自到 DONE 都跑；asks 序 A,B,C 且 success', async () => {
    const workflow = {
      ...linearWorkflow,
      entry: 'a',
      nodes: [
        { id: 'a', title: 'a', prompt: '节点A', verdicts: ['pass'] },
        { id: 'b', title: 'b', prompt: '节点B', verdicts: ['pass'] },
        { id: 'c', title: 'c', prompt: '节点C', verdicts: ['pass'] },
      ],
      edges: [
        { from: 'a', when: 'pass', to: 'b' },
        { from: 'a', when: 'pass', to: 'c' },
        { from: 'b', when: 'pass', to: 'DONE' },
        { from: 'c', when: 'pass', to: 'DONE' },
      ],
    }
    freshState([
      { verdict: 'pass', summary: 'a 完成' },
      { verdict: 'pass', summary: 'b 完成' },
      { verdict: 'pass', summary: 'c 完成' },
    ])
    const result = await runWorkflowInstance({
      runId: 'prun_fan',
      workflow,
      planPath,
      workspaceDir: makeWorkspace(),
    })
    expect(result.status).toBe('success')
    expect(sessionState.asks).toHaveLength(3)
    // 两条分支都要跑（旧实现只走第一条出边，C 会被静默丢弃）。
    expect(sessionState.asks[0].content).toContain('节点A')
    expect(sessionState.asks[1].content).toContain('节点B')
    expect(sessionState.asks[2].content).toContain('节点C')
  })

  it('汇聚（AND-join）：A→{B,C}、B→D、C→D，D 只跑一次且 prompt 含两条分支摘要', async () => {
    const workflow = {
      ...linearWorkflow,
      entry: 'a',
      nodes: [
        { id: 'a', title: 'a', prompt: '节点A', verdicts: ['pass'] },
        { id: 'b', title: 'b', prompt: '节点B', verdicts: ['pass'] },
        { id: 'c', title: 'c', prompt: '节点C', verdicts: ['pass'] },
        { id: 'd', title: 'd', prompt: '节点D：prev={{prevVerdict}} / {{prevSummary}}', verdicts: ['pass'] },
      ],
      edges: [
        { from: 'a', when: 'pass', to: 'b' },
        { from: 'a', when: 'pass', to: 'c' },
        { from: 'b', when: 'pass', to: 'd' },
        { from: 'c', when: 'pass', to: 'd' },
        { from: 'd', when: 'pass', to: 'DONE' },
      ],
    }
    freshState([
      { verdict: 'pass', summary: 'a 完成' },
      { verdict: 'pass', summary: 'b 分支结论' },
      { verdict: 'pass', summary: 'c 分支结论' },
      { verdict: 'pass', summary: 'd 汇合' },
    ])
    const result = await runWorkflowInstance({
      runId: 'prun_join',
      workflow,
      planPath,
      workspaceDir: makeWorkspace(),
    })
    expect(result.status).toBe('success')
    // D 只跑一次（4 次 ask，不是 5 次：d 被两条入边各触发一次就该去重）。
    expect(sessionState.asks).toHaveLength(4)
    const dPrompt = sessionState.asks[3].content
    expect(dPrompt).toContain('节点D')
    expect(dPrompt).toContain('b 分支结论')
    expect(dPrompt).toContain('c 分支结论')
    // 多上游的 prevVerdict 去重后 join（两边都是 pass → 'pass'）。
    expect(dPrompt).toContain('prev=pass /')
  })

  it('长分支汇聚：A→B→B2、C→D、B2→D，D 等 C 与 B2 都结算才跑（asks 序 A,B,C,B2,D）', async () => {
    // 这个形态正是「层深比较判回边」的误判现场：D 的 BFS 层深被短分支 C→D
    // 压成 2，B2 也是 2——按层深 B2→D 会被当回边、跳过依赖门，D 提前跑。
    const workflow = {
      ...linearWorkflow,
      entry: 'a',
      nodes: [
        { id: 'a', title: 'a', prompt: '节点A', verdicts: ['pass'] },
        { id: 'b', title: 'b', prompt: '节点B', verdicts: ['pass'] },
        { id: 'b2', title: 'b2', prompt: '节点B2', verdicts: ['pass'] },
        { id: 'c', title: 'c', prompt: '节点C', verdicts: ['pass'] },
        { id: 'd', title: 'd', prompt: '节点D', verdicts: ['pass'] },
      ],
      edges: [
        { from: 'a', when: 'pass', to: 'b' },
        { from: 'a', when: 'pass', to: 'c' },
        { from: 'b', when: 'pass', to: 'b2' },
        { from: 'c', when: 'pass', to: 'd' },
        { from: 'b2', when: 'pass', to: 'd' },
        { from: 'd', when: 'pass', to: 'DONE' },
      ],
    }
    freshState([
      { verdict: 'pass', summary: 'a' },
      { verdict: 'pass', summary: 'b' },
      { verdict: 'pass', summary: 'c' },
      { verdict: 'pass', summary: 'b2' },
      { verdict: 'pass', summary: 'd' },
    ])
    const result = await runWorkflowInstance({
      runId: 'prun_long',
      workflow,
      planPath,
      workspaceDir: makeWorkspace(),
    })
    expect(result.status).toBe('success')
    const order = sessionState.asks.map((a) => /节点([A-Z0-9]+)/.exec(a.content)?.[1])
    expect(order).toEqual(['A', 'B', 'C', 'B2', 'D'])
  })

  it('死锁：前向上游含不可达节点 → failed 且 error 含「等待上游」', async () => {
    // c 从 entry 不可达（validate 只 warning），b 却声称等 c——队列抽空时
    // b 的上游永远凑不齐，必须响亮失败而不是静默 success。
    const workflow = {
      ...linearWorkflow,
      entry: 'a',
      nodes: [
        { id: 'a', title: 'a', prompt: '节点A', verdicts: ['pass'] },
        { id: 'b', title: 'b', prompt: '节点B', verdicts: ['pass'] },
        { id: 'c', title: 'c', prompt: '节点C', verdicts: ['pass'] },
      ],
      edges: [
        { from: 'a', when: 'pass', to: 'b' },
        { from: 'c', when: 'pass', to: 'b' },
        { from: 'b', when: 'pass', to: 'DONE' },
      ],
    }
    freshState([{ verdict: 'pass', summary: 'a' }])
    const result = await runWorkflowInstance({
      runId: 'prun_dead',
      workflow,
      planPath,
      workspaceDir: makeWorkspace(),
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('等待上游')
    expect(result.error).toContain('c')
  })

  it('条件分支：没走到的对侧分支整支跳过，不算死锁（user 2026-11-09 结果状态）', async () => {
    // a 有 pass/fail 两个出口，agent 报 pass → 只有 b 那支跑；c 支没被走到，
    // 它的前向上游（a）已经结清了——不能再算「等待上游」。
    const workflow = {
      ...linearWorkflow,
      entry: 'a',
      nodes: [
        { id: 'a', title: 'a', prompt: '节点A', verdicts: ['pass', 'fail'] },
        { id: 'b', title: 'b', prompt: '节点B', verdicts: ['pass'] },
        { id: 'c', title: 'c', prompt: '节点C', verdicts: ['pass'] },
      ],
      edges: [
        { from: 'a', when: 'pass', to: 'b' },
        { from: 'a', when: 'fail', to: 'c' },
        { from: 'b', when: 'pass', to: 'DONE' },
        { from: 'c', when: 'pass', to: 'DONE' },
      ],
    }
    freshState([{ verdict: 'pass', summary: 'a 通过' }, { verdict: 'pass', summary: 'b 完成' }])
    const result = await runWorkflowInstance({ runId: 'prun_branch', workflow, planPath, workspaceDir: makeWorkspace() })
    expect(result.status).toBe('success')
    const order = sessionState.asks.map((a) => /节点([A-Z0-9]+)/.exec(a.content)?.[1])
    expect(order).toEqual(['A', 'B']) // C 不跑，也不算死锁
  })

  it('条件分支 + 汇聚：跳过的分支不再锁住 AND-join 的汇入节点', async () => {
    // a|pass→b、a|fail→c、b→d、c→d、d→DONE。a 报 pass ⇒ c 整支跳过，d 的
    // 前向依赖 {b,c} 里 c 那一条随跳过解锁，d 拿到 b 的上下文后照常跑。
    const workflow = {
      ...linearWorkflow,
      entry: 'a',
      nodes: [
        { id: 'a', title: 'a', prompt: '节点A', verdicts: ['pass', 'fail'] },
        { id: 'b', title: 'b', prompt: '节点B', verdicts: ['pass'] },
        { id: 'c', title: 'c', prompt: '节点C', verdicts: ['pass'] },
        { id: 'd', title: 'd', prompt: '节点D：{{prevSummary}}', verdicts: ['pass'] },
      ],
      edges: [
        { from: 'a', when: 'pass', to: 'b' },
        { from: 'a', when: 'fail', to: 'c' },
        { from: 'b', when: 'pass', to: 'd' },
        { from: 'c', when: 'pass', to: 'd' },
        { from: 'd', when: 'pass', to: 'DONE' },
      ],
    }
    freshState([
      { verdict: 'pass', summary: 'a 通过' },
      { verdict: 'pass', summary: 'b 完成' },
      { verdict: 'pass', summary: 'd 完成' },
    ])
    const result = await runWorkflowInstance({ runId: 'prun_join_skip', workflow, planPath, workspaceDir: makeWorkspace() })
    expect(result.status).toBe('success')
    const order = sessionState.asks.map((a) => /节点([A-Z0-9]+)/.exec(a.content)?.[1])
    expect(order).toEqual(['A', 'B', 'D'])
    // d 的上游上下文只有 b 那一条（跳过的分支不留空壳）。
    expect(sessionState.asks[2].content).toContain('b 完成')
  })

  it('出口词汇表注入：自定义状态进阶段 prompt，默认单 pass 一个字节都不加', async () => {
    const custom = {
      ...linearWorkflow,
      entry: 'a',
      nodes: [
        { id: 'a', title: 'a', prompt: '节点A', verdicts: ['成功', '需修订'] },
        { id: 'b', title: 'b', prompt: '节点B', verdicts: ['pass'] },
      ],
      edges: [
        { from: 'a', when: '成功', to: 'b' },
        { from: 'b', when: 'pass', to: 'DONE' },
      ],
    }
    freshState([{ verdict: '成功', summary: 'ok' }, { verdict: 'pass', summary: 'ok' }])
    const result = await runWorkflowInstance({ runId: 'prun_vocab', workflow: custom, planPath, workspaceDir: makeWorkspace() })
    expect(result.status).toBe('success')
    // 阶段 prompt 是模型唯一的规格来源：合法状态 + 契约行模板（示例取首个
    // 状态，绝不给出词汇表之外的值）。
    expect(sessionState.asks[0].content).toContain('本阶段的结果状态只能取：成功 / 需修订')
    expect(sessionState.asks[0].content).toContain('PIPELINE_RESULT: {"verdict":"成功"')
    // 默认单出口的节点不加噪音（内置模板的 prompt 逐字不变）。
    expect(sessionState.asks[1].content).not.toContain('PIPELINE_RESULT')
    expect(sessionState.asks[1].content).not.toContain('结果状态只能取')
    // 完成协议进阶段 prompt：主通道是 finish_stage 工具，文本契约只作兜底。
    expect(sessionState.asks[0].content).toContain('finish_stage')
    expect(sessionState.asks[0].content).toContain('如果工具不可用')
    // 默认单出口的节点没有完成协议噪音（词汇表注记），但 handoff 契约照常注入
    // （PLAN-workflow-context：它提到 finish_stage 只是「先写交接再 finish」的
    // 顺序承诺，不是词汇表噪音）。
    expect(sessionState.asks[1].content).toContain('finish_stage` 之前')
    expect(sessionState.asks[1].content).toContain('交接文件')
    // 阶段会话的 createSession 带着本节点的出口词汇表（工具 schema 的 enum 源）。
    expect(sessionState.created[0].opts.stageFinish).toEqual({ verdicts: ['成功', '需修订'] })
    expect(sessionState.created[1].opts.stageFinish).toEqual({ verdicts: ['pass'] })
  })

  it('阶段完成协议：finish_stage 记录是主通道，正文里的另一条契约不抢结算', async () => {
    // 模型同一回合既调了工具（成功）又在正文里写了一条不同的 PIPELINE_RESULT
    // （需修订）：结算必须走工具记录——参数过了 schema + 词汇表双重校验，
    // 正文只是散文。走错这里就是不报错的分支错投。
    const custom = {
      ...linearWorkflow,
      entry: 'a',
      nodes: [
        { id: 'a', title: 'a', prompt: '节点A', verdicts: ['成功', '需修订'] },
        { id: 'b', title: 'b', prompt: '节点B', verdicts: ['pass'] },
        { id: 'c', title: 'c', prompt: '节点C', verdicts: ['pass'] },
      ],
      edges: [
        { from: 'a', when: '成功', to: 'b' },
        { from: 'a', when: '需修订', to: 'c' },
        { from: 'b', when: 'pass', to: 'DONE' },
        { from: 'c', when: 'pass', to: 'DONE' },
      ],
    }
    freshState([
      {
        finish: { verdict: '成功', summary: '工具记录：通过' },
        text: contractLine({ verdict: '需修订', summary: '正文契约：要改' }),
      },
      { verdict: 'pass', summary: 'ok' },
    ])
    const result = await runWorkflowInstance({ runId: 'prun_finish_priority', workflow: custom, planPath, workspaceDir: makeWorkspace() })
    expect(result.status).toBe('success')
    expect(sessionState.asks).toHaveLength(2)
    expect(sessionState.asks[1].content).toContain('节点B')
    expect(sessionState.asks[1].content).not.toContain('节点C')
  })

  it('阶段完成协议：记录越表时接受合法文本兜底，激发话术点名 finish_stage', async () => {
    // 工作流在运行中被改了词汇表：旧记录里的 verdict 越表，但模型按新词汇表
    // 在正文里补了契约。结算不能因为那条陈旧记录永远判失败（激发臂会耗尽）。
    const custom = {
      ...linearWorkflow,
      entry: 'a',
      nodes: [{ id: 'a', title: 'a', prompt: '节点A', verdicts: ['成功'] }],
      edges: [{ from: 'a', when: '成功', to: 'DONE' }],
    }
    freshState([
      { finish: { verdict: '失败', summary: '旧词汇表的记录' } },
      { verdict: '成功', summary: '文本兜底' },
    ])
    const result = await runWorkflowInstance({ runId: 'prun_finish_stale', workflow: custom, planPath, workspaceDir: makeWorkspace() })
    expect(result.status).toBe('success')
    expect(sessionState.asks).toHaveLength(2)
    // 激发话术两个通道都写明：先 finish_stage，工具不可用才退回文本契约。
    expect(sessionState.asks[1].content).toContain('finish_stage')
    expect(sessionState.asks[1].content).toContain('PIPELINE_RESULT')
    expect(sessionState.asks[1].content).toContain('失败')
  })

  it('状态定义进阶段 prompt：每个状态一行「- 名：定义」，没定义的那条只列名', async () => {
    // 光给状态名，模型没有依据判断该报哪一个（user 2026-11-09「定义结果状态时
    // 还需要明确状态定义」）；定义是调度规格的一部分，必须和词汇表同处 prompt。
    const custom = {
      ...linearWorkflow,
      entry: 'a',
      nodes: [
        {
          id: 'a',
          title: 'a',
          prompt: '节点A',
          verdicts: ['成功', '需修订', '卡住'],
          verdictDefs: { 成功: '产物齐备且校验通过', 需修订: '结构没问题但内容要改' },
        },
        { id: 'b', title: 'b', prompt: '节点B', verdicts: ['pass'] },
      ],
      edges: [
        { from: 'a', when: '成功', to: 'b' },
        { from: 'b', when: 'pass', to: 'DONE' },
      ],
    }
    freshState([{ verdict: '成功', summary: 'ok' }, { verdict: 'pass', summary: 'ok' }])
    const result = await runWorkflowInstance({ runId: 'prun_vdefs', workflow: custom, planPath, workspaceDir: makeWorkspace() })
    expect(result.status).toBe('success')
    const ask = sessionState.asks[0].content
    expect(ask).toContain('本阶段的结果状态只能取下面这些，按定义判断该报哪一个：')
    expect(ask).toContain('- 成功：产物齐备且校验通过')
    expect(ask).toContain('- 需修订：结构没问题但内容要改')
    // 没有定义的状态照样列进词汇表（不然它就不是可选的出口了）。
    expect(ask).toContain('- 卡住')
    expect(ask).not.toContain('- 卡住：')
    // 简版那句话在有定义时让位（两套说法并存会让模型两边读）。
    expect(ask).not.toContain('本阶段的结果状态只能取：')
  })

  it('无匹配出边 → fail-safe 失败，报错点名状态与补救动作（不再合成 FAILED 芯片）', async () => {
    const workflow = {
      ...linearWorkflow,
      entry: 'a',
      nodes: [
        { id: 'a', title: 'a', prompt: '节点A', verdicts: ['pass', 'blocked'] },
        { id: 'b', title: 'b', prompt: '节点B', verdicts: ['pass'] },
      ],
      edges: [
        { from: 'a', when: 'pass', to: 'b' },
        { from: 'b', when: 'pass', to: 'DONE' },
      ],
    }
    freshState([{ verdict: 'blocked', summary: '卡住了' }])
    const result = await runWorkflowInstance({ runId: 'prun_noedge', workflow, planPath, workspaceDir: makeWorkspace() })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('blocked')
    expect(result.error).toContain('出口连一条线')
  })

  it('git checkpoint 自动降级（user 2026-11-15「有 git 就用，没有不强制」）：脏仓/非 git 照常运行、baseline 留空；干净仓 FAILED 回滚、DONE 保留提交', async () => {
    // 脏仓：不再拒跑——降级为无快照运行（成功跑完、baseline_commit 留空、
    // 没有任何流水线提交）。
    const dirty = mkdtempSync(join(tmpdir(), 'pm-pipeline-dirty-'))
    writeFileSync(join(dirty, 'PLAN.md'), '计划条目 1：实现 X')
    gitRepo(dirty, true)
    freshState([
      { verdict: 'pass', summary: 'ok' },
      { verdict: 'pass', summary: 'ok' },
    ])
    const gated = await runWorkflowInstance({
      runId: 'prun_dirty2',
      workflow: { ...linearWorkflow, params: { ...linearWorkflow.params, gitCheckpoint: true } },
      planPath,
      workspaceDir: dirty,
    })
    expect(gated.status).toBe('success')
    expect(runRows.get('prun_dirty2')?.baselineCommit ?? null).toBeNull()
    expect(execSync('git log --oneline', { cwd: dirty }).toString()).not.toContain('pipeline(')

    // 非 git 目录：同样照常运行（探测的 spawn 失败路径）
    const notRepo = mkdtempSync(join(tmpdir(), 'pm-pipeline-nonrepo-'))
    writeFileSync(join(notRepo, 'PLAN.md'), '计划条目 1：实现 X')
    freshState([
      { verdict: 'pass', summary: 'ok' },
      { verdict: 'pass', summary: 'ok' },
    ])
    const nonRepo = await runWorkflowInstance({
      runId: 'prun_nonrepo',
      workflow: { ...linearWorkflow, params: { ...linearWorkflow.params, gitCheckpoint: true } },
      planPath,
      workspaceDir: notRepo,
    })
    expect(nonRepo.status).toBe('success')

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

// ── 结算通知（2026-11-18）──
// 工作流往往跑几分钟到几十分钟，用户不会守在运行视图前；但通知也不能变成
// 刷屏源——批量实例静默（一次 CSV 几十行），失败要带原因（用户点开前就知道
// 是哪一步垮的）。判据都在**调用面**：标题里的名称与成败词、正文是否给得出
// 下一步，而不是「通知函数被 import 了」。
//
// 位置承重：必须排在 pipelineEngine.stop 组**之前**（见那组的注释）。
describe('pipelineEngine 结算通知', () => {
  const notifyMock = vi.mocked(notify)
  const waitNotify = async (n: number): Promise<void> => {
    for (let i = 0; i < 100 && notifyMock.mock.calls.length < n; i++) await new Promise((r) => setTimeout(r, 20))
  }

  it('成功结算 → 「工作流完成」+ 名称，正文引导点开', async () => {
    notifyMock.mockClear()
    freshState([{ verdict: 'pass', summary: 'ok' }, { verdict: 'pass', summary: 'ok' }])
    pipelineEngine.start('prun_notify_ok', { runId: 'prun_notify_ok', workflow: linearWorkflow, planPath, workspaceDir: makeWorkspace() })
    await waitNotify(1)
    expect(notifyMock).toHaveBeenCalledTimes(1)
    const [title, body] = notifyMock.mock.calls[0]
    expect(title).toBe('工作流完成：测试流水线')
    expect(body).toBe('点击查看运行结果')
  })

  it('失败结算 → 「工作流失败」+ 名称，正文带失败原因', async () => {
    notifyMock.mockClear()
    freshState([{ verdict: 'fail', summary: '完不成' }])
    pipelineEngine.start('prun_notify_fail', { runId: 'prun_notify_fail', workflow: linearWorkflow, planPath, workspaceDir: makeWorkspace() })
    await waitNotify(1)
    expect(notifyMock).toHaveBeenCalledTimes(1)
    const [title, body] = notifyMock.mock.calls[0]
    expect(title).toBe('工作流失败：测试流水线')
    expect(body.length).toBeGreaterThan(0)
  })

  it('批量实例静默（一次 CSV 几十行不能刷屏）', async () => {
    notifyMock.mockClear()
    freshState([{ verdict: 'pass', summary: 'ok' }, { verdict: 'pass', summary: 'ok' }])
    // enqueue 不建行（建行是 start 的事）：批量铸行时带 batchId，这里照抄。
    pipelineRunStore.createRun({
      id: 'prun_notify_batch',
      workflowId: 'test-flow',
      workflowName: '测试流水线',
      objective: '',
      workspaceDir: '',
      status: 'running',
      startedAt: new Date().toISOString(),
      batchId: 'batch_1',
    })
    pipelineEngine.enqueue('prun_notify_batch', {
      runId: 'prun_notify_batch',
      workflow: linearWorkflow,
      planPath,
      workspaceDir: makeWorkspace(),
    })
    // 等实例真的结算再断言零通知——固定 sleep 会让用例假绿。
    for (let i = 0; i < 100 && runRows.get('prun_notify_batch')?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(runRows.get('prun_notify_batch')?.status).not.toBe('running')
    expect(notifyMock).not.toHaveBeenCalled()
  })
})

// 位置承重：'hang' 阶段永不结算 → runWorkflowInstance 不返回 → 全局单例的
// draining 一直是 true。本组之后不得再放依赖引擎队列真跑起来的用例（后续的
// resume 组直接调 runWorkflowInstance，不经队列，因此不受影响）。
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

// ── 从失败节点续跑（2026-11-18 运行视图「从失败节点续跑」的引擎面）──
// 续跑的全部价值就在「前序阶段的模型调用不白烧」，所以这组用例钉的是调度状态
// 的播种：已结算阶段重放成 done + arrivals + 前向依赖结清，起点节点重新入队，
// 起点自己那条失败行**不播种**（否则它会像真结算一样把下游推起来）。

describe('runWorkflowInstance.resume（续跑播种）', () => {
  it('前序已结算阶段不重跑：只铸起点阶段的会话，成功后正常收口 DONE', async () => {
    freshState([{ verdict: 'pass', summary: '全绿' }])
    priorStages = [
      { nodeId: 'code', verdict: 'pass', summary: '编码完成', artifacts: ['src/x.ts'] },
      { nodeId: 'test', verdict: 'fail', summary: '两个测试挂了', error: '阶段失败' },
    ]
    const result = await runWorkflowInstance({
      runId: 'prun_resume',
      workflow: linearWorkflow,
      planPath,
      workspaceDir: makeWorkspace(),
      resume: { fromRunId: 'prun_prev', nodeId: 'test' },
    })
    expect(result.status).toBe('success')
    // 前序阶段一行都没起（code 的模型调用没有被重复烧）
    expect(stageRows.map((s) => s.nodeId)).toEqual(['test'])
    expect(sessionState.created).toHaveLength(1)
  })

  it('起点自身的失败行不播种：不因前一次的 fail 把实例推进到 fix', async () => {
    freshState([{ verdict: 'pass', summary: '全绿' }])
    // 前一次 test 结算为 fail（它就是用户点的那个失败节点）；若这行被当结算
    // 重放，实例会直接排上 fix 而不重跑 test。
    priorStages = [
      { nodeId: 'code', verdict: 'pass', summary: '编码完成' },
      { nodeId: 'test', verdict: 'fail', summary: '两个测试挂了' },
    ]
    const result = await runWorkflowInstance({
      runId: 'prun_resume2',
      workflow: linearWorkflow,
      planPath,
      workspaceDir: makeWorkspace(),
      resume: { fromRunId: 'prun_prev', nodeId: 'test' },
    })
    expect(result.status).toBe('success')
    expect(stageRows.map((s) => s.nodeId)).toEqual(['test'])
  })

  it('播种的上游上下文真的进 prompt：续跑节点的 {{prevSummary}} 是前序结算的摘要', async () => {
    freshState([
      { verdict: 'pass', summary: '修复完成' },
      { verdict: 'pass', summary: '全绿' },
    ])
    priorStages = [
      { nodeId: 'code', verdict: 'pass', summary: '编码完成' },
      { nodeId: 'test', verdict: 'fail', summary: '两个测试挂了' },
    ]
    const result = await runWorkflowInstance({
      runId: 'prun_resume3',
      workflow: linearWorkflow,
      planPath,
      workspaceDir: makeWorkspace(),
      // 起点是 fix：它的 prompt 吃 {{prevVerdict}} / {{prevSummary}}
      resume: { fromRunId: 'prun_prev', nodeId: 'fix' },
    })
    expect(result.status).toBe('success')
    expect(sessionState.asks[0].content).toContain('fail')
    expect(sessionState.asks[0].content).toContain('两个测试挂了')
    // fix pass → test 重跑（失败节点的下游照常推进），不是整条从 code 重来
    expect(stageRows.map((s) => s.nodeId)).toEqual(['fix', 'test'])
  })
})


// ── PLAN-workflow-context：信封 + handoff 接线 ──

describe('信封接线（composeStagePrompt 替换 renderStagePrompt + stageContractNote）', () => {
  const envelopeWorkflow = {
    id: 'env-flow',
    name: '竞品监控流水线',
    objective: '每周汇总三家竞品的官网价格',
    entry: 'fetch',
    params: { gitCheckpoint: false },
    inputs: [
      { key: 'siteA', label: '竞品A官网', default: 'https://a.com' },
      { key: 'siteB', label: '竞品B官网' },
    ],
    nodes: [
      { id: 'fetch', title: '列出竞品清单', prompt: '抓取清单写入 list.md。', verdicts: ['pass'] },
      { id: 'prices', title: '抓取竞品价格', prompt: '抓取三家价格页写入 prices.csv。', verdicts: ['pass'] },
    ],
    edges: [
      { from: 'fetch', when: 'pass', to: 'prices' },
      { from: 'prices', when: 'pass', to: 'DONE' },
    ],
  }

  beforeEach(() => freshState([]))

  it('信封默认全开：位置声明 / 全局目标 / 运行输入 / 完成方式交接契约全部进 prompt', async () => {
    freshState([{ verdict: 'pass', summary: '清单完成' }, { verdict: 'pass', summary: '价格完成' }])
    const dir = makeWorkspace()
    await runWorkflowInstance({
      runId: 'prun_env',
      workflow: envelopeWorkflow,
      workspaceDir: dir,
      runObjective: '运行级目标',
      vars: { siteA: 'https://a.com', siteB: '' },
    })
    const p1 = sessionState.asks[0].content
    // 位置块 = 承重墙：分工声明 + 阶段序号
    expect(p1).toContain('── 你在这个工作流里的位置 ──')
    expect(p1).toContain('第 1/2 阶段「列出竞品清单」')
    expect(p1).toContain('不要代做')
    expect(p1).toContain('── 全局目标 ──\n运行级目标')
    // 输入块：default 预填 + 缺值标「（未填）」
    expect(p1).toContain('竞品A官网：https://a.com')
    expect(p1).toContain('竞品B官网：（未填）')
    expect(p1).toContain('── 本阶段任务（你只负责这一部分） ──\n抓取清单写入 list.md。')
    expect(p1).toContain('── 完成方式 ──')
    // 交接契约：绝对路径 + 骨架 + 顺序承诺
    expect(p1).toContain(join(dir, '.pulsemind', 'workflows', 'prun_env', 'fetch-handoff.md'))
    expect(p1).toContain('# 列出竞品清单 交接')
    expect(p1).toContain('finish_stage` 之前')
    // 入口节点：上游块整体不渲染（而不是「（无）」）
    expect(p1).not.toContain('上游交接')
    const p2 = sessionState.asks[1].content
    // 隐式上游 = 只给路径 + verdict 释义，不注入 summary 正文
    expect(p2).toContain('── 上游交接 · 来自「列出竞品清单」 ──')
    expect(p2).toContain('verdict：pass')
    expect(p2).toContain('.pulsemind/workflows/prun_env/fetch-handoff.md')
    expect(p2).not.toContain('清单完成')
  })

  it('去重与开关：{{objective}} 省略目标块；context.upstream:false 省略上游块；{{prevSummary}} 仍是全文语义', async () => {
    const custom = {
      ...envelopeWorkflow,
      nodes: [
        { id: 'fetch', title: '列出竞品清单', prompt: '抓取清单。目标：{{objective}}', verdicts: ['pass'] },
        { id: 'prices', title: '抓取竞品价格', prompt: '上游说：{{prevSummary}}', verdicts: ['pass'], context: { upstream: false } },
      ],
    }
    freshState([{ verdict: 'pass', summary: '清单完成' }, { verdict: 'pass', summary: '价格完成' }])
    await runWorkflowInstance({ runId: 'prun_dedup', workflow: custom, workspaceDir: makeWorkspace(), runObjective: '运行级目标' })
    const p1 = sessionState.asks[0].content
    expect(p1).not.toContain('── 全局目标 ──')
    expect(p1).toContain('目标：运行级目标') // 显式占位符替换语义逐字不变
    const p2 = sessionState.asks[1].content
    expect(p2).not.toContain('── 上游交接')
    expect(p2).toContain('上游说：清单完成') // {{prevSummary}} 全文注入语义不变
  })

  it('handoff 兜底回填：模型没写 → 结算回填最小交接（verdict/summary/artifacts/notes）；写了 → 一个字节不碰', async () => {
    const dir = makeWorkspace()
    freshState([{ finish: { verdict: 'pass', summary: '编码完成', artifacts: ['src/a.ts'], notes: '注意：B 接口限速' } }])
    await runWorkflowInstance({ runId: 'prun_bf', workflow: envelopeWorkflow, workspaceDir: dir, runObjective: '目标' })
    const hp = join(dir, '.pulsemind', 'workflows', 'prun_bf', 'fetch-handoff.md')
    expect(existsSync(hp)).toBe(true)
    const text = readFileSync(hp, 'utf-8')
    expect(text).toContain('# 列出竞品清单 交接')
    expect(text).toContain('## 状态\npass')
    expect(text).toContain('编码完成')
    expect(text).toContain('src/a.ts')
    expect(text).toContain('注意：B 接口限速')
    // 模型写了就一个字节都不碰（存在即返回）
    freshState([{ finish: { verdict: 'pass', summary: '第二次运行' } }])
    const dir2 = makeWorkspace()
    const hp2 = join(dir2, '.pulsemind', 'workflows', 'prun_bf2', 'fetch-handoff.md')
    mkdirSync(join(dir2, '.pulsemind', 'workflows', 'prun_bf2'), { recursive: true })
    writeFileSync(hp2, '模型自己写的交接', 'utf-8')
    await runWorkflowInstance({ runId: 'prun_bf2', workflow: envelopeWorkflow, workspaceDir: dir2, runObjective: '目标' })
    expect(readFileSync(hp2, 'utf-8')).toBe('模型自己写的交接')
  })

  it('RETRY 重入：上游 = 上一次自己的交接（块头「本节点第 2 次运行 · 上次交接」）', async () => {
    const retryFlow = {
      id: 'retry-flow',
      name: '重试流',
      entry: 'n1',
      params: { gitCheckpoint: false, defaultMaxVisits: 3 },
      nodes: [{ id: 'n1', title: '试着跑', prompt: '跑一下。', verdicts: ['pass', 'fail'] }],
      edges: [
        { from: 'n1', when: 'pass', to: 'DONE' },
        { from: 'n1', when: 'fail', to: 'RETRY' },
      ],
    }
    freshState([{ verdict: 'fail', summary: '第一次失败' }, { verdict: 'pass', summary: '第二次成功' }])
    await runWorkflowInstance({ runId: 'prun_retry', workflow: retryFlow, workspaceDir: makeWorkspace() })
    const p2 = sessionState.asks[1].content
    expect(p2).toContain('── 上游交接 · 本节点第 2 次运行 · 上次交接 ──')
    expect(p2).toContain('verdict：fail')
    expect(p2).toContain('n1-handoff.md')
  })

  it('handoff 生命周期：超出最近 20 次的 run 目录被清掉，别的工作区的不碰', async () => {
    const dir = makeWorkspace()
    const rows = Array.from({ length: 22 }, (_, i) => ({
      id: `run_old${i}`,
      workspaceDir: dir,
      startedAt: new Date(Date.now() - i * 1000).toISOString(),
    }))
    // 超出保留线但属于**别的工作区**：路径过滤必须挡住它
    rows.push({ id: 'run_elsewhere', workspaceDir: '/elsewhere', startedAt: new Date(Date.now() - 99_000).toISOString() })
    for (const id of ['run_old20', 'run_old21', 'run_elsewhere']) {
      mkdirSync(resolveWorkflowHandoff(dir, id).dir, { recursive: true })
      writeFileSync(join(resolveWorkflowHandoff(dir, id).dir, 'n1-handoff.md'), 'x')
    }
    vi.mocked(pipelineRunStore.listRuns).mockReturnValueOnce(rows as never)
    freshState([{ verdict: 'pass', summary: 'ok' }])
    await runWorkflowInstance({ runId: 'prun_prune', workflow: envelopeWorkflow, workspaceDir: dir, runObjective: '目标' })
    expect(existsSync(resolveWorkflowHandoff(dir, 'run_old20').dir)).toBe(false)
    expect(existsSync(resolveWorkflowHandoff(dir, 'run_old21').dir)).toBe(false)
    expect(existsSync(resolveWorkflowHandoff(dir, 'run_elsewhere').dir)).toBe(true)
    // 本 run 自己是最新一条，在保留线内
    expect(existsSync(resolveWorkflowHandoff(dir, 'prun_prune').dir)).toBe(true)
  })
})
