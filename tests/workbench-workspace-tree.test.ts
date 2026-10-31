// ── 工作区 tree: expansion cache + hover actions (PLAN-workbench W15) ──
// Two behaviours the user asked for on 2026-09-17: the folder expansion state
// must survive a workbench tab switch (which unmounts the tree), and every row
// must offer 复制 / 删除 on hover. The cache's pure half is tested here
// directly; the real UI half (hover, clipboard, the confirm dialog, an actual
// tab switch) is `scripts/probe-workspace-tree.mjs`, because vitest runs in
// plain Node with no layout engine.

import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dropSubtree, removeNode, MAX_WORKSPACE_DIRS } from '../src/renderer/src/stores/workspace-tree'
import { useWorkspaceTreeStore, NO_EXPANDED_KEYS } from '../src/renderer/src/stores/workspaceTreeStore'
import { touchRecord } from '../src/renderer/src/utils/lru-record'
import { usePreviewPaneStore } from '../src/renderer/src/stores/previewPaneStore'
import { svcDeletePath } from '../src/main/services/file-ops'
import { shell, TEST_TRASH_DIR } from './stubs/electron'

describe('dropSubtree', () => {
  it('drops the target itself', () => {
    expect(dropSubtree(['/w/a', '/w/b'], '/w/a')).toEqual(['/w/b'])
  })

  it('drops everything under the target', () => {
    expect(dropSubtree(['/w/a', '/w/a/b', '/w/a/b/c', '/w/b'], '/w/a')).toEqual(['/w/b'])
  })

  it('handles Windows separators (keys come from path.join, so \\ is real)', () => {
    expect(dropSubtree(['C:\\w\\a', 'C:\\w\\a\\b', 'C:\\w\\b'], 'C:\\w\\a')).toEqual(['C:\\w\\b'])
  })

  it('keeps a sibling that merely shares the prefix', () => {
    // The trap a bare startsWith(target) falls into: /w/ab is not inside /w/a.
    expect(dropSubtree(['/w/a', '/w/ab', '/w/ab/c'], '/w/a')).toEqual(['/w/ab', '/w/ab/c'])
  })

  it('is a no-op for a path nothing had expanded', () => {
    const keys = ['/w/a', '/w/b']
    expect(dropSubtree(keys, '/w/zz')).toEqual(keys)
  })
})

describe('removeNode', () => {
  const tree = () => [
    { key: '/w/a', children: [{ key: '/w/a/x' }, { key: '/w/a/y' }] },
    { key: '/w/b', children: [{ key: '/w/b/x' }] },
  ]

  it('removes a top-level node and only that node', () => {
    const next = removeNode(
      [
        { key: '/w/a', children: [{ key: '/w/a/x' }] },
        { key: '/w/b' },
      ],
      '/w/a',
    )
    expect(next.map((n) => n.key)).toEqual(['/w/b'])
  })

  it('removes a nested node', () => {
    const next = removeNode(tree(), '/w/a/y')
    expect(next[0].children?.map((n) => n.key)).toEqual(['/w/a/x'])
    expect(next[1].key).toBe('/w/b')
  })

  it('removes a whole subtree when its root goes', () => {
    const next = removeNode(tree(), '/w/a')
    expect(next.map((n) => n.key)).toEqual(['/w/b'])
  })

  it('returns the SAME array when the key is absent (the no-op path)', () => {
    const nodes = tree()
    expect(removeNode(nodes, '/w/nope')).toBe(nodes)
  })

  it('keeps untouched siblings by reference so React.memo/diffing stays honest', () => {
    const nodes = tree()
    const next = removeNode(nodes, '/w/a/x')
    expect(next).not.toBe(nodes)
    expect(next[1]).toBe(nodes[1])
    expect(next[0]).not.toBe(nodes[0])
    expect(next[0].key).toBe('/w/a')
  })

  it('takes a real antd DataNode key, which is React.Key (string | number | bigint)', () => {
    // The call site is `removeNode(prev.entries, …)` where the nodes are antd
    // `DataNode`s; @types/react 18.3 widened `React.Key` with bigint, so a
    // TreeNodeShape.key of `string | number` rejects every real node. That
    // breaks web tsc and nothing else — `npm test` does not typecheck — hence
    // the assertion here, on the pure module that declares the shape.
    const src = readFileSync(join(process.cwd(), 'src/renderer/src/stores/workspace-tree.ts'), 'utf8')
    expect(src).toMatch(/key\?:\s*string \| number \| bigint/)
  })
})

