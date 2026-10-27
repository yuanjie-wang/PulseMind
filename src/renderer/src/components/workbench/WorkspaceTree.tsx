// ── 工作区 tab (workbench): the conversation workspace's file tree ──
// One lazy DirectoryTree over the workspace dir: each expansion lists one
// level through util:list-dir, and clicking a file previews it beside this
// tree (previewPaneStore.openFile also brings the workbench up on this tab).
// The header carries the search box and 刷新 — the root path moved to the
// address bar above (WorkspacePane, 2026-10-25 layout ruling).
//
// Three things this view owes the user:
//   * the expansion state is cached per workspace dir in workspaceTreeStore —
//     WorkbenchPane unmounts this component on every tab switch, so anything
//     held in component state is gone by the time the user comes back;
//   * every row reveals 复制路径 / 删除 on hover. Those clicks must not also
//     select or expand the row (DirectoryTree's expandAction is 'click'), hence
//     the stopPropagation on both buttons — and 删除 asks first, being the one
//     action here that clicking again cannot undo;
//   * 搜索 walks the whole workspace recursively (not just the loaded levels —
//     a filter over lazy levels would only ever search what happens to be
//     open), debounced, with the matched paths and their ancestors materialized
//     as a flat-by-comparison result tree, all levels expanded.
// Selection is controlled by the parent (WorkspacePane) so the address bar and
// an agent-opened preview can highlight the same file.
// Labels stay hardcoded Chinese — the pane's own convention
// (工作区/浏览器/工作计划).

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Tree, Tooltip, Button, Input, Spin, Modal, message } from 'antd'
import type { DataNode, EventDataNode } from 'antd/es/tree'
import { CopyOutlined, DeleteOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { usePreviewPaneStore, DRAFT_CONVERSATION_KEY } from '../../stores/previewPaneStore'
import { isDirty } from '../../stores/preview-edit'
import { useWorkspaceTreeStore, NO_EXPANDED_KEYS } from '../../stores/workspaceTreeStore'
import { removeNode } from '../../stores/workspace-tree'

const { DirectoryTree } = Tree

/** Row CSS. Scoped to this tree: antd's Tree is used elsewhere in the app and
 *  the title-row layout below is this view's own. */
const TREE_CSS = `
.pm-ws-tree .ant-tree-node-content-wrapper { display: flex; align-items: center; }
.pm-ws-tree .ant-tree-node-content-wrapper > .ant-tree-iconEle { flex: none; }
.pm-ws-tree .ant-tree-title { flex: 1; min-width: 0; display: flex; align-items: center; }
.pm-ws-row { flex: 1; min-width: 0; display: flex; align-items: center; }
.pm-ws-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-ws-hit { background: var(--pm-warn-bg); border-radius: 2px; }
/* Reserved, not hidden-by-reflow: the row keeps its geometry whether or not the
   pointer is on it, so running the mouse down the tree never shifts the names. */
.pm-ws-actions { flex: none; display: flex; align-items: center; gap: 2px; margin-left: 6px; visibility: hidden; }
.pm-ws-tree .ant-tree-treenode:hover .pm-ws-actions,
.pm-ws-tree .ant-tree-treenode:focus-within .pm-ws-actions { visibility: visible; }
.pm-ws-btn {
  width: 18px; height: 18px; padding: 0; border: none; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; color: var(--pm-graph-ink-dim); font-size: 11px; cursor: pointer;
}
/* The inks reuse the graph ladder's exact hexes (#8c8c8c/#595959): one role per
   value, and the dark column's counterparts come with them. */
.pm-ws-btn:hover { background: var(--pm-hover); color: var(--pm-graph-ink); }
/* The delete button deliberately keeps .pm-ws-btn's grey on hover — destructive
   actions are not painted red anywhere (buildAntdTheme scopes Button.colorError
   to the same grey). */
`

interface Props {
  conversationId: string | undefined
  /** The selected row, controlled by WorkspacePane (the address bar mirrors
   *  it; an agent-opened preview highlights itself through the same state). */
  selectedPath: string | null
  onSelectPath: (path: string | null) => void
}

interface WorkspaceEntry {
  name: string
  path: string
  isDir: boolean
}

/** A tree node keeps the listing entry it came from — the hover actions need
 *  the path and the kind, and rc-tree only hands `titleRender` the node. */
type WorkspaceNode = DataNode & { entry: WorkspaceEntry }

function entryToNode(entry: WorkspaceEntry): WorkspaceNode {
  return entry.isDir
    ? { title: entry.name, key: entry.path, entry }
    : { title: entry.name, key: entry.path, entry, isLeaf: true }
}

/** Replace one node's children (matched by key) anywhere in the loaded tree.
 *  A child that already had a loaded subtree KEEPS it: this is called both by
 *  the restore below and by rc-tree's `loadData`, and re-reading a level must
 *  not collapse the deeper folders the user still has open. */
function withChildren(nodes: WorkspaceNode[], key: React.Key, children: WorkspaceNode[]): WorkspaceNode[] {
  return nodes.map((node) => {
    if (node.key === key) return { ...node, children: keepSubtrees(node.children as WorkspaceNode[] | undefined, children) }
    return node.children ? { ...node, children: withChildren(node.children as WorkspaceNode[], key, children) } : node
  })
}

/** The fresh level, with each child's already-loaded children carried over. */
function keepSubtrees(prev: WorkspaceNode[] | undefined, next: WorkspaceNode[]): WorkspaceNode[] {
  if (!prev || prev.length === 0) return next
  const loaded = new Map(prev.map((n) => [String(n.key), n]))
  return next.map((n) => {
    const before = loaded.get(String(n.key))
    return before?.children ? { ...n, children: before.children } : n
  })
}

/** Centered one-line hint for the no-workspace / unreadable / empty states. */
function Hint({ text }: { text: string }): React.ReactElement {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px', color: 'var(--pm-text-muted)', fontSize: 12, textAlign: 'center' }}>
      {text}
    </div>
  )
}

