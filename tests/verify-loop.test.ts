/**
 * The verify loop (2026-10-27 验证闭环): the wiring that closes the gap between
 * "edit succeeded" and "the change works". Four surfaces share one module
 * (agent/verify-loop.ts) and one design rule — every piece is silent outside a
 * project workspace, so an office session ships zero new bytes:
 *   1. `## Verify` state-block section (detected commands, TTL-cached);
 *   2. the source-edit streak soft gate (hint once per session, exec resets);
 *   3. the office_edit spot-check hint (once per session, from batch 2);
 *   4. the test-output summary head on exec results.
 *
 * The soft-gate sections drive the REAL ToolExecutor (soft-gates.test.ts's
 * harness); detection drives the real module against a stub host; the spawn
 * preset and the two exec dispatch points get wiring scans (their behavior is
 * either covered above or lives behind a real shell the suite cannot start).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-verify-loop-'))

const { ToolExecutor } = await import('../src/renderer/src/agent/tool-executors')
const {
  detectVerifyCommands,
  resetVerifyCommandsCache,
  isSourceFilePath,
  isVerifyExecCommand,
  summarizeTestOutput,
  verifyStreakHint,
  VERIFY_STREAK_THRESHOLD,
} = await import('../src/renderer/src/agent/verify-loop')
const { setHost } = await import('../src/renderer/src/agent/host')
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

type HostStub = Record<string, unknown>

/** Host whose readFile serves `files` (absolute paths) and reports the rest
 *  as absent (null). `reads` counts every probe — the detection cache is
 *  pinned against it. */
function fileHost(files: Record<string, string> = {}): { host: HostStub; reads: () => number } {
  let count = 0
  return {
    reads: () => count,
    host: {
      readFile: async (p: string) => {
        count++
        return Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null
      },
    },
  }
}

// ── 1. detectVerifyCommands ───────────────────────────────────────────────

describe('detectVerifyCommands', () => {
  beforeEach(() => resetVerifyCommandsCache())

  it('maps package.json verify scripts, aliasing test to npm test, ignoring the rest', async () => {
    const { host } = fileHost({
      '/ws/package.json': JSON.stringify({
        scripts: { dev: 'vite', build: 'tsc && vite build', test: 'vitest run', lint: 'eslint .', 'test:unit': 'vitest --dir unit' },
      }),
    })
    setHost(host as never)
    // Priority order: test runners first (test, its :variants), then
    // lint/typecheck/check, build last — the cap never drops a test runner
    // in favor of a build script.
    expect(await detectVerifyCommands('/ws')).toEqual(['npm test', 'npm run test:unit', 'npm run lint'])
  })

  it('detects cargo / go / pytest / make from their manifests', async () => {
    const { host } = fileHost({
      '/go/Cargo.toml': '[package]\nname = "x"\n',
      '/go/go.mod': 'module x\n',
      '/go/pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n',
      '/go/Makefile': 'build:\n\tgo build\ntest:\n\tgo test ./...\n',
    })
    setHost(host as never)
    expect(await detectVerifyCommands('/go')).toEqual(['cargo test', 'go test ./...', 'pytest', 'make test'])
  })

  it('caps the rendered list at the per-source limit', async () => {
    const { host } = fileHost({
      '/cap/package.json': JSON.stringify({ scripts: { test: 'a', lint: 'b', check: 'c', typecheck: 'd', 'test:e2e': 'e' } }),
    })
    setHost(host as never)
    const cmds = await detectVerifyCommands('/cap')
    expect(cmds).toHaveLength(3)
    expect(cmds).toContain('npm test')
    expect(cmds).toContain('npm run lint')
    expect(cmds).not.toContain('npm run typecheck')
  })

  it('a workspace with no manifests yields [] — the office case', async () => {
    const { host } = fileHost({})
    setHost(host as never)
    expect(await detectVerifyCommands('/office')).toEqual([])
  })

  it('is TTL-cached per workspace — the state block rebuilds every iteration', async () => {
    const f = fileHost({ '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest' } }) })
    setHost(f.host as never)
    await detectVerifyCommands('/ws')
    const afterFirst = f.reads()
    await detectVerifyCommands('/ws')
    expect(f.reads()).toBe(afterFirst)
    resetVerifyCommandsCache()
    await detectVerifyCommands('/ws')
    expect(f.reads()).toBeGreaterThan(afterFirst)
  })
})

