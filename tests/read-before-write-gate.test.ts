import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same HOME sandbox as auto-mode-phantom-approval.test.ts — the executor's
// import chain touches real stores and must never write into the live
// ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-read-before-write-'))

const { ToolExecutor } = await import('../src/renderer/src/agent/tool-executors')
const { setHost } = await import('../src/renderer/src/agent/host')
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

// ── The mock host is a minimal disk simulation keyed by resolved path:
//  `touch` bumps the mtime every write, which is exactly the dimension the
//  freshness gate compares. `read`'s shell path is opaque (a command string),
//  so its outcome is driven by the mutable `readResult`. ────────────────────

type Stat = { size: number; birthtime: string; mtime: string; isDirectory: boolean }

const disk = new Map<string, Stat>()
let tick = 0
let editCalls = 0
let patchCalls = 0
let writeCalls = 0
let readResult = { code: 0, output: 'line1\nline2' }

const sig = (): Stat => ({
  size: 10,
  birthtime: '2026-10-27T00:00:00.000Z',
  mtime: new Date(1_700_000_000_000 + ++tick * 1_000).toISOString(),
  isDirectory: false,
})
const touch = (p: string): void => disk.set(p, sig())

setHost({
  getFileStat: async (p: string) => disk.get(p) ?? null,
  execCommandSync: async () => readResult,
  editFile: async (i: { filePath: string }) => { editCalls++; touch(i.filePath); return { success: true, replacements: 1 } },
  patchFile: async (i: { filePath: string }) => { patchCalls++; touch(i.filePath); return { success: true, replacements: 1 } },
  writeFile: async (i: { filePath: string }) => { writeCalls++; touch(i.filePath); return { success: true } },
  convertFileToMarkdown: async (p: string) => ({ content: 'converted', cachePath: null, hit: false, sourcePath: p }),
} as never)

const WS = '/ws'
const NOTES = `${WS}/notes.md`
let ex: InstanceType<typeof ToolExecutor>