/** Is `filePath` reachable in the loaded tree: every ancestor dir present AND
 *  expanded, the file itself among the last ancestor's loaded children. */
function rowVisible(entries: WorkspaceNode[], ancestors: string[], filePath: string, expanded: ReadonlySet<string>): boolean {
  let nodes = entries
  for (const dir of ancestors) {
    const node = nodes.find((n) => n.key === dir)
    if (!node || !expanded.has(dir)) return false
    nodes = (node.children as WorkspaceNode[] | undefined) ?? []
  }
  return nodes.some((n) => n.key === filePath)
}

interface RowProps {
  entry: WorkspaceEntry
  highlight?: string
  onCopy: (entry: WorkspaceEntry) => void
  onDelete: (entry: WorkspaceEntry) => void
}

/** The name with every case-insensitive hit of `highlight` painted; an empty
 *  highlight renders the plain name. */
function HighlightedName({ name, highlight }: { name: string; highlight?: string }): React.ReactElement {
  if (!highlight) return <>{name}</>
  const lower = name.toLowerCase()
  const needle = highlight.toLowerCase()
  const parts: React.ReactNode[] = []
  let at = 0
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, at)) {
    if (i > at) parts.push(name.slice(at, i))
    parts.push(
      <span key={i} className="pm-ws-hit">
        {name.slice(i, i + needle.length)}
      </span>,
    )
    at = i + needle.length
  }
  if (at < name.length) parts.push(name.slice(at))
  return <>{parts}</>
}

/** One row's title: the name, then the two hover actions. Rendered through
 *  `titleRender` so the handlers are always the current ones while the tree
 *  data stays plain data. */