// ── 2. isSourceFilePath / isVerifyExecCommand ─────────────────────────────

describe('isSourceFilePath', () => {
  it('counts code files across the supported extensions', () => {
    for (const p of ['/ws/src/a.ts', '/ws/app.py', '/ws/main.go', '/ws/lib.rs', '/ws/C.java', '/ws/x.vue']) {
      expect(isSourceFilePath(p), p).toBe(true)
    }
  })

  it('excludes non-code, extensionless and scratch-namespace paths', () => {
    for (const p of ['/ws/README.md', '/ws/report.docx', '/ws/data.xlsx', '/ws/Makefile', '/ws/src/noext.d']) {
      expect(isSourceFilePath(p), p).toBe(false)
    }
    expect(isSourceFilePath('/ws/noext')).toBe(false)
    expect(isSourceFilePath('/ws/.pulsemind/tmp/probe.ts')).toBe(false)
    expect(isSourceFilePath('\\ws\\.pulsemind\\tmp\\probe.ts')).toBe(false)
  })
})

describe('isVerifyExecCommand', () => {
  it('matches the verification vocabulary on both exec dispatch paths', () => {
    for (const c of ['npm test', 'npm run lint', 'npm run build', 'pnpm test', 'npx vitest run src', 'pytest -q', 'go test ./...', 'cargo test', 'make check', 'gradlew test', 'tsc --noEmit']) {
      expect(isVerifyExecCommand(c), c).toBe(true)
    }
  })

  it('does not fire on ordinary commands or word-interior matches', () => {
    for (const c of ['ls -la', 'echo done', 'cat package.json', 'git status', 'node -v', 'echo latest']) {
      expect(isVerifyExecCommand(c), c).toBe(false)
    }
  })
})

// ── 3. summarizeTestOutput ────────────────────────────────────────────────

describe('summarizeTestOutput', () => {
  it('reads vitest failure counts and the first failing file', () => {
    const out = [
      ' RUN  v2.1.1 /repo',
      '',
      ' ❯ tests/a.test.ts (4 tests | 3 failed) 0.1s',
      '   × one',
      ' FAIL  tests/a.test.ts > suite > three',
      ' FAIL  tests/b.test.ts > suite > four',
      '',
      ' Test Files  2 failed | 1 passed (3)',
      '      Tests  3 failed | 120 passed | 5 skipped (128)',
    ].join('\n')
    const s = summarizeTestOutput(out)
    expect(s?.line).toBe('Tests: 3 failed, 120 passed · first failure: tests/a.test.ts')
  })

  it('reads jest, pytest (stripping ::test), go (with file:line) and cargo', () => {
    const jest = summarizeTestOutput('FAIL src/a.test.ts\nTests: 3 failed, 120 passed, 128 total')
    expect(jest?.line).toContain('Tests: 3 failed, 120 passed')
    expect(jest?.line).toContain('src/a.test.ts')

    const pytest = summarizeTestOutput('FAILED tests/test_x.py::test_y - AssertionError\n= 3 failed, 120 passed in 2.34s =')
    expect(pytest?.line).toContain('Tests: 3 failed, 120 passed')
    expect(pytest?.line).toContain('tests/test_x.py')
    expect(pytest?.line).not.toContain('test_y')

    const go = summarizeTestOutput('--- FAIL: TestAuth (0.10s)\n    auth_test.go:42: token mismatch\nFAIL\nFAIL\texample.com/x\t0.5s')
    expect(go?.line).toContain('TestAuth')
    expect(go?.line).toContain('auth_test.go:42')

    const cargo = summarizeTestOutput('failures:\n    it_works\ntest result: FAILED. 3 passed; 2 failed; 0 ignored')
    expect(cargo?.line).toContain('Tests: 2 failed, 3 passed')
  })

  it('summarizes green runs and rejects non-test output', () => {
    expect(summarizeTestOutput(' Tests  120 passed (120)')?.line).toBe('Tests: 120 passed')
    expect(summarizeTestOutput('= 120 passed in 0.9s =')?.line).toBe('Tests: 120 passed')
    expect(summarizeTestOutput('test result: ok. 120 passed; 0 failed; 0 ignored')?.line).toBe('Tests: 120 passed')
    expect(summarizeTestOutput('ok      example.com/x\t0.5s')?.line).toContain('go test passed')
    expect(summarizeTestOutput('total 0\nsrc/a.ts 3 KB\n')).toBeNull()
    expect(summarizeTestOutput('')).toBeNull()
  })
})

