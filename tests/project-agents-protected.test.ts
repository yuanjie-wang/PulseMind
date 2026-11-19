/**
 * The project-instructions gate, AFTER the 2026-11-19 ruling (user
 * 「放开改AGENTS.md的权限」): writes to .pulsemind/AGENTS.md and the
 * workspace-root AGENTS.md are ORDINARY workspace writes — the dedicated
 * hold that asked at every approval level (2026-10-27) and the /init grant
 * window that bypassed it (2026-11-11) are both gone, machinery included
 * (projectInstructionsGrantUntil / grantProjectInstructionsWrite /
 * INIT_PROJECT_INSTRUCTIONS_GRANT_MS / isProjectAgentsPath / the initGrant
 * i18n key). What remains of the gate is ONE arm: a spawned sub-agent's
 * instructions-file write still settles as a flat rejection — its ladder can
 * never release, and an unattended run must not rewrite standing law.
 *
 * isProjectInstructionsPath is the pure predicate (next to projectAgentsPath
 * and rootAgentsPath, which own the paths); the deny split lives in
 * ExecutionFlow's partitionWrites, consumed by BOTH the marking stage
 * (handleToolUseResponse) and the dispatch stage — the wiring scans pin both
 * call sites, the executor-side resolution they must agree with, the
 * multi-file path extraction so a `diff --git` section cannot smuggle a
 * protected file past the denial, and the REMOVAL of the retired grant
 * machinery (negative scans — the point of 2026-11-19 is that it never
 * grows back).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isProjectInstructionsPath, projectAgentsPath, rootAgentsPath } from '../src/renderer/src/agent/system-prompt-builder'
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

  it('covers the workspace-root AGENTS.md too (its body is injected as law)', () => {
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

  it('never matches anything else — other .pulsemind files stay ordinary', () => {
    // scratch space is ENCOURAGED under .pulsemind/tmp — the predicate is one file, not one directory
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

// ── Behavioral: the post-ruling partition, driven through the real code ──
// partitionWrites only reads opts.workspaceDir / spawnSystemPrompt /
// isSpawnedSubAgent / opts.approvalMode, so a minimal EngineCore stub is
// enough (execution-flow.test.ts's makeCore is heavier than this gate needs).

interface Partitioned { auto: ToolUseBlock[]; held: ToolUseBlock[]; denied: ToolUseBlock[] }

function makeFlow(opts: {
  approvalMode?: 'auto' | 'outside-ask' | 'always-ask'
  spawned?: boolean
}): { partition: (tools: ToolUseBlock[]) => Partitioned } {
  const core = {
    opts: { workspaceDir: WS, approvalMode: opts.approvalMode ?? 'auto' },
    spawnSystemPrompt: undefined,
    isSpawnedSubAgent: opts.spawned === true,
  } as unknown as EngineCore
  const flow = new ExecutionFlow(core) as unknown as { partitionWrites: (tools: ToolUseBlock[]) => Partitioned }
  return { partition: (tools) => flow.partitionWrites(tools) }
}

const writeCall = (filePath: string, id = 't1'): ToolUseBlock =>
  ({ id, name: 'write', input: { file_path: filePath } }) as unknown as ToolUseBlock

describe('post-ruling partition: instructions files are ordinary writes', () => {
  it('outside-ask (the default 按需确认) lets BOTH files run free', () => {
    const out = makeFlow({ approvalMode: 'outside-ask' }).partition([
      writeCall('.pulsemind/AGENTS.md', 't1'),
      writeCall('AGENTS.md', 't2'),
    ])
    expect(out.auto).toHaveLength(2)
    expect(out.held).toHaveLength(0)
    expect(out.denied).toHaveLength(0)
  })

  it('auto mode runs them too', () => {
    const out = makeFlow({ approvalMode: 'auto' }).partition([writeCall('.pulsemind/AGENTS.md')])
    expect(out.auto).toHaveLength(1)
  })

  it('always-ask still holds them — the session tier is the only gate left', () => {
    const out = makeFlow({ approvalMode: 'always-ask' }).partition([writeCall('.pulsemind/AGENTS.md')])
    expect(out.held).toHaveLength(1)
    expect(out.auto).toHaveLength(0)
  })

  it('a spawned sub-agent is flat-denied at every level', () => {
    for (const approvalMode of ['auto', 'outside-ask', 'always-ask'] as const) {
      const out = makeFlow({ spawned: true, approvalMode }).partition([writeCall('.pulsemind/AGENTS.md')])
      expect(out.denied).toHaveLength(1)
      expect(out.auto).toHaveLength(0)
    }
  })

  it('a multi-file diff touching instructions + normal files rides free at outside-ask', () => {
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
    const out = makeFlow({ approvalMode: 'outside-ask' }).partition([
      { id: 't1', name: 'edit', input: { diff } } as unknown as ToolUseBlock,
    ])
    expect(out.auto).toHaveLength(1)
  })

  it('a multi-file diff smuggling instructions is denied for a sub-agent', () => {
    // the denial arm still reads EVERY target path, so the protected file
    // cannot hide in a diff's later section
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1,2 @@',
      ' a',
      '+b',
      'diff --git a/AGENTS.md b/AGENTS.md',
      '--- a/AGENTS.md',
      '+++ b/AGENTS.md',
      '@@ -1 +1,2 @@',
      ' old',
      '+new',
    ].join('\n')
    const out = makeFlow({ spawned: true, approvalMode: 'auto' }).partition([
      { id: 't1', name: 'edit', input: { diff } } as unknown as ToolUseBlock,
    ])
    expect(out.denied).toHaveLength(1)
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

  it('the sub-agent denial reads EVERY target path of a call (multi-file diff safe)', () => {
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
})

describe('retired machinery stays retired (negative scans)', () => {
  it('no grant window anywhere in the engine', () => {
    const flow = read('src/renderer/src/agent/engine/execution-flow.ts')
    const engine = read('src/renderer/src/agent/AgentEngine.ts')
    const core = read('src/renderer/src/agent/engine/engine-core.ts')
    for (const src of [flow, engine, core]) {
      expect(src).not.toContain('projectInstructionsGrantUntil')
      expect(src).not.toContain('grantProjectInstructionsWrite')
      expect(src).not.toContain('PROJECT_INSTRUCTIONS_GRANT_MAX_MS')
    }
  })

  it('no grant op on the session bridge or the renderer hooks', () => {
    const sessionManager = read('src/main/agent/session-manager.ts')
    const conversationEngine = read('src/renderer/src/hooks/useConversationEngine.ts')
    const controller = read('src/renderer/src/hooks/useChatController.ts')
    for (const src of [sessionManager, conversationEngine, controller]) {
      expect(src).not.toContain('grantProjectInstructionsWrite')
    }
    expect(controller).not.toContain('INIT_PROJECT_INSTRUCTIONS_GRANT_MS')
    const commands = read('src/renderer/src/agent/chat-commands.ts')
    expect(commands).not.toContain('INIT_PROJECT_INSTRUCTIONS_GRANT_MS')
  })

  it('no grant-scoped predicate and no grant toast in i18n', () => {
    const builder = read('src/renderer/src/agent/system-prompt-builder.ts')
    expect(builder).not.toContain('isProjectAgentsPath')
    expect(builder).not.toContain('propose the change first')
    expect(builder).not.toContain('confirm before the first write')
    expect(read('src/renderer/src/i18n/locales/zh.ts')).not.toContain('initGrant')
    expect(read('src/renderer/src/i18n/locales/en.ts')).not.toContain('initGrant')
  })
})
