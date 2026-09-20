// ── 工作区 tab (workbench): the conversation workspace's file tree ──
// One lazy DirectoryTree over the workspace dir: each expansion lists one
// level through util:list-dir, and clicking a file opens it in the 文件预览
// tab (previewPaneStore.openFile also flips the workbench over itself).
//
// Two things this view owes the user (2026-09-17):
//   * the expansion state is cached per workspace dir in workspaceTreeStore —
//     WorkbenchPane unmounts this component on every tab switch, so anything
//     held in component state is gone by the time the user comes back;
//   * every row reveals 复制路径 / 删除 on hover. Those clicks must not also
//     select or expand the row (DirectoryTree's expandAction is 'click'), hence
//     the stopPropagation on both buttons — and 删除 asks first, being the one
//     action here that clicking again cannot undo.
// Labels stay hardcoded Chinese — the pane's own convention
// (工作区/文件预览/浏览器/工作计划).

import React, { useCallback, useEffect, useState } from 'react'
import { Tree, Tooltip, Button, Spin, Modal, message } from 'antd'
import type { DataNode, EventDataNode } from 'antd/es/tree'
import { CopyOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
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
/* Reserved, not hidden-by-reflow: the row keeps its geometry whether or not the
   pointer is on it, so running the mouse down the tree never shifts the names. */
.pm-ws-actions { flex: none; display: flex; align-items: center; gap: 2px; margin-left: 6px; visibility: hidden; }
.pm-ws-tree .ant-tree-treenode:hover .pm-ws-actions,
.pm-ws-tree .ant-tree-treenode:focus-within .pm-ws-actions { visibility: visible; }
.pm-ws-btn {
  width: 18px; height: 18px; padding: 0; border: none; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; color: #8c8c8c; font-size: 11px; cursor: pointer;
}
.pm-ws-btn:hover { background: rgba(0, 0, 0, 0.06); color: #595959; }
/* The delete button deliberately keeps .pm-ws-btn's grey on hover — destructive
   actions are not painted red anywhere (buildAntdTheme scopes Button.colorError
   to the same grey). */
`

interface Props {
  conversationId: string | undefined
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
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px', color: '#999', fontSize: 12, textAlign: 'center' }}>
      {text}
    </div>
  )
}

interface RowProps {
  entry: WorkspaceEntry
  onCopy: (entry: WorkspaceEntry) => void
  onDelete: (entry: WorkspaceEntry) => void
}

/** One row's title: the name, then the two hover actions. Rendered through
 *  `titleRender` so the handlers are always the current ones while the tree
 *  data stays plain data. */
function TreeRow({ entry, onCopy, onDelete }: RowProps): React.ReactElement {
  return (
    <span className="pm-ws-row" data-ws-path={entry.path}>
      <span className="pm-ws-name">{entry.name}</span>
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

export function WorkspaceTree({ conversationId }: Props): React.ReactElement {
  const workspaceDir = usePreviewPaneStore((s) => s.workspaceDir)
  const setWorkspaceExpanded = useWorkspaceTreeStore((s) => s.setExpanded)
  // Cached expansion for THIS root; NO_EXPANDED_KEYS is one shared array so the
  // prop's identity is stable (DirectoryTree re-syncs its internal state from
  // it, and a fresh [] per render would loop).
  const expandedKeys = useWorkspaceTreeStore((s) => (workspaceDir ? (s.expandedByDir[workspaceDir] ?? NO_EXPANDED_KEYS) : NO_EXPANDED_KEYS))
  const [tick, setTick] = useState(0)
  // Root listing, tagged with the request it answers: a switch or refresh bumps
  // reqKey and the render reads the state as "loading" until the matching
  // result lands — no state reset inside the effect to flap through.
  const reqKey = `${workspaceDir ?? ''}#${tick}`
  const [root, setRoot] = useState<{ key: string; entries: WorkspaceNode[]; failed: boolean } | null>(null)
  const current = root && root.key === reqKey ? root : null

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

  const loadData = useCallback(
    async (node: EventDataNode<DataNode>): Promise<void> => {
      const res = await window.electronAPI.listDir(String(node.key))
      if (!res) return
      const children = res.entries.map(entryToNode)
      setRoot((prev) => (prev && prev.key === reqKey ? { ...prev, entries: withChildren(prev.entries, node.key, children) } : prev))
    },
    [reqKey],
  )

  // File click → preview in the 文件预览 tab; directory clicks only expand.
  const onSelect = (keys: React.Key[], info: { node: EventDataNode<DataNode> }): void => {
    if (keys.length === 0 || !info.node.isLeaf) return
    usePreviewPaneStore.getState().openFile(conversationId ?? null, String(keys[0]))
  }

  const onExpand = (keys: React.Key[]): void => {
    if (!workspaceDir) return
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
      // needs re-reading.
      setRoot((prev) => (prev && prev.key === reqKey ? { ...prev, entries: removeNode(prev.entries, entry.path) } : prev))
      // The key must leave the expansion cache too, or the next mount would try
      // to re-expand a directory that no longer exists.
      useWorkspaceTreeStore.getState().dropDeleted(entry.path)
      dropPreviewTab(conversationId, entry.path)
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
    return <TreeRow entry={entry} onCopy={copyPath} onDelete={requestDelete} />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <style>{TREE_CSS}</style>
      {/* Path bar: where the tree is rooted + refresh. */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 8px 6px 12px',
          borderBottom: '1px solid #ececf0',
        }}
      >
        <span
          title={workspaceDir ?? undefined}
          style={{ flex: 1, fontSize: 12, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {workspaceDir ?? '当前会话暂无工作目录'}
        </span>
        <Tooltip title="刷新">
          <Button
            type="text"
            size="small"
            aria-label="刷新"
            icon={<ReloadOutlined style={{ fontSize: 12, color: '#888' }} />}
            disabled={!workspaceDir}
            onClick={() => setTick((n) => n + 1)}
            style={{ width: 22, height: 22, minWidth: 22, padding: 0 }}
          />
        </Tooltip>
      </div>

      {!workspaceDir ? (
        <Hint text="当前会话暂无工作目录" />
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
            titleRender={titleRender}
            style={{ fontSize: 12 }}
          />
        </div>
      )}
    </div>
  )
}
