import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── The edit tool's atomic multi-file form (2026-10-28): a git-style diff
//  with one `diff --git` section per file and NO file_path applies every
//  section or nothing. Three layers are pinned here:
//   1. parseMultiFileDiff — the shared splitter (executor, approval gate and
//      both transcript renderers must never disagree about section bounds);
//   2. the executor branch — the read-before-write gate across the WHOLE set,
//      the isNew existence rule, and the envelope;
//   3. svcPatchFiles — the transaction itself on real fs: mismatch anywhere
//      writes nothing, a write failure rolls back, creates are pure additions.

const { parseMultiFileDiff, patchContent } = await import('../src/shared/diff/patch-utils')

// ── 1. the shared parser ────────────────────────────────────────────────────

const TWO_FILES = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111111..222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' one',
  '-two',
  '+TWO',
  'diff --git a/lib/b.ts b/lib/b.ts',
  '--- a/lib/b.ts',
  '+++ b/lib/b.ts',
  '@@ -3,1 +3,1 @@',
  '-x',
  '+y',
].join('\n')

describe('parseMultiFileDiff', () => {
  it('returns null for a single-file diff — the file_path form, headers ignored', () => {
    expect(parseMultiFileDiff('--- a/f.ts\n+++ b/f.ts\n@@ -1,1 +1,1 @@\n-a\n+b')).toBeNull()
    expect(parseMultiFileDiff('@@ -1,1 +1,1 @@\n-a\n+b')).toBeNull()
  })

  it('splits sections, strips a/ b/ prefixes, drops index/mode lines', () => {
    const sections = parseMultiFileDiff(TWO_FILES)!
    expect(sections.map((s) => s.path)).toEqual(['src/a.ts', 'lib/b.ts'])
    expect(sections.every((s) => !s.isNew && !s.isDelete && !s.isRename)).toBe(true)
    // Each section is self-contained: patchContent applies it on its own file.
    const r = patchContent('one\ntwo', sections[0].diff)
    expect(r.success).toBe(true)
    expect(r.content).toBe('one\nTWO')
  })

  it('--- /dev/null marks a create; +++ /dev/null marks a delete (path from the --- side)', () => {
    const d = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,1 @@',
      '+hello',
      'diff --git a/old.ts b/old.ts',
      'deleted file mode 100644',
      '--- a/old.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-bye',
    ].join('\n')
    const sections = parseMultiFileDiff(d)!
    expect(sections[0]).toMatchObject({ path: 'new.ts', isNew: true, isDelete: false })
    expect(sections[1]).toMatchObject({ path: 'old.ts', isDelete: true, isNew: false })
  })

  it('flags rename sections as unsupported', () => {
    const d = [
      'diff --git a/old.ts b/renamed.ts',
      'similarity index 92%',
      'rename from old.ts',
      'rename to renamed.ts',
      '--- a/old.ts',
      '+++ b/renamed.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
    ].join('\n')
    expect(parseMultiFileDiff(d)![0].isRename).toBe(true)
  })

  it('handles quoted paths and tab-timestamp suffixes', () => {
    const d = [
      'diff --git "a/src/with space.ts" "b/src/with space.ts"',
      '--- "a/src/with space.ts"\t2026-10-28 10:00:00',
      '+++ "b/src/with space.ts"\t2026-10-28 10:00:01',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
    ].join('\n')
    expect(parseMultiFileDiff(d)![0].path).toBe('src/with space.ts')
  })
})

// ── 2. the executor branch (mock host, real ToolExecutor) ─────────────────

// Same HOME sandbox as read-before-write-gate.test.ts — the executor's import
// chain touches real stores and must never write into the live ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-multi-patch-'))

const { ToolExecutor } = await import('../src/renderer/src/agent/tool-executors')
const { setHost } = await import('../src/renderer/src/agent/host')
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

type Stat = { size: number; birthtime: string; mtime: string; isDirectory: boolean }

const disk = new Map<string, Stat>()
let tick = 0
let singleEditCalls = 0
let patchFilesCalls: Array<{ entries: Array<{ filePath: string; diff: string; isNew?: boolean }> }> = []
let patchFilesResult: { success: boolean; replacements: number; error?: string; files?: Array<{ path: string; isNew: boolean }> } = { success: true, replacements: 2 }

