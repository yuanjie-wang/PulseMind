/**
 * Workspace file ops + content search (PLAN-project-ide 刀二/刀三, 2026-10-31).
 * Three layers, matching the repo's testing discipline:
 *   - the two new write services (svcCreateDirectory / svcRenamePath) against
 *     a REAL temp tree — the guard's baseline deny-roots are the security
 *     contract, so the name-segment and existence rules get a matrix;
 *   - svcSearchWorkspace against the repo's OWN bundled rg binary (the same
 *     resolution production uses, dev path) — the fixed-string flag, case
 *     toggle, cap+truncation and .pulsemind exclusion are the contract;
 *   - wiring scans for the four files whose behavior lives behind real IPC /
 *     real shells (channels, handler, preload, bridge) and the two renderer
 *     surfaces (WorkspaceTree's entry/toggle/exclusion wiring, SearchPanel's
 *     run-summarize-jump chain).
 */
import { beforeAll, afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

// Temp HOME BEFORE the first import — settings-store reads it at module load.
const homeDir = mkdtempSync(join(tmpdir(), 'pulsemind-ws-ops-'))
process.env.HOME = homeDir

const { svcCreateDirectory, svcRenamePath, svcSearchWorkspace } = await import('../src/main/services/file-ops')
const { parseSearchLine } = await import('../src/shared/workspace-search')
const { walkTreeSearch, MAX_MATCHES, MAX_WALKED_DIRS } = await import('../src/shared/workspace-tree-search')

const ROOT = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const rgBin = join(ROOT, 'resources', 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rg.exe' : 'rg')

let ws: string
beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), 'pulsemind-ws-fixtures-'))
  writeFileSync(join(ws, 'app.ts'), 'const alpha = 1\nconst beta = alpha + 1\n')
  writeFileSync(join(ws, 'readme.md'), 'hello world\n')
  mkdirSync(join(ws, 'src'))
  writeFileSync(join(ws, 'src', 'util.ts'), 'export const gamma = 3\n')
  // The scratch namespace is excluded from search — plant a hit in it.
  mkdirSync(join(ws, '.pulsemind', 'tmp'), { recursive: true })
  writeFileSync(join(ws, '.pulsemind', 'tmp', 'junk.ts'), 'const alpha = 99\n')
})
afterEach(() => {
  rmSync(join(ws, 'made'), { recursive: true, force: true })
  rmSync(join(ws, 'renamed.txt'), { force: true })
  rmSync(join(ws, 'moved'), { recursive: true, force: true })
})

describe('svcCreateDirectory', () => {
  it('creates a directory (nested, recursive)', async () => {
    const res = await svcCreateDirectory(join(ws, 'made', 'deep'))
    expect(res.success).toBe(true)
    expect(existsSync(join(ws, 'made', 'deep'))).toBe(true)
  })

  it('rejects a relative path', async () => {
    const res = await svcCreateDirectory('made/relative')
    expect(res.success).toBe(false)
    expect(res.error).toContain('absolute')
  })

  it('is idempotent on an existing directory', async () => {
    mkdirSync(join(ws, 'made'))
    const res = await svcCreateDirectory(join(ws, 'made'))
    expect(res.success).toBe(true)
  })
})