function TreeRow({ entry, highlight, onCopy, onDelete }: RowProps): React.ReactElement {
  return (
    <span className="pm-ws-row" data-ws-path={entry.path}>
      <span className="pm-ws-name">
        <HighlightedName name={entry.name} highlight={highlight} />
      </span>
      <span className="pm-ws-actions">
        <button
          type="button"
          className="pm-ws-btn"
          title="复制路径"
          aria-label={`复制路径 ${entry.name}`}
          onClick={(e) => {
            e.stopPropagation()
            onCopy(entry)
          }}
        >
          <CopyOutlined />
        </button>
        <button
          type="button"
          className="pm-ws-btn pm-ws-btn-danger"
          title="删除"
          aria-label={`删除 ${entry.name}`}
          onClick={(e) => {
            e.stopPropagation()
            onDelete(entry)
          }}
        >
          <DeleteOutlined />
        </button>
      </span>
    </span>
  )
}

/** A deleted path has no file left to preview, so its tab goes with it — but a
 *  tab holding unsaved edits stays, keeping the draft (PLAN-preview-edit D10:
 *  edits are never discarded silently). */
function dropPreviewTab(conversationId: string | undefined, path: string): void {
  const pv = usePreviewPaneStore.getState()
  const open = pv.tabsByConversation[conversationId ?? DRAFT_CONVERSATION_KEY]?.some((t) => t.path === path)
  const draft = pv.drafts[path]
  if (open && !(draft && isDirty(draft))) pv.closeTab(conversationId ?? null, path)
}

// ── 搜索 (2026-10-25): a recursive name walk over the workspace. ──
// The walk is bounded — a runaway tree (node_modules under a project workspace)
// must not pin the renderer — and the result is pruned to matched entries plus
// the ancestor folders that reach them, every level expanded.
const SEARCH_DEBOUNCE_MS = 250
const MAX_WALKED_DIRS = 400
const MAX_MATCHES = 100

interface SearchResult {
  nodes: WorkspaceNode[]
  /** Every dir that survived pruning — the result renders fully expanded. */
  expanded: string[]
  truncated: boolean
}

/** DFS the workspace collecting every entry's coordinates; prune to matches +
 *  ancestors afterwards. Returns the pruned tree fully expanded. */
async function walkMatches(rootDir: string, query: string): Promise<SearchResult> {
  const byParent = new Map<string, WorkspaceEntry[]>()
  const matched = new Set<string>()
  let walked = 0
  let truncated = false
  const walk = async (dir: string): Promise<void> => {
    if (walked >= MAX_WALKED_DIRS) {
      truncated = true
      return
    }
    walked += 1
    const res = await window.electronAPI.listDir(dir)
    if (!res) return
    byParent.set(dir, res.entries)
    for (const entry of res.entries) {
      if (entry.name.toLowerCase().includes(query.toLowerCase())) {
        matched.add(entry.path)
        if (matched.size >= MAX_MATCHES) truncated = true
      }
      if (entry.isDir && !truncated) await walk(entry.path)
    }
  }
  await walk(rootDir)

  const expanded: string[] = []
  const build = (dir: string): WorkspaceNode[] => {
    const nodes: WorkspaceNode[] = []
    for (const entry of byParent.get(dir) ?? []) {
      if (entry.isDir) {
        const children = build(entry.path)
        if (children.length > 0) {
          expanded.push(entry.path)
          nodes.push({ title: entry.name, key: entry.path, entry, children })
        }
      } else if (matched.has(entry.path)) {
        nodes.push({ title: entry.name, key: entry.path, entry, isLeaf: true })
      }
    }
    return nodes
  }
  return { nodes: build(rootDir), expanded, truncated }
}