const sig = (): Stat => ({
  size: 10,
  birthtime: '2026-10-28T00:00:00.000Z',
  mtime: new Date(1_700_000_000_000 + ++tick * 1_000).toISOString(),
  isDirectory: false,
})
const touch = (p: string): void => disk.set(p, sig())

setHost({
  getFileStat: async (p: string) => disk.get(p) ?? null,
  execCommandSync: async () => ({ code: 0, output: 'line1\nline2' }),
  patchFile: async () => { throw new Error('single-file patchFile must not run in multi-file tests') },
  editFile: async (i: { filePath: string }) => { singleEditCalls++; touch(i.filePath); return { success: true, replacements: 1 } },
  patchFiles: async (i: { entries: Array<{ filePath: string; diff: string; isNew?: boolean }> }) => {
    patchFilesCalls.push(i)
    // A real success bumps every target's mtime — that is what makes the
    // ledger-refresh assertion below observable (a follow-up edit on a
    // target passes only if the entry was refreshed post-patch).
    if (patchFilesResult.success) for (const e of i.entries) touch(e.filePath)
    return patchFilesResult
  },
  writeFile: async (i: { filePath: string }) => { touch(i.filePath); return { success: true } },
  convertFileToMarkdown: async (p: string) => ({ content: 'converted', cachePath: null, hit: false, sourcePath: p }),
} as never)

const WS = '/ws'
let ex: InstanceType<typeof ToolExecutor>

beforeEach(() => {
  disk.clear()
  tick = 0
  patchFilesCalls = []
  singleEditCalls = 0
  patchFilesResult = { success: true, replacements: 2 }
  ex = new ToolExecutor(
    { workspaceDir: WS, platformInfo: { platform: 'darwin' } } as never,
    new Map(), {} as never, {} as never, () => {}, () => {},
  )
})

const block = (name: string, input: Record<string, unknown>): ToolUseBlock =>
  ({ type: 'tool_use', id: `t_${name}_${Math.random().toString(36).slice(2, 8)}`, name, input, status: 'queued' })

const doRead = async (path: string) => {
  const t = block('read', { file_path: path })
  await ex.execReadOnlyTools([t])
  return t
}
const doMultiEdit = async (diff: string) => {
  const t = block('edit', { diff })
  await ex.execWorkspaceTool(t)
  return t
}