describe('svcRenamePath', () => {
  it('renames a file', async () => {
    writeFileSync(join(ws, 'note.txt'), 'x')
    const res = await svcRenamePath(join(ws, 'note.txt'), 'renamed.txt')
    expect(res.success).toBe(true)
    expect(existsSync(join(ws, 'renamed.txt'))).toBe(true)
    expect(existsSync(join(ws, 'note.txt'))).toBe(false)
    rmSync(join(ws, 'note.txt'), { force: true })
  })

  it('renames a directory with its contents', async () => {
    mkdirSync(join(ws, 'moved-src'))
    writeFileSync(join(ws, 'moved-src', 'a.txt'), 'a')
    const res = await svcRenamePath(join(ws, 'moved-src'), 'moved')
    expect(res.success).toBe(true)
    expect(existsSync(join(ws, 'moved', 'a.txt'))).toBe(true)
  })

  it('rejects separators and dot-names before touching the guard', async () => {
    writeFileSync(join(ws, 'n1.txt'), 'x')
    for (const bad of ['../escape.txt', 'a/b.txt', 'a\\b.txt', '.', '..']) {
      const res = await svcRenamePath(join(ws, 'n1.txt'), bad)
      expect(res.success).toBe(false)
      expect(existsSync(join(ws, 'n1.txt'))).toBe(true)
    }
  })

  it('rejects a missing source and an existing target', async () => {
    const missing = await svcRenamePath(join(ws, 'no-such-file.txt'), 'x.txt')
    expect(missing.success).toBe(false)
    expect(missing.error).toContain('不存在')

    writeFileSync(join(ws, 'n2.txt'), 'x')
    writeFileSync(join(ws, 'n3.txt'), 'y')
    const clash = await svcRenamePath(join(ws, 'n2.txt'), 'n3.txt')
    expect(clash.success).toBe(false)
    expect(clash.error).toContain('已存在')
  })

  it('same name is a successful no-op', async () => {
    writeFileSync(join(ws, 'n4.txt'), 'x')
    const res = await svcRenamePath(join(ws, 'n4.txt'), 'n4.txt')
    expect(res.success).toBe(true)
    expect(existsSync(join(ws, 'n4.txt'))).toBe(true)
  })
})

describe('svcSearchWorkspace', () => {
  it('empty query → empty result without spawning rg', async () => {
    const res = await svcSearchWorkspace({ query: '  ', dir: ws, rgPath: rgBin })
    expect(res.ok).toBe(true)
    expect(res.lines).toEqual([])
  })

  it('finds hits in `path:line:text` form', async () => {
    const res = await svcSearchWorkspace({ query: 'alpha', dir: ws, rgPath: rgBin })
    expect(res.ok).toBe(true)
    const rows = (res.lines ?? []).map(parseSearchLine)
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows.some((r) => r.path === join(ws, 'app.ts') && r.line === 1 && r.text.includes('alpha'))).toBe(true)
  })

  it('fixed-string search: regex metacharacters match literally', async () => {
    const res = await svcSearchWorkspace({ query: 'alpha + 1', dir: ws, rgPath: rgBin })
    expect(res.ok).toBe(true)
    expect((res.lines ?? []).length).toBeGreaterThanOrEqual(1)
  })

  it('case toggle: insensitive by default, sensitive on demand', async () => {
    writeFileSync(join(ws, 'case.txt'), 'MIXED case\n')
    const loose = await svcSearchWorkspace({ query: 'mixed case', dir: ws, rgPath: rgBin })
    expect((loose.lines ?? []).length).toBeGreaterThanOrEqual(1)
    const strict = await svcSearchWorkspace({ query: 'mixed case', dir: ws, rgPath: rgBin, caseSensitive: true })
    expect(strict.lines ?? []).toHaveLength(0)
    rmSync(join(ws, 'case.txt'))
  })

  it('excludes the .pulsemind scratch namespace', async () => {
    const res = await svcSearchWorkspace({ query: 'alpha', dir: ws, rgPath: rgBin })
    expect((res.lines ?? []).some((l) => l.includes('.pulsemind'))).toBe(false)
  })

  it('caps rows and reports the truncation', async () => {
    mkdirSync(join(ws, 'many'))
    for (let i = 0; i < 5; i++) writeFileSync(join(ws, 'many', `f${i}.txt`), 'needle here\n')
    const res = await svcSearchWorkspace({ query: 'needle', dir: ws, rgPath: rgBin, maxResults: 2 })
    expect(res.ok).toBe(true)
    expect(res.lines).toHaveLength(2)
    expect(res.truncated).toBe(true)
    rmSync(join(ws, 'many'), { recursive: true, force: true })
  })

  it('a missing search dir is an honest error', async () => {
    const res = await svcSearchWorkspace({ query: 'x', dir: join(ws, 'no-such-dir'), rgPath: rgBin })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不存在')
  })
})

