/**
 * The verify panel (PLAN-project-ide 刀一, 2026-10-31): the tree column's
 * bottom strip that runs the workspace's own verify commands and turns
 * failures into clickable preview reveals. Two layers, matching the repo's
 * testing discipline:
 *   - `parseTestFailures` as a pure matrix (anchor honesty is the contract:
 *      a line number only ever comes from the runner, never invented);
 *   - wiring scans for the two files whose behavior lives behind a real
 *      shell / the exec bridge (the panel's probe-run-summarize-jump chain,
 *      the tree's toggle + mutual exclusion with the diff strip).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { parseTestFailures, MAX_TEST_FAILURES } = await import('../src/renderer/src/agent/verify-loop')

const ROOT = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

describe('parseTestFailures', () => {
  it('empty output → empty list', () => {
    expect(parseTestFailures('')).toEqual([])
  })

  it('vitest: FAIL suite chain peeled to the file, no invented line', () => {
    const out = [' FAIL  tests/a.test.ts > suite > case one', ' FAIL  tests/a.test.ts > suite > case two', ' Tests  2 failed | 3 passed (5)'].join('\n')
    expect(parseTestFailures(out)).toEqual([{ path: 'tests/a.test.ts' }])
  })

  it('jest: FAIL file token', () => {
    const out = 'FAIL src/b.test.ts\nTests: 1 failed, 2 passed, 3 total'
    expect(parseTestFailures(out)).toEqual([{ path: 'src/b.test.ts' }])
  })

  it('pytest: FAILED strips ::test and - msg', () => {
    const out = 'FAILED tests/test_x.py::test_y - AssertionError: assert 1 == 2'
    expect(parseTestFailures(out)).toEqual([{ path: 'tests/test_x.py' }])
  })

  it('go: file:line from inside each --- FAIL: block; the test NAME is not offered as a path', () => {
    const out = [
      '--- FAIL: TestAuth (0.00s)',
      '    auth_test.go:42: token mismatch',
      '--- FAIL: TestSession (0.00s)',
      '    session_test.go:7: expired',
      'FAIL',
    ].join('\n')
    expect(parseTestFailures(out)).toEqual([
      { path: 'auth_test.go', line: 42 },
      { path: 'session_test.go', line: 7 },
    ])
  })

  it('go: a --- FAIL: block without a printed location contributes nothing', () => {
    const out = '--- FAIL: TestAuth (0.00s)\n    some message\nFAIL'
    expect(parseTestFailures(out)).toEqual([])
  })

  it('rustc: --> file:line:col compile anchors (cargo test failing before tests run)', () => {
    const out = ['error[E0308]: mismatched types', ' --> src/lib.rs:10:5', '  |'].join('\n')
    expect(parseTestFailures(out)).toEqual([{ path: 'src/lib.rs', line: 10 }])
  })

  it('dedupes by path+line and keeps first-appearance order', () => {
    const out = ['FAIL src/a.ts', 'FAIL src/a.ts', 'FAIL src/b.ts', '--> src/a.ts:3:1'].join('\n')
    const got = parseTestFailures(out)
    expect(got).toEqual([{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/a.ts', line: 3 }])
  })

  it('caps at MAX_TEST_FAILURES', () => {
    const out = Array.from({ length: MAX_TEST_FAILURES + 5 }, (_, i) => `FAIL src/f${i}.ts`).join('\n')
    expect(parseTestFailures(out)).toHaveLength(MAX_TEST_FAILURES)
  })

  it('a FAIL line of prose (whitespace token) is rejected; a suite chain peels to its file token', () => {
    expect(parseTestFailures('FAIL this is not a path')).toEqual([])
    expect(parseTestFailures('FAIL  a > b')).toEqual([{ path: 'a' }])
  })
})

describe('verify panel wiring', () => {
  const panel = read('src/renderer/src/components/workbench/VerifyPanel.tsx')
  const tree = read('src/renderer/src/components/workbench/WorkspaceTree.tsx')

  it('panel reuses the shared detection cache and summary (never re-implements them)', () => {
    expect(panel).toContain('detectVerifyCommands(workspaceDir)')
    expect(panel).toContain('summarizeTestOutput(result.output)')
    expect(panel).toContain('parseTestFailures(result.output)')
  })

  it('panel runs through the renderer exec bridge with a raised idle cap', () => {
    expect(panel).toContain('window.electronAPI.execCommandSync(command, workspaceDir, VERIFY_IDLE_TIMEOUT_MS)')
    expect(panel).toContain('VERIFY_IDLE_TIMEOUT_MS = 120_000')
  })

  it('failure rows jump through the same preview-resolution path as every other producer', () => {
    expect(panel).toContain('openInPreviewPane(f.path')
    expect(panel).toContain("{ mode: 'line', line: f.line }")
  })

  it('empty detection renders the honest hint naming the manifests', () => {
    expect(panel).toContain('未检测到验证命令')
    expect(panel).toContain('package.json / Cargo.toml / go.mod / pyproject.toml / Makefile')
  })

  it('tree mounts the strip with a toolbar toggle', () => {
    expect(tree).toContain("import { VerifyPanel } from './VerifyPanel'")
    expect(tree).toContain('<VerifyPanel workspaceDir={workspaceDir}')
    expect(tree).toContain('aria-label="验证"')
  })

  it('strip and diff panel are mutually exclusive — both directions', () => {
    // showDiff closes verify …
    expect(tree).toMatch(/const showDiff = async[\s\S]{0,200}setVerifyOpen\(false\)/)
    // … and opening verify closes the diff. One strip at a time is centralized
    // in closeStrips (2026-10-31 refactor; the verify toggle rides it), so the
    // pin follows the helper, not the old inline setDiffTarget(null).
    expect(tree).toMatch(/const closeStrips = [\s\S]{0,120}setDiffTarget\(null\)[\s\S]{0,160}setVerifyOpen\(false\)/)
    expect(tree).toMatch(/if \(next\) closeStrips\(\)[\s\S]{0,60}setVerifyOpen\(next\)/)
  })

  it('verify strip is hidden in search mode (it would squeeze the result list)', () => {
    expect(tree).toContain('verifyOpen && !searching && workspaceDir != null')
  })
})