describe('multi-file edit: the executor gate', () => {
  const A_RESOLVED = `${WS}/src/a.ts`
  const B_RESOLVED = `${WS}/lib/b.ts`

  it('rejects the whole call when ANY target was never read — naming the unread ones', async () => {
    disk.set(A_RESOLVED, sig())
    disk.set(B_RESOLVED, sig())
    const t = await doMultiEdit(TWO_FILES)
    expect(t.output).toContain('multi-file edit requires a prior read of every target')
    expect(t.output).toContain(`${A_RESOLVED}, ${B_RESOLVED}`)
    expect(t.exitCode).toBe(-1)
    expect(patchFilesCalls).toHaveLength(0)
  })

  it('applies after both targets are read; envelope lists every file; ledger refreshed', async () => {
    disk.set(A_RESOLVED, sig())
    disk.set(B_RESOLVED, sig())
    await doRead('src/a.ts')
    await doRead('lib/b.ts')
    const t = await doMultiEdit(TWO_FILES)
    expect(t.exitCode).toBe(0)
    expect(t.output).toContain('Applied 2 hunk(s) across 2 file(s)')
    expect(t.output).toContain(A_RESOLVED)
    expect(t.output).toContain(B_RESOLVED)
    expect(patchFilesCalls).toHaveLength(1)
    // The call's own mtime bump must not stale-reject the next edit on a
    // target — the post-success refresh ran for every file.
    const follow = block('edit', { file_path: 'src/a.ts', old_str: 'a', new_str: 'b' })
    await ex.execWorkspaceTool(follow)
    expect(follow.exitCode).toBe(0)
    expect(singleEditCalls).toBe(1)
  })

  it('one read is not enough: the read target passes, the unread one still rejects the call', async () => {
    disk.set(A_RESOLVED, sig())
    disk.set(B_RESOLVED, sig())
    await doRead('src/a.ts')
    const t = await doMultiEdit(TWO_FILES)
    expect(t.output).toContain('not yet read')
    expect(t.output).toContain(B_RESOLVED)
    expect(t.output).not.toContain(`${A_RESOLVED},`)
    expect(patchFilesCalls).toHaveLength(0)
  })

  it('a --- /dev/null create target needs no read — but must not exist', async () => {
    disk.set(`${WS}/exists.ts`, sig())
    const createDiff = 'diff --git a/exists.ts b/exists.ts\n--- /dev/null\n+++ b/exists.ts\n@@ -0,0 +1,1 @@\n+hi'
    const t = await doMultiEdit(createDiff)
    expect(t.output).toContain('already exists — a --- /dev/null section only creates new files')
    expect(patchFilesCalls).toHaveLength(0)

    const freshDiff = 'diff --git a/fresh.ts b/fresh.ts\n--- /dev/null\n+++ b/fresh.ts\n@@ -0,0 +1,1 @@\n+hi'
    const t2 = await doMultiEdit(freshDiff)
    expect(t2.exitCode).toBe(0)
    expect(patchFilesCalls[0].entries[0]).toMatchObject({ filePath: `${WS}/fresh.ts`, isNew: true })
    expect(t2.output).toContain('(new)')
  })

  it('a stale target (changed since its read) rejects before the host call', async () => {
    disk.set(A_RESOLVED, sig())
    disk.set(B_RESOLVED, sig())
    await doRead('src/a.ts')
    await doRead('lib/b.ts')
    touch(A_RESOLVED) // external writer between read and patch
    const t = await doMultiEdit(TWO_FILES)
    expect(t.output).toContain('file changed on disk since it was read')
    expect(patchFilesCalls).toHaveLength(0)
  })

  it('delete and rename sections are rejected with recovery guidance', async () => {
    const del = 'diff --git a/old.ts b/old.ts\n--- a/old.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye'
    const t = await doMultiEdit(del)
    expect(t.output).toContain('cannot delete')
    expect(t.output).toContain('exec rm')
    const ren = 'diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1,1 +1,1 @@\n-a\n+b'
    const t2 = await doMultiEdit(ren)
    expect(t2.output).toContain('cannot rename')
  })

  it('a diff with no parseable sections (and no file_path) asks for either form explicitly', async () => {
    const t = await doMultiEdit('this is not a diff at all')
    expect(t.output).toContain('multi-file diff mode needs git-style sections')
  })
})

describe('multi-file edit: wiring', () => {
  const execSrc = () => readFileSync(join(__dirname, '..', 'src/renderer/src/agent/tool-executors.ts'), 'utf8')

  it('the multi-file branch keeps the gate, the ledger refresh and the host call attached', () => {
    const src = execSrc()
    const branch = src.slice(
      src.indexOf('private async execMultiFilePatch'),
      src.indexOf('Format exec tool result with exit code'),
    )
    expect(branch).toContain('readFilePaths.get')
    expect(branch).toContain('assertUnchangedOnDisk')
    expect(branch).toContain('getHost().patchFiles')
    expect(branch.split('refreshReadSignature').length - 1).toBe(1)
  })

  it('the approval gate extracts EVERY section path, not just file_path', () => {
    const flow = readFileSync(join(__dirname, '..', 'src/renderer/src/agent/engine/execution-flow.ts'), 'utf8')
    expect(flow).toContain('editToolTargetPaths(t.input)')
    const utils = readFileSync(join(__dirname, '..', 'src/renderer/src/agent/agent-utils.ts'), 'utf8')
    expect(utils).toContain('export function editToolTargetPaths')
  })
})

// ── 3. svcPatchFiles — the transaction on real fs ──────────────────────────

// file-ops pulls in the sandbox guard → audit store → SQLite (Electron-ABI,
// unloadable under plain Node). The jail is path-jail.test.ts's business; here
// the guard is replaced wholesale with an allow-all (workspace-write-lock
// pattern). writeFile is wrapped so the rollback test can fail one path
// deterministically; everything else forwards to the real fs.
vi.mock('../src/main/sandbox/guard', () => ({
  expandTilde: (t: string) => t,
  guardFsTarget: async (t: string) => ({ ok: true, resolved: t }),
  checkFsTarget: async (t: string) => ({ ok: true, resolved: t }),
}))