describe('parseSearchLine', () => {
  it('parses the rg --no-heading row, including Windows drive paths', () => {
    expect(parseSearchLine('/w/app.ts:12:const alpha = 1')).toEqual({ path: '/w/app.ts', line: 12, text: 'const alpha = 1' })
    expect(parseSearchLine('C:\\w\\app.ts:3:hello')).toEqual({ path: 'C:\\w\\app.ts', line: 3, text: 'hello' })
  })

  it('keeps a row whose match text is empty; rejects non-rows', () => {
    expect(parseSearchLine('/w/empty.ts:5:')).toEqual({ path: '/w/empty.ts', line: 5, text: '' })
    expect(parseSearchLine('summary line 42 of text')).toBeNull()
    expect(parseSearchLine('/w/app.ts:zero:text')).toBeNull()
  })
})

describe('walkTreeSearch (tree filename filter — the 2026-10-31 「漏」 fixes)', () => {
  type Entry = { name: string; path: string; isDir: boolean }
  const fixture: Record<string, Entry[]> = {
    '/ws': [
      { name: 'src', path: '/ws/src', isDir: true },
      { name: 'docs', path: '/ws/docs', isDir: true },
      { name: 'node_modules', path: '/ws/node_modules', isDir: true },
      { name: 'readme.md', path: '/ws/readme.md', isDir: false },
    ],
    '/ws/src': [
      { name: 'deep', path: '/ws/src/deep', isDir: true },
      { name: 'util.ts', path: '/ws/src/util.ts', isDir: false },
    ],
    '/ws/src/deep': [{ name: 'alpha.ts', path: '/ws/src/deep/alpha.ts', isDir: false }],
    '/ws/docs': [{ name: 'notes.md', path: '/ws/docs/notes.md', isDir: false }],
    '/ws/node_modules': [{ name: 'left-pad', path: '/ws/node_modules/left-pad', isDir: true }],
    '/ws/node_modules/left-pad': [{ name: 'index.js', path: '/ws/node_modules/left-pad/index.js', isDir: false }],
    '/ws/.git': [{ name: 'config', path: '/ws/.git/config', isDir: false }],
    '/ws/.pulsemind': [{ name: 'scratch.md', path: '/ws/.pulsemind/scratch.md', isDir: false }],
  }
  const walkedDirs: string[] = []
  const listDir = async (dir: string): Promise<{ entries: Entry[] } | null> => {
    walkedDirs.push(dir)
    return fixture[dir] ? { entries: fixture[dir] } : null
  }
  type WalkNode = { key: string; isLeaf?: boolean; children?: WalkNode[] }
  const flat = (nodes: WalkNode[], out: WalkNode[] = []): WalkNode[] => {
    for (const n of nodes) {
      out.push(n)
      if (n.children) flat(n.children, out)
    }
    return out
  }

  it('keeps a matched directory whose subtree has no further matches (leak #1)', async () => {
    const res = await walkTreeSearch('/ws', 'docs', listDir)
    // Old builder dropped any dir with children.length === 0 — searching a
    // folder's own name showed NOTHING.
    const docs = flat(res.nodes).find((n) => n.key === '/ws/docs')
    expect(docs).toBeDefined()
    expect(docs.isLeaf).toBe(true)
    expect(res.expanded).toEqual([])
  })

  it('nested file matches with the ancestor chain expanded', async () => {
    const res = await walkTreeSearch('/ws', 'ALPHA', listDir) // case-insensitive
    const file = flat(res.nodes).find((n) => n.key === '/ws/src/deep/alpha.ts')
    expect(file).toBeDefined()
    expect(file.isLeaf).toBe(true)
    expect([...res.expanded].sort()).toEqual(['/ws/src', '/ws/src/deep']) // post-order by construction; rc-tree doesn't care
  })

  it('skips node_modules/.git/.pulsemind at every depth — the budget stays on user files (leak #2)', async () => {
    walkedDirs.length = 0
    const inside = await walkTreeSearch('/ws', 'index.js', listDir)
    expect(inside.nodes).toEqual([]) // the only 'index.js' lives in node_modules
    const inside2 = await walkTreeSearch('/ws', 'config', listDir)
    expect(inside2.nodes).toEqual([]) // .git's config is invisible
    expect(walkedDirs).not.toContain('/ws/node_modules')
    expect(walkedDirs).not.toContain('/ws/.git')
    expect(walkedDirs).not.toContain('/ws/.pulsemind')
  })

  it('a skipped directory whose OWN name matches still shows, as a leaf', async () => {
    const res = await walkTreeSearch('/ws', 'node_modules', listDir)
    const node = flat(res.nodes).find((n) => n.key === '/ws/node_modules')
    expect(node).toBeDefined()
    expect(node.isLeaf).toBe(true)
  })

  it('caps at MAX_MATCHES and reports truncated', async () => {
    const big: Record<string, Entry[]> = {
      '/cap': [{ name: 'sub', path: '/cap/sub', isDir: true }],
      '/cap/sub': [],
    }
    for (let i = 0; i < 150; i++) big['/cap/sub'].push({ name: `zz${i}.ts`, path: `/cap/sub/zz${i}.ts`, isDir: false })
    const res = await walkTreeSearch('/cap', 'zz', async (dir) => (big[dir] ? { entries: big[dir] } : null))
    expect(res.truncated).toBe(true)
    // The cap is honest: matched FILES stop at 100 (the rendered tree adds the
    // ancestor dir on top), matching what the truncation hint promises.
    const leaves = flat(res.nodes).filter((n) => n.isLeaf)
    expect(leaves.length).toBe(MAX_MATCHES)
  })

  it('caps the walked dirs and reports truncated — late hits are missing honestly', async () => {
    const deep: Record<string, Entry[]> = { '/deep': [] }
    for (let i = 0; i <= MAX_WALKED_DIRS + 50; i++) {
      const d = `/deep/d${String(i).padStart(4, '0')}`
      deep['/deep'].push({ name: `d${String(i).padStart(4, '0')}`, path: d, isDir: true })
      deep[d] = [{ name: 'filler.txt', path: `${d}/filler.txt`, isDir: false }]
    }
    deep['/deep/d0450'] = [{ name: 'needle-file.md', path: '/deep/d0450/needle-file.md', isDir: false }]
    deep['/deep/d0000'].unshift({ name: 'needle-early.md', path: '/deep/d0000/needle-early.md', isDir: false })
    const res = await walkTreeSearch('/deep', 'needle', async (dir) => (deep[dir] ? { entries: deep[dir] } : null))
    const hits = flat(res.nodes).map((n) => n.key)
    expect(hits).toContain('/deep/d0000/needle-early.md')
    expect(hits).not.toContain('/deep/d0450/needle-file.md')
    expect(res.truncated).toBe(true)
  })

  it('unlistable directories are skipped without aborting the walk', async () => {
    const partial: Record<string, Entry[] | null> = {
      '/p': [
        { name: 'ghost', path: '/p/ghost', isDir: true },
        { name: 'real.md', path: '/p/real.md', isDir: false },
      ],
      '/p/ghost': null,
    }
    const res = await walkTreeSearch('/p', 'real', async (dir) => (partial[dir] ? { entries: partial[dir] as Entry[] } : null))
    expect(flat(res.nodes).map((n) => n.key)).toEqual(['/p/real.md'])
  })

  it('the component hands the host listDir bridge to the shared walk', () => {
    const tree = read('src/renderer/src/components/workbench/WorkspaceTree.tsx')
    expect(tree).toContain('walkTreeSearch(workspaceDir, debounced')
    expect(tree).toContain('window.electronAPI.listDir(dir)')
    expect(tree).not.toContain('function walkMatches')
  })
})