// ── 4. The source-edit streak gate (real ToolExecutor) ────────────────────

const WS = '/ws'
const PKG = JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } })

let lastResult: { content: string; isError: boolean } | null = null

function makeExecutor(files: Record<string, string> = { [`${WS}/package.json`]: PKG }): InstanceType<typeof ToolExecutor> {
  const { host } = fileHost(files)
  setHost({
    ...host,
    getFileStat: async () => null,
    writeFile: async () => ({ success: true }),
    editFile: async () => ({ success: true, replacements: 1 }),
    patchFile: async () => ({ success: true, replacements: 1 }),
    editDocx: async () => ({ success: true, results: [{ index: 1, op: 'insert_paragraph', ok: true, detail: '段落已插入' }] }),
  } as never)
  const ex = new ToolExecutor(
    { workspaceDir: WS, platformInfo: { platform: 'darwin' } } as never,
    new Map(), {} as never, {} as never, () => {}, () => {},
  )
  ;(ex as unknown as { addToolResult: unknown }).addToolResult = (
    _id: string, content: string, isError: boolean,
  ) => { lastResult = { content, isError } }
  lastResult = null
  return ex
}

const doWrite = async (ex: InstanceType<typeof ToolExecutor>, path: string, content = 'x'): Promise<ToolUseBlock> => {
  const t = { type: 'tool_use', id: 't_w', name: 'write', input: { file_path: path, content }, status: 'queued' } as ToolUseBlock
  await ex.execWorkspaceTool(t)
  return t
}

describe('source-edit streak soft gate', () => {
  beforeEach(() => resetVerifyCommandsCache())

  it('the threshold-crossing source write carries the hint naming the detected commands', async () => {
    const ex = makeExecutor()
    await doWrite(ex, 'a.ts')
    await doWrite(ex, 'b.py')
    const t = await doWrite(ex, 'c.ts')
    expect(t.exitCode).toBe(0)
    expect(lastResult?.isError).toBe(false)
    expect(lastResult?.content).toContain(`${VERIFY_STREAK_THRESHOLD}+ source files edited`)
    expect(lastResult?.content).toContain('`npm test`')
    expect(lastResult?.content).toContain('`npm run lint`')
    // Once per session: a later edit does not repeat it.
    await doWrite(ex, 'd.ts')
    expect(lastResult?.content).not.toContain('source files edited')
  })

  it('non-source writes never count, and a manifest-less workspace disarms the gate', async () => {
    const ex = makeExecutor()
    await doWrite(ex, 'notes.md')
    await doWrite(ex, 'report.docx')
    const t = await doWrite(ex, 'out.md')
    expect(t.exitCode).toBe(0)
    expect(lastResult?.content).not.toContain('source files edited')

    const bare = makeExecutor({}) // no manifests — the office case
    await doWrite(bare, 'a.ts')
    await doWrite(bare, 'b.ts')
    await doWrite(bare, 'c.ts')
    expect(lastResult?.content).not.toContain('source files edited')
  })

  it('a verify-shaped exec resets the streak; an ordinary one does not', async () => {
    const ex = makeExecutor()
    await doWrite(ex, 'a.ts')
    await doWrite(ex, 'b.ts')
    ex.noteVerifyExec('npm test')
    await doWrite(ex, 'c.ts')
    expect(lastResult?.content).not.toContain('source files edited')

    const ex2 = makeExecutor()
    await doWrite(ex2, 'a.ts')
    await doWrite(ex2, 'b.ts')
    ex2.noteVerifyExec('ls -la')
    const t = await doWrite(ex2, 'c.ts')
    expect(lastResult?.content).toContain('source files edited')
    expect(t.exitCode).toBe(0)
  })

  it('the hint text quotes the workspace commands for one-command recovery', () => {
    expect(verifyStreakHint(['npm test'])).toContain('`npm test`')
  })
})

