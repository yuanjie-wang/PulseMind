/**
 * The project-instructions protection gate (2026-10-27; extended 2026-10-28):
 * a write/edit to the workspace's .pulsemind/AGENTS.md — AND to the
 * workspace-root AGENTS.md whose body is injected as the read-only fallback —
 * is HELD for approval at every level (「propose the change first」 as a
 * ladder hold), and a spawned sub-agent's attempt settles as a flat rejection
 * (its ladder can never release).
 *
 * isProjectInstructionsPath is the pure predicate (next to projectAgentsPath
 * and rootAgentsPath, which own the paths); the hold/deny split lives in
 * ExecutionFlow's partitionWrites, consumed by BOTH the marking stage
 * (handleToolUseResponse) and the dispatch stage — the wiring scans pin both
 * call sites plus the executor-side resolution they must agree with, and the
 * multi-file path extraction so a `diff --git` section cannot smuggle a
 * protected file past the gate.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isProjectAgentsPath, isProjectInstructionsPath, projectAgentsPath, rootAgentsPath } from '../src/renderer/src/agent/system-prompt-builder'
import { resolveToolFilePath } from '../src/renderer/src/agent/agent-utils'
import { ExecutionFlow } from '../src/renderer/src/agent/engine/execution-flow'
import type { EngineCore } from '../src/renderer/src/agent/engine/engine-core'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

const ROOT = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
const WS = '/Users/demo/项目'

describe('isProjectInstructionsPath', () => {
  it('matches the instructions file in every spelling the model uses', () => {
    expect(isProjectInstructionsPath('.pulsemind/AGENTS.md', WS)).toBe(true)
    expect(isProjectInstructionsPath(`${WS}/.pulsemind/AGENTS.md`, WS)).toBe(true)
    expect(isProjectInstructionsPath(' .pulsemind/AGENTS.md ', WS)).toBe(true)
  })

  it('covers the workspace-root AGENTS.md too (2026-10-28: its body is injected as law)', () => {
    // the root file used to belong to other tools outright; since the
    // read-only fallback its bytes ride the prompt, so an unreviewed write
    // would poison every later session — same ladder, both files.
    expect(isProjectInstructionsPath('AGENTS.md', WS)).toBe(true)
    expect(isProjectInstructionsPath(`${WS}/AGENTS.md`, WS)).toBe(true)
    const winWs = 'C:\\Users\\demo\\proj'
    expect(isProjectInstructionsPath('AGENTS.md', winWs)).toBe(true)
    expect(isProjectInstructionsPath('C:\\Users\\demo\\proj\\AGENTS.md', winWs)).toBe(true)
    expect(rootAgentsPath(WS)).toBe(`${WS}/AGENTS.md`)
  })

  it('normalizes Windows separators on both sides of the comparison', () => {
    const winWs = 'C:\\Users\\demo\\proj'
    expect(isProjectInstructionsPath('.pulsemind\\AGENTS.md', winWs)).toBe(true)
    expect(isProjectInstructionsPath('C:\\Users\\demo\\proj\\.pulsemind\\AGENTS.md', winWs)).toBe(true)
  })

  it('never matches anything else — other .pulsemind files stay writable', () => {
    // scratch space is ENCOURAGED under .pulsemind/tmp — the gate is one file, not one directory
    expect(isProjectInstructionsPath('.pulsemind/tmp/scratch.md', WS)).toBe(false)
    expect(isProjectInstructionsPath('.pulsemind/agents.md', WS)).toBe(false) // case-exact
    expect(isProjectInstructionsPath('AGENTS.md.bak', WS)).toBe(false)
    expect(isProjectInstructionsPath('.pulsemind/AGENTS.md.bak', WS)).toBe(false)
    expect(isProjectInstructionsPath('notes.md', WS)).toBe(false)
  })

  it('no workspace, no gate', () => {
    expect(isProjectInstructionsPath('.pulsemind/AGENTS.md', undefined)).toBe(false)
    expect(isProjectInstructionsPath('AGENTS.md', undefined)).toBe(false)
    expect(isProjectInstructionsPath('', WS)).toBe(false)
  })

  it('resolution matches the executor spelling — ~ passes through unmatched', () => {
    // the read-before-write ledger's same deliberate gap: a ~-spelled path is
    // a different coordinate, and only the main process expands it
    expect(resolveToolFilePath('~/.pulsemind/AGENTS.md', WS)).toBe('~/.pulsemind/AGENTS.md')
    expect(isProjectInstructionsPath('~/.pulsemind/AGENTS.md', WS)).toBe(false)
    expect(projectAgentsPath(WS)).toBe(`${WS}/.pulsemind/AGENTS.md`)
  })
})

describe('isProjectAgentsPath (the /init grant scope)', () => {
  it('matches ONLY .pulsemind/AGENTS.md — never the shared root AGENTS.md', () => {
    expect(isProjectAgentsPath('.pulsemind/AGENTS.md', WS)).toBe(true)
    expect(isProjectAgentsPath(`${WS}/.pulsemind/AGENTS.md`, WS)).toBe(true)
    expect(isProjectAgentsPath('.pulsemind\\AGENTS.md', 'C:\\Users\\demo\\proj')).toBe(true)
    // the grant exists for /init, which writes only the .pulsemind file; the
    // root file's bytes are other tools' law and stay under the normal hold.
    expect(isProjectAgentsPath('AGENTS.md', WS)).toBe(false)
    expect(isProjectAgentsPath(`${WS}/AGENTS.md`, WS)).toBe(false)
    expect(isProjectAgentsPath('.pulsemind/tmp/scratch.md', WS)).toBe(false)
    expect(isProjectAgentsPath('', WS)).toBe(false)
    expect(isProjectAgentsPath('.pulsemind/AGENTS.md', undefined)).toBe(false)
  })
})

// ── Behavioral: the /init window, driven through the real partition ──────
// partitionWrites only reads opts.workspaceDir / spawnSystemPrompt /
// isSpawnedSubAgent / projectInstructionsGrantUntil / opts.approvalMode, so a
// minimal EngineCore stub is enough (execution-flow.test.ts's makeCore is
// heavier than this gate needs).

interface Partitioned { auto: ToolUseBlock[]; held: ToolUseBlock[]; denied: ToolUseBlock[] }

function makeFlow(opts: {
  approvalMode?: 'auto' | 'outside-ask' | 'always-ask'
  spawned?: boolean
  grantUntil?: number
}): { partition: (tools: ToolUseBlock[]) => Partitioned } {
  const core = {
    opts: { workspaceDir: WS, approvalMode: opts.approvalMode ?? 'auto' },
    spawnSystemPrompt: undefined,
    isSpawnedSubAgent: opts.spawned === true,
    projectInstructionsGrantUntil: opts.grantUntil ?? 0,
  } as unknown as EngineCore
  const flow = new ExecutionFlow(core) as unknown as { partitionWrites: (tools: ToolUseBlock[]) => Partitioned }
  return { partition: (tools) => flow.partitionWrites(tools) }
}

const writeCall = (filePath: string, id = 't1'): ToolUseBlock =>
  ({ id, name: 'write', input: { file_path: filePath } }) as unknown as ToolUseBlock

const ACTIVE = (): number => Date.now() + 60_000

describe('/init time window: partitionWrites honors it exactly where intended', () => {
  it('without a window the project file is still held (baseline)', () => {
    const out = makeFlow({}).partition([writeCall('.pulsemind/AGENTS.md')])
    expect(out.held).toHaveLength(1)
    expect(out.auto).toHaveLength(0)
  })

  it('an active window lets .pulsemind/AGENTS.md run in auto mode', () => {
    const out = makeFlow({ grantUntil: ACTIVE() }).partition([writeCall('.pulsemind/AGENTS.md')])
    expect(out.auto).toHaveLength(1)
    expect(out.held).toHaveLength(0)
  })

  it('an expired window holds again', () => {
    const out = makeFlow({ grantUntil: Date.now() - 1 }).partition([writeCall('.pulsemind/AGENTS.md')])
    expect(out.held).toHaveLength(1)
    expect(out.auto).toHaveLength(0)
  })

  it('root AGENTS.md stays held inside the window (scope is one file)', () => {
    const out = makeFlow({ grantUntil: ACTIVE() }).partition([writeCall('AGENTS.md')])
    expect(out.held).toHaveLength(1)
    expect(out.auto).toHaveLength(0)
  })

  it('always-ask keeps asking inside the window (tier hold wins)', () => {
    const out = makeFlow({ approvalMode: 'always-ask', grantUntil: ACTIVE() }).partition([writeCall('.pulsemind/AGENTS.md')])
    expect(out.held).toHaveLength(1)
    expect(out.auto).toHaveLength(0)
  })

  it('a spawned sub-agent is still flat-denied inside the window', () => {
    const out = makeFlow({ spawned: true, grantUntil: ACTIVE() }).partition([writeCall('.pulsemind/AGENTS.md')])
    expect(out.denied).toHaveLength(1)
    expect(out.auto).toHaveLength(0)
  })

  it('a multi-file diff touching ONLY the project file rides the window', () => {
    const diff = [
      'diff --git a/.pulsemind/AGENTS.md b/.pulsemind/AGENTS.md',
      '--- a/.pulsemind/AGENTS.md',
      '+++ b/.pulsemind/AGENTS.md',
      '@@ -1 +1,2 @@',
      ' old',
      '+new',
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1,2 @@',
      ' a',
      '+b',
    ].join('\n')
    const out = makeFlow({ grantUntil: ACTIVE() }).partition([
      { id: 't1', name: 'edit', input: { diff } } as unknown as ToolUseBlock,
    ])
    expect(out.auto).toHaveLength(1)
  })

  it('a multi-file diff that also touches root AGENTS.md stays held', () => {
    const diff = [
      'diff --git a/.pulsemind/AGENTS.md b/.pulsemind/AGENTS.md',
      '--- a/.pulsemind/AGENTS.md',
      '+++ b/.pulsemind/AGENTS.md',
      '@@ -1 +1,2 @@',
      ' old',
      '+new',
      'diff --git a/AGENTS.md b/AGENTS.md',
      '--- a/AGENTS.md',
      '+++ b/AGENTS.md',
      '@@ -1 +1,2 @@',
      ' a',
      '+b',
    ].join('\n')
    const out = makeFlow({ grantUntil: ACTIVE() }).partition([
      { id: 't1', name: 'edit', input: { diff } } as unknown as ToolUseBlock,
    ])
    expect(out.held).toHaveLength(1)
    expect(out.auto).toHaveLength(0)
  })
})

describe('wiring: the partition is shared by marking and dispatch', () => {
  const flow = read('src/renderer/src/agent/engine/execution-flow.ts')

  it('partitionWrites exists and both stages consume it', () => {
    expect(flow).toContain('private partitionWrites(tools: ToolUseBlock[])')
    // marking stage: the ladder takes writes.held instead of the old tier-only shape
    expect(flow).toContain('...writes.held,')
    // dispatch stage: only writes.auto reaches the executor
    expect(flow).toMatch(/if \(writes\.auto\.length > 0\) for \(const t of writes\.auto\) await this\.engine\.toolExecutor\.execWorkspaceTool\(t\)/)
  })

  it('the protected check reads EVERY target path of a call (multi-file diff safe)', () => {
    // file_path alone would let a protected file ride inside a multi-file
    // diff's later section — the extraction must be the all-paths helper.
    expect(flow).toContain('editToolTargetPaths(t.input)')
  })

  it('the sub-agent denial is a flat rejection, not a hold nobody can release', () => {
    expect(flow).toContain('isSpawnedSubAgent')
    expect(flow).toContain('子代理无权修改项目指令文件')
  })

  it('the predicate resolves through the executor coordinate system', () => {
    const executor = read('src/renderer/src/agent/tool-executors.ts')
    // the executor delegates — one resolution, two consumers
    expect(executor).toContain('return resolveToolFilePath(filePath, this.opts.workspaceDir)')
  })

  it('the /init window is wired end to end', () => {
    // the gate reads the engine's deadline and narrows the scope to the
    // .pulsemind file (`every` keeps root AGENTS.md and mixed diffs held)
    expect(flow).toContain('projectInstructionsGrantUntil > Date.now()')
    expect(flow).toContain('isProjectAgentsPath')
    // the engine owns the deadline + the clamped setter
    const engine = read('src/renderer/src/agent/AgentEngine.ts')
    expect(engine).toContain('PROJECT_INSTRUCTIONS_GRANT_MAX_MS')
    expect(engine).toContain('grantProjectInstructionsWrite = (ttlMs: number)')
    expect(engine).toContain('Math.min(Math.max(ttlMs, 0), PROJECT_INSTRUCTIONS_GRANT_MAX_MS)')
    // the remote-client bridge must whitelist it, or the renderer cannot reach it
    const sessionManager = read('src/main/agent/session-manager.ts')
    expect(sessionManager).toContain("case 'grantProjectInstructionsWrite'")
    // /init opens the window BEFORE startLoop, and the TTL lives in the command registry
    const commands = read('src/renderer/src/agent/chat-commands.ts')
    expect(commands).toContain('INIT_PROJECT_INSTRUCTIONS_GRANT_MS = 10 * 60_000')
    const controller = read('src/renderer/src/hooks/useChatController.ts')
    expect(controller).toContain('grantProjectInstructionsWrite(INIT_PROJECT_INSTRUCTIONS_GRANT_MS)')
    expect(controller.indexOf('grantProjectInstructionsWrite(INIT_PROJECT_INSTRUCTIONS_GRANT_MS)'))
      .toBeLessThan(controller.indexOf('engineHandle.startLoop(content, knowledgeBase, forcedSkills)'))
    // the handle awaits creation before the call (no session-not-found race)
    const conversationEngine = read('src/renderer/src/hooks/useConversationEngine.ts')
    expect(conversationEngine).toContain("agentSessionEngineCall(convId, 'grantProjectInstructionsWrite', [ttlMs])")
    expect(conversationEngine).toContain('await window.electronAPI.agentSessionCreate(convId)')
  })
})