describe('touchRecord', () => {
  it('re-inserts the key as most recent', () => {
    const next = touchRecord({ a: 1, b: 2 }, 'a', 9, 10)
    expect(Object.keys(next)).toEqual(['b', 'a'])
    expect(next.a).toBe(9)
  })

  it('prunes past the cap, oldest first', () => {
    let map: Record<string, number> = {}
    for (let i = 0; i < 4; i++) map = touchRecord(map, `k${i}`, i, 3)
    expect(Object.keys(map)).toEqual(['k1', 'k2', 'k3'])
  })

  it('keeps every entry while the map is still smaller than the cap', () => {
    // The bug this pinned: `slice(len - cap)` reads as "keep the tail" but a
    // negative start counts from the END, so six entries under a cap of ten
    // came back as the last four. The pre-existing previewPaneStore copy of
    // this arithmetic had it, which silently dropped the oldest conversations'
    // tab strips.
    let map: Record<string, number> = {}
    for (let i = 0; i < 6; i++) map = touchRecord(map, `k${i}`, i, 10)
    expect(Object.keys(map)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5'])
  })
})

describe('previewPaneStore LRU (the original call site of the prune above)', () => {
  it('keeps a tab strip for every conversation below the cap', () => {
    // Seven conversations, well under MAX_CONVERSATION_MAPS = 10: each one's
    // strip must still be there when the user comes back to it.
    usePreviewPaneStore.setState({ tabsByConversation: {}, activeByConversation: {}, activeConversationId: null, workspaceDir: null })
    const store = usePreviewPaneStore.getState()
    for (let i = 0; i < 7; i++) store.openFile(`conv_${i}`, `/w/note-${i}.md`)
    expect(Object.keys(usePreviewPaneStore.getState().tabsByConversation)).toHaveLength(7)
  })
})

describe('workspaceTreeStore', () => {
  const reset = (): void => useWorkspaceTreeStore.setState({ expandedByDir: {} })

  it('caches expansion per workspace dir', () => {
    reset()
    const { setExpanded } = useWorkspaceTreeStore.getState()
    setExpanded('/w/one', ['/w/one/a'])
    setExpanded('/w/two', ['/w/two/b', '/w/two/c'])
    expect(useWorkspaceTreeStore.getState().expandedByDir).toEqual({
      '/w/one': ['/w/one/a'],
      '/w/two': ['/w/two/b', '/w/two/c'],
    })
  })

  it('keeps collapsed keys out of the cache (the value is what the tree reports)', () => {
    reset()
    const { setExpanded } = useWorkspaceTreeStore.getState()
    setExpanded('/w/one', ['/w/one/a', '/w/one/a/b'])
    setExpanded('/w/one', ['/w/one/a'])
    expect(useWorkspaceTreeStore.getState().expandedByDir['/w/one']).toEqual(['/w/one/a'])
  })

  it('caps the number of cached dirs', () => {
    reset()
    const { setExpanded } = useWorkspaceTreeStore.getState()
    for (let i = 0; i < MAX_WORKSPACE_DIRS + 2; i++) setExpanded(`/w/${i}`, [`/w/${i}/a`])
    expect(Object.keys(useWorkspaceTreeStore.getState().expandedByDir)).toHaveLength(MAX_WORKSPACE_DIRS)
  })

  it('dropDeleted takes a deleted folder and its subtree out of every cached dir', () => {
    reset()
    const { setExpanded } = useWorkspaceTreeStore.getState()
    setExpanded('/w/one', ['/w/one/a', '/w/one/a/b', '/w/one/c'])
    setExpanded('/w/two', ['/w/one/a/b'])
    useWorkspaceTreeStore.getState().dropDeleted('/w/one/a')
    const after = useWorkspaceTreeStore.getState().expandedByDir
    expect(after['/w/one']).toEqual(['/w/one/c'])
    expect(after['/w/two']).toEqual([])
  })

  it('dropDeleted is an identity no-op when nothing matched (no re-render)', () => {
    reset()
    const { setExpanded } = useWorkspaceTreeStore.getState()
    setExpanded('/w/one', ['/w/one/a'])
    const before = useWorkspaceTreeStore.getState().expandedByDir
    useWorkspaceTreeStore.getState().dropDeleted('/w/one/plain-file.txt')
    expect(useWorkspaceTreeStore.getState().expandedByDir).toBe(before)
  })

  it('exposes one shared empty list, so the tree prop identity is stable', () => {
    // DirectoryTree syncs its internal expansion state in an effect keyed on
    // this prop: a fresh [] per render would loop React.
    expect(Object.isFrozen(NO_EXPANDED_KEYS)).toBe(false)
    expect(useWorkspaceTreeStore.getState().expandedByDir['/never'] ?? NO_EXPANDED_KEYS).toBe(NO_EXPANDED_KEYS)
  })
})

describe('svcDeletePath', () => {
  const makeTree = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'pulsemind-del-'))
    writeFileSync(join(root, 'note.txt'), 'hello')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'deep.txt'), 'deep')
    return root
  }

  it('deletes a file (through the trash, which the stub records)', async () => {
    const root = makeTree()
    const res = await svcDeletePath(join(root, 'note.txt'))
    expect(res).toEqual({ success: true })
    expect(existsSync(join(root, 'note.txt'))).toBe(false)
    expect(existsSync(join(root, 'sub'))).toBe(true)
    // It went to the trash, not into the void: deleting is recoverable.
    expect(readdirSync(TEST_TRASH_DIR).some((name) => name.endsWith('note.txt'))).toBe(true)
  })

  it('deletes a directory with its contents', async () => {
    const root = makeTree()
    const res = await svcDeletePath(join(root, 'sub'))
    expect(res).toEqual({ success: true })
    expect(existsSync(join(root, 'sub'))).toBe(false)
  })

  it('falls back to a real removal when the platform has no trash', async () => {
    // The app is fine either way (macOS trashes, a bare Linux box removes);
    // what must not happen is a delete that reports success and leaves the
    // file — so the fallback is exercised for real.
    const root = makeTree()
    const original = shell.trashItem
    shell.trashItem = async () => {
      throw new Error('no trash on this platform')
    }
    try {
      const res = await svcDeletePath(join(root, 'note.txt'))
      expect(res).toEqual({ success: true })
      expect(existsSync(join(root, 'note.txt'))).toBe(false)
    } finally {
      shell.trashItem = original
    }
  })

  it('refuses the filesystem root', () => {
    // Asserted from source, not driven: the only input that reaches this
    // branch is `/`, so a regression that removed the check would have the
    // test suite itself rmdir the machine. The two lines are the guard.
    const src = readFileSync(join(process.cwd(), 'src/main/services/file-ops.ts'), 'utf8')
    expect(src).toContain('if (safePath === path.parse(safePath).root)')
    expect(src).toContain('refusing to delete')
  })

  it('refuses a protected root (the baseline deny list applies outside a session)', async () => {
    const sshDir = join(process.env.HOME as string, '.ssh')
    mkdirSync(sshDir, { recursive: true })
    writeFileSync(join(sshDir, 'id_test'), 'secret')
    const res = await svcDeletePath(join(sshDir, 'id_test'))
    expect(res.success).toBe(false)
    expect(existsSync(join(sshDir, 'id_test'))).toBe(true)
  })

  it('reports a missing path as a failure instead of pretending', async () => {
    const root = makeTree()
    const res = await svcDeletePath(join(root, 'ghost.txt'))
    expect(res.success).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('reports a relative path as a failure', async () => {
    const res = await svcDeletePath('notes/relative.txt')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/absolute/i)
  })
})