export function WorkspaceTree({ conversationId, selectedPath, onSelectPath }: Props): React.ReactElement {
  const workspaceDir = usePreviewPaneStore((s) => s.workspaceDir)
  const setWorkspaceExpanded = useWorkspaceTreeStore((s) => s.setExpanded)
  // Cached expansion for THIS root; NO_EXPANDED_KEYS is one shared array so the
  // prop's identity is stable (DirectoryTree re-syncs its internal state from
  // it, and a fresh [] per render would loop).
  const expandedKeys = useWorkspaceTreeStore((s) => (workspaceDir ? (s.expandedByDir[workspaceDir] ?? NO_EXPANDED_KEYS) : NO_EXPANDED_KEYS))
  const [tick, setTick] = useState(0)
  const [searchTick, setSearchTick] = useState(0)
  // Root listing, tagged with the request it answers: a switch or refresh bumps
  // reqKey and the render reads the state as "loading" until the matching
  // result lands — no state reset inside the effect to flap through.
  const reqKey = `${workspaceDir ?? ''}#${tick}`
  const [root, setRoot] = useState<{ key: string; entries: WorkspaceNode[]; failed: boolean } | null>(null)
  const current = root && root.key === reqKey ? root : null

  // ── 搜索: debounced query → recursive walk. The result carries its own
  // request tag too, so a query typed during an in-flight walk can never
  // render the previous walk's rows. ──
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const searching = debounced !== ''
  const [search, setSearch] = useState<{ key: string; result: SearchResult } | null>(null)
  const searchReqKey = `${workspaceDir ?? ''}#${debounced}#${searchTick}`
  const searchCurrent = search && search.key === searchReqKey ? search.result : null

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!workspaceDir || !debounced) {
      setSearch(null)
      return
    }
    let cancelled = false
    void (async (): Promise<void> => {
      const result = await walkMatches(workspaceDir, debounced)
      if (!cancelled) setSearch({ key: searchReqKey, result })
    })()
    return () => {
      cancelled = true
    }
  }, [workspaceDir, debounced, searchReqKey])

  useEffect(() => {
    if (!workspaceDir) return
    let cancelled = false
    // Restore the cached expansion (see workspaceTreeStore). rc-tree only calls
    // `loadData` for a node the user expands in THIS mount, so handing it the
    // cached keys would reopen the folders EMPTY and never fetch them — the
    // levels have to be read here. Parents come first (`sort` puts a prefix
    // before its children, which is the order the walk below needs), and a
    // level that vanished from disk is simply skipped.
    const restore = [...(useWorkspaceTreeStore.getState().expandedByDir[workspaceDir] ?? [])].sort()
    void (async (): Promise<void> => {
      const res = await window.electronAPI.listDir(workspaceDir)
      if (cancelled) return
      let entries = res ? res.entries.map(entryToNode) : []
      for (const key of restore) {
        const level = await window.electronAPI.listDir(key)
        if (cancelled) return
        if (level) entries = withChildren(entries, key, level.entries.map(entryToNode))
      }
      setRoot({ key: reqKey, entries, failed: !res })
    })()
    return () => {
      cancelled = true
    }
  }, [workspaceDir, tick, reqKey])

  // ── Reveal (user rulings 2026-10-25: 正在被预览的文件要在树中被选中；
  //    被折叠了要展开) ──
  // Selection is controlled from WorkspacePane, but rc-tree can only highlight
  // a row that is actually rendered. A preview opened WITHOUT a click (agent
  // auto-preview, chat file chip) may live in folders this lazy tree never
  // listed, and the user may have collapsed a folder whose file is still on
  // screen — both shapes leave the selected row unrendered. When the selected
  // path is not reachable (an ancestor missing from the loaded data OR simply
  // collapsed), fetch the missing levels — idempotent, `withChildren` keeps
  // whatever subtrees are already loaded — and expand the whole chain into the
  // expansion cache, so the row renders selected. Collapsing a folder under an
  // active selection therefore re-expands it: every collapse writes a new
  // expandedKeys array, the effect re-runs, and the chain is written back.
  // A plain tree click never lands here: the clicked row is by definition
  // visible.
  // The negative latch guards the two DEAD ends only — an ancestor level that
  // would not list, or a parent listing without the file (a deleted file whose
  // dirty draft kept the preview alive). Both would setRoot-loop forever if
  // chased, so the attempt is remembered per (tree load, path) until the
  // selection moves or 刷新 re-reads. Every REACHABLE shape resolves through
  // its expansion/root write and never touches the latch.
  const revealDoneRef = useRef<string | null>(null)
  useEffect(() => {
    if (!workspaceDir || !selectedPath || !current) return
    if (!selectedPath.startsWith(workspaceDir + '/')) return
    const segs = selectedPath.slice(workspaceDir.length + 1).split('/')
    const ancestors: string[] = []
    let dir = workspaceDir
    for (const seg of segs.slice(0, -1)) {
      dir += '/' + seg
      ancestors.push(dir)
    }
    // Nothing to expand for a root-level path; if its row is missing the tree
    // simply has nothing to reveal.
    if (ancestors.length === 0) return
    if (rowVisible(current.entries, ancestors, selectedPath, new Set(expandedKeys))) return
    const latch = `${reqKey}::${selectedPath}`
    if (revealDoneRef.current === latch) return
    let cancelled = false
    void (async (): Promise<void> => {
      const fetched: string[] = []
      let deepest: WorkspaceEntry[] | null = null
      for (const key of ancestors) {
        const level = await window.electronAPI.listDir(key)
        if (cancelled) return
        if (level) {
          fetched.push(key)
          deepest = level.entries
          setRoot((prev) => (prev && prev.key === reqKey ? { ...prev, entries: withChildren(prev.entries, key, level.entries.map(entryToNode)) } : prev))
        }
      }
      if (cancelled) return
      if (fetched.length > 0) {
        const store = useWorkspaceTreeStore.getState()
        const cached = store.expandedByDir[workspaceDir] ?? []
        const merged = [...new Set([...cached, ...fetched])]
        if (merged.length > cached.length) store.setExpanded(workspaceDir, merged)
      }
      // Latch only when the chain is truly dead: a level refused to list, or
      // the file is absent from its parent's fresh listing. Otherwise the
      // writes above make the row visible and the next effect pass
      // early-returns on rowVisible.
      if (!deepest || !deepest.some((e) => e.path === selectedPath)) revealDoneRef.current = latch
    })()
    return () => {
      cancelled = true
    }
  }, [workspaceDir, selectedPath, current, reqKey, expandedKeys])

  const loadData = useCallback(
    async (node: EventDataNode<DataNode>): Promise<void> => {
      const res = await window.electronAPI.listDir(String(node.key))
      if (!res) return
      const children = res.entries.map(entryToNode)
      setRoot((prev) => (prev && prev.key === reqKey ? { ...prev, entries: withChildren(prev.entries, node.key, children) } : prev))
    },
    [reqKey],
  )

  // Click = selection, and a file click also previews beside the tree
  // (openFile brings the workbench up on 工作区, so a click still opens the
  // pane when it was folded). Clicking the selected row again deselects; the
  // address bar falls back to the workspace root.
  const onSelect = (keys: React.Key[], info: { node: EventDataNode<DataNode> }): void => {
    const next = keys.length === 0 ? null : String(keys[0])
    onSelectPath(next)
    if (next && info.node.isLeaf) usePreviewPaneStore.getState().openFile(conversationId ?? null, next)
  }

  const onExpand = (keys: React.Key[]): void => {
    // The search result owns its expansion (always fully open); a collapse
    // there must not write into the browsing cache.
    if (searching || !workspaceDir) return
    setWorkspaceExpanded(workspaceDir, keys.map(String))
  }

  const copyPath = async (entry: WorkspaceEntry): Promise<void> => {
    try {
      await navigator.clipboard.writeText(entry.path)
      void message.success('已复制路径')
    } catch {
      void message.error('复制失败')
    }
  }

  const deleteEntry = async (entry: WorkspaceEntry): Promise<void> => {
    try {
      const res = await window.electronAPI.deletePath(entry.path)
      if (res && res.success === false) {
        void message.error(res.error || '删除失败')
        return
      }
      // Take the row out of the loaded tree by hand instead of re-listing the
      // parent: the clicked node cannot be stale, and nothing else on screen
      // needs re-reading. The search result prunes the same way when one is
      // showing.
      setRoot((prev) => (prev && prev.key === reqKey ? { ...prev, entries: removeNode(prev.entries, entry.path) } : prev))
      setSearch((prev) => (prev ? { ...prev, result: { ...prev.result, nodes: removeNode(prev.result.nodes, entry.path) } } : prev))
      // The key must leave the expansion cache too, or the next mount would try
      // to re-expand a directory that no longer exists.
      useWorkspaceTreeStore.getState().dropDeleted(entry.path)
      dropPreviewTab(conversationId, entry.path)
      // The selection follows the row — UNLESS the preview still shows the
      // deleted file (a dirty draft keeps its tab alive): the address bar must
      // keep naming what is on screen. dropPreviewTab ran first, so a tab that
      // just closed is already reflected here.
      if (selectedPath === entry.path) {
        const key = conversationId ?? DRAFT_CONVERSATION_KEY
        const activePath = usePreviewPaneStore.getState().activeByConversation[key] ?? null
        if (activePath !== entry.path) onSelectPath(null)
      }
      void message.success(`已删除「${entry.name}」`)
    } catch (err) {
      void message.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  const requestDelete = (entry: WorkspaceEntry): void => {
    Modal.confirm({
      title: entry.isDir ? '删除文件夹' : '删除文件',
      content: entry.isDir ? `文件夹「${entry.name}」及其中的全部内容将被删除。` : `文件「${entry.name}」将被删除。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => deleteEntry(entry),
    })
  }

  const titleRender = (node: DataNode): React.ReactNode => {
    const entry = (node as WorkspaceNode).entry
    if (!entry) return node.title as React.ReactNode
    return <TreeRow entry={entry} highlight={searching ? debounced : undefined} onCopy={copyPath} onDelete={requestDelete} />
  }

  const refresh = () => {
    setTick((n) => n + 1)
    // An in-flight search re-runs too: 刷新 means re-read the disk, whatever
    // mode the tree is in.
    setSearchTick((n) => n + 1)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <style>{TREE_CSS}</style>
      {/* Tree header: search + 刷新. The root path lives in the address bar. */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 6px 4px 8px',
          borderBottom: '1px solid var(--pm-separator-faint)',
        }}
      >
        <Input
          size="small"
          aria-label="搜索文件"
          placeholder="搜索"
          prefix={<SearchOutlined style={{ fontSize: 11, color: 'var(--pm-text-quiet)' }} />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          allowClear
          disabled={!workspaceDir}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Tooltip title="刷新">
          <Button
            type="text"
            size="small"
            aria-label="刷新"
            icon={<ReloadOutlined style={{ fontSize: 12, color: 'var(--pm-text-quiet)' }} />}
            disabled={!workspaceDir}
            onClick={refresh}
            style={{ width: 22, height: 22, minWidth: 22, padding: 0 }}
          />
        </Tooltip>
      </div>

      {!workspaceDir ? (
        <Hint text="当前会话暂无工作目录" />
      ) : searching ? (
        !searchCurrent ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spin size="small" />
          </div>
        ) : searchCurrent.nodes.length === 0 ? (
          <Hint text="无匹配文件" />
        ) : (
          <div className="auto-hide-scroll" style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '6px 4px' }}>
            <DirectoryTree
              className="pm-ws-tree"
              treeData={searchCurrent.nodes}
              expandedKeys={searchCurrent.expanded}
              onSelect={onSelect}
              selectedKeys={selectedPath ? [selectedPath] : []}
              titleRender={titleRender}
              style={{ fontSize: 12 }}
            />
            {searchCurrent.truncated && (
              <div style={{ padding: '4px 12px', fontSize: 11, color: 'var(--pm-text-faint)' }}>
                结果过多，仅显示前 {MAX_MATCHES} 条
              </div>
            )}
          </div>
        )
      ) : !current ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spin size="small" />
        </div>
      ) : current.failed ? (
        <Hint text="无法读取该目录" />
      ) : current.entries.length === 0 ? (
        <Hint text="工作目录为空" />
      ) : (
        <div className="auto-hide-scroll" style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '6px 4px' }}>
          <DirectoryTree
            key={reqKey}
            className="pm-ws-tree"
            treeData={current.entries}
            expandedKeys={expandedKeys}
            onExpand={onExpand}
            loadData={loadData}
            onSelect={onSelect}
            selectedKeys={selectedPath ? [selectedPath] : []}
            titleRender={titleRender}
            style={{ fontSize: 12 }}
          />
        </div>
      )}
    </div>
  )
}
