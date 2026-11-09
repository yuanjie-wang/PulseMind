/**
 * 工作区树会话改动着色（2026-10-28，用户：侧边窗口工作区文件列表用不同颜色区分由
 * 本轮会话新增或改变的文件）。
 *
 * 数据链：ToolExecutor 的 SessionFileLedger（write/edit/patch/office_edit/
 * export_document 成功即记账，kind 在首次触碰时定死）→ 父子引擎共享同一份实例
 * （spawn-manager 引用共享）→ 根引擎 onFileChangesChanged → session-manager 的
 * `file_changes` 事件 / snapshot / engineCall getFileChanges → mirror fold +
 * sessionFileChangesStore → WorkspaceTree 的 fileChangeMarks 画行。
 *
 * 这里钉：台账语义、paint map 的目录上卷规则、树的「最近已加载祖先」选择、
 * mirror fold、真 executor 的五处记账点、以及各连接处的 wiring。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same HOME sandbox as read-before-write-gate.test.ts — the executor's import
// chain touches real stores and must never write into the live ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-session-file-changes-'))

const { ToolExecutor } = await import('../src/renderer/src/agent/tool-executors')
const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')
const { setHost } = await import('../src/renderer/src/agent/host')
import { SessionFileLedger, fileChangeMarks, normalizeChangePath } from '../src/shared/agent-session/file-changes'
import { applySessionEvent, freshSessionState, seedSessionState } from '../src/shared/agent-session/mirror'
import { loadedAncestor, parentDir } from '../src/renderer/src/stores/workspace-tree'
import type { SessionFileChange } from '../src/shared/agent-protocol'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

// ── 台账 ──────────────────────────────────────────────────────────────────────

describe('SessionFileLedger', () => {
  it('records the FIRST kind and ignores later touches of the same path', () => {
    const ledger = new SessionFileLedger()
    expect(ledger.note('/ws/a.md', 'created')).toBe(true)
    expect(ledger.note('/ws/a.md', 'modified')).toBe(false)
    expect(ledger.note('/ws/b.md', 'modified')).toBe(true)
    expect(ledger.note('/ws/b.md', 'created')).toBe(false)
    expect(ledger.list()).toEqual([{ path: '/ws/a.md', kind: 'created' }, { path: '/ws/b.md', kind: 'modified' }])
    expect(ledger.size).toBe(2)
  })

  it('fires onChange with the full list only when the ledger actually moved', () => {
    const ledger = new SessionFileLedger()
    const fired: SessionFileChange[][] = []
    ledger.onChange = (c) => fired.push(c)
    ledger.note('/ws/a.md', 'created')
    ledger.note('/ws/a.md', 'modified')
    ledger.note('', 'created')
    ledger.note('/ws/b.md', 'modified')
    expect(fired).toEqual([
      [{ path: '/ws/a.md', kind: 'created' }],
      [{ path: '/ws/a.md', kind: 'created' }, { path: '/ws/b.md', kind: 'modified' }],
    ])
  })

  it('clear empties and emits [] — but only if there was something to clear', () => {
    const ledger = new SessionFileLedger()
    const fired: SessionFileChange[][] = []
    ledger.onChange = (c) => fired.push(c)
    ledger.clear()
    expect(fired).toEqual([])
    ledger.note('/ws/a.md', 'created')
    ledger.clear()
    expect(ledger.list()).toEqual([])
    expect(fired).toEqual([[{ path: '/ws/a.md', kind: 'created' }], []])
  })
})

// ── paint map ─────────────────────────────────────────────────────────────────

describe('fileChangeMarks', () => {
  it('paints the file and every folder between the root and it; the root itself never', () => {
    const marks = fileChangeMarks([{ path: '/ws/src/feat/new.ts', kind: 'created' }], '/ws')
    expect(marks.get('/ws/src/feat/new.ts')).toBe('created')
    expect(marks.get('/ws/src/feat')).toBe('created')
    expect(marks.get('/ws/src')).toBe('created')
    expect(marks.has('/ws')).toBe(false)
    expect(marks.size).toBe(3)
  })

  it('a folder follows its subtree: any rewrite inside → modified, created-only → created', () => {
    const marks = fileChangeMarks([
      { path: '/ws/src/a.ts', kind: 'created' },
      { path: '/ws/src/b.ts', kind: 'modified' },
      { path: '/ws/docs/new.md', kind: 'created' },
    ], '/ws')
    expect(marks.get('/ws/src')).toBe('modified')
    expect(marks.get('/ws/src/a.ts')).toBe('created')
    expect(marks.get('/ws/docs')).toBe('created')
    // Order independence: the modified file seen first still yields modified.
    const reversed = fileChangeMarks([
      { path: '/ws/src/b.ts', kind: 'modified' },
      { path: '/ws/src/a.ts', kind: 'created' },
    ], '/ws')
    expect(reversed.get('/ws/src')).toBe('modified')
  })

  it('skips entries outside the workspace and paints nothing without one', () => {
    const marks = fileChangeMarks([
      { path: '/elsewhere/x.md', kind: 'created' },
      { path: '/wsx/sibling.md', kind: 'created' },
      { path: '/ws/in.md', kind: 'modified' },
    ], '/ws')
    expect([...marks.keys()]).toEqual(['/ws/in.md'])
    expect(fileChangeMarks([{ path: '/ws/in.md', kind: 'modified' }], null).size).toBe(0)
    expect(fileChangeMarks([], '/ws').size).toBe(0)
  })

  it('normalizes the model\'s own segments onto the tree\'s path.join keys', () => {
    const marks = fileChangeMarks([{ path: '/ws/./notes//today/../a.md', kind: 'created' }], '/ws/')
    expect(marks.get('/ws/notes/a.md')).toBe('created')
    expect(marks.get('/ws/notes')).toBe('created')
    expect(marks.size).toBe(2)
    expect(normalizeChangePath('/ws/./x//y/../z.md')).toBe('/ws/x/z.md')
    expect(normalizeChangePath('C:\\ws\\.\\a\\b.md')).toBe('C:\\ws\\a\\b.md')
  })

  it('walks backslash paths the same way', () => {
    const marks = fileChangeMarks([{ path: 'C:\\ws\\src\\a.ts', kind: 'modified' }], 'C:\\ws')
    expect(marks.get('C:\\ws\\src\\a.ts')).toBe('modified')
    expect(marks.get('C:\\ws\\src')).toBe('modified')
    expect(marks.has('C:\\ws')).toBe(false)
  })
})

// ── 树的重列目标 ──────────────────────────────────────────────────────────────

describe('loadedAncestor / parentDir', () => {
  const tree = [
    { key: '/ws/src', children: [{ key: '/ws/src/lib' }, { key: '/ws/src/a.ts' }] },
    { key: '/ws/docs' },
  ]

  it('parentDir strips the last segment on either separator', () => {
    expect(parentDir('/ws/src/a.ts')).toBe('/ws/src')
    expect(parentDir('C:\\ws\\a.ts')).toBe('C:\\ws')
    expect(parentDir('a.ts')).toBe('')
  })

  it('the root, a loaded dir, and the nearest loaded dir above an unloaded one', () => {
    expect(loadedAncestor(tree, '/ws', '/ws')).toBe('/ws')
    expect(loadedAncestor(tree, '/ws', '/ws/src')).toBe('/ws/src')
    // /ws/src/lib is present but never listed (no children) → its parent.
    expect(loadedAncestor(tree, '/ws', '/ws/src/lib')).toBe('/ws/src')
    expect(loadedAncestor(tree, '/ws', '/ws/src/lib/deep/er')).toBe('/ws/src')
    // /ws/docs is present but unloaded, and the root is the only level above.
    expect(loadedAncestor(tree, '/ws', '/ws/docs/sub')).toBe('/ws')
    // A folder chain the tree never heard of → root.
    expect(loadedAncestor(tree, '/ws', '/ws/brand/new')).toBe('/ws')
  })

  it('a dir outside the workspace is nobody\'s to re-list', () => {
    expect(loadedAncestor(tree, '/ws', '/other/dir')).toBeNull()
    expect(loadedAncestor(tree, '/ws', '/wsx')).toBeNull()
  })
})

// ── mirror fold ───────────────────────────────────────────────────────────────

describe('session mirror: file_changes', () => {
  it('starts empty, folds the event, and seeds from a snapshot with or without the field', () => {
    const st = freshSessionState()
    expect(st.fileChanges).toEqual([])
    const changes: SessionFileChange[] = [{ path: '/ws/a.md', kind: 'created' }]
    expect(applySessionEvent(st, { type: 'file_changes', changes })).toBe(true)
    expect(st.fileChanges).toEqual(changes)
    seedSessionState(st, { messages: [], status: { status: 'idle' }, streamingBlocks: [], plan: null })
    expect(st.fileChanges).toEqual([])
    seedSessionState(st, { messages: [], status: { status: 'idle' }, streamingBlocks: [], plan: null, fileChanges: changes })
    expect(st.fileChanges).toEqual(changes)
  })
})

// ── 真 executor：五处记账点 ──────────────────────────────────────────────────

type Stat = { size: number; birthtime: string; mtime: string; isDirectory: boolean }
const disk = new Map<string, Stat>()
let tick = 0
let writeOk = true
const sig = (): Stat => ({ size: 10, birthtime: '2026-10-28T00:00:00.000Z', mtime: new Date(1_700_000_000_000 + ++tick * 1_000).toISOString(), isDirectory: false })
const touch = (p: string): void => disk.set(p, sig())

setHost({
  getFileStat: async (p: string) => disk.get(p) ?? null,
  execCommandSync: async () => ({ code: 0, output: 'line1\nline2' }),
  editFile: async (i: { filePath: string }) => { touch(i.filePath); return { success: true, replacements: 1 } },
  patchFile: async (i: { filePath: string }) => { touch(i.filePath); return { success: true, replacements: 1 } },
  patchFiles: async (i: { entries: Array<{ filePath: string }> }) => { for (const e of i.entries) touch(e.filePath); return { success: true, replacements: 2 } },
  writeFile: async (i: { filePath: string }) => { if (!writeOk) return { success: false, error: 'disk full' }; touch(i.filePath); return { success: true } },
  editDocx: async (i: { filePath: string }) => { touch(i.filePath); return { success: true, results: [{ index: 0, op: 'replace_text', ok: true, detail: 'ok' }] } },
  exportDocument: async (i: { filePath: string }) => { touch(i.filePath); return { success: true, path: i.filePath, bytes: 2048 } },
  convertFileToMarkdown: async (p: string) => ({ content: 'converted', cachePath: null, hit: false, sourcePath: p }),
  // The engine fixture below: settings + the change listeners it subscribes to.
  getSettings: () => Promise.resolve({ locale: 'zh' }),
  onMcpServersChanged: () => Promise.resolve([]), onSkillsChanged: () => Promise.resolve([]), mcpListServers: () => Promise.resolve([]),
  expertList: () => Promise.resolve([]), getSkillPreferences: () => Promise.resolve([]),
} as never)

const WS = '/ws'
let ex: InstanceType<typeof ToolExecutor>

beforeEach(() => {
  disk.clear()
  tick = 0
  writeOk = true
  ex = new ToolExecutor(
    { workspaceDir: WS, platformInfo: { platform: 'darwin' } } as never,
    new Map(), {} as never, {} as never, () => {}, () => {},
  )
})

const block = (name: string, input: Record<string, unknown>): ToolUseBlock =>
  ({ type: 'tool_use', id: `t_${name}_${Math.random().toString(36).slice(2, 8)}`, name, input, status: 'queued' })
const run = async (name: string, input: Record<string, unknown>): Promise<ToolUseBlock> => {
  const t = block(name, input)
  if (name === 'read') await ex.execReadOnlyTools([t])
  else await ex.execWorkspaceTool(t)
  return t
}
const kinds = (): Record<string, string> => Object.fromEntries(ex.fileChanges.list().map((c) => [c.path, c.kind]))

describe('ToolExecutor records into the session ledger', () => {
  it('write: a new file is created, a re-read existing one modified, and created stays created', async () => {
    await run('write', { file_path: 'new.md', content: 'hi' })
    expect(kinds()).toEqual({ [`${WS}/new.md`]: 'created' })
    touch(`${WS}/old.md`)
    await run('read', { file_path: 'old.md' })
    await run('write', { file_path: 'old.md', content: 'replaced' })
    expect(kinds()[`${WS}/old.md`]).toBe('modified')
    // The created file edited afterwards keeps its first kind.
    await run('edit', { file_path: 'new.md', old_str: 'hi', new_str: 'ho' })
    expect(kinds()[`${WS}/new.md`]).toBe('created')
  })

  it('append: created when the file did not exist, modified when it did', async () => {
    await run('write', { file_path: 'log.txt', content: 'a', append: true })
    touch(`${WS}/have.txt`)
    await run('write', { file_path: 'have.txt', content: 'b', append: true })
    expect(kinds()).toEqual({ [`${WS}/log.txt`]: 'created', [`${WS}/have.txt`]: 'modified' })
  })

  it('edit (old_str and diff forms) records modified on the gated, read file', async () => {
    touch(`${WS}/a.ts`); touch(`${WS}/b.ts`)
    await run('read', { file_path: 'a.ts' })
    await run('read', { file_path: 'b.ts' })
    await run('edit', { file_path: 'a.ts', old_str: 'line1', new_str: 'LINE1' })
    await run('edit', { file_path: 'b.ts', diff: '@@ -1,1 +1,1 @@\n-line1\n+LINE1' })
    expect(kinds()).toEqual({ [`${WS}/a.ts`]: 'modified', [`${WS}/b.ts`]: 'modified' })
  })

  it('multi-file diff: each section by its own shape (create vs update)', async () => {
    touch(`${WS}/src/a.ts`)
    await run('read', { file_path: 'src/a.ts' })
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,1 @@', '-line1', '+LINE1',
      'diff --git a/src/new.ts b/src/new.ts', '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,1 @@', '+hello',
    ].join('\n')
    const t = await run('edit', { diff })
    expect(t.exitCode).toBe(0)
    expect(kinds()).toEqual({ [`${WS}/src/a.ts`]: 'modified', [`${WS}/src/new.ts`]: 'created' })
  })

  it('office_edit records modified; export_document created-or-modified by prior existence', async () => {
    touch(`${WS}/doc.docx`)
    await run('office_edit', { file_path: 'doc.docx', ops: [{ op: 'replace_text', find: 'a', replace: 'b' }] })
    await run('office_export', { format: 'docx', content: '# hi', file_path: 'out.docx' })
    touch(`${WS}/again.docx`)
    await run('office_export', { format: 'docx', content: '# hi', file_path: 'again.docx' })
    expect(kinds()).toEqual({ [`${WS}/doc.docx`]: 'modified', [`${WS}/out.docx`]: 'created', [`${WS}/again.docx`]: 'modified' })
  })

  it('a failed write and a gate rejection leave no entry', async () => {
    writeOk = false
    const failed = await run('write', { file_path: 'nope.md', content: 'x' })
    expect(failed.exitCode).toBe(1)
    writeOk = true
    touch(`${WS}/unread.md`)
    const rejected = await run('write', { file_path: 'unread.md', content: 'x' })
    expect(rejected.exitCode).toBe(-1)
    expect(ex.fileChanges.size).toBe(0)
  })

  it('onChange fires once per NEW path, carrying the whole ledger', async () => {
    const fired: number[] = []
    ex.fileChanges.onChange = (c) => fired.push(c.length)
    await run('write', { file_path: 'a.md', content: '1' })
    await run('write', { file_path: 'a.md', content: '2', append: true })
    await run('write', { file_path: 'b.md', content: '3' })
    expect(fired).toEqual([1, 2])
  })
})

// ── 真引擎：回调接线 + reset 清空 + 读取面 ───────────────────────────────────

describe('AgentEngine: ledger → onFileChangesChanged', () => {
  it('a ledger move reaches the callback; reset clears and emits []; getFileChanges reads the ledger', () => {
    const fired: SessionFileChange[][] = []
    const engine = new AgentEngine({
      apiKey: '', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 512,
      myName: '', soul: '', yourName: '', adapter: {} as never,
      toolManager: new ToolManager(), skillManager: new SkillManager(),
      conversationId: 'conv_file_changes',
    }, { onFileChangesChanged: (c) => fired.push(c) })
    engine.toolExecutor.fileChanges.note('/ws/a.md', 'created')
    expect(fired).toEqual([[{ path: '/ws/a.md', kind: 'created' }]])
    expect(engine.getFileChanges()).toEqual([{ path: '/ws/a.md', kind: 'created' }])
    engine.reset()
    expect(engine.getFileChanges()).toEqual([])
    expect(fired[fired.length - 1]).toEqual([])
    engine.dispose()
  })
})

// ── wiring 扫描 ───────────────────────────────────────────────────────────────

const ROOT = join(process.cwd(), 'src')

describe('session file-change wiring', () => {
  const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

  it('protocol: the event member and the ledger entry type exist', () => {
    const p = read('shared/agent-protocol/payloads.ts')
    expect(p).toContain("| { type: 'file_changes'; changes: SessionFileChange[] }")
    expect(p).toContain("export type SessionFileChangeKind = 'created' | 'modified'")
  })

  it('spawn-manager hands every sub-engine its parent\'s ledger instance', () => {
    expect(read('renderer/src/agent/engine/spawn-manager.ts')).toContain('engine.toolExecutor.fileChanges = this.engine.toolExecutor.fileChanges')
  })

  it('main: the callback becomes the event, the snapshot and engineCall expose the ledger', () => {
    const sm = read('main/agent/session-manager.ts')
    expect(sm).toContain("onFileChangesChanged: (changes: SessionFileChange[]) => this.emit(sessionId, { type: 'file_changes', changes })")
    expect(sm).toContain('fileChanges: entry.engine.getFileChanges()')
    expect(sm).toContain("case 'getFileChanges': return entry.engine.getFileChanges()")
    expect(read('shared/types/electron-bridge.ts')).toContain('fileChanges: unknown[] } | null>')
    expect(read('preload/index.ts')).toContain('fileChanges: unknown[] } | null> =>')
  })

  it('renderer: the fold mirrors the event into the store; eviction and reset drop it', () => {
    const hook = read('renderer/src/hooks/useConversationEngine.ts')
    expect(hook).toContain("if (data.type === 'file_changes') useSessionFileChangesStore.getState().set(sessionId, st.fileChanges)")
    expect(hook.match(/useSessionFileChangesStore\.getState\(\)\.drop\(convId\)/g)?.length).toBe(2)
  })

  it('tree: paints from fileChangeMarks, pulls the ledger on mount, re-lists the loaded ancestor', () => {
    const tree = read('renderer/src/components/workbench/WorkspaceTree.tsx')
    expect(tree).toContain('fileChangeMarks(changes, workspaceDir)')
    expect(tree).toContain('mark={marks.get(entry.path)}')
    expect(tree).toContain('.pm-ws-name.pm-ws-created { color: var(--pm-ws-created); }')
    expect(tree).toContain('.pm-ws-name.pm-ws-modified { color: var(--pm-ws-modified); }')
    expect(tree).toContain("agentSessionEngineCall(conversationId, 'getFileChanges', [])")
    expect(tree).toContain('loadedAncestor(cur.entries, workspaceDir, parentDir(normalizeChangePath(c.path)))')
    // Re-listing goes through setRoot, never through the remounting `tick`.
    expect(tree).toContain('replaceLevel(prev.entries, workspaceDir, dir, level.entries)')
  })

  it('palette: both columns define the two inks', () => {
    const palette = read('renderer/src/theme/palette.ts')
    expect(palette.match(/'--pm-ws-created':/g)?.length).toBe(2)
    expect(palette.match(/'--pm-ws-modified':/g)?.length).toBe(2)
  })
})