beforeEach(() => {
  disk.clear()
  tick = 0
  editCalls = 0; patchCalls = 0; writeCalls = 0
  readResult = { code: 0, output: 'line1\nline2' }
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
const doEdit = async (input: Record<string, unknown>) => {
  const t = block('edit', input)
  await ex.execWorkspaceTool(t)
  return t
}
const doWrite = async (input: Record<string, unknown>) => {
  const t = block('write', input)
  await ex.execWorkspaceTool(t)
  return t
}

// ── Behavior ──────────────────────────────────────────────────────────────

describe('read-before-write gate: edit', () => {
  it('rejects an edit to a path this session never read, before reaching the host', async () => {
    disk.set(NOTES, sig())
    const t = await doEdit({ file_path: 'notes.md', old_str: 'a', new_str: 'b' })
    expect(t.output).toContain('edit requires a prior read of /ws/notes.md')
    expect(t.exitCode).toBe(-1)
    expect(editCalls).toBe(0)
  })

  it('lets an edit through after a read of the same path', async () => {
    disk.set(NOTES, sig())
    const r = await doRead('notes.md')
    expect(r.exitCode).toBe(0)
    const t = await doEdit({ file_path: 'notes.md', old_str: 'a', new_str: 'b' })
    expect(t.exitCode).toBe(0)
    expect(editCalls).toBe(1)
  })

  it('licenses an edit spelled as an absolute path after a relative read (same resolveWorkspacePath spelling)', async () => {
    disk.set(NOTES, sig())
    await doRead('notes.md')
    const t = await doEdit({ file_path: '/ws/notes.md', old_str: 'a', new_str: 'b' })
    expect(t.exitCode).toBe(0)
  })

  it('rejects an edit after the file changed on disk since the read', async () => {
    disk.set(NOTES, sig())
    await doRead('notes.md')
    touch(NOTES) // external writer between read and edit
    const t = await doEdit({ file_path: 'notes.md', old_str: 'a', new_str: 'b' })
    expect(t.output).toContain('file changed on disk since it was read')
    expect(t.exitCode).toBe(-1)
    expect(editCalls).toBe(0)
  })

  it('rejects an edit when the file vanished since the read', async () => {
    disk.set(NOTES, sig())
    await doRead('notes.md')
    disk.delete(NOTES)
    const t = await doEdit({ file_path: 'notes.md', old_str: 'a', new_str: 'b' })
    expect(t.output).toContain('file changed on disk since it was read')
    expect(editCalls).toBe(0)
  })

  it('does not stale-reject the second edit after its own successful edit (post-success refresh)', async () => {
    disk.set(NOTES, sig())
    await doRead('notes.md')
    const first = await doEdit({ file_path: 'notes.md', old_str: 'a', new_str: 'b' })
    expect(first.exitCode).toBe(0)
    const second = await doEdit({ file_path: 'notes.md', old_str: 'b', new_str: 'c' })
    expect(second.exitCode).toBe(0)
    expect(editCalls).toBe(2)
  })

  it('gates the diff form by the same ledger', async () => {
    disk.set(NOTES, sig())
    const before = await doEdit({ file_path: 'notes.md', diff: '@@ -1,1 +1,1 @@\n-a\n+b' })
    expect(before.output).toContain('edit requires a prior read')
    expect(patchCalls).toBe(0)
    await doRead('notes.md')
    const after = await doEdit({ file_path: 'notes.md', diff: '@@ -1,1 +1,1 @@\n-a\n+b' })
    expect(after.exitCode).toBe(0)
    expect(patchCalls).toBe(1)
  })

  it('does not record a failed read (non-zero exit, no output)', async () => {
    readResult = { code: 1, output: '' }
    await doRead('notes.md')
    const t = await doEdit({ file_path: 'notes.md', old_str: 'a', new_str: 'b' })
    expect(t.output).toContain('edit requires a prior read')
  })

  it('records convertible-format reads so office files reach the accurate office rejection, not a read loop', async () => {
    // A convert-path read must carry a ledger entry: without one, the gate
    // would ping-pong read(convert) ↔ 「read it first」 on formats text
    // write/edit can never touch. With one, the call passes OUR gate and the
    // main-side officeBinaryReject delivers its 「用 office_edit」 message.
    disk.set(`${WS}/doc.pdf`, sig())
    const r = await doRead('doc.pdf')
    expect(r.exitCode).toBe(0)
    const t = await doEdit({ file_path: 'doc.pdf', old_str: 'a', new_str: 'b' })
    expect(t.exitCode).toBe(0)
    expect(editCalls).toBe(1)
  })
})

describe('read-before-write gate: write', () => {
  it('rejects overwriting an existing file this session never read', async () => {
    disk.set(NOTES, sig())
    const t = await doWrite({ file_path: 'notes.md', content: 'replacement body' })
    expect(t.output).toContain('already exists and has not been read in this session')
    expect(t.exitCode).toBe(-1)
    expect(writeCalls).toBe(0)
  })

  it('lets a new-file write through and licenses a follow-up edit', async () => {
    const w = await doWrite({ file_path: 'new.md', content: 'hi' })
    expect(w.exitCode).toBe(0)
    expect(writeCalls).toBe(1)
    const e = await doEdit({ file_path: 'new.md', old_str: 'h', new_str: 'H' })
    expect(e.exitCode).toBe(0)
  })

  it('rejects an overwrite after the file changed on disk since the read (silent-loss case)', async () => {
    disk.set(NOTES, sig())
    await doRead('notes.md')
    touch(NOTES) // external writer
    const t = await doWrite({ file_path: 'notes.md', content: 'replacement body' })
    expect(t.output).toContain('file changed on disk since it was read')
    expect(writeCalls).toBe(0)
  })

  it('lets an overwrite through when the read is still current', async () => {
    disk.set(NOTES, sig())
    await doRead('notes.md')
    const t = await doWrite({ file_path: 'notes.md', content: 'replacement body' })
    expect(t.exitCode).toBe(0)
    expect(writeCalls).toBe(1)
  })

  it('never gates append: true — it does not destroy existing bytes', async () => {
    disk.set(NOTES, sig())
    const t = await doWrite({ file_path: 'notes.md', content: 'more', append: true })
    expect(t.exitCode).toBe(0)
    expect(writeCalls).toBe(1)
  })

  it('refreshes the ledger on write success so a follow-up edit is not stale-rejected', async () => {
    const w = await doWrite({ file_path: 'new.md', content: 'hi' })
    expect(w.exitCode).toBe(0)
    const w2 = await doWrite({ file_path: 'new.md', content: 'hi again' })
    expect(w2.exitCode).toBe(0)
    expect(writeCalls).toBe(2)
  })
})

describe('read-before-write gate: session isolation', () => {
  it('a sub-agent executor does not inherit the parent session\'s reads', async () => {
    disk.set(NOTES, sig())
    await doRead('notes.md') // the PARENT executor's ledger
    const child = new ToolExecutor(
      { workspaceDir: WS, platformInfo: { platform: 'darwin' } } as never,
      new Map(), {} as never, {} as never, () => {}, () => {},
    )
    const t = block('edit', { file_path: 'notes.md', old_str: 'a', new_str: 'b' })
    await child.execWorkspaceTool(t)
    expect(t.output).toContain('edit requires a prior read')
    expect(editCalls).toBe(0)
  })
})

// ── Wiring scans: the ledger must stay attached to all three branches — a
//  silent removal of any record/gate/refresh point reverts the ruling without
//  a single test above necessarily noticing (they drive one path each). ─────

describe('read-before-write gate: wiring', () => {
  const src = () => readFileSync(join(__dirname, '..', 'src/renderer/src/agent/tool-executors.ts'), 'utf8')

  it('read branch records on BOTH paths (text + convert)', () => {
    const branch = src().slice(
      src().indexOf("if (t.name === 'read')"),
      src().indexOf('── git read-only tools'),
    )
    expect(branch.split('readFilePaths.set').length - 1).toBe(2)
  })

  it('write branch gates overwrite entries and refreshes on success', () => {
    const branch = src().slice(
      src().indexOf("if (t.name === 'write')"),
      src().indexOf("} else if (t.name === 'office_edit')"),
    )
    expect(branch).toContain('readFilePaths.get')
    expect(branch).toContain('assertUnchangedOnDisk')
    expect(branch).toContain('refreshReadSignature')
    expect(branch).toContain('already exists and has not been read')
  })

  it('edit branch gates ahead of BOTH forms and refreshes on each success', () => {
    const branch = src().slice(
      src().indexOf("} else if (t.name === 'edit')"),
      src().indexOf('} catch (err) { const em'),
    )
    expect(branch).toContain('edit requires a prior read')
    expect(branch).toContain('assertUnchangedOnDisk')
    expect(branch.split('refreshReadSignature').length - 1).toBe(2)
  })
})
