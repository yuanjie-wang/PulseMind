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

import { isProjectInstructionsPath, projectAgentsPath, rootAgentsPath } from '../src/renderer/src/agent/system-prompt-builder'
import { resolveToolFilePath } from '../src/renderer/src/agent/agent-utils'

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
})