describe('WorkspaceTree wiring (source scan — the renderer half is probed, not unit-tested)', () => {
  const src = readFileSync(join(process.cwd(), 'src/renderer/src/components/workbench/WorkspaceTree.tsx'), 'utf8')

  it('reads a non-empty source (a broken scan cannot pass by finding nothing)', () => {
    expect(src.length).toBeGreaterThan(1500)
    expect(src).toContain('DirectoryTree')
  })

  it('drives the tree with controlled expandedKeys from the store', () => {
    expect(src).toContain("from '../../stores/workspaceTreeStore'")
    expect(src).toContain('expandedKeys={expandedKeys}')
    expect(src).toContain('onExpand={onExpand}')
    expect(src).toContain('setWorkspaceExpanded(workspaceDir, keys.map(String))')
  })

  it('re-reads the cached levels on mount (rc-tree only loads a node the user expands)', () => {
    // Verified against @rc-component/tree: a changed `expandedKeys` prop only
    // recomputes flattenNodes — `loadData` runs from onNodeExpand alone. So
    // restoring the keys without re-reading the levels reopens EMPTY folders;
    // scripts/probe-workspace-tree.mjs fails on exactly that (its negative
    // control: with `restore` forced to [], the deep row never comes back).
    expect(src).toContain('useWorkspaceTreeStore.getState().expandedByDir[workspaceDir]')
    expect(src).toMatch(/\]\.sort\(\)/)
    expect(src).toContain('const level = await window.electronAPI.listDir(key)')
    expect(src).toContain('entries = withChildren(entries, key, level.entries.map(entryToNode))')
  })

  it('re-reading a level keeps the subtrees that were already loaded', () => {
    // Otherwise collapse→expand of a preloaded folder would drop its open
    // descendants and leave them rendered expanded-but-empty.
    expect(src).toContain('keepSubtrees(prev')
    expect(src).toContain('before?.children ? { ...n, children: before.children } : n')
  })

  it('reveals the hover actions on the row and stops their clicks from reaching the tree', () => {
    // DirectoryTree's expandAction is 'click', so a button without
    // stopPropagation would also expand/select the row it sits on.
    expect(src).toContain('className="pm-ws-actions"')
    expect((src.match(/e\.stopPropagation\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(src).toContain('visibility: hidden')
    expect(src).toContain('.ant-tree-treenode:hover .pm-ws-actions')
  })

  it('routes 删除 through the guarded IPC (复制路径 removed 2026-10-31 — its clipboard pin left the suite with the button)', () => {
    expect(src).toContain('window.electronAPI.deletePath(entry.path)')
    expect(src).toContain('Modal.confirm')
    expect(src).not.toContain('复制路径')
  })

  it('takes a deleted path out of the loaded tree and the expansion cache', () => {
    expect(src).toContain('removeNode(prev.entries, entry.path)')
    expect(src).toContain('dropDeleted(entry.path)')
  })

  it('keeps a tab holding unsaved edits (a delete must not discard a draft silently)', () => {
    expect(src).toContain('isDirty(draft)')
  })
})