// ── 5. The office branch (real ToolExecutor + stubbed editor) ─────────────

const officeEdit = async (ex: InstanceType<typeof ToolExecutor>): Promise<ToolUseBlock> => {
  const t = {
    type: 'tool_use', id: 't_oe', name: 'office_edit',
    input: { file_path: 'd.docx', ops: [{ op: 'insert_paragraph', index: 1, text: 'x' }] },
    status: 'queued',
  } as ToolUseBlock
  await ex.execWorkspaceTool(t)
  return t
}

describe('office_edit spot-check hint', () => {
  beforeEach(() => resetVerifyCommandsCache())

  it('fires once per session from the SECOND successful batch', async () => {
    const ex = makeExecutor()
    const first = await officeEdit(ex)
    expect(first.exitCode).toBe(0)
    expect(lastResult?.content).not.toContain('office_read')
    const second = await officeEdit(ex)
    expect(second.exitCode).toBe(0)
    expect(lastResult?.content).toContain('spot-check the affected')
    expect(lastResult?.content).toContain('office_read')
    await officeEdit(ex)
    expect(lastResult?.content).not.toContain('spot-check the affected')
  })
})

// ── 6. formatExecResult's test head ───────────────────────────────────────

describe('formatExecResult test summary', () => {
  beforeEach(() => resetVerifyCommandsCache())

  it('prepends the one-line summary to a matching exec result, output stays verbatim', () => {
    const ex = makeExecutor()
    const out = ex.formatExecResult(1, ' FAIL  tests/a.test.ts > suite > x\n Tests  2 failed | 7 passed', '')
    expect(out).toContain('Tests: 2 failed, 7 passed')
    expect(out).toContain('first failure: tests/a.test.ts')
    expect(out.indexOf('Tests:')).toBeLessThan(out.indexOf('--- stdout ---'))
    expect(out).toContain('FAIL  tests/a.test.ts')
  })

  it('non-test output is byte-identical to the plain format', () => {
    const ex = makeExecutor()
    const raw = ex.formatExecResult(0, 'hello\nworld', 'warn')
    expect(raw).toContain('Exit Code: 0')
    expect(raw).not.toContain('Tests:')
  })
})

// ── 7. Wiring scans — the dispatch points the suite cannot start ──────────

const ROOT = join(process.cwd(), 'src', 'renderer', 'src')

describe('wiring scans', () => {
  const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

  it('both exec dispatch points reset the streak', () => {
    expect(read('agent/executors/domain-tools.ts')).toContain('ex.noteVerifyExec?.(command)')
    expect(read('agent/engine/execution-flow.ts')).toContain('noteVerifyExec?.(resolvedCommand)')
  })

  it('the write/edit surfaces feed the streak and office_edit its own branch', () => {
    const src = read('agent/tool-executors.ts')
    expect(src).toContain('await this.noteSourceEdit(fp, resultText)')
    expect(src).toContain('this.noteOfficeEdit(parts.join')
    expect(src).toContain('summarizeTestOutput(stdout)')
  })

  it('the state block carries the Verify section and spawn reuses detection', () => {
    expect(read('agent/system-prompt-builder.ts')).toContain('buildVerifySection')
    expect(read('agent/executors/spawn-tool.ts')).toContain('detectVerifyCommands(ex.opts.workspaceDir)')
    expect(read('agent/executors/spawn-tool.ts')).toContain('allowedTools: isExplore ? EXPLORE_TOOLSET : undefined')
    expect(read('agent/engine/spawn-manager.ts')).toContain('allowedTools: config.allowedTools')
  })
})
