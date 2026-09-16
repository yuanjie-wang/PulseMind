// ── 工作区 tab (workbench): the conversation workspace's file tree ──
// One lazy DirectoryTree over the workspace dir: each expansion lists one
// level through util:list-dir, and clicking a file opens it in the 文件预览
// tab (previewPaneStore.openFile also flips the workbench over itself).
// Labels stay hardcoded Chinese — the pane's own convention
// (工作区/文件预览/浏览器/工作计划).

import React, { useCallback, useEffect, useState } from 'react'
import { Tree, Tooltip, Button, Spin } from 'antd'
import type { DataNode, EventDataNode } from 'antd/es/tree'
import { ReloadOutlined } from '@ant-design/icons'
import { usePreviewPaneStore } from '../../stores/previewPaneStore'

const { DirectoryTree } = Tree

interface Props {
  conversationId: string | undefined
}

function entryToNode(entry: { name: string; path: string; isDir: boolean }): DataNode {
  const title = <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
  return entry.isDir ? { title, key: entry.path } : { title, key: entry.path, isLeaf: true }
}

/** Replace one node's children (matched by key) anywhere in the loaded tree. */
function withChildren(nodes: DataNode[], key: React.Key, children: DataNode[]): DataNode[] {
  return nodes.map((node) => {
    if (node.key === key) return { ...node, children }
    return node.children ? { ...node, children: withChildren(node.children, key, children) } : node
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

export function WorkspaceTree({ conversationId }: Props): React.ReactElement {
  const workspaceDir = usePreviewPaneStore((s) => s.workspaceDir)
  const [tick, setTick] = useState(0)
  // Root listing, tagged with the request it answers: a switch or refresh bumps
  // reqKey and the render reads the state as "loading" until the matching
  // result lands — no state reset inside the effect to flap through.
  const reqKey = `${workspaceDir ?? ''}#${tick}`
  const [root, setRoot] = useState<{ key: string; entries: DataNode[]; failed: boolean } | null>(null)
  const current = root && root.key === reqKey ? root : null

  useEffect(() => {
    if (!workspaceDir) return
    let cancelled = false
    window.electronAPI.listDir(workspaceDir).then((res) => {
      if (cancelled) return
      setRoot({ key: reqKey, entries: res ? res.entries.map(entryToNode) : [], failed: !res })
    })
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
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
            treeData={current.entries}
            loadData={loadData}
            onSelect={onSelect}
            style={{ fontSize: 12 }}
          />
        </div>
      )}
    </div>
  )
}
