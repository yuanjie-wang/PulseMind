// ── 工作区 tree: expansion-cache logic (pure — vitest covers it directly) ──
// The tree's expansion state has to outlive the component (WorkbenchPane
// unmounts it on every tab switch), so it lives in workspaceTreeStore keyed by
// workspace dir. This file holds everything about that cache that can be
// decided without React: the recency cap, and what a deletion does to a cached
// key list.

/** Cached dirs kept by recency (insertion order); beyond this the oldest
 *  workspace's expansion state is dropped. */
export const MAX_WORKSPACE_DIRS = 10

/**
 * Copy of `keys` without `target` and without everything under it.
 * Deleting a folder must take its descendants out of the cache too — otherwise
 * the next mount would re-expand a path that no longer exists. Separator-aware:
 * keys are built by main's `path.join`, so a child is `target + '/'` on posix
 * and `target + '\\'` on Windows, and a sibling sharing a prefix (`/w/a` vs
 * `/w/ab`) must survive.
 */
export function dropSubtree(keys: readonly string[], target: string): string[] {
  return keys.filter((k) => k !== target && !k.startsWith(`${target}/`) && !k.startsWith(`${target}\\`))
}

/** Minimal shape the walk below needs — no antd/React import in a pure module.
 *  `key` includes `bigint` because that is `React.Key` since @types/react 18.3:
 *  antd's `DataNode` keys are typed `Key`, so `string | number` alone would
 *  reject every real tree node at the call site (`removeNode(prev.entries, …)`). */
export interface TreeNodeShape {
  key?: string | number | bigint
  children?: TreeNodeShape[]
}

/** Remove the node with `key` (and its subtree) from a loaded tree level,
 *  wherever it sits. Levels the deletion did not touch come back as the very
 *  same reference, so the tree's `setState` on an unrelated key is a no-op. */
export function removeNode<T extends TreeNodeShape>(nodes: T[], key: string): T[] {
  const kept = nodes.filter((node) => String(node.key) !== key)
  if (kept.length !== nodes.length) return kept
  let changed = false
  const next = nodes.map((node) => {
    if (!node.children) return node
    const children = removeNode(node.children as T[], key)
    if (children === node.children) return node
    changed = true
    return { ...node, children }
  })
  return changed ? next : nodes
}

// ── Live re-list for session-created files (2026-10-28 工作区树着色) ──
// A file the session just created is not in any level the tree has already
// listed. Re-reading the whole tree would remount it (spinner, lost scroll),
// so the tree re-lists ONE level: the nearest ancestor of the new file that
// it has loaded. The helpers below decide which one, separator-agnostic like
// dropSubtree above.

/** The directory part of `p` (either separator); '' when there is none. */
export function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? '' : p.slice(0, i)
}

function findNode<T extends TreeNodeShape>(nodes: T[], key: string): T | undefined {
  for (const node of nodes) {
    if (String(node.key) === key) return node
    if (node.children) {
      const hit = findNode(node.children as T[], key)
      if (hit) return hit
    }
  }
  return undefined
}

/**
 * The deepest directory on `dir`'s chain (from `dir` itself up to the
 * workspace root) whose listing the tree HOLDS: a nested dir counts when its
 * node is present with `children` set — rc-tree's `loadData` and the restore
 * pass are the only writers of that field — and the root always counts. A
 * `dir` outside the root is not the tree's to re-list → null.
 *
 * Why the nearest LOADED one and not the parent: a parent the tree never
 * listed needs nothing (expanding it reads fresh), but its own nearest listed
 * ancestor is now stale too — it does not know a new folder chain exists under
 * it — and that is the level whose re-read makes the new rows reachable.
 */
export function loadedAncestor<T extends TreeNodeShape>(nodes: T[], workspaceDir: string, dir: string): string | null {
  if (dir === workspaceDir) return workspaceDir
  if (!dir.startsWith(`${workspaceDir}/`) && !dir.startsWith(`${workspaceDir}\\`)) return null
  for (let cur = dir; cur.length > workspaceDir.length; cur = parentDir(cur)) {
    if (findNode(nodes, cur)?.children !== undefined) return cur
  }
  return workspaceDir
}
