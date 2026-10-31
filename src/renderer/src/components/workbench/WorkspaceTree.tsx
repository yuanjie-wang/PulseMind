// ── 工作区 tab (workbench): the conversation workspace's file tree ──
// One lazy DirectoryTree over the workspace dir: each expansion lists one
// level through util:list-dir, and clicking a file previews it beside this
// tree (previewPaneStore.openFile also brings the workbench up on this tab).
// The header carries the search box and 刷新 — the path lives in the address
// bar inside the preview column (WorkspacePane, 2026-10-30 layout ruling).
//
// Three things this view owes the user:
//   * the expansion state is cached per workspace dir in workspaceTreeStore —
//     WorkbenchPane unmounts this component on every tab switch, so anything
//     held in component state is gone by the time the user comes back;
//   * every row reveals 在系统中打开 / 删除 on hover. Those clicks
//     must not also select or expand the row (DirectoryTree's expandAction is
//     'click'), hence the stopPropagation on every button — and 删除 asks
//     first, being the one action here that clicking again cannot undo.
//     「在系统中打开」 is the folder's Finder entry point, added 2026-10-30: the
//     address bar now speaks for the previewed file only, so a folder that is
//     merely selected would otherwise have no way out of the app;
//   * 搜索 walks the whole workspace recursively (not just the loaded levels —
//     a filter over lazy levels would only ever search what happens to be
//     open), debounced, with the matched paths and their ancestors materialized
//     as a flat-by-comparison result tree, all levels expanded.
// Selection is controlled by the parent (WorkspacePane) so the tree rows and
// an agent-opened preview can highlight the same file.
// Rows the SESSION touched are painted (2026-10-28, user: 用不同颜色区分由本轮
// 会话新增或改变的文件): a file the conversation's tools created reads in
// --pm-ws-created, one they rewrote in --pm-ws-modified, and a folder takes its
// subtree's colour (any rewrite inside → modified, else created). The source is
// the engine's own ledger (sessionFileChangesStore ← `file_changes` event +
// the initial pull below), not mtimes — a build step or the user's editor
// touching a file is not "the session changed it". A created file's parent
// level is re-listed in place so the new row shows up without 刷新.
// Labels stay hardcoded Chinese — the pane's own convention
// (工作区/浏览器/工作计划).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Tree, Tooltip, Button, Input, Spin, Modal, message, Dropdown } from 'antd'
import type { DataNode, EventDataNode } from 'antd/es/tree'
import {
  CheckCircleOutlined,
  DeleteOutlined,
  DiffOutlined,
  EditOutlined,
  FileOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { usePreviewPaneStore, openInPreviewPane, DRAFT_CONVERSATION_KEY } from '../../stores/previewPaneStore'
import { isDirty } from '../../stores/preview-edit'
import { useWorkspaceTreeStore, NO_EXPANDED_KEYS } from '../../stores/workspaceTreeStore'
import { loadedAncestor, parentDir, removeNode } from '../../stores/workspace-tree'
import { NO_FILE_CHANGES, useSessionFileChangesStore } from '../../stores/sessionFileChangesStore'
import { buildChangedFilesTree, fileChangeMarks, normalizeChangePath, type ChangedFileNode } from '../../../../shared/agent-session/file-changes'
import { MAX_MATCHES, walkTreeSearch, type TreeSearchResult } from '../../../../shared/workspace-tree-search'
import type { SessionFileChange, SessionFileChangeKind } from '../../../../shared/agent-protocol'
import { VerifyPanel } from './VerifyPanel'
import { SearchPanel } from './SearchPanel'

/** 刀一验证面板的入口旗标（2026-10-31 用户裁定「有点鸡肋，先隐藏让我再
 *  想想」）：false = 工具条按钮不渲染。strip/互斥/失败解析链全部保留在位，
 *  拨回 true 即恢复——不删代码，等用户想清楚去留。 */
const VERIFY_ENTRY_ENABLED = false

const { DirectoryTree } = Tree

/** Row CSS. Scoped to this tree: antd's Tree is used elsewhere in the app and
 *  the title-row layout below is this view's own. */
const TREE_CSS = `
/* Per-level indent step (2026-10-29, user: 目录树的缩进距离有点宽). antd derives
   the Tree's indentSize from titleHeight = controlHeightSM — 24px per level,
   which is a wide staircase beside this pane's 12px labels. Scoped to this
   tree: skill browsers elsewhere keep the stock step, and Settings' own Tree
   never sees it. The selector carries the tree class twice over (root + indent
   + unit) on purpose — it has to out-specify the component style antd injects
   at runtime, which is also why there is no !important. 10px per level
   (2026-10-31, user: 每级再收窄到 10px). */
.pm-ws-tree.ant-tree .ant-tree-indent .ant-tree-indent-unit { width: 10px; }
/* Long names truncate to … instead of stretching past the column (2026-10-31,
   user). The break has to happen at the wrapper: without the blockNode prop
   on the Tree (added alongside) the content wrapper is content-sized, so the
   name span's own ellipsis rules never come into play — the long name pushes
   the whole row out. blockNode is antd's intended switch (wrapper flex:auto plus
   full-row stretch, which also gives the selected/hover wash the editor-
   explorer full-row shape); min-width: 0 + overflow: hidden here complete the
   shrinkable flex chain down to .pm-ws-name's ellipsis. */
.pm-ws-tree .ant-tree-node-content-wrapper { display: flex; align-items: center; min-width: 0; overflow: hidden; padding-inline-start: 0; }
/* Tighter caret→icon gap (2026-10-31, user: 缩小折叠箭头和 icon 之间的间距).
   Stock antd spends ~25px between the two glyphs: the switcher is a 24px cell
   with the caret centered (~7px right slack) plus a 4px margin-inline-end antd
   derives from (switcherSize − controlInteractiveSize)/2, the content wrapper
   opens with paddingInline 8px, and the icon rides another 24px centered cell
   (~6px left slack). 18px cells on both sides, no margin, and no wrapper
   inset bring the gap to ~7px while the caret keeps a full-height 18px hit
   target — its hover pill (::before) follows the same width. The lost wrapper
   inset costs nothing visually: blockNode (above) stretches the selected/
   hover wash across the whole row anyway, so the inset only ever showed as
   dead space after the caret. This amends the earlier stance that the 24px
   switcher slot stays untouched: the user asked for the tighter spacing
   explicitly. */
.pm-ws-tree.ant-tree .ant-tree-switcher { width: 18px; margin-inline-end: 0; }
.pm-ws-tree.ant-tree .ant-tree-switcher::before { width: 18px; }
.pm-ws-tree .ant-tree-node-content-wrapper > .ant-tree-iconEle { flex: none; width: 18px; }
.pm-ws-tree .ant-tree-title { flex: 1; min-width: 0; display: flex; align-items: center; }
.pm-ws-row { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }
.pm-ws-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-ws-hit { background: var(--pm-warn-bg); border-radius: 2px; }
/* Session-change inks (see the header). On the name span, not the row: the
   selected row's grey wash and ink come from the theme's directoryNodeSelected*
   tokens on the wrapper, and the name keeps its colour on top of them the way
   an editor's explorer does. */
.pm-ws-name.pm-ws-created { color: var(--pm-ws-created); }
.pm-ws-name.pm-ws-modified { color: var(--pm-ws-modified); }
/* Hover actions are an OVERLAY, not a reservation (2026-10-31, user: 给按钮
   预留空间让名字提前截断很奇怪，有没有优化方案). Absolute at the row's right
   edge, they never consume layout width — the name rides the full row and
   only truncates when it genuinely hits the column edge, ~64px later than the
   reserved-block layout allowed. The 2026-10-30 no-reflow ruling survives in
   a stronger form: the name's geometry is constant across hover because the
   buttons float above it; what keeps them legible over the name's tail is the
   fade below, not reserved emptiness. */
.pm-ws-actions {
  position: absolute; right: 0; top: 50%; transform: translateY(-50%);
  display: flex; align-items: center; gap: 2px; visibility: hidden;
}
.pm-ws-tree .ant-tree-treenode:hover .pm-ws-actions,
.pm-ws-tree .ant-tree-treenode:focus-within .pm-ws-actions { visibility: visible; }
/* The fade mirrors the visibility toggle exactly (hover / focus-within): while
   the buttons float, the name's tail dissolves before their left edge — worst
   case a modified row carries 4 buttons (4×18px + 3×2px gaps = 78px), so the
   gradient reaches full transparency at 78px and starts dissolving 34px
   earlier, a soft slope rather than a hard cut. Paint-only: a mask changes no
   geometry, so the no-reflow check keeps measuring identical boxes. */
.pm-ws-tree .ant-tree-treenode:hover .pm-ws-name,
.pm-ws-tree .ant-tree-treenode:focus-within .pm-ws-name {
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 112px), transparent calc(100% - 78px));
  mask-image: linear-gradient(to right, #000 calc(100% - 112px), transparent calc(100% - 78px));
}
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
  return entry.isDir ? { title: entry.name, key: entry.path, entry } : { title: entry.name, key: entry.path, entry, isLeaf: true }
}

/** A 「只看本会话改动」 synthetic row keeps the live tree's affordances by
 *  carrying a fabricated entry — same shape, real path (the hover actions and
 *  the marks ink all read it). */
function changedNode(node: ChangedFileNode): WorkspaceNode {
  const entry: WorkspaceEntry = { name: node.name, path: node.path, isDir: node.children != null }
  return entry.isDir
    ? { title: node.name, key: node.path, entry, children: node.children!.map(changedNode) }
    : { title: node.name, key: node.path, entry, isLeaf: true }
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

/** Look up a listed entry by path inside the loaded levels (新建's target-dir
 *  resolution: is the selected row a directory?). Unloaded levels answer
 *  null — the caller falls back to the path's parent. */
function findEntry(nodes: WorkspaceNode[], target: string): WorkspaceEntry | null {
  for (const node of nodes) {
    if (node.entry.path === target) return node.entry
    if (node.children) {
      const hit = findEntry(node.children as WorkspaceNode[], target)
      if (hit) return hit
    }
  }
  return null
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

/** One level re-read in place — the root (which has no node of its own) or a
 *  nested dir — keeping every deeper subtree the user has open. */
function replaceLevel(entries: WorkspaceNode[], workspaceDir: string, dir: string, level: WorkspaceEntry[]): WorkspaceNode[] {
  const children = level.map(entryToNode)
  return dir === workspaceDir ? keepSubtrees(entries, children) : withChildren(entries, dir, children)
}

/** Centered one-line hint for the no-workspace / unreadable / empty states. */
function Hint({ text }: { text: string }): React.ReactElement {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 16px',
        color: 'var(--pm-text-muted)',
        fontSize: 12,
        textAlign: 'center',
      }}
    >
      {text}
    </div>
  )
}

/** Scroll shell that measures itself and hands the content the inner viewport
 *  height (2026-10-30 perf: 大项目目录树卡顿). rc-tree only virtualizes when
 *  `height` is set — without it EVERY expanded row is a real DOM node and every
 *  expand/select/ledger repaint walks them all. The tree renders only after
 *  the first measurement (a blank frame beats an unvirtualized first paint of
 *  a few thousand rows); the 12px is the wrapper's own vertical padding. */
function TreeScrollShell({ children }: { children: (viewportH: number) => React.ReactNode }): React.ReactElement {
  const shellRef = useRef<HTMLDivElement | null>(null)
  const [h, setH] = useState(0)
  useEffect(() => {
    const el = shellRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={shellRef} className="auto-hide-scroll" style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '6px 4px' }}>
      {children(Math.max(0, h - 12))}
    </div>
  )
}

/** git diff 文本的逐行着色（刀三）：+绿 −红 @@蓝，头行弱化。git 的 -U80 上下文
 *  原样展示，不做二次 diff 解析——行首前缀就是 git 自己的标记。 */
function DiffLines({ text }: { text: string }): React.ReactElement {
  return (
    <>
      {text.split('\n').map((line, i) => {
        const color =
          line.startsWith('+++') || line.startsWith('---')
            ? 'var(--pm-text-faint)'
            : line.startsWith('@@')
              ? 'var(--pm-link)'
              : line.startsWith('+')
                ? 'var(--pm-success)'
                : line.startsWith('-')
                  ? 'var(--pm-error)'
                  : undefined
        return (
          <div
            key={i}
            style={{
              color,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              fontSize: 11,
              lineHeight: 1.6,
              fontFamily: 'Menlo, Consolas, monospace',
            }}
          >
            {line || ' '}
          </div>
        )
      })}
    </>
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
  /** The session-change ink for this row (file or folder), if any. */
  mark?: SessionFileChangeKind
  onDelete: (entry: WorkspaceEntry) => void
  /** Shell-open the row's path — files in their default app, folders in
   *  Finder (2026-10-30: the address bar's 📂 speaks for the previewed file
   *  alone, so this row button is a folder's way out of the app). */
  onOpenOs: (entry: WorkspaceEntry) => void
  /** Rename-in-place (PLAN-project-ide 刀三): opens the name Modal. */
  onRename: (entry: WorkspaceEntry) => void
  /** The session-diff action (PLAN-ide-linkage 刀三): only handed down in
   *  「只看改动」 mode, and the button only renders on modified files — a
   *  created file has no git past to diff against. */
  onDiff?: (entry: WorkspaceEntry) => void
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

/** One row's title: the name, then the hover actions. Rendered through
 *  `titleRender` so the handlers are always the current ones while the tree
 *  data stays plain data. */
function TreeRow({ entry, highlight, mark, onDelete, onOpenOs, onRename, onDiff }: RowProps): React.ReactElement {
  return (
    <span className="pm-ws-row" data-ws-path={entry.path}>
      <span className={mark ? `pm-ws-name pm-ws-${mark}` : 'pm-ws-name'} data-ws-mark={mark}>
        <HighlightedName name={entry.name} highlight={highlight} />
      </span>
      <span className="pm-ws-actions">
        {onDiff && mark === 'modified' && (
          <button
            type="button"
            className="pm-ws-btn"
            title="查看本次改动 diff"
            aria-label={`查看 diff ${entry.name}`}
            onClick={(e) => {
              e.stopPropagation()
              onDiff(entry)
            }}
          >
            <DiffOutlined />
          </button>
        )}
        <button
          type="button"
          className="pm-ws-btn"
          title="在系统中打开"
          aria-label={`在系统中打开 ${entry.name}`}
          onClick={(e) => {
            e.stopPropagation()
            onOpenOs(entry)
          }}
        >
          <FolderOpenOutlined />
        </button>
        <button
          type="button"
          className="pm-ws-btn"
          title="重命名"
          aria-label={`重命名 ${entry.name}`}
          onClick={(e) => {
            e.stopPropagation()
            onRename(entry)
          }}
        >
          <EditOutlined />
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
// the ancestor folders that reach them, every level expanded. The walk itself
// lives in shared/workspace-tree-search.ts so vitest can drive it against a
// fake listDir (the 2026-10-31 「漏」 fixes live there: matched directories
// are retained as leaves, dependency/VCS trees are skipped by name).
const SEARCH_DEBOUNCE_MS = 250

/** Session-created files re-list their parent level after this quiet window:
 *  a sub-agent scaffolding ten files fires ten ledger events in a burst, and
 *  one re-read per touched level is all the tree needs. */
const LIVE_RELIST_DEBOUNCE_MS = 300

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
  const [search, setSearch] = useState<{ key: string; result: TreeSearchResult } | null>(null)
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
      const result = await walkTreeSearch(workspaceDir, debounced, (dir) => window.electronAPI.listDir(dir))
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

  // ── Session-change paint (2026-10-28) ──
  // The ledger copy for THIS conversation; the paint map derives every row's
  // ink from it (files exact, folders by subtree). NO_FILE_CHANGES keeps an
  // untouched conversation's memo input stable.
  const changes = useSessionFileChangesStore((s) => (conversationId ? s.byConversation[conversationId] : undefined)) ?? NO_FILE_CHANGES
  const marks = useMemo(() => fileChangeMarks(changes, workspaceDir), [changes, workspaceDir])

  // ── 只看本会话改动 (PLAN-ide-linkage 刀二) ──
  // A toggle, not a live-tree filter: the tree is lazy, so after a restart or
  // tab switch a changed file's ancestors may not be listed at all — filtering
  // loaded levels would silently miss rows. The synthetic tree is built from
  // the ledger alone (self-contained at any moment) and re-derives live as the
  // ledger grows. Enabling it clears the search: one view at a time, and the
  // search box is hidden in this mode (nothing left to search — the view IS
  // the filter).
  const [onlyChanges, setOnlyChanges] = useState(false)
  const changed = useMemo(() => buildChangedFilesTree(changes, workspaceDir), [changes, workspaceDir])
  const [filterExpanded, setFilterExpanded] = useState<string[] | null>(null)
  const changedNodes = useMemo(() => changed.nodes.map(changedNode), [changed])

  // ── 改动 diff (PLAN-ide-linkage 刀三) ──
  // A modified row's 「查看 diff」: one read-only git action, pathspec limited
  // to that file, cwd = the workspace. The ledger does not depend on git, so a
  // non-repo workspace keeps its list and says so honestly instead of faking a
  // diff; an empty diff means the change is staged (or the disk moved back).
  const [diffTarget, setDiffTarget] = useState<string | null>(null)
  const [diffState, setDiffState] = useState<{ kind: 'loading' | 'repo' | 'norepo' | 'empty' | 'error'; text: string } | null>(null)
  // ── 验证面板 (PLAN-project-ide 刀一) + 内容搜索 (刀二) ──
  // The diff strip's siblings: ONE strip at a time — two half-height strips
  // would starve the tree they sit under. Every opener closes the other two;
  // the verify button itself is hidden behind VERIFY_ENTRY_ENABLED (2026-10-31
  // user ruling: 「有点鸡肋，先隐藏让我再想想」) — the strip wiring stays.
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [contentSearchOpen, setContentSearchOpen] = useState(false)
  const closeStrips = (): void => {
    setDiffTarget(null)
    setDiffState(null)
    setVerifyOpen(false)
    setContentSearchOpen(false)
  }
  const showDiff = async (entry: WorkspaceEntry): Promise<void> => {
    if (!workspaceDir) return
    setVerifyOpen(false)
    setContentSearchOpen(false)
    setDiffTarget(entry.path)
    setDiffState({ kind: 'loading', text: '' })
    try {
      const res = await window.electronAPI.gitInvoke({ action: 'diff', cwd: workspaceDir, files: [entry.path] })
      if (!res.ok) {
        setDiffState({ kind: 'error', text: res.error?.message ?? 'git diff 执行失败' })
        return
      }
      const data = res.data as { isRepo?: boolean; diff?: string } | undefined
      if (!data?.isRepo) {
        setDiffState({ kind: 'norepo', text: '' })
        return
      }
      const diff = data.diff ?? ''
      setDiffState(diff ? { kind: 'repo', text: diff } : { kind: 'empty', text: '' })
    } catch (err) {
      setDiffState({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  // Initial pull: the desktop mirror is built from events alone (it never
  // snapshots), so a tree mounted AFTER the writes — tab switch, window reload
  // — would start blank without asking main for the ledger. Re-runs on 刷新 so
  // the colours re-read with the disk. A conversation with no live session
  // (opened, never sent) has nothing to paint and the call simply fails.
  useEffect(() => {
    if (!conversationId) return
    let cancelled = false
    window.electronAPI
      .agentSessionEngineCall(conversationId, 'getFileChanges', [])
      .then((v) => {
        if (!cancelled && Array.isArray(v)) useSessionFileChangesStore.getState().set(conversationId, v as SessionFileChange[])
      })
      .catch(() => {
        /* no live session — nothing to paint */
      })
    return () => {
      cancelled = true
    }
  }, [conversationId, tick])

  // Live re-list: a file the session just CREATED is missing from the level
  // the tree already listed (rewrites need nothing — the row exists, only its
  // ink changes). Re-read the nearest loaded ancestor of each new file, in
  // place through setRoot like the reveal effect does, never through `tick`
  // (which remounts the tree: spinner, lost scroll). Entries handled for this
  // tree load are remembered so a later ledger event re-reads only what is
  // new; a fresh load (new reqKey) already reflects the disk and starts over.
  // `current` is read through a ref: it is what the setRoot below changes,
  // and a dep on it would cancel this effect's own batch mid-flight.
  const currentRef = useRef(current)
  useEffect(() => {
    currentRef.current = current
  }, [current])
  const relistedRef = useRef<{ key: string; seen: Set<string> }>({ key: '', seen: new Set() })
  useEffect(() => {
    if (!workspaceDir || searching) return
    if (relistedRef.current.key !== reqKey) relistedRef.current = { key: reqKey, seen: new Set() }
    const seen = relistedRef.current.seen
    const fresh = changes.filter((c) => c.kind === 'created' && !seen.has(c.path))
    if (fresh.length === 0) return
    let cancelled = false
    const timer = setTimeout(async () => {
      const cur = currentRef.current
      // Still loading: the listing in flight is newer than any ledger entry,
      // so there is nothing to re-read — and nothing is marked seen, so the
      // entries are reconsidered on the next ledger event.
      if (!cur || cur.key !== reqKey) return
      const dirs = new Set<string>()
      for (const c of fresh) {
        seen.add(c.path)
        // Normalized like the paint map's keys: the ledger spells the model's
        // own segments (`./notes/a.md`), the tree's keys are path.join's.
        const dir = loadedAncestor(cur.entries, workspaceDir, parentDir(normalizeChangePath(c.path)))
        if (dir) dirs.add(dir)
      }
      for (const dir of dirs) {
        const level = await window.electronAPI.listDir(dir)
        if (cancelled) return
        if (level) setRoot((prev) => (prev && prev.key === reqKey ? { ...prev, entries: replaceLevel(prev.entries, workspaceDir, dir, level.entries) } : prev))
      }
    }, LIVE_RELIST_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [changes, workspaceDir, searching, reqKey])

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

  /** The same executable-gated IPC the address bar's 📂 rides. That button
   *  only ever opens the previewed file now — a folder needs this row action. */
  const openInOs = (entry: WorkspaceEntry): void => {
    void window.electronAPI.openFolder(entry.path).catch((err: unknown) => {
      void message.error(err instanceof Error ? err.message : '无法在系统中打开')
    })
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

  // ── 新建 / 重命名 (PLAN-project-ide 刀三) ──
  // 新建落在「选中目录」（选中行是目录就是它，是文件则其父目录），无选中 =
  // 根。重命名是单段名称操作：分隔符在主进程 svcRenamePath 拒，这里也先挡
  // 一道省一次往返。两者完成后重列受影响的一层——根走 tick 全量、子目录走
  // withChildren 原地替换（与 created 文件的实时重列同款，不走重挂）。
  const [createKind, setCreateKind] = useState<'file' | 'dir' | null>(null)
  const [createName, setCreateName] = useState('')
  const [renameTarget, setRenameTarget] = useState<WorkspaceEntry | null>(null)
  const [renameName, setRenameName] = useState('')

  const openCreate = (kind: 'file' | 'dir'): void => {
    setCreateKind(kind)
    setCreateName('')
  }

  /** The directory a 新建 lands in: the selected row's own dir, else the
   *  selected file's parent, else the workspace root. */
  const createTargetDir = (): string => {
    if (!workspaceDir) return ''
    if (selectedPath) {
      const entry = current ? findEntry(current.entries, selectedPath) : null
      if (entry?.isDir) return entry.path
      if (selectedPath.startsWith(workspaceDir + '/')) return parentDir(selectedPath)
    }
    return workspaceDir
  }

  /** Re-list ONE affected level in place through replaceLevel (root keeps
   *  loaded subtrees, a nested level swaps its children) — no `tick`, so no
   *  remount/spinner/lost scroll, the same discipline as the created-file
   *  re-list above. */
  const relistDir = async (dir: string): Promise<void> => {
    if (!dir || !workspaceDir) return
    const res = await window.electronAPI.listDir(dir)
    if (!res) return
    setRoot((prev) => (prev && prev.key === reqKey ? { ...prev, entries: replaceLevel(prev.entries, workspaceDir, dir, res.entries) } : prev))
  }

  const confirmCreate = async (): Promise<void> => {
    const kind = createKind
    const name = createName.trim()
    if (!kind || !name) return
    if (name.includes('/') || name.includes('\\')) {
      void message.error('名称不能包含路径分隔符')
      return
    }
    const dir = createTargetDir()
    const target = `${dir}/${name}`
    try {
      if (kind === 'dir') {
        const res = await window.electronAPI.createDir(target)
        if (!res.success) {
          void message.error(res.error || '创建失败')
          return
        }
        void message.success(`已创建文件夹「${name}」`)
      } else {
        // An empty-file create rides the preview-save write path: same guard,
        // and it materializes nested parents for free.
        const res = await window.electronAPI.writeFile({ filePath: target, content: '' })
        if (!res.success) {
          void message.error(res.error || '创建失败')
          return
        }
        openInPreviewPane(target)
        void message.success(`已创建「${name}」`)
      }
      setCreateKind(null)
      await relistDir(dir)
    } catch (err) {
      void message.error(err instanceof Error ? err.message : '创建失败')
    }
  }

  const requestRename = (entry: WorkspaceEntry): void => {
    setRenameTarget(entry)
    setRenameName(entry.name)
  }

  const confirmRename = async (): Promise<void> => {
    const entry = renameTarget
    if (!entry) return
    const name = renameName.trim()
    if (!name || name === entry.name) {
      setRenameTarget(null)
      return
    }
    if (name.includes('/') || name.includes('\\')) {
      void message.error('名称不能包含路径分隔符')
      return
    }
    try {
      const res = await window.electronAPI.renamePath(entry.path, name)
      if (!res.success) {
        void message.error(res.error || '重命名失败')
        return
      }
      const parent = parentDir(entry.path)
      setRenameTarget(null)
      // The old key leaves the expansion cache (a renamed DIR must not have its
      // children re-expanded onto a path that no longer exists), the open tab
      // follows the delete's semantics — a dirty draft keeps its tab — and the
      // selection moves to the new path so the highlight survives.
      useWorkspaceTreeStore.getState().dropDeleted(entry.path)
      dropPreviewTab(conversationId, entry.path)
      if (selectedPath === entry.path) onSelectPath(`${parent}/${name}`)
      await relistDir(parent)
      void message.success(`已重命名为「${name}」`)
    } catch (err) {
      void message.error(err instanceof Error ? err.message : '重命名失败')
    }
  }

  const titleRender = (node: DataNode): React.ReactNode => {
    const entry = (node as WorkspaceNode).entry
    if (!entry) return node.title as React.ReactNode
    return (
      <TreeRow
        entry={entry}
        highlight={searching ? debounced : undefined}
        mark={marks.get(entry.path)}
        onDelete={requestDelete}
        onOpenOs={openInOs}
        onRename={requestRename}
        onDiff={onlyChanges ? showDiff : undefined}
      />
    )
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
      {/* Tree header: search + 只看改动 + 刷新. The root path lives in the
          address bar. In 改动 mode the search box is hidden — the view is
          already the filter. */}
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
        {!onlyChanges && (
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
        )}
        {onlyChanges && (
          <div
            style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--pm-text-muted)', paddingLeft: 2 }}
          >{`本会话改动 · ${changed.nodes.length} 个文件`}</div>
        )}
        <Tooltip title={changes.length > 0 ? `只看本会话改动（${changes.length} 个文件）` : '本会话暂无文件改动'}>
          <Button
            type="text"
            size="small"
            aria-label="只看本会话改动"
            icon={<DiffOutlined style={{ fontSize: 12, color: onlyChanges ? 'var(--pm-link)' : 'var(--pm-text-quiet)' }} />}
            disabled={!workspaceDir || changes.length === 0}
            onClick={() => {
              const next = !onlyChanges
              setOnlyChanges(next)
              setFilterExpanded(null)
              if (next) {
                setQuery('')
                setSearch(null)
              } else {
                setDiffTarget(null)
                setDiffState(null)
              }
            }}
            style={{ width: 22, height: 22, minWidth: 22, padding: 0 }}
          />
        </Tooltip>
        {VERIFY_ENTRY_ENABLED && (
          <Tooltip title="验证（运行工作区自带的 test/lint 命令）">
            <Button
              type="text"
              size="small"
              aria-label="验证"
              icon={<CheckCircleOutlined style={{ fontSize: 12, color: verifyOpen ? 'var(--pm-link)' : 'var(--pm-text-quiet)' }} />}
              disabled={!workspaceDir}
              onClick={() => {
                const next = !verifyOpen
                if (next) closeStrips()
                setVerifyOpen(next)
              }}
              style={{ width: 22, height: 22, minWidth: 22, padding: 0 }}
            />
          </Tooltip>
        )}
        <Tooltip title="全文搜索（工作区内容）">
          <Button
            type="text"
            size="small"
            aria-label="全文搜索"
            icon={<FileSearchOutlined style={{ fontSize: 12, color: contentSearchOpen ? 'var(--pm-link)' : 'var(--pm-text-quiet)' }} />}
            disabled={!workspaceDir}
            onClick={() => {
              const next = !contentSearchOpen
              if (next) closeStrips()
              setContentSearchOpen(next)
            }}
            style={{ width: 22, height: 22, minWidth: 22, padding: 0 }}
          />
        </Tooltip>
        <Dropdown
          trigger={['click']}
          disabled={!workspaceDir}
          menu={{
            items: [
              { key: 'file', icon: <FileOutlined />, label: '新建文件' },
              { key: 'dir', icon: <FolderOutlined />, label: '新建文件夹' },
            ],
            onClick: ({ key }) => openCreate(key === 'dir' ? 'dir' : 'file'),
          }}
        >
          <Tooltip title="新建（在选中目录或根目录）">
            <Button
              type="text"
              size="small"
              aria-label="新建"
              icon={<PlusOutlined style={{ fontSize: 12, color: 'var(--pm-text-quiet)' }} />}
              disabled={!workspaceDir}
              style={{ width: 22, height: 22, minWidth: 22, padding: 0 }}
            />
          </Tooltip>
        </Dropdown>
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
      ) : onlyChanges ? (
        changed.nodes.length === 0 ? (
          <Hint text="本会话暂无文件改动" />
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div className="auto-hide-scroll" style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '6px 4px' }}>
              <DirectoryTree
                className="pm-ws-tree"
                blockNode
                treeData={changedNodes}
                expandedKeys={filterExpanded ?? changed.expanded}
                onExpand={(keys) => setFilterExpanded(keys.map(String))}
                onSelect={onSelect}
                selectedKeys={selectedPath ? [selectedPath] : []}
                titleRender={titleRender}
                style={{ fontSize: 12 }}
              />
            </div>
            {/* The diff strip (刀三): a modified row's 查看 diff lands here —
                the tree keeps its height, the diff takes up to ~half below. */}
            {diffTarget && (
              <div
                data-ws-diff-panel
                style={{
                  flexShrink: 0,
                  maxHeight: '48%',
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                  borderTop: '1px solid var(--pm-separator-faint)',
                  background: 'var(--pm-bg)',
                }}
              >
                <div
                  style={{
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 8px',
                    borderBottom: '1px solid var(--pm-separator-faint)',
                  }}
                >
                  <DiffOutlined style={{ fontSize: 11, color: 'var(--pm-text-quiet)', flexShrink: 0 }} />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 11,
                      color: 'var(--pm-text-muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      direction: 'rtl',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ direction: 'ltr', unicodeBidi: 'embed' }}>{diffTarget}</span>
                  </span>
                  <button
                    type="button"
                    className="pm-ws-btn"
                    title="关闭 diff"
                    aria-label="关闭 diff"
                    onClick={() => {
                      setDiffTarget(null)
                      setDiffState(null)
                    }}
                  >
                    <DeleteOutlined style={{ transform: 'rotate(45deg)' }} />
                  </button>
                </div>
                <div className="auto-hide-scroll" style={{ overflow: 'auto', minHeight: 0, padding: '6px 10px' }}>
                  {!diffState || diffState.kind === 'loading' ? (
                    <div style={{ padding: '8px 0', textAlign: 'center' }}>
                      <Spin size="small" />
                    </div>
                  ) : diffState.kind === 'norepo' ? (
                    <div style={{ fontSize: 12, color: 'var(--pm-text-muted)', padding: '4px 0' }}>非 git 仓库——列表照常可用，但没有 diff 可看</div>
                  ) : diffState.kind === 'empty' ? (
                    <div style={{ fontSize: 12, color: 'var(--pm-text-muted)', padding: '4px 0' }}>无未暂存改动（可能已暂存，或文件已还原）</div>
                  ) : diffState.kind === 'error' ? (
                    <div style={{ fontSize: 12, color: 'var(--pm-error)', padding: '4px 0', whiteSpace: 'pre-wrap' }}>{diffState.text}</div>
                  ) : (
                    <DiffLines text={diffState.text} />
                  )}
                </div>
              </div>
            )}
          </div>
        )
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
              blockNode
              treeData={searchCurrent.nodes}
              expandedKeys={searchCurrent.expanded}
              onSelect={onSelect}
              selectedKeys={selectedPath ? [selectedPath] : []}
              titleRender={titleRender}
              style={{ fontSize: 12 }}
            />
            {searchCurrent.truncated && (
              <div style={{ padding: '4px 12px', fontSize: 11, color: 'var(--pm-text-faint)' }}>结果过多，仅显示前 {MAX_MATCHES} 条</div>
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
        <TreeScrollShell>
          {(viewportH) =>
            viewportH > 0 ? (
              <DirectoryTree
                key={reqKey}
                className="pm-ws-tree"
                blockNode
                treeData={current.entries}
                height={viewportH}
                expandedKeys={expandedKeys}
                onExpand={onExpand}
                loadData={loadData}
                onSelect={onSelect}
                selectedKeys={selectedPath ? [selectedPath] : []}
                titleRender={titleRender}
                style={{ fontSize: 12 }}
              />
            ) : null
          }
        </TreeScrollShell>
      )}
      {/* The verify strip (PLAN-project-ide 刀一): tree-column bottom strip,
          sibling of the diff strip (mutually exclusive). Search mode hides it —
          the strip would squeeze the result list it sits under. */}
      {verifyOpen && !searching && workspaceDir != null && <VerifyPanel workspaceDir={workspaceDir} onClose={() => setVerifyOpen(false)} />}
      {contentSearchOpen && !searching && workspaceDir != null && <SearchPanel workspaceDir={workspaceDir} />}

      {/* 新建 / 重命名 Modals（PLAN-project-ide 刀三） */}
      <Modal
        title={createKind === 'dir' ? '新建文件夹' : '新建文件'}
        open={createKind != null}
        okText="创建"
        cancelText="取消"
        onCancel={() => setCreateKind(null)}
        onOk={() => void confirmCreate()}
        destroyOnClose
      >
        <Input
          aria-label="新建名称"
          placeholder="名称"
          value={createName}
          autoFocus
          onChange={(e) => setCreateName(e.target.value)}
          onPressEnter={() => void confirmCreate()}
        />
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--pm-text-muted)' }}>{`位置：${createTargetDir()}`}</div>
      </Modal>
      <Modal
        title="重命名"
        open={renameTarget != null}
        okText="重命名"
        cancelText="取消"
        onCancel={() => setRenameTarget(null)}
        onOk={() => void confirmRename()}
        destroyOnClose
      >
        <Input
          aria-label="新名称"
          value={renameTarget ? renameName : ''}
          autoFocus
          onChange={(e) => setRenameName(e.target.value)}
          onPressEnter={() => void confirmRename()}
        />
      </Modal>
    </div>
  )
}