const writeFileHolder = vi.hoisted(() => ({ real: null as null | ((...a: unknown[]) => Promise<void>) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  writeFileHolder.real = actual.writeFile as typeof writeFileHolder.real
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

const { svcPatchFiles } = await import('../src/main/services/file-ops')

const SVC_DIR = join(mkdtempSync(join(tmpdir(), 'pulsemind-svc-patch-')), 'repo')
mkdirSync(SVC_DIR, { recursive: true })
const A = join(SVC_DIR, 'a.ts')
const B = join(SVC_DIR, 'b.ts')

const secA = (from: string, to: string): string =>
  `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-${from}\n+${to}`
const secB = (from: string, to: string): string =>
  `diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1,1 +1,1 @@\n-${from}\n+${to}`

describe('svcPatchFiles: the transaction', () => {
  it('applies every section and reports the per-file manifest', async () => {
    writeFileSync(A, 'alpha', 'utf-8')
    writeFileSync(B, 'bravo', 'utf-8')
    const res = await svcPatchFiles({ entries: [
      { filePath: A, diff: secA('alpha', 'ALPHA') },
      { filePath: B, diff: secB('bravo', 'BRAVO') },
    ] })
    expect(res.success).toBe(true)
    expect(res.replacements).toBe(2)
    expect(res.files).toEqual([{ path: A, isNew: false }, { path: B, isNew: false }])
    expect(readFileSync(A, 'utf-8')).toBe('ALPHA')
    expect(readFileSync(B, 'utf-8')).toBe('BRAVO')
  })

  it('one mismatching hunk anywhere writes NOTHING — the earlier file stays untouched', async () => {
    writeFileSync(A, 'alpha', 'utf-8')
    writeFileSync(B, 'bravo', 'utf-8')
    const bogus = 'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1,1 +1,1 @@\n-WRONG\n+B'
    const res = await svcPatchFiles({ entries: [
      { filePath: A, diff: secA('alpha', 'ALPHA') },
      { filePath: B, diff: bogus },
    ] })
    expect(res.success).toBe(false)
    expect(res.error).toContain(`${B}:`)
    expect(readFileSync(A, 'utf-8')).toBe('alpha')
    expect(readFileSync(B, 'utf-8')).toBe('bravo')
  })

  it('a write failure rolls back the files already written from their originals', async () => {
    writeFileSync(A, 'alpha', 'utf-8')
    writeFileSync(B, 'bravo', 'utf-8')
    const mod = await import('node:fs/promises')
    const mock = vi.mocked(mod.writeFile)
    const real = writeFileHolder.real!
    mock.mockImplementation(async (p: never, data: never, opts: never) => {
      if (String(p) === B) throw new Error('ENOSPC: simulated disk full')
      return real(p, data, opts)
    })
    try {
      const res = await svcPatchFiles({ entries: [
        { filePath: A, diff: secA('alpha', 'ALPHA') },
        { filePath: B, diff: secB('bravo', 'BRAVO') },
      ] })
      expect(res.success).toBe(false)
      expect(res.error).toContain(`${B}: write failed`)
      expect(res.error).toContain('restored')
      expect(readFileSync(A, 'utf-8')).toBe('alpha')
      expect(readFileSync(B, 'utf-8')).toBe('bravo')
    } finally {
      mock.mockImplementation(real as never)
    }
  })

  it('a --- /dev/null section creates the file with exactly the + lines', async () => {
    const fresh = join(SVC_DIR, 'nested', 'fresh.ts')
    const create = 'diff --git a/fresh.ts b/fresh.ts\nnew file mode 100644\n--- /dev/null\n+++ b/fresh.ts\n@@ -0,0 +1,2 @@\n+hello\n+world'
    const res = await svcPatchFiles({ entries: [{ filePath: fresh, diff: create, isNew: true }] })
    expect(res.success).toBe(true)
    expect(res.files).toEqual([{ path: fresh, isNew: true }])
    expect(readFileSync(fresh, 'utf-8')).toBe('hello\nworld')
  })

  it('an update section on a missing file is rejected by name', async () => {
    const res = await svcPatchFiles({ entries: [{ filePath: join(SVC_DIR, 'ghost.ts'), diff: secA('a', 'b') }] })
    expect(res.success).toBe(false)
    expect(res.error).toContain('file not found')
  })

  it('duplicate paths across sections are rejected before any IO', async () => {
    writeFileSync(A, 'alpha', 'utf-8')
    const res = await svcPatchFiles({ entries: [
      { filePath: A, diff: secA('alpha', 'ALPHA') },
      { filePath: `${SVC_DIR}/./a.ts`, diff: secA('alpha', 'ALPHA-2') },
    ] })
    expect(res.success).toBe(false)
    expect(res.error).toContain('duplicate file section')
  })

  it('an office binary target is rejected with the office_edit guidance', async () => {
    const doc = join(SVC_DIR, 'doc.docx')
    const res = await svcPatchFiles({ entries: [{ filePath: doc, diff: secA('a', 'b') }] })
    expect(res.success).toBe(false)
    expect(res.error).toContain('office_edit')
  })

  it('empty entries are rejected', async () => {
    expect((await svcPatchFiles({ entries: [] })).success).toBe(false)
  })
})
// ── PLAN-tool-issues #3（2026-10-28）：零 hunk 的拒绝要自己教格式 ──
// parseUnifiedDiff 静默跳过首个 @@ 之前的所有行，头格式错（或压根不是 diff）
// 塌缩成零 hunk，旧文案只有一句裸报错——模型分不清「格式错」和「文件错」，
// 只能退回逐条 search/replace。诊断把两种情况分开点名。
describe('noHunksError: the zero-hunk rejection teaches the format', () => {
  const FILE = 'alpha\nbeta\ngamma\n'

  it('no @@ header anywhere: says the payload is not a unified diff, with the shape example', async () => {
    const { patchContent } = await import('../src/shared/diff/patch-utils')
    const out = patchContent(FILE, 'please change alpha to delta')
    expect(out.success).toBe(false)
    expect(out.error).toContain('no `@@` hunk header anywhere')
    expect(out.error).toContain('@@ -start,count +start,count @@')
    expect(out.error).toContain('+added line')
    // 示例的算术必须自洽（1 上下文 + 1 删 + 1 增 = old 2 / new 2）：applyPatch
    // 的 splice 按头的 oldCount 吃区间，虚高计数（旧示例 -12,3 +12,4 配 2/2
    // body）照抄会把 hunk 后一行静默吞掉——教学面不能教吃行形状。
    expect(out.error).toContain('@@ -12,2 +12,2 @@')
  })

  it('a malformed @@ line: quoted with its line number against the expected shape', async () => {
    const { patchContent } = await import('../src/shared/diff/patch-utils')
    const out = patchContent(FILE, [
      '--- a/f',
      '+++ b/f',
      '@@ 1,2 +1,2 @@', // missing the leading "-old" side
      ' alpha',
      '-beta',
      '+BETA',
    ].join('\n'))
    expect(out.success).toBe(false)
    expect(out.error).toContain('line 3')
    expect(out.error).toContain('@@ 1,2 +1,2 @@')
    expect(out.error).toContain('does not match the expected shape')
  })

  it('CRLF payloads are normalized before the parse: a valid CRLF header is not a zero-hunk case', async () => {
    const { patchContent } = await import('../src/shared/diff/patch-utils')
    // The header parses, the hunk MISSES (no 'nonexistent' line) — so the
    // failure must come from the match branch's diagnosable error, proving
    // parse-failure and match-failure stay distinct diagnoses.
    const out = patchContent(FILE, '@@ -1,1 +1,1 @@\r\n-nonexistent\r\n+ALPHA\r\n')
    expect(out.success).toBe(false)
    expect(out.error).not.toContain('No valid hunks found')
    expect(out.error.length).toBeGreaterThan(40)
  })

  it('a real zero-hunk case still refuses without applying anything', async () => {
    const { patchContent } = await import('../src/shared/diff/patch-utils')
    const out = patchContent(FILE, 'diff --git a/f b/f\nindex 123..456\n')
    expect(out.success).toBe(false)
    expect(out.replacements).toBe(0)
    expect(out.error).toContain('No valid hunks found in diff')
  })
})