describe('wiring: channels → handler → preload → bridge', () => {
  const channels = read('src/shared/ipc-channels.ts')
  const handler = read('src/main/ipc/file-ops.handler.ts')
  const preload = read('src/preload/index.ts')
  const bridge = read('src/shared/types/electron-bridge.ts')

  it('the three channels are declared, handled, bridged and typed', () => {
    for (const name of ['UTIL_CREATE_DIR', 'UTIL_RENAME_PATH', 'UTIL_SEARCH_WORKSPACE']) {
      expect(channels).toContain(`${name}:`)
    }
    expect(handler).toContain('ipcMain.handle(IPC_CHANNELS.UTIL_CREATE_DIR')
    expect(handler).toContain('ipcMain.handle(IPC_CHANNELS.UTIL_RENAME_PATH')
    expect(handler).toContain('ipcMain.handle(IPC_CHANNELS.UTIL_SEARCH_WORKSPACE')
    expect(preload).toContain('createDir: (dirPath: string)')
    expect(preload).toContain('renamePath: (oldPath: string, newName: string)')
    expect(preload).toContain('searchWorkspace: (input: {')
    expect(preload).toMatch(/searchWorkspace[\s\S]{0,120}caseSensitive\?: boolean/)
    expect(bridge).toContain('createDir: (dirPath: string)')
    expect(bridge).toContain('renamePath: (oldPath: string, newName: string)')
    expect(bridge).toContain('searchWorkspace: (input: {')
    expect(bridge).toMatch(/searchWorkspace[\s\S]{0,120}caseSensitive\?: boolean/)
  })

  it('the search service is rg-based, fixed-string, capped and kills at the cap', () => {
    const svc = read('src/main/services/file-ops.ts')
    expect(svc).toContain('getBundledRipgrepPath()')
    expect(svc).toMatch(/'--no-heading',\s*'-F'/)
    expect(svc).toContain("'-g',")
    expect(svc).toContain("'!.pulsemind/**'")
    expect(svc).toContain("child.kill('SIGKILL')")
  })
})

describe('wiring: WorkspaceTree entry surface', () => {
  const tree = read('src/renderer/src/components/workbench/WorkspaceTree.tsx')

  it('刀一 verify entry is hidden behind a false flag — strip wiring stays', () => {
    expect(tree).toContain('const VERIFY_ENTRY_ENABLED = false')
    expect(tree).toMatch(/\{VERIFY_ENTRY_ENABLED && \(/)
    expect(tree).toContain('<VerifyPanel workspaceDir={workspaceDir}')
  })

  it('content search strip: toggle + mount + panel wiring', () => {
    expect(tree).toContain("import { SearchPanel } from './SearchPanel'")
    expect(tree).toContain('aria-label="全文搜索"')
    expect(tree).toContain('<SearchPanel workspaceDir={workspaceDir}')
  })

  it('strips are mutually exclusive — search and diff both close the others', () => {
    expect(tree).toMatch(/const showDiff = async[\s\S]{0,220}setContentSearchOpen\(false\)/)
    expect(tree).toMatch(/const next = !contentSearchOpen[\s\S]{0,120}closeStrips\(\)/)
  })

  it('新建 dropdown and 重命名 row action are wired', () => {
    expect(tree).toContain("label: '新建文件'")
    expect(tree).toContain("label: '新建文件夹'")
    expect(tree).toContain('onRename={requestRename}')
    expect(tree).toContain('aria-label={`重命名 ${entry.name}`}')
    expect(tree).toContain('window.electronAPI.createDir(target)')
    expect(tree).toContain("window.electronAPI.writeFile({ filePath: target, content: '' })")
    expect(tree).toContain('window.electronAPI.renamePath(entry.path, name)')
  })

  it('after create/rename the affected level re-lists in place (replaceLevel, no remount)', () => {
    expect(tree).toMatch(/const relistDir = async[\s\S]{0,400}replaceLevel\(prev\.entries, workspaceDir, dir, res\.entries\)/)
    expect(tree).not.toMatch(/const relistDir = async[\s\S]{0,400}setTick/)
  })
})

describe('wiring: SearchPanel run-summarize-jump chain', () => {
  const panel = read('src/renderer/src/components/workbench/SearchPanel.tsx')

  it('debounced input, min length, bridge call, line reveal on click', () => {
    expect(panel).toContain('SEARCH_DEBOUNCE_MS = 400')
    expect(panel).toContain('MIN_QUERY_LEN = 2')
    expect(panel).toContain('.searchWorkspace({ query: debounced, dir: workspaceDir, caseSensitive, maxResults: DEFAULT_MAX_RESULTS })')
    expect(panel).toContain("openInPreviewPane(r.path, { mode: 'line', line: r.line })")
    expect(panel).toContain("import { parseSearchLine, type WorkspaceSearchRow } from '../../../../shared/workspace-search'")
  })

  it('truncation is surfaced, never passed off as a complete list', () => {
    expect(panel).toContain('shown.truncated &&')
    expect(panel).toContain('结果过多，仅显示前')
  })
})
